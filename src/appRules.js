/**
 * appRules.js
 *
 * Plain functions App.jsx uses to keep its two rule lists consistent:
 *   - csvRules:       the rules from the latest rules.csv upload
 *   - confirmedRules: rules the user added in plain language and confirmed
 *
 * activeRules = [...csvRules, ...confirmedRules]. CSV rules come first, so on
 * a tie the CSV rule wins (the engine prefers the earlier rule), exactly as
 * the rule preview assumed.
 *
 * Kept free of React so the rules can be tested directly.
 */

import { validateRule, ruleTermsKey } from './engine/discountRuleValidator.js'
import { priceCart } from './engine/discountEngine.js'
import { nextRuleId } from './components/ruleInputState.js'

const idKey = (id) => (typeof id === 'string' ? id.trim().toUpperCase() : '')

/** The rules the engine uses: CSV rules first, then confirmed rules, in the order they were added. */
export function combineRules(csvRules, confirmedRules) {
  return [...csvRules, ...confirmedRules]
}

/** True when there is at least one rule and one cart item to price. */
export function canCalculate(activeRules, cartItems) {
  return activeRules.length > 0 && cartItems.length > 0
}

/**
 * Results are derived, never stored: they exist only after the first
 * "Calculate Discounts" click, and only while there is something to price.
 * Every change to the rules or the cart therefore re-prices automatically,
 * and results can never be stale.
 */
export function computeResults({ hasCalculated, activeRules, cartItems }) {
  if (!hasCalculated || !canCalculate(activeRules, cartItems)) return null
  return priceCart(cartItems, activeRules)
}

/**
 * Adds a confirmed rule to the confirmed list.
 * The rule is validated again; if its ID is missing or already used by any
 * CSV or confirmed rule, it gets the next free NL- ID instead, so an existing
 * rule is never replaced. Returns { confirmedRules, rule } or { error }.
 */
export function addConfirmedRule(csvRules, confirmedRules, candidate) {
  const { rule, errors } = validateRule(candidate)
  if (!rule) return { error: errors[0]?.message ?? 'invalid rule' }
  // The same offer twice would give the discount twice
  const duplicate = findDuplicateOffer([...csvRules, ...confirmedRules], rule)
  if (duplicate) return { error: duplicateOfferMessage(duplicate), duplicateOf: duplicate.ruleId }

  const usedIds = [...csvRules, ...confirmedRules].map((r) => r.ruleId)
  const taken = new Set(usedIds.map(idKey))
  const requested = candidate?.ruleId
  const ruleId = idKey(requested) !== '' && !taken.has(idKey(requested)) ? requested.trim() : nextRuleId(usedIds)

  const added = { ruleId, ...rule }
  return { confirmedRules: [...confirmedRules, added], rule: added }
}

/**
 * Applied to a new rules.csv upload: any row whose rule_id is already used by
 * a confirmed plain-language rule is skipped with a clear message, so the
 * two lists never share an ID and the confirmed rule is not renamed.
 */
export function withoutConfirmedIdClashes(uploadedRules, confirmedRules) {
  const confirmedIds = new Set(confirmedRules.map((r) => idKey(r.ruleId)))
  const rules = []
  const errors = []
  for (const rule of uploadedRules) {
    if (confirmedIds.has(idKey(rule.ruleId))) {
      errors.push(`rule_id "${rule.ruleId}" is already used by a rule added in plain language, so that row was skipped`)
    } else {
      rules.push(rule)
    }
  }
  return { rules, errors }
}

// ── Duplicate offers ──────────────────────────────────────────────

/**
 * The active rule that is the same offer as `candidate` (same scope, brand
 * or platform, type, value, stackable and minimum; see ruleTermsKey), or
 * null. The candidate is validated first, so it is compared exactly as it
 * would be added. Offers that differ in any of these terms are not duplicates.
 */
export function findDuplicateOffer(activeRules, candidate) {
  const { rule } = validateRule(candidate)
  if (!rule) return null
  const key = ruleTermsKey(rule)
  return activeRules.find((active) => ruleTermsKey(active) === key) ?? null
}

/** The message shown when an offer is already active. */
export function duplicateOfferMessage(duplicate) {
  return `This offer is already active as ${duplicate.ruleId}, so adding it again would apply the same discount twice.`
}

// ── Removing a plain-language offer ───────────────────────────────

/**
 * Removes one confirmed offer by ID. Returns { confirmedRules, removed }
 * where removed is { rule, index } (for Undo), or null if there is no such offer.
 */
export function removeConfirmedRule(confirmedRules, ruleId) {
  const index = confirmedRules.findIndex((rule) => rule.ruleId === ruleId)
  if (index < 0) return null
  return {
    confirmedRules: [...confirmedRules.slice(0, index), ...confirmedRules.slice(index + 1)],
    removed: { rule: confirmedRules[index], index },
  }
}

/**
 * Puts a removed offer back where it was. Returns the new confirmed list, or
 * null if it can no longer go back safely: its ID or its terms are now used
 * by another active rule. (App also withdraws Undo whenever the rules change.)
 */
export function restoreConfirmedRule(csvRules, confirmedRules, removed) {
  const active = [...csvRules, ...confirmedRules]
  if (active.some((rule) => idKey(rule.ruleId) === idKey(removed.rule.ruleId))) return null
  if (findDuplicateOffer(active, removed.rule)) return null
  const index = Math.min(removed.index, confirmedRules.length)
  return [...confirmedRules.slice(0, index), removed.rule, ...confirmedRules.slice(index)]
}
