/**
 * CheckoutSummary.jsx
 *
 * The price breakdown in the Checkout panel: items total, item offers,
 * subtotal, cart offers, the amount to pay and the total saving, plus any
 * cart offer the subtotal does not reach yet. Every figure comes from
 * checkoutSummary() (src/checkout/checkoutSummary.js), which reads the
 * engine's actual result; previews never reach this component.
 *
 * Props:
 *   summary  — from checkoutSummary()
 *   titleRef — on the "Price details" heading, so focus can be moved there
 */

import { plural } from './loadStatus.js'

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

export default function CheckoutSummary({ summary, titleRef }) {
  const {
    itemCount, originalTotal, itemSavings, subtotal, cartOffers,
    finalTotal, totalSavings, cartOffersNotReached,
  } = summary

  return (
    <div className="price-details">
      <h3 className="price-details-title" ref={titleRef} tabIndex={-1}>Price details</h3>

      <div className="summary-line">
        <span>Items total<span className="sub">{plural(itemCount, 'item')} at base price</span></span>
        <span className="num">{rupees(originalTotal)}</span>
      </div>
      {itemSavings > 0 && (
        <div className="summary-line offer">
          <span>Item offers</span>
          <span className="num">−{rupees(itemSavings)}</span>
        </div>
      )}
      <div className="summary-line">
        <span>Subtotal<span className="sub">after item offers</span></span>
        <span className="num">{rupees(subtotal)}</span>
      </div>
      {cartOffers.map((offer) => (
        <div key={offer.ruleId} className="summary-line offer">
          <span>
            {offer.label}
            <span className="sub">{offer.ruleId} · cart total of {rupees(offer.minCartValue)} or more</span>
          </span>
          <span className="num">−{rupees(offer.amount)}</span>
        </div>
      ))}

      <div className="summary-total">
        <span>Amount to pay</span>
        <span className="total-value">{rupees(finalTotal)}</span>
      </div>

      {totalSavings > 0 ? (
        <p className="savings-banner">
          You save <strong>{rupees(totalSavings)}</strong> on this order
        </p>
      ) : (
        <p className="summary-note">No offers apply to this cart.</p>
      )}

      {cartOffersNotReached.map((offer) => (
        <p key={offer.ruleId} className="summary-note threshold">
          {offer.value}% cart offer ({offer.ruleId}): your cart after item offers is {rupees(subtotal)},{' '}
          {rupees(offer.shortBy)} below the {rupees(offer.minCartValue)} minimum.
        </p>
      ))}
    </div>
  )
}
