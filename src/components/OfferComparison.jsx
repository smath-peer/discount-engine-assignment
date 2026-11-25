/**
 * OfferComparison.jsx
 *
 * Under an item's applied offer: a "Compare N offers" button that shows the
 * other offers the item qualifies for, why the applied one was chosen, and a
 * "Preview this offer" button for each alternative. A preview shows what the
 * item and the whole cart would cost with that offer. It is only a preview:
 * there is no way to apply it, and closing it leaves everything as it was.
 *
 * All figures come from offerComparison.js; this component only displays them.
 *
 * Props:
 *   index        — the item's position in the cart
 *   itemName     — the product name, for the button's accessible name
 *   comparison   — from itemOfferOptions() (never null here)
 *   open         — whether the list is shown
 *   onToggle     — show or hide the list
 *   preview      — from previewOffer() for this item, or null
 *   messages     — from previewMessages(preview)
 *   onPreview    — (ruleId) => void
 *   onClosePreview
 */

import { useEffect, useRef } from 'react'

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`
const signedRupees = (amount) => (amount > 0 ? `+${rupees(amount)}` : amount < 0 ? `−${rupees(-amount)}` : rupees(0))

export default function OfferComparison({ index, itemName, comparison, open, onToggle, preview, messages, onPreview, onClosePreview }) {
  const listId = `offer-options-${index}`
  const { options, stackable, reason } = comparison

  return (
    <div className="offer-compare">
      <button type="button" className="link-button" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
        {open ? 'Hide other offers' : `Compare ${options.length} offers`}
        <span className="sr-only"> for {itemName}</span>
      </button>
      {open && (
        <div id={listId} className="offer-options">
          <p className="offer-reason">{reason}</p>
          <ul>
            {options.map((option) => (
              <li key={option.ruleId} className={option.applied ? 'applied' : undefined}>
                <span className="offer-option-text">
                  <span className="offer-option-name">{option.name}</span>
                  <span className="offer-option-figures">
                    You save {rupees(option.itemSaving)} · item price {rupees(option.itemPrice)}
                  </span>
                </span>
                {option.applied ? (
                  <span className="tag">Applied · largest saving</span>
                ) : (
                  <button
                    type="button"
                    id={`preview-button-${index}-${option.ruleId}`}
                    className="btn secondary sm"
                    aria-pressed={preview?.ruleId === option.ruleId}
                    onClick={() => onPreview(option.ruleId)}
                  >
                    Preview this offer
                    <span className="sr-only">: {option.name}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          {stackable.length > 0 && (
            <p className="offer-stackable">Applied on top of any of these: {stackable.join(', ')}</p>
          )}
          {preview && <OfferPreview preview={preview} messages={messages} onClose={onClosePreview} />}
        </div>
      )}
    </div>
  )
}

function OfferPreview({ preview, messages, onClose }) {
  const titleRef = useRef(null)
  const titleId = `offer-preview-title-${preview.itemIndex}`

  // Opening a preview (or switching to another) moves focus to it
  useEffect(() => { titleRef.current?.focus() }, [preview.ruleId])

  return (
    <div
      className="offer-preview"
      role="region"
      aria-labelledby={titleId}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
    >
      <div className="offer-preview-head">
        <h5 id={titleId} ref={titleRef} tabIndex={-1}>Preview: {preview.offer}</h5>
        <span className="tag preview-tag">Preview only — not applied</span>
      </div>
      <dl className="impact-figures">
        <div>
          <dt>This item</dt>
          <dd>{rupees(preview.itemPrice)}</dd>
        </div>
        <div>
          <dt>Cart total</dt>
          <dd>{rupees(preview.finalTotal)}</dd>
        </div>
        <div>
          <dt>Compared with what you pay</dt>
          <dd className={preview.totalDifference > 0 ? 'negative' : preview.totalDifference < 0 ? 'positive' : undefined}>
            {signedRupees(preview.totalDifference)}
          </dd>
        </div>
      </dl>
      {messages.map((message) => <p key={message}>{message}</p>)}
      <div className="review-actions">
        <button type="button" className="btn secondary sm" onClick={onClose}>Close preview</button>
      </div>
    </div>
  )
}
