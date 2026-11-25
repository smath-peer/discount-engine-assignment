/**
 * PayBar.jsx
 *
 * The bar fixed to the bottom of the screen while the page is one column
 * (below 1100px, see index.css), where Checkout comes after the cart and the
 * offers: it keeps the actual amount to pay in view and leads to the price
 * details. It is hidden on wide screens, where Checkout is always beside the
 * cart. The page leaves room below its content for the bar, so the bar never
 * covers the last controls.
 *
 * Display only: the figures are the actual result's (from checkoutSummary()),
 * never a preview's.
 *
 * Props:
 *   finalTotal, totalSavings — from checkoutSummary()
 *   onShowDetails            — scrolls to the price details and focuses them
 */

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

export default function PayBar({ finalTotal, totalSavings, onShowDetails }) {
  return (
    <aside className="pay-bar" aria-label="Amount to pay">
      <div className="pay-bar-inner">
        <p className="pay-bar-figures">
          <span className="pay-bar-label">Amount to pay</span>
          <span className="pay-bar-total">{rupees(finalTotal)}</span>
          {totalSavings > 0 && <span className="pay-bar-saving">You save {rupees(totalSavings)}</span>}
        </p>
        <button type="button" className="btn accent" onClick={onShowDetails}>
          Price details
        </button>
      </div>
    </aside>
  )
}
