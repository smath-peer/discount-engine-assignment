/**
 * RuleInput.jsx
 *
 * Lets the shop owner describe a discount in plain language, review what the
 * rule assistant understood, see its effect on the current cart, and then
 * confirm or discard it.
 *
 * Props:
 *   activeRules  — the rules currently in use (CSV + confirmed); read only
 *   cartItems    — the loaded cart; read only (may be empty)
 *   onConfirm    — called with the final rule (with its new NL-n ID) when confirmed
 *
 * Nothing here changes the parent's rules or cart. A candidate stays local to
 * this component until the user confirms it; only then does onConfirm receive it.
 * The server call goes through parseRuleInstruction; the preview through previewRule.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { parseRuleInstruction, MAX_TEXT_LENGTH } from '../parseRuleClient.js'
import { previewRule } from '../engine/rulePreview.js'
import {
  ruleInputReducer,
  initialRuleInputState,
  canSubmit,
  buildConfirmedRule,
  clarificationTitle,
  PERCENTAGE_OVER_100_MESSAGE,
  describeRule,
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

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

export default function RuleInput({ activeRules = [], cartItems = [], onConfirm }) {
  const [text, setText] = useState('')
  const [state, dispatch] = useReducer(ruleInputReducer, initialRuleInputState)
  const lastRequestId = useRef(0)
  const activeRequest = useRef(null) // the AbortController of the request in flight, if any

  // Leaving the page (unmounting) cancels any request still in flight
  useEffect(() => () => activeRequest.current?.abort(), [])

  const loading = state.phase === 'loading'
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
    onConfirm?.(rule)
    dispatch({ type: 'confirmed', ruleId: rule.ruleId })
    setText('')
  }

  // The preview is recalculated from the current props; it never changes them
  const preview = useMemo(
    () => (state.phase === 'review' && state.candidate ? previewRule(cartItems, activeRules, state.candidate) : null),
    [state.phase, state.candidate, cartItems, activeRules],
  )

  const overHundred = state.message === PERCENTAGE_OVER_100_MESSAGE

  return (
    <div className="card" aria-labelledby="rule-input-title" aria-busy={loading}>
      <div className="card-head">
        <h3 id="rule-input-title">Describe an offer</h3>
        <p>
          Describe one offer, for example “{EXAMPLES[0]}” or “{EXAMPLES[2]}”. You will review it before it is added.
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
            {loading ? 'Interpreting…' : 'Interpret'}
          </button>
          {loading && (
            <button type="button" className="btn secondary" onClick={handleCancel}>Cancel</button>
          )}
        </div>
        <div id="rule-instruction-help" className="field-foot">
          <span>Write numbers in digits, for example 10% or Rs.5,000.</span>
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
              <p>It is listed under Active offers with an “Added” tag.</p>
            </div>
          </div>
        )}
      </div>

      {state.phase === 'review' && state.candidate && (
        <ReviewCard
          rule={state.candidate}
          preview={preview}
          onConfirm={handleConfirm}
          onDiscard={handleDiscard}
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

function ReviewCard({ rule, preview, onConfirm, onDiscard }) {
  const tone = previewTone(preview)
  const confirmable = preview?.reason !== 'invalid_rule'

  return (
    <div className="review" role="region" aria-labelledby="rule-review-title">
      <div className="review-head">
        <h4 id="rule-review-title">Review this rule</h4>
        <span className="tag">Not active until you confirm</span>
      </div>

      <dl className="facts">
        {describeRule(rule).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {preview && (
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
      )}

      <div className="review-actions">
        <button type="button" className="btn" onClick={onConfirm} disabled={!confirmable}>
          Confirm and add rule
        </button>
        <button type="button" className="btn secondary" onClick={onDiscard}>Discard</button>
      </div>
    </div>
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
