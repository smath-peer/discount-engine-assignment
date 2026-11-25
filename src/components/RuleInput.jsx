/**
 * RuleInput.jsx
 *
 * Lets the shop owner add one offer at a time, in either of two ways:
 *   - describe it in plain language and let the rule assistant interpret it
 *     ("Interpret with AI"), or
 *   - fill in its details in a form ("Enter manually"), with no AI request.
 * Either way the offer is reviewed with its effect on the current cart, can
 * be edited ("Edit details"), and is added only when confirmed.
 *
 * Props:
 *   activeRules  — the rules currently in use (CSV + confirmed); read only
 *   cartItems    — the loaded cart; read only (may be empty)
 *   onConfirm    — called with the final rule (with its new NL-n ID) when
 *                  confirmed; returns { error } if the parent refuses it
 *
 * Nothing here changes the parent's rules or cart. A candidate or draft stays
 * local to this component until the user confirms it; only then does
 * onConfirm receive it. The server call goes through parseRuleInstruction;
 * the preview through previewRule. An offer that is already active (same
 * terms, from any source) cannot be confirmed again.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { parseRuleInstruction, MAX_TEXT_LENGTH } from '../parseRuleClient.js'
import { previewRule } from '../engine/rulePreview.js'
import { findDuplicateOffer, duplicateOfferMessage } from '../appRules.js'
import {
  ruleInputReducer,
  initialRuleInputState,
  canSubmit,
  buildConfirmedRule,
  clarificationTitle,
  PERCENTAGE_OVER_100_MESSAGE,
  describeRule,
  draftToRule,
  errorTitle,
  missingFieldLabels,
  previewTone,
  previewHasTotals,
} from './ruleInputState.js'

const EXAMPLES = [
  '20% off for Natura Casa brand, stackable with other offers',
  'Rs.100 flat discount on all Flipkart items',
  '10% off if cart value is more than Rs.5,000',
]

const ORIGIN_LABEL = { ai: 'Interpreted by AI', manual: 'Entered manually', edited: 'AI interpretation, edited' }

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

export default function RuleInput({ activeRules = [], cartItems = [], onConfirm }) {
  const [text, setText] = useState('')
  const [state, dispatch] = useReducer(ruleInputReducer, initialRuleInputState)
  const lastRequestId = useRef(0)
  const activeRequest = useRef(null) // the AbortController of the request in flight, if any
  const formTitle = useRef(null)
  const reviewTitle = useRef(null)
  const previousPhase = useRef(state.phase)

  // Leaving the page (unmounting) cancels any request still in flight
  useEffect(() => () => activeRequest.current?.abort(), [])

  // Focus follows the form: into it when it opens, back to the review when it closes
  useEffect(() => {
    const before = previousPhase.current
    previousPhase.current = state.phase
    if (state.phase === 'editing' && before !== 'editing') formTitle.current?.focus()
    if (state.phase === 'review' && before === 'editing') reviewTitle.current?.focus()
  }, [state.phase])

  const loading = state.phase === 'loading'
  const editing = state.phase === 'editing'
  const submittable = canSubmit(state, text)

  async function handleSubmit(event) {
    event.preventDefault()
    // The ref check blocks a second click that arrives before React re-renders
    if (!submittable || activeRequest.current) return

    const requestId = ++lastRequestId.current
    const controller = new AbortController()
    activeRequest.current = controller
    dispatch({ type: 'submit', requestId })

    const result = await parseRuleInstruction(text, { signal: controller.signal })
    if (activeRequest.current === controller) activeRequest.current = null
    dispatch({ type: 'response', requestId, result }) // ignored by the reducer if no longer current
  }

  function handleCancel() {
    activeRequest.current?.abort()
    activeRequest.current = null
    dispatch({ type: 'cancel' })
  }

  function handleDiscard() {
    activeRequest.current?.abort()
    activeRequest.current = null
    dispatch({ type: 'discard' }) // the text is kept so it can be edited and sent again
  }

  function handleConfirm() {
    const { rule } = buildConfirmedRule(state.candidate, activeRules.map((r) => r.ruleId))
    if (!rule) {
      dispatch({ type: 'confirmFailed' })
      return
    }
    const result = onConfirm?.(rule)
    if (result?.error) {
      dispatch({ type: 'confirmRejected', message: result.error })
      return
    }
    dispatch({ type: 'confirmed', ruleId: rule.ruleId })
    setText('')
  }

  // The preview is recalculated from the current props; it never changes them
  const preview = useMemo(
    () => (state.phase === 'review' && state.candidate ? previewRule(cartItems, activeRules, state.candidate) : null),
    [state.phase, state.candidate, cartItems, activeRules],
  )
  const duplicate = state.phase === 'review' && state.candidate ? findDuplicateOffer(activeRules, state.candidate) : null

  const overHundred = state.message === PERCENTAGE_OVER_100_MESSAGE

  return (
    <div className="card" aria-labelledby="rule-input-title" aria-busy={loading}>
      <div className="card-head">
        <h3 id="rule-input-title">Describe an offer</h3>
        <p>
          Describe one offer, for example “{EXAMPLES[0]}” or “{EXAMPLES[2]}”, or enter its details yourself. You will
          review it before it is added.
        </p>
      </div>

      <form className="field" onSubmit={handleSubmit}>
        <label htmlFor="rule-instruction">Discount instruction</label>
        <div className="field-row">
          <input
            id="rule-instruction"
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_TEXT_LENGTH}
            placeholder={EXAMPLES[1]}
            autoComplete="off"
            disabled={loading}
            aria-describedby="rule-instruction-help"
          />
          <button type="submit" className="btn" disabled={!submittable}>
            {loading && <span className="spinner" aria-hidden="true" />}
            {loading ? 'Interpreting…' : 'Interpret with AI'}
          </button>
          {loading && (
            <button type="button" className="btn secondary" onClick={handleCancel}>Cancel</button>
          )}
          {!loading && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => dispatch({ type: 'startManual' })}
              disabled={editing || state.phase === 'review'}
            >
              Enter manually
            </button>
          )}
        </div>
        <div id="rule-instruction-help" className="field-foot">
          <span>Write numbers in digits, for example 10% or Rs.5,000. Entering manually sends nothing to the AI.</span>
          <span>{text.trim().length}/{MAX_TEXT_LENGTH} characters</span>
        </div>
      </form>

      <div role="status" aria-live="polite" className="status-line">
        {loading && 'Interpreting your instruction…'}
        {state.phase === 'idle' && state.confirmedRuleId && (
          <div className="alert success notice">
            <span className="symbol" aria-hidden="true">✓</span>
            <div className="alert-body">
              <p className="alert-title">Rule {state.confirmedRuleId} added.</p>
              <p>It is listed under Active offers with an “Added” tag, where it can be removed.</p>
            </div>
          </div>
        )}
      </div>

      {state.phase === 'review' && state.candidate && (
        <ReviewCard
          rule={state.candidate}
          origin={state.origin}
          preview={preview}
          duplicate={duplicate}
          confirmError={state.confirmError}
          titleRef={reviewTitle}
          onConfirm={handleConfirm}
          onEdit={() => dispatch({ type: 'startEdit' })}
          onDiscard={handleDiscard}
        />
      )}

      {editing && state.draft && (
        <OfferForm
          draft={state.draft}
          isEdit={Boolean(state.previousCandidate)}
          showErrors={state.showDraftErrors}
          activeRules={activeRules}
          cartItems={cartItems}
          titleRef={formTitle}
          onChange={(field, value) => dispatch({ type: 'updateDraft', field, value })}
          onSave={() => dispatch({ type: 'saveDraft' })}
          onCancel={() => dispatch({ type: 'cancelEdit' })}
        />
      )}

      {state.phase === 'clarification' && (
        <Notice tone={overHundred ? 'warning' : 'info'} title={clarificationTitle(state.message)} onDismiss={handleDiscard}>
          <p>{state.message}</p>
          {missingFieldLabels(state.missingFields).length > 0 && (
            <ul>
              {missingFieldLabels(state.missingFields).map((label) => <li key={label}>{label}</li>)}
            </ul>
          )}
        </Notice>
      )}

      {state.phase === 'unsupported' && (
        <Notice tone="warning" title="This offer is not supported" onDismiss={handleDiscard}>
          <p>{state.message}</p>
        </Notice>
      )}

      {state.phase === 'error' && (
        <Notice tone="danger" title={errorTitle(state.errorCode)} role="alert" onDismiss={handleDiscard}>
          <p>{state.message}</p>
        </Notice>
      )}
    </div>
  )
}

function ReviewCard({ rule, origin, preview, duplicate, confirmError, titleRef, onConfirm, onEdit, onDiscard }) {
  const confirmable = preview?.reason !== 'invalid_rule' && !duplicate

  return (
    <div className="review" role="region" aria-labelledby="rule-review-title">
      <div className="review-head">
        <h4 id="rule-review-title" ref={titleRef} tabIndex={-1}>Review this rule</h4>
        <span className="review-tags">
          {ORIGIN_LABEL[origin] && <span className="tag subtle">{ORIGIN_LABEL[origin]}</span>}
          <span className="tag">Not active until you confirm</span>
        </span>
      </div>

      <dl className="facts">
        {describeRule(rule).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <PreviewImpact preview={preview} />

      {(duplicate || confirmError) && (
        <div className="alert warning duplicate-note" role="alert">
          <span className="symbol" aria-hidden="true">!</span>
          <div className="alert-body">
            <p className="alert-title">This offer cannot be added</p>
            <p>{duplicate ? duplicateOfferMessage(duplicate) : confirmError} Edit its details or discard it.</p>
          </div>
        </div>
      )}

      <div className="review-actions">
        <button type="button" className="btn" onClick={onConfirm} disabled={!confirmable}>
          Confirm and add rule
        </button>
        <button type="button" className="btn secondary" onClick={onEdit}>Edit details</button>
        <button type="button" className="btn secondary" onClick={onDiscard}>Discard</button>
      </div>
    </div>
  )
}

/** What the offer would do to the current cart: preview only, never applied. */
function PreviewImpact({ preview }) {
  if (!preview) return null
  const tone = previewTone(preview)
  return (
    <div className={`impact ${tone}`}>
      {previewHasTotals(preview) && (
        <dl className="impact-figures">
          <div>
            <dt>Current cart total</dt>
            <dd>{rupees(preview.currentTotal)}</dd>
          </div>
          <div>
            <dt>With this rule</dt>
            <dd>{rupees(preview.projectedTotal)}</dd>
          </div>
          <div>
            <dt>{preview.additionalSaving < 0 ? 'Increase' : 'Additional saving'}</dt>
            <dd className={tone === 'warning' ? 'negative' : tone === 'positive' ? 'positive' : undefined}>
              {rupees(Math.abs(preview.additionalSaving))}
            </dd>
          </div>
        </dl>
      )}
      {preview.outcome === 'costs_more' && (
        <p className="impact-warning">
          Warning: adding this rule would increase the amount the customer pays.
        </p>
      )}
      <p>{preview.explanation}</p>
    </div>
  )
}

