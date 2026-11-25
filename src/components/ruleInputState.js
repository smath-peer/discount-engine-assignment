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
 *   any phase but loading ──startManual──► editing (an empty draft; no request is ever made)
 *   review ──startEdit──► editing (the draft is filled from the candidate)
 *   editing ──saveDraft (valid)──► review (the candidate becomes the draft's rule)
 *   editing ──cancelEdit──► review with the previous candidate, or idle if there was none
 *
 * The draft is the form's text, not a rule: only a draft that passes the
 * shared validateRule becomes the candidate, and only a confirmed candidate
 * reaches the parent. Editing never changes the active rules or the cart.
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
  origin: null, // where the candidate came from: 'ai' | 'manual' | 'edited' (an AI rule changed by hand)
  draft: null, // the form's values while editing (see EMPTY_DRAFT)
  previousCandidate: null, // the candidate an edit started from, restored by cancelEdit
  showDraftErrors: false, // true once saving an invalid draft was attempted
  confirmError: '', // why the parent refused the confirmation (e.g. a duplicate)
})

/** A new manual offer's form values. Numbers are kept as typed text until saved. */
export const EMPTY_DRAFT = Object.freeze({
  scope: 'brand',
  appliesTo: '',
  type: 'percentage',
  value: '',
  minCartValue: '',
  stackable: false,
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

    case 'confirmRejected':
      // The parent refused it (e.g. the same offer became active meanwhile): keep the review open
      if (state.phase !== 'review') return state
      return { ...state, confirmError: String(action.message ?? '') }

    case 'startManual':
      if (state.phase === 'loading') return state
      return { ...initialRuleInputState, requestId: state.requestId, phase: 'editing', origin: 'manual', draft: { ...EMPTY_DRAFT } }

    case 'startEdit':
      if (state.phase !== 'review' || !state.candidate) return state
      return {
        ...state,
        phase: 'editing',
        draft: draftFromRule(state.candidate),
        previousCandidate: state.candidate,
        showDraftErrors: false,
        confirmError: '',
      }

    case 'updateDraft':
      if (state.phase !== 'editing') return state
      return { ...state, draft: updateDraft(state.draft, action.field, action.value) }

    case 'saveDraft': {
      if (state.phase !== 'editing') return state
      const { rule } = draftToRule(state.draft)
      if (!rule) return { ...state, showDraftErrors: true }
      return {
        ...initialRuleInputState,
        requestId: state.requestId,
        phase: 'review',
        candidate: rule,
        origin: state.origin === 'ai' ? 'edited' : state.origin,
      }
    }

    case 'cancelEdit':
      if (state.phase !== 'editing') return state
      if (!state.previousCandidate) return { ...initialRuleInputState, requestId: state.requestId }
      return {
        ...initialRuleInputState,
        requestId: state.requestId,
        phase: 'review',
        candidate: state.previousCandidate,
        origin: state.origin,
      }

    default:
      return state
  }
}

// ── The edit form's draft ─────────────────────────────────────────

/** The form values for an existing rule (numbers become text, as typed). */
export function draftFromRule(rule) {
  return {
    scope: rule.scope,
    appliesTo: rule.scope === 'cart' ? '' : rule.appliesTo ?? '',
    type: rule.type,
    value: String(rule.value),
    minCartValue: rule.minCartValue == null ? '' : String(rule.minCartValue),
    stackable: Boolean(rule.stackable),
  }
}

/**
 * Changes one form value. A whole-cart offer can only be a percentage, so
 * choosing Cart switches a flat amount to a percentage (the form says so).
 */
export function updateDraft(draft, field, value) {
  if (!Object.hasOwn(EMPTY_DRAFT, field)) return draft
  const next = { ...draft, [field]: field === 'stackable' ? Boolean(value) : String(value ?? '') }
  if (field === 'scope' && next.scope === 'cart' && next.type === 'flat') next.type = 'percentage'
  return next
}

// Numbers are written as digits with an optional decimal part, as in the CSV
const DECIMAL = /^\d+(?:\.\d+)?$/

/**
 * Turns the form into a rule with the same shared validator as the CSV and
 * the rule assistant. Returns { rule, errors }:
 *   rule:   the validated rule (no ruleId), or null
 *   errors: { field: message } in plain words, for the fields that need fixing
 */
export function draftToRule(draft) {
  const errors = {}
  const scope = draft?.scope
  const isCart = scope === 'cart'
  const target = scope === 'platform' ? 'platform' : 'brand'

  const appliesTo = isCart ? '' : String(draft?.appliesTo ?? '').trim()
  if (!isCart && appliesTo === '') errors.appliesTo = `Enter the ${target} name, as it appears in the cart.`
  else if (appliesTo.length > 100) errors.appliesTo = `The ${target} name can be at most 100 characters.`

  const valueText = String(draft?.value ?? '').trim()
  let value = null
  if (valueText === '') errors.value = 'Enter the discount amount.'
  else if (!DECIMAL.test(valueText)) {
    errors.value = valueText.startsWith('-')
      ? 'The discount must be more than 0.'
      : 'Enter the discount as a number, using digits only, for example 10 or 10.5.'
  } else {
    value = Number(valueText)
    if (!(value > 0)) errors.value = 'The discount must be more than 0.'
    else if (draft.type === 'percentage' && value > 100) errors.value = 'A percentage cannot be more than 100.'
  }

  let minCartValue = null
  if (isCart) {
    const minText = String(draft?.minCartValue ?? '').trim()
    if (minText === '') errors.minCartValue = 'Enter the minimum cart value, for example 5000.'
    else if (!DECIMAL.test(minText)) {
      errors.minCartValue = minText.startsWith('-')
        ? 'The minimum cart value cannot be negative.'
        : 'Enter the minimum cart value using digits only, for example 5000.'
    } else minCartValue = Number(minText)
  }

  if (Object.keys(errors).length > 0) return { rule: null, errors }

  // The shared validator has the final word, so all three sources agree
  const { rule, errors: ruleErrors } = validateRule({
    scope, appliesTo, type: draft.type, value, stackable: Boolean(draft.stackable), minCartValue,
  })
  if (rule) return { rule, errors: {} }
  for (const error of ruleErrors) {
    const field = Object.hasOwn(EMPTY_DRAFT, error.field) ? error.field : 'scope'
    errors[field] ??= error.unsupported ? 'A whole-cart offer can only be a percentage.' : `Check this value: ${error.message}.`
  }
  return { rule: null, errors }
}

/** Maps a parseRuleInstruction result to the next state. */
function applyResult(requestId, result) {
  const base = { ...initialRuleInputState, requestId }
  switch (result?.status) {
    case 'ok':
      if (!result.rule) break
      return { ...base, phase: 'review', candidate: result.rule, origin: 'ai' }
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
  if (state.phase === 'loading' || state.phase === 'editing') return false // one way of describing an offer at a time
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
