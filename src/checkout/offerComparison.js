/**
 * offerComparison.js
 *
 * Lets a customer compare an item's applied offer with the other offers it
 * qualifies for, and preview what an alternative would cost. Comparison and
 * preview only: nothing here changes the cart, the rules or the actual
 * prices, and there is no way to apply an alternative.
 *
 * It reuses the engine's exported functions and adds no pricing rules:
 *   - ruleMatchesItem         decides which offers an item qualifies for
 *   - calculateDiscountAmount is the measure the engine ranks offers by
 *   - applyDiscounts          prices the item with one chosen offer plus its
 *                             stackable offers, so rounding, stacking order
 *                             and the zero-price floor are the engine's own
 *   - applyCartRules          re-checks cart offers for the preview total
 *
 * The engine applies the best non-stackable offer, then every stackable
 * offer on top. Only the non-stackable offers are alternatives to each
 * other; stackable offers apply with any of them, so they are listed as
 * "also applied", never as alternatives.
 *
 * Items are referred to by their position in the cart (itemIndex), because
 * a CSV may repeat an item ID.
 */

import { ruleMatchesItem, calculateDiscountAmount, applyDiscounts, applyCartRules } from '../engine/discountEngine.js'

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

/** An offer as customers read it, in the engine's own words (e.g. "Platform offer: 15% off"). */
function offerName(item, rule) {
  return applyDiscounts(item, [rule]).reasoning
}

/** The rules of an item, split as the engine splits them. */
function matchingRules(item, rules) {
  const matching = rules.filter((rule) => rule.scope !== 'cart' && ruleMatchesItem(item, rule))
  return {
    nonStackable: matching.filter((rule) => !rule.stackable),
    stackable: matching.filter((rule) => rule.stackable),
  }
}

/**
 * What each applied offer took off an item, in the order the engine applied
 * them: the chosen non-stackable offer first, then each stackable one.
 * Each amount is the difference between the engine's own prices with and
 * without that offer (applyDiscounts on the applied offers so far), so the
 * amounts always add up to the engine's totalDiscount.
 *   item:   the CartItem
 *   rules:  the active rules
 *   actual: the item's DiscountResult from priceCart
 * Returns [{ ruleId, name, amount, stackable }], empty when no offer applies.
 */
export function appliedOfferBreakdown(item, rules, actual) {
  const byId = new Map(rules.map((rule) => [rule.ruleId, rule]))
  const applied = actual.appliedRules.map((id) => byId.get(id)).filter(Boolean)
  let before = item.basePrice
  return applied.map((rule, k) => {
    const after = applyDiscounts(item, applied.slice(0, k + 1)).finalPrice
    const entry = { ruleId: rule.ruleId, name: offerName(item, rule), amount: before - after, stackable: rule.stackable }
    before = after
    return entry
  })
}

/**
 * The offers an item can choose between, and why the applied one won.
 *   item:   the CartItem
 *   rules:  the active rules, in order
 *   actual: the item's DiscountResult from priceCart
 * Returns null when there is nothing to compare (fewer than two
 * non-stackable offers), otherwise:
 *   { options: [{ ruleId, name, ownSaving, itemPrice, itemSaving, applied }],
 *     stackable: [names], reason }
 *   ownSaving:  what the offer alone takes off the base price — the measure
 *               the engine ranks by
 *   itemPrice:  the item's price with this offer and the stackable offers
 * Options are listed best first; equal savings keep the rules' order, as the
 * engine does, so the applied offer is always first.
 */
export function itemOfferOptions(item, rules, actual) {
  const { nonStackable, stackable } = matchingRules(item, rules)
  if (nonStackable.length < 2) return null

  const options = nonStackable
    .map((rule) => {
      const priced = applyDiscounts(item, [rule, ...stackable])
      return {
        ruleId: rule.ruleId,
        name: offerName(item, rule),
        ownSaving: calculateDiscountAmount(item.basePrice, rule),
        itemPrice: priced.finalPrice,
        itemSaving: priced.totalDiscount,
        applied: rule.ruleId === actual.appliedRules[0],
      }
    })
    .sort((a, b) => b.ownSaving - a.ownSaving) // stable: ties keep the rules' order

  return {
    options,
    stackable: stackable.map((rule) => offerName(item, rule)),
    reason: appliedReason(options),
  }
}

/** One sentence on why the applied offer was chosen over the next best. */
function appliedReason(options) {
  const applied = options.find((o) => o.applied)
  const next = options.find((o) => !o.applied)
  if (!applied || !next) return ''
  if (applied.ownSaving === next.ownSaving) {
    return `${applied.name} and ${next.name} both take ${rupees(applied.ownSaving)} off, so the first listed offer is applied.`
  }
  return `Applied because it takes ${rupees(applied.ownSaving)} off, the largest saving; ${next.name} would take ${rupees(next.ownSaving)} off.`
}

