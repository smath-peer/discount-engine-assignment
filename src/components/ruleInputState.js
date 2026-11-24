/**
 * ruleInputState.js
 *
 * The plain-JavaScript logic behind RuleInput.jsx, kept free of React so it
 * can be tested directly:
 *   - ruleInputReducer: the state machine
 *   - nextRuleId / buildConfirmedRule: turning a confirmed candidate into a rule
 *   - small display helpers (field labels, rule summary, preview tone)
 *
 * State machine:
 *
 *   idle ──submit──► loading ──response──► review | clarification | unsupported | error
 *     ▲                 │                         │
 *     │◄────cancel──────┘  (a "cancelled" result also returns to idle)
 *     │◄────discard / confirmed ──────────────────┘
 *
 * Every request carries a requestId. A response is applied only if it
 * belongs to the request currently loading, so a late or cancelled reply
 * can never overwrite a newer one.
 */

import { validateRule } from '../engine/discountRuleValidator.js'
import { MIN_TEXT_LENGTH, MAX_TEXT_LENGTH } from '../parseRuleClient.js'

export const initialRuleInputState = Object.freeze({
  phase: 'idle', // 'idle' | 'loading' | 'review' | 'clarification' | 'unsupported' | 'error'
  requestId: 0, // the latest request started; ids only ever increase
  candidate: null, // the interpreted rule awaiting review (never active, no ruleId)
  message: '',
  missingFields: [],
  errorCode: null,
  retryAfterSeconds: null,
  confirmedRuleId: null, // set after a confirmation, for the "Rule NL-1 added" note
})

const INVALID_CANDIDATE_MESSAGE = 'This rule is no longer valid, so it was not added. Please describe it again.'

/**
 * Actions:
 *   { type: 'submit', requestId }        start a request (ignored while one is loading)
 *   { type: 'response', requestId, result }  a parseRuleInstruction result
 *   { type: 'cancel' }                   the user cancelled the loading request
 *   { type: 'discard' }                  drop the candidate or message
 *   { type: 'confirmed', ruleId }        the parent accepted the confirmed rule
 *   { type: 'confirmFailed' }            the candidate failed the final validation
 */
export function ruleInputReducer(state, action) {
  switch (action?.type) {
    case 'submit':
      // One request at a time, and request ids must keep increasing
      if (state.phase === 'loading') return state
      if (!Number.isInteger(action.requestId) || action.requestId <= state.requestId) return state
      return { ...initialRuleInputState, phase: 'loading', requestId: action.requestId }

    case 'response':
      // Only the reply to the request currently loading is used
      if (state.phase !== 'loading' || action.requestId !== state.requestId) return state
      return applyResult(state.requestId, action.result)

    case 'cancel':
      if (state.phase !== 'loading') return state
      return { ...initialRuleInputState, requestId: state.requestId }

    case 'discard':
      if (state.phase === 'loading' || state.phase === 'idle') return state
      return { ...initialRuleInputState, requestId: state.requestId }

    case 'confirmed':
      if (state.phase !== 'review' || typeof action.ruleId !== 'string') return state
      return { ...initialRuleInputState, requestId: state.requestId, confirmedRuleId: action.ruleId }

    case 'confirmFailed':
      if (state.phase !== 'review') return state
      return {
        ...initialRuleInputState,
        requestId: state.requestId,
        phase: 'error',
        errorCode: 'invalid_candidate',
        message: INVALID_CANDIDATE_MESSAGE,
      }

    default:
      return state
  }
}

/** Maps a parseRuleInstruction result to the next state. */
function applyResult(requestId, result) {
  const base = { ...initialRuleInputState, requestId }
  switch (result?.status) {
    case 'ok':
      if (!result.rule) break
      return { ...base, phase: 'review', candidate: result.rule }
    case 'needs_clarification':
      return {
        ...base,
        phase: 'clarification',
        message: result.message,
        missingFields: Array.isArray(result.missingFields) ? [...result.missingFields] : [],
      }
    case 'unsupported':
      return { ...base, phase: 'unsupported', message: result.message }
    case 'error':
      return {
        ...base,
        phase: 'error',
        message: result.message,
        errorCode: result.code ?? null,
        retryAfterSeconds: Number.isInteger(result.retryAfterSeconds) ? result.retryAfterSeconds : null,
      }
    case 'cancelled':
      return base
  }
  return {
    ...base,
    phase: 'error',
    errorCode: 'invalid_response',
    message: 'The server sent an unexpected response. Please try again.',
  }
}