const FIELD_ORDER = ['scope', 'appliesTo', 'type', 'value', 'minCartValue']

/**
 * The offer's details as a form: for a new manual offer, or to edit the one
 * under review. Only the draft changes here; Save returns to the review card
 * (if the draft is valid) and Cancel restores what was there before.
 */
function OfferForm({ draft, isEdit, showErrors, activeRules, cartItems, titleRef, onChange, onSave, onCancel }) {
  const { rule, errors } = draftToRule(draft)
  const shown = showErrors ? errors : {}
  const isCart = draft.scope === 'cart'
  const target = draft.scope === 'platform' ? 'Platform' : 'Brand'
  const preview = rule ? previewRule(cartItems, activeRules, rule) : null
  const duplicate = rule ? findDuplicateOffer(activeRules, rule) : null

  function handleSubmit(event) {
    event.preventDefault()
    onSave()
    if (!rule) {
      // Move to the first field to fix; its message is linked to it
      const first = FIELD_ORDER.find((field) => errors[field])
      setTimeout(() => document.getElementById(`offer-${first}`)?.focus(), 0) // after the messages render
    }
  }

  const errorText = (field) =>
    shown[field] ? <p id={`offer-${field}-error`} className="field-error">{shown[field]}</p> : null
  const describedBy = (field, hint) =>
    [hint, shown[field] && `offer-${field}-error`].filter(Boolean).join(' ') || undefined

  return (
    <form className="review offer-form" aria-labelledby="offer-form-title" onSubmit={handleSubmit} noValidate>
      <div className="review-head">
        <h4 id="offer-form-title" ref={titleRef} tabIndex={-1}>{isEdit ? 'Edit offer details' : 'Enter an offer manually'}</h4>
        <span className="tag">Not active until you confirm</span>
      </div>

      {showErrors && Object.keys(errors).length > 0 && (
        <div className="alert danger" role="alert">
          <span className="symbol" aria-hidden="true">!</span>
          <div className="alert-body">
            <p className="alert-title">Please fix the highlighted {Object.keys(errors).length === 1 ? 'field' : 'fields'}</p>
          </div>
        </div>
      )}

      <div className="offer-grid">
        <fieldset className="choice">
          <legend>Applies to</legend>
          {[['brand', 'A brand'], ['platform', 'A platform'], ['cart', 'The whole cart']].map(([value, label], i) => (
            <label key={value}>
              <input
                type="radio"
                name="offer-scope"
                id={i === 0 ? 'offer-scope' : undefined}
                value={value}
                checked={draft.scope === value}
                onChange={() => onChange('scope', value)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {!isCart && (
          <div className="field">
            <label htmlFor="offer-appliesTo">{target} name</label>
            <input
              id="offer-appliesTo"
              type="text"
              value={draft.appliesTo}
              onChange={(event) => onChange('appliesTo', event.target.value)}
              autoComplete="off"
              maxLength={120}
              aria-invalid={shown.appliesTo ? true : undefined}
              aria-describedby={describedBy('appliesTo', 'offer-appliesTo-hint')}
            />
            <p id="offer-appliesTo-hint" className="field-hint">As written in the cart, for example {target === 'Brand' ? 'Natura Casa' : 'Amazon India'}.</p>
            {errorText('appliesTo')}
          </div>
        )}

        <fieldset className="choice" aria-describedby={isCart ? 'offer-type-hint' : undefined}>
          <legend>Discount type</legend>
          <label>
            <input type="radio" name="offer-type" id="offer-type" value="percentage" checked={draft.type === 'percentage'} onChange={() => onChange('type', 'percentage')} />
            Percentage (%)
          </label>
          <label>
            <input type="radio" name="offer-type" value="flat" checked={draft.type === 'flat'} disabled={isCart} onChange={() => onChange('type', 'flat')} />
            Flat amount (Rs.)
          </label>
          {isCart && <p id="offer-type-hint" className="field-hint">A whole-cart offer can only be a percentage.</p>}
        </fieldset>

        <div className="field">
          <label htmlFor="offer-value">{draft.type === 'percentage' ? 'Discount (%)' : 'Discount (Rs.)'}</label>
          <input
            id="offer-value"
            type="text"
            inputMode="decimal"
            value={draft.value}
            onChange={(event) => onChange('value', event.target.value)}
            autoComplete="off"
            aria-invalid={shown.value ? true : undefined}
            aria-describedby={describedBy('value')}
          />
          {errorText('value')}
        </div>

        {isCart && (
          <div className="field">
            <label htmlFor="offer-minCartValue">Minimum cart value (Rs.)</label>
            <input
              id="offer-minCartValue"
              type="text"
              inputMode="decimal"
              value={draft.minCartValue}
              onChange={(event) => onChange('minCartValue', event.target.value)}
              autoComplete="off"
              aria-invalid={shown.minCartValue ? true : undefined}
              aria-describedby={describedBy('minCartValue', 'offer-minCartValue-hint')}
            />
            <p id="offer-minCartValue-hint" className="field-hint">The offer applies when the cart is this much or more.</p>
            {errorText('minCartValue')}
          </div>
        )}

        <label className="check">
          <input type="checkbox" checked={draft.stackable} onChange={(event) => onChange('stackable', event.target.checked)} />
          Stacks with other offers
        </label>
      </div>

      {duplicate && (
        <p className="field-error" role="status">{duplicateOfferMessage(duplicate)}</p>
      )}
      <PreviewImpact preview={preview} />

      <div className="review-actions">
        <button type="submit" className="btn">{isEdit ? 'Save changes' : 'Review offer'}</button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

const NOTICE_SYMBOL = { info: 'i', warning: '!', danger: '!' }

function Notice({ tone, title, role, onDismiss, children }) {
  return (
    <div className={['alert', tone !== 'info' && tone, 'notice'].filter(Boolean).join(' ')} role={role}>
      <span className="symbol" aria-hidden="true">{NOTICE_SYMBOL[tone]}</span>
      <div className="alert-body">
        <p className="alert-title">{title}</p>
        {children}
        <div className="alert-actions">
          <button type="button" className="btn secondary sm" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    </div>
  )
}
