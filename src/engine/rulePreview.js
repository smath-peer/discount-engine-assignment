/**
 * rulePreview.js
 *
 * Shows what a proposed discount rule would do to the current cart,
 * before the user confirms it. Pure calculation: no state, no side effects.
 *
 * It prices the cart twice with the existing engine (priceCart) — once with
 * the active rules, once with the active rules plus the candidate — and
 * compares the two results. It never calculates a discount itself.
 *
 * The candidate is placed LAST, which is exactly where a confirmed rule goes
 * (activeRules = [...csvRules, ...confirmedRules]). That matters because the
 * engine breaks ties in favour of the earlier rule and applies stackable rules
 * in list order, so the preview always matches what confirming would give.
 *
 * PreviewResult {
 *   currentTotal:     number   — final cart total with the active rules
 *   projectedTotal:   number   — final cart total if the candidate were added
 *   additionalSaving: number   — currentTotal - projectedTotal (negative if the total would rise)
 *   outcome:          "saves" | "no_change" | "costs_more"
 *   reason:           "applies" | "empty_cart" | "no_matching_items" |
 *                     "below_threshold" | "existing_offer_better" | "no_effect" | "invalid_rule"
 *   explanation:      string   — customer-readable sentence(s)
 *   affectedItemIds:  string[] — items the candidate would be applied to
 *   betterRuleIds:    string[] — existing rules that beat the candidate (existing_offer_better)
 *   lostCartOfferIds: string[] — cart offers that would stop applying with the candidate
 * }
 *
 * The preview-only rule ID never appears in the result.
 */

import { priceCart, ruleMatchesItem } from './discountEngine.js'
import { validateRule } from './discountRuleValidator.js'

const PREVIEW_ID_BASE = 'PREVIEW-CANDIDATE'

/**
 * Previews the effect of adding `candidateRule` to `activeRules` for `cartItems`.
 * None of the inputs are changed.
 */
export function previewRule(cartItems, activeRules, candidateRule) {
  const current = priceCart(cartItems, activeRules)
  const base = {
    currentTotal: current.finalTotal,
    projectedTotal: current.finalTotal,
    additionalSaving: 0,
    outcome: 'no_change',
    affectedItemIds: [],
    betterRuleIds: [],
    lostCartOfferIds: [],
  }

  // The candidate is validated again, and the validator's clean copy is used,
  // so the caller's object is never touched and stray fields never reach the engine.
  const { rule, errors } = validateRule(candidateRule)
  if (!rule) {
    return { ...base, reason: 'invalid_rule', explanation: `This rule can't be previewed: ${errors[0].message}.` }
  }

  if (cartItems.length === 0) {
    return { ...base, reason: 'empty_cart', explanation: 'Load a cart to see the effect of this offer.' }
  }

  // A temporary copy with an ID no active rule uses, in a new list.
  const previewId = uniquePreviewId(activeRules)
  const temporaryRules = [...activeRules, { ...rule, ruleId: previewId }]
  const projected = priceCart(cartItems, temporaryRules)

  const additionalSaving = current.finalTotal - projected.finalTotal
  const affectedItemIds = projected.items
    .filter((item) => item.appliedRules.includes(previewId))
    .map((item) => item.itemId)
  const candidateIsUsed =
    affectedItemIds.length > 0 || projected.cartOffers.some((offer) => offer.ruleId === previewId)

  // Cart offers that apply today but not with the candidate, split by cause:
  // lost  = the lower subtotal no longer reaches the offer's minimum
  // replaced = still reachable, but the candidate (a bigger cart offer) won instead
  const projectedOfferIds = new Set(projected.cartOffers.map((offer) => offer.ruleId))
  const droppedOffers = current.cartOffers.filter((offer) => !projectedOfferIds.has(offer.ruleId))
  const lostCartOfferIds = droppedOffers.filter((o) => projected.subtotal < o.minCartValue).map((o) => o.ruleId)
  const replacedCartOfferIds = droppedOffers.filter((o) => projected.subtotal >= o.minCartValue).map((o) => o.ruleId)

  const result = {
    ...base,
    projectedTotal: projected.finalTotal,
    additionalSaving,
    outcome: additionalSaving > 0 ? 'saves' : additionalSaving < 0 ? 'costs_more' : 'no_change',
    affectedItemIds,
    lostCartOfferIds,
  }

  if (candidateIsUsed) {
    const explanation = explainApplied(current, projected, result, rule, replacedCartOfferIds)
    return { ...result, reason: 'applies', explanation }
  }

  // The candidate was not used anywhere: work out why.
  if (rule.scope === 'cart') {
    if (projected.subtotal < rule.minCartValue) {
      return {
        ...result,
        reason: 'below_threshold',
        explanation:
          `The cart total before cart offers is ${rupees(projected.subtotal)}, below this offer's minimum of ` +
          `${rupees(rule.minCartValue)}, so it would not apply yet.`,
      }
    }
    // Eligible but not used: another non-stackable cart offer won.
    const betterRuleIds = projected.cartOffers.filter((offer) => offer.ruleId !== previewId).map((o) => o.ruleId)
    if (betterRuleIds.length > 0) return existingOfferBetter(result, betterRuleIds.slice(0, 1))
  } else {
    const matchingItems = cartItems.filter((item) => ruleMatchesItem(item, rule))
    if (matchingItems.length === 0) {
      const where = rule.scope === 'brand' ? `from the brand "${rule.appliesTo}"` : `sold on "${rule.appliesTo}"`
      return {
        ...result,
        reason: 'no_matching_items',
        explanation: `No item in the current cart is ${where}, so this offer would not change the total.`,
      }
    }
    // Matching items exist, but on each one another non-stackable rule won.
    const matchingIds = new Set(matchingItems.map((item) => item.itemId))
    const betterRuleIds = unique(
      projected.items
        .filter((item) => matchingIds.has(item.itemId) && item.skippedRules.includes(previewId))
        .map((item) => item.appliedRules[0])
    )
    if (betterRuleIds.length > 0) return existingOfferBetter(result, betterRuleIds)
  }

  return { ...result, reason: 'no_effect', explanation: 'This offer would not change any price in the current cart.' }
}

