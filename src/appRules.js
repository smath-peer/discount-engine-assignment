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

import { validateRule } from './engine/discountRuleValidator.js'
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
