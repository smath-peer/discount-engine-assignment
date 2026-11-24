/**
 * discountEngine.js
 *
 * Pure discount calculation logic. No UI, no side effects.
 * All functions take plain objects and return plain objects.
 *
 * Data shapes:
 *
 * DiscountRule {
 *   ruleId:       string       — e.g. "RULE-01"
 *   scope:        "brand" | "platform" | "cart"
 *   appliesTo:    string       — e.g. "Natura Casa", "Amazon India" ("" for cart rules)
 *   type:         "percentage" | "flat"   (cart rules are always "percentage")
 *   value:        number       — percentage as integer (15 = 15%), flat in rupees
 *   stackable:    boolean
 *   minCartValue: number | null — cart rules only: the subtotal must be >= this
 * }
 *
 * CartItem {
 *   itemId:    string       — e.g. "ITEM-01"
 *   product:   string
 *   brand:     string
 *   platform:  string
 *   basePrice: number       — in rupees
 * }
 *
 * DiscountResult {
 *   itemId:        string
 *   product:       string
 *   brand:         string
 *   platform:      string
 *   basePrice:     number
 *   finalPrice:    number
 *   totalDiscount: number
 *   appliedRules:  string[]
 *   skippedRules:  string[]
 *   reasoning:     string   — customer-readable explanation
 * }
 *
 * CartOffer {
 *   ruleId:       string
 *   type:         "percentage"
 *   value:        number   — the percentage (10 = 10%)
 *   minCartValue: number
 *   amount:       number   — rupees actually saved
 *   label:        string   — customer-readable, e.g. "Cart offer: 10% off — Rs.593 saved"
 * }
 *
 * PricedCart {
 *   items:        DiscountResult[]
 *   subtotal:     number   — sum of item final prices, before cart offers
 *   cartOffers:   CartOffer[]  — empty when no cart rule qualifies
 *   cartDiscount: number   — total saved by cart offers
 *   finalTotal:   number   — subtotal - cartDiscount, never below 0
 * }
 */

/**
 * Returns true if the rule applies to this cart item.
 */
export function ruleMatchesItem(item, rule) {
  const normalise = (s) => s.trim().toLowerCase()
  if (rule.scope === 'brand') {
    return normalise(item.brand) === normalise(rule.appliesTo)
  }
  if (rule.scope === 'platform') {
    return normalise(item.platform) === normalise(rule.appliesTo)
  }
  return false
}

/**
 * Calculates the rupee discount a rule gives on a given price.
 * Uses the provided price, not the original base price — important for stacking.
 */
export function calculateDiscountAmount(price, rule) {
  if (rule.type === 'percentage') {
    return Math.round(price * rule.value / 100)
  }
  if (rule.type === 'flat') {
    return rule.value
  }
  return 0
}

/**
 * Builds the customer-facing reasoning string for an applied rule.
 */
function ruleToReasoning(rule) {
  const scopeLabel = rule.scope === 'brand' ? 'Brand' : 'Platform'
  if (rule.type === 'percentage') {
    return `${scopeLabel} offer: ${rule.value}% off`
  }
  if (rule.type === 'flat') {
    return `${scopeLabel} offer: Rs.${rule.value} off`
  }
  return `${scopeLabel} offer applied`
}

/**
 * Applies the active discount rules to a single cart item.
 * Returns a DiscountResult.
 *
 * Logic:
 *   1. Find all rules that match this item.
 *   2. Among non-stackable rules, pick the one giving the largest discount.
 *   3. Apply any stackable rules on top of that price.
 *   4. Build the reasoning string from what was applied.
 */