/** Explanation when the candidate is applied somewhere. */
function explainApplied(current, projected, result, rule, replacedCartOfferIds) {
  const { currentTotal, projectedTotal, additionalSaving, lostCartOfferIds } = result
  const itemDrop = current.subtotal - projected.subtotal
  const cartOfferDrop = current.cartDiscount - projected.cartDiscount
  const lostText = lostCartOfferIds.length > 0
    ? `the item prices drop by ${rupees(itemDrop)}, which takes the cart below the minimum for ` +
      `${list(lostCartOfferIds)}, so ${lostCartOfferIds.length === 1 ? 'that cart offer no longer applies' : 'those cart offers no longer apply'}`
    : null

  if (additionalSaving < 0) {
    return (
      `Careful: the total would rise from ${rupees(currentTotal)} to ${rupees(projectedTotal)}. ` +
      (lostText ? `This is because ${lostText}.` : 'Cart offers are worked out on the lower subtotal and shrink by more than this offer saves.')
    )
  }
  if (additionalSaving === 0) {
    return `This offer would apply, but the total stays at ${rupees(currentTotal)}.`
  }

  let text = `Total ${rupees(currentTotal)} → ${rupees(projectedTotal)} (you save ${rupees(additionalSaving)} more).`
  if (replacedCartOfferIds.length > 0) {
    text += ` It replaces ${list(replacedCartOfferIds)}, which gave a smaller saving.`
  }
  if (lostText) {
    text += ` Note: ${lostText}.`
  } else if (rule.scope !== 'cart' && itemDrop > 0 && cartOfferDrop > 0) {
    text +=
      ` Item prices drop by ${rupees(itemDrop)}; the cart offer is worked out on the lower subtotal,` +
      ` so it shrinks by ${rupees(cartOfferDrop)}.`
  }
  return text
}

function existingOfferBetter(result, betterRuleIds) {
  const verb = betterRuleIds.length === 1 ? 'gives' : 'give'
  return {
    ...result,
    reason: 'existing_offer_better',
    betterRuleIds,
    explanation:
      `No change: ${list(betterRuleIds)} already ${verb} an equal or larger saving, so this offer would not be used.`,
  }
}

/** Returns an ID that no active rule uses: PREVIEW-CANDIDATE, then PREVIEW-CANDIDATE-2, -3… */
function uniquePreviewId(activeRules) {
  const taken = new Set(activeRules.map((r) => r.ruleId))
  let id = PREVIEW_ID_BASE
  for (let n = 2; taken.has(id); n++) id = `${PREVIEW_ID_BASE}-${n}`
  return id
}

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`
const unique = (values) => [...new Set(values)]
const list = (ids) => (ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`)