/**
 * The cart as it would be if one item used a different offer. Only that
 * item's price changes; every other item keeps its actual price, and the
 * cart offers are re-checked against the new subtotal.
 *   cartItems: the cart, in order
 *   rules:     the active rules
 *   actual:    the PricedCart from priceCart (never changed)
 *   itemIndex: which item
 *   ruleId:    the non-stackable offer to preview for it
 * Returns null if that offer does not apply to that item as a non-stackable
 * offer. Otherwise every figure needed to show the preview and compare it
 * with the actual amount to pay.
 */
export function previewOffer(cartItems, rules, actual, itemIndex, ruleId) {
  const item = cartItems[itemIndex]
  const actualItem = actual.items[itemIndex]
  if (!item || !actualItem) return null
  const { nonStackable, stackable } = matchingRules(item, rules)
  const rule = nonStackable.find((r) => r.ruleId === ruleId)
  if (!rule) return null

  const previewItem = applyDiscounts(item, [rule, ...stackable])
  const subtotal = actual.subtotal - actualItem.finalPrice + previewItem.finalPrice
  const cart = applyCartRules(subtotal, rules.filter((r) => r.scope === 'cart'))

  const actualCartIds = actual.cartOffers.map((o) => o.ruleId)
  const previewCartIds = cart.cartOffers.map((o) => o.ruleId)

  return {
    itemIndex,
    ruleId,
    applied: ruleId === actualItem.appliedRules[0],
    offer: previewItem.reasoning,
    itemPrice: previewItem.finalPrice,
    actualItemPrice: actualItem.finalPrice,
    itemDifference: previewItem.finalPrice - actualItem.finalPrice,
    subtotal,
    cartOffers: cart.cartOffers,
    cartDiscount: cart.cartDiscount,
    finalTotal: cart.finalTotal,
    actualFinalTotal: actual.finalTotal,
    totalDifference: cart.finalTotal - actual.finalTotal,
    cartOffersGained: cart.cartOffers.filter((o) => !actualCartIds.includes(o.ruleId)),
    cartOffersLost: actual.cartOffers.filter((o) => !previewCartIds.includes(o.ruleId)),
  }
}

const cartOfferText = (offer) => `the ${offer.value}% cart offer (from ${rupees(offer.minCartValue)})`

/**
 * The preview's explanation, as plain sentences, calculated only from the
 * preview's figures.
 */
export function previewMessages(preview) {
  if (preview.applied) return ['This is the offer already applied, so nothing would change.']

  const messages = []
  const item = preview.itemDifference
  messages.push(
    item > 0 ? `This item would cost ${rupees(item)} more than with the applied offer.`
      : item < 0 ? `This item would cost ${rupees(-item)} less than with the applied offer.`
        : 'This item would cost the same as with the applied offer.',
  )

  for (const offer of preview.cartOffersGained) messages.push(`The cart would then reach ${cartOfferText(offer)}.`)
  for (const offer of preview.cartOffersLost) messages.push(`The cart would no longer reach ${cartOfferText(offer)}.`)

  const total = preview.totalDifference
  if (total > 0) {
    messages.push(`You would pay ${rupees(total)} more in total: ${rupees(preview.finalTotal)} instead of ${rupees(preview.actualFinalTotal)}.`)
  } else if (total < 0) {
    messages.push(
      `The cart total would be ${rupees(-total)} lower: ${rupees(preview.finalTotal)} instead of ${rupees(preview.actualFinalTotal)}. ` +
        'Offers are still chosen item by item, so the applied offer stays the one with the largest saving on this item.',
    )
  } else {
    messages.push(`The cart total would be the same: ${rupees(preview.finalTotal)}.`)
  }
  return messages
}

// ── Which preview is open ────────────────────────────────────────

/**
 * Opening, closing and resetting a preview. The open preview remembers the
 * cart and rules it was opened for; as soon as either changes, it no longer
 * counts as open, so a stale preview can never be shown.
 */
export function openPreview(cartItems, rules, itemIndex, ruleId) {
  return { cartItems, rules, itemIndex, ruleId }
}

export function closePreview() {
  return null
}

/** The open preview's { itemIndex, ruleId } if it still matches the cart and rules in use, else null. */
export function currentPreview(state, cartItems, rules) {
  if (!state || state.cartItems !== cartItems || state.rules !== rules) return null
  return { itemIndex: state.itemIndex, ruleId: state.ruleId }
}