/** True when the text can be sent: nothing is loading and it is 3–300 characters. */
export function canSubmit(state, text) {
  if (state.phase === 'loading') return false
  const length = typeof text === 'string' ? text.trim().length : 0
  return length >= MIN_TEXT_LENGTH && length <= MAX_TEXT_LENGTH
}

// ── Rule IDs ──────────────────────────────────────────────────────

/**
 * The first free ID in the sequence NL-1, NL-2, NL-3…
 * `existingIds` are all IDs in use (CSV rules and confirmed rules), passed in
 * by the parent. The comparison ignores case and spaces, so a CSV rule named
 * "nl-1" also blocks NL-1.
 */
export function nextRuleId(existingIds = []) {
  const taken = new Set()
  for (const id of existingIds) {
    if (typeof id === 'string') taken.add(id.trim().toUpperCase())
  }
  for (let n = 1; ; n++) {
    const id = `NL-${n}`
    if (!taken.has(id)) return id
  }
}

/**
 * Validates the candidate once more and gives it the next free ID.
 * Returns { rule, errors }; rule is null if the candidate is not valid.
 * Any ID already on the candidate (e.g. a preview ID) is dropped by the validator.
 */
export function buildConfirmedRule(candidate, existingIds) {
  const { rule, errors } = validateRule(candidate)
  if (!rule) return { rule: null, errors }
  return { rule: { ruleId: nextRuleId(existingIds), ...rule }, errors: [] }
}

// ── Display helpers ───────────────────────────────────────────────

/** Plain names for fields the user may need to add. */
export const FIELD_LABELS = Object.freeze({
  scope: 'Whether it is for a brand, a platform or the whole cart',
  appliesTo: 'The brand or platform name',
  type: 'Percentage or flat rupee amount',
  value: 'The discount amount',
  minCartValue: 'The minimum cart value',
})

export function missingFieldLabels(fields) {
  return fields.filter((f) => Object.hasOwn(FIELD_LABELS, f)).map((f) => FIELD_LABELS[f])
}

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

/** The candidate's fields as [label, value] rows for the review card. */
export function describeRule(rule) {
  const appliesTo =
    rule.scope === 'cart' ? 'Entire cart' : `${rule.scope === 'brand' ? 'Brand' : 'Platform'}: ${rule.appliesTo}`
  return [
    ['Applies to', appliesTo],
    ['Discount', rule.type === 'percentage' ? `${rule.value}% off` : `${rupees(rule.value)} off`],
    // The minimum is inclusive: "more than Rs.5,000" is applied as Rs.5,000 or more
    ['Condition', rule.minCartValue == null ? 'None' : `Cart total of ${rupees(rule.minCartValue)} or more`],
    ['Stacks with other offers', rule.stackable ? 'Yes' : 'No'],
  ]
}

/**
 * The server's message when the model returns a percentage over 100.
 * A copy, because server code is not bundled into the browser; a test checks
 * it still matches what the server actually sends.
 */
export const PERCENTAGE_OVER_100_MESSAGE =
  'A percentage discount cannot be more than 100%. Please give a percentage up to 100.'

/**
 * A heading for a clarification notice. A percentage over 100 is a refusal,
 * not missing detail, so it gets its own heading. Validation is unchanged.
 */
export function clarificationTitle(message) {
  return message === PERCENTAGE_OVER_100_MESSAGE ? 'This discount is not allowed' : 'A little more detail is needed'
}

/**
 * A heading for an error that names what kind of problem it is, so a quota
 * or connection problem is not presented as "could not interpret".
 */
export function errorTitle(errorCode) {
  switch (errorCode) {
    case 'quota_exceeded':
      return 'Free usage limit reached'
    case 'timeout':
      return 'No response in time'
    case 'network_error':
      return 'Connection problem'
    case 'not_configured':
    case 'service_unavailable':
      return 'Rule assistant unavailable'
    case 'forbidden':
      return 'Request blocked'
    case 'invalid_candidate':
      return 'Rule not added'
    default:
      return 'Could not interpret the instruction'
  }
}

/** How the preview should be coloured: 'positive', 'warning' or 'neutral'. */
export function previewTone(preview) {
  if (!preview) return 'neutral'
  if (preview.outcome === 'costs_more') return 'warning'
  if (preview.outcome === 'saves') return 'positive'
  return 'neutral'
}

/** Whether the review card should show totals (not for an empty cart or an invalid rule). */
export function previewHasTotals(preview) {
  return Boolean(preview) && preview.reason !== 'empty_cart' && preview.reason !== 'invalid_rule'
}
