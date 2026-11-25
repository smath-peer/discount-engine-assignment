/**
 * checkoutSummary.js
 *
 * The customer-facing price breakdown, read from the engine's own result.
 * It adds nothing to the pricing: every figure is a sum or a difference of
 * values priceCart already produced, so the breakdown always agrees with
 * the item prices and the final total.
 *
 *   originalTotal   — the items' base prices added up
 *   itemSavings     — what item-level offers took off (originalTotal - subtotal)
 *   subtotal        — the engine's subtotal after item offers
 *   cartOffers      — the engine's applied cart offers, unchanged
 *   cartDiscount    — what cart offers took off
 *   finalTotal      — the amount to pay
 *   totalSavings    — originalTotal - finalTotal
 *   cartOffersNotReached — cart rules whose minimum the subtotal is below,
 *                          with how far below it is (never "add Rs.X more":
 *                          extra items may be discounted themselves)
 */

import { plural } from '../components/loadStatus.js'

/**
 * priced:    the PricedCart from priceCart (never changed)
 * cartRules: the active rules with scope 'cart'
 */
export function checkoutSummary(priced, cartRules = []) {
  const originalTotal = priced.items.reduce((sum, item) => sum + item.basePrice, 0)

  const cartOffersNotReached = cartRules
    .filter((rule) => priced.subtotal < rule.minCartValue)
    .map((rule) => ({
      ruleId: rule.ruleId,
      value: rule.value,
      minCartValue: rule.minCartValue,
      shortBy: rule.minCartValue - priced.subtotal,
    }))
    .sort((a, b) => a.minCartValue - b.minCartValue)

  return {
    itemCount: priced.items.length,
    originalTotal,
    itemSavings: originalTotal - priced.subtotal,
    subtotal: priced.subtotal,
    cartOffers: priced.cartOffers,
    cartDiscount: priced.cartDiscount,
    finalTotal: priced.finalTotal,
    totalSavings: originalTotal - priced.finalTotal,
    cartOffersNotReached,
  }
}

/**
 * A warning for totals built from a partly loaded cart file, or null.
 * cart: the cart in use ({ items, fileName, skipped })
 */
export function partialCartWarning(cart) {
  if (!cart || cart.skipped.length === 0 || cart.items.length === 0) return null
  return (
    `${plural(cart.skipped.length, 'row')} from ${cart.fileName} could not be read, so these totals ` +
    `include only the ${plural(cart.items.length, 'item')} that loaded. The skipped rows are listed under Your cart.`
  )
}