export function applyDiscounts(item, rules) {
  const matchingRules = rules.filter((r) => ruleMatchesItem(item, r))

  // No rules match — return base price with explanation
  if (matchingRules.length === 0) {
    return {
      itemId: item.itemId,
      product: item.product,
      brand: item.brand,
      platform: item.platform,
      basePrice: item.basePrice,
      finalPrice: item.basePrice,
      totalDiscount: 0,
      appliedRules: [],
      skippedRules: [],
      reasoning: 'No offers available',
    }
  }

  const nonStackable = matchingRules.filter((r) => !r.stackable)
  const stackable = matchingRules.filter((r) => r.stackable)

  // Pick the non-stackable rule that gives the largest saving
  let winner = null
  let skipped = []

  if (nonStackable.length > 0) {
    const sorted = [...nonStackable].sort(
      (a, b) =>
        calculateDiscountAmount(item.basePrice, b) -
        calculateDiscountAmount(item.basePrice, a)
    )
    winner = sorted[0]
    skipped = sorted.slice(1)
  }

  // Apply winner first, then stack on top
  let price = item.basePrice
  const appliedRules = []
  const reasoningParts = []

  // Math.max(0, …) stops a large flat discount from making the price negative
  if (winner) {
    price = Math.max(0, price - calculateDiscountAmount(price, winner))
    appliedRules.push(winner.ruleId)
    reasoningParts.push(ruleToReasoning(winner))
  }

  for (const rule of stackable) {
    price = Math.max(0, price - calculateDiscountAmount(price, rule))
    appliedRules.push(rule.ruleId)
    reasoningParts.push(ruleToReasoning(rule))
  }

  const finalPrice = Math.round(price)

  return {
    itemId: item.itemId,
    product: item.product,
    brand: item.brand,
    platform: item.platform,
    basePrice: item.basePrice,
    finalPrice,
    totalDiscount: item.basePrice - finalPrice,
    appliedRules,
    skippedRules: skipped.map((r) => r.ruleId),
    reasoning: reasoningParts.join(' + '),
  }
}

/**
 * Runs applyDiscounts across every item in the cart.
 * Returns an array of DiscountResult objects.
 */
export function processCart(cartItems, rules) {
  return cartItems.map((item) => applyDiscounts(item, rules))
}

/**
 * Sums the final prices across all results.
 */
export function cartTotal(results) {
  return results.reduce((sum, r) => sum + r.finalPrice, 0)
}

/**
 * Applies cart-level rules to the item subtotal.
 * Returns { cartOffers, cartDiscount, finalTotal }.
 *
 * Logic (same principles as item-level rules):
 *   1. A rule is eligible when subtotal >= rule.minCartValue. Every threshold
 *      is checked against the subtotal BEFORE any cart discount.
 *   2. Among eligible non-stackable rules, pick the one giving the largest
 *      saving. On a tie the earlier rule wins (sort is stable).
 *   3. Apply eligible stackable rules on top, in the order they were given.
 *      They still apply when no non-stackable rule is eligible.
 *   4. A saving never exceeds what is left, so the total never goes below 0.
 */
export function applyCartRules(subtotal, cartRules) {
  const eligible = cartRules.filter((r) => subtotal >= r.minCartValue)
  const nonStackable = eligible.filter((r) => !r.stackable)
  const stackable = eligible.filter((r) => r.stackable)

  const winner = [...nonStackable].sort(
    (a, b) => calculateDiscountAmount(subtotal, b) - calculateDiscountAmount(subtotal, a)
  )[0]
  const rulesToApply = winner ? [winner, ...stackable] : stackable

  let total = subtotal
  const cartOffers = []

  for (const rule of rulesToApply) {
    const amount = Math.min(calculateDiscountAmount(total, rule), total)
    if (amount <= 0) continue // don't show a "Rs.0 saved" line
    total -= amount
    cartOffers.push({
      ruleId: rule.ruleId,
      type: rule.type,
      value: rule.value,
      minCartValue: rule.minCartValue,
      amount,
      label: `Cart offer: ${rule.value}% off — Rs.${amount.toLocaleString('en-IN')} saved`,
    })
  }

  return { cartOffers, cartDiscount: subtotal - total, finalTotal: total }
}

/**
 * Prices a whole cart: item-level rules first, then cart-level rules.
 * This is the one function the UI calls. Returns a PricedCart.
 */
export function priceCart(cartItems, rules) {
  const itemRules = rules.filter((r) => r.scope !== 'cart')
  const cartRules = rules.filter((r) => r.scope === 'cart')

  const items = processCart(cartItems, itemRules)
  const subtotal = cartTotal(items)

  return { items, subtotal, ...applyCartRules(subtotal, cartRules) }
}
