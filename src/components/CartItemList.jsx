/**
 * CartItemList.jsx
 *
 * The cart as product cards: name, brand and platform, and the price. Before
 * prices are calculated a card shows the base price; afterwards it shows the
 * final price, the base price struck through, the saving, each applied offer
 * with what it took off, and (when the item qualifies for more than one
 * non-stackable offer) the comparison and preview from OfferComparison.
 *
 * Display only: every figure comes from the engine's result and from
 * offerComparison.js.
 *
 * Props:
 *   items          — the cart in use (CartItem[])
 *   results        — the engine's DiscountResult[] in the same order, or null before calculating
 *   breakdowns     — per item, from appliedOfferBreakdown()
 *   comparisons    — per item, from itemOfferOptions() (null when nothing to compare)
 *   comparingIndex — the item whose offer list is open, or null
 *   preview        — the open preview (from previewOffer()), or null
 *   onToggleCompare(index), onPreview(index, ruleId), onClosePreview()
 */

import OfferComparison from './OfferComparison.jsx'
import { previewMessages } from '../checkout/offerComparison.js'

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

export default function CartItemList({
  items, results, breakdowns, comparisons, comparingIndex, preview, onToggleCompare, onPreview, onClosePreview,
}) {
  return (
    <ul className="product-list" aria-label="Items in your cart">
      {items.map((item, index) => (
        <ProductCard
          key={index}
          item={item}
          index={index}
          result={results?.[index] ?? null}
          breakdown={breakdowns[index] ?? []}
          comparison={comparisons[index] ?? null}
          open={comparingIndex === index}
          preview={preview?.itemIndex === index ? preview : null}
          onToggleCompare={() => onToggleCompare(index)}
          onPreview={(ruleId) => onPreview(index, ruleId)}
          onClosePreview={onClosePreview}
        />
      ))}
    </ul>
  )
}

function ProductCard({ item, index, result, breakdown, comparison, open, preview, onToggleCompare, onPreview, onClosePreview }) {
  const saving = result?.totalDiscount ?? 0

  return (
    <li className="product-card">
      <div className="product-head">
        <div className="product-info">
          {/* Under the "Items" heading (h3) in Your cart (h2) */}
          <h4 className="product-name">{item.product}</h4>
          <p className="product-meta">
            {/* May break only between the brand and the platform, never inside a name */}
            <span className="keep">{item.brand}</span> · <span className="keep">{item.platform}</span>{' '}
            <span className="product-id">{item.itemId}</span>
          </p>
        </div>

        <div className="product-price">
          {result ? (
            <>
              {saving > 0 && (
                <span className="price-was"><span className="sr-only">Base price </span><s>{rupees(item.basePrice)}</s></span>
              )}
              <span className="price-now">
                <span className="sr-only">{saving > 0 ? 'Final price ' : 'Price '}</span>{rupees(result.finalPrice)}
              </span>
              {saving > 0 && <span className="price-saving">You save {rupees(saving)}</span>}
            </>
          ) : (
            <span className="price-now"><span className="sr-only">Base price </span>{rupees(item.basePrice)}</span>
          )}
        </div>
      </div>

      {result && (
        <div className="product-offers">
          {breakdown.length === 0 ? (
            <p className="offer-none">
              {result.reasoning}
              <span className="offer-none-why"> — no offer covers {item.brand} or {item.platform}.</span>
            </p>
          ) : (
            <ul className="applied-offers" aria-label={`Offers applied to ${item.product}`}>
              {breakdown.map((offer) => (
                <li key={offer.ruleId}>
                  <span className="applied-offer-name">
                    {offer.name}
                    {!offer.stackable && comparison && (
                      <span className="tag best">Best of {comparison.options.length} offers</span>
                    )}
                    {offer.stackable && breakdown.length > 1 && <span className="tag subtle">Stacks on top</span>}
                  </span>
                  <span className="applied-offer-amount">−{rupees(offer.amount)}</span>
                </li>
              ))}
            </ul>
          )}

          {comparison && (
            <OfferComparison
              index={index}
              itemName={item.product}
              comparison={comparison}
              open={open}
              onToggle={onToggleCompare}
              preview={preview}
              messages={preview ? previewMessages(preview) : []}
              onPreview={onPreview}
              onClosePreview={onClosePreview}
            />
          )}
        </div>
      )}
    </li>
  )
}
