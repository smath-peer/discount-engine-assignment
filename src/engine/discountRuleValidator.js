/**
 * discountRuleValidator.js
 *
 * The single place that decides whether a discount rule is allowed.
 * It checks an already-typed rule candidate (numbers are numbers, booleans
 * are booleans) and returns a clean DiscountRule without a ruleId.
 *
 * It does not read CSV text, call the network, touch the UI or price
 * anything. Each input source (CSV parser, natural-language interpreter)
 * converts its own input into typed fields first, then calls validateRule.
 *
 * The caller adds the ruleId: the CSV parser takes it from the file, and
 * the rule assistant assigns one when the user confirms the rule.
 *
 * Input fields read (anything else is ignored and dropped):
 *   scope:        "brand" | "platform" | "cart"
 *   appliesTo:    string — required for brand/platform; ignored for cart
 *   type:         "percentage" | "flat"  (cart rules: "percentage" only)
 *   value:        number > 0 (at most 100 for a percentage)
 *   stackable:    boolean
 *   minCartValue: number >= 0 for cart rules; null or absent otherwise
 *
 * Output: { rule, errors }
 *   rule:   { scope, appliesTo, type, value, stackable, minCartValue } or null
 *   errors: [{ field, message, unsupported? }] — empty when the rule is valid.
 *           unsupported: true marks a request the engine cannot represent
 *           (for example a flat cart discount), as opposed to a mistake.
 */

export const RULE_SCOPES = Object.freeze(['brand', 'platform', 'cart'])
export const RULE_TYPES = Object.freeze(['percentage', 'flat'])
export const MAX_PERCENTAGE = 100

/**
 * Validates a typed rule candidate.
 * Collects every problem it can find, in a fixed order, so callers can
 * either show the first error (CSV) or list all of them (rule assistant).
 */
export function validateRule(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { rule: null, errors: [{ field: 'rule', message: 'rule must be an object with the rule fields' }] }
  }

  const { scope, appliesTo, type, value, stackable, minCartValue } = candidate
  const errors = []
  const fail = (field, message, extra = {}) => errors.push({ field, message, ...extra })

  const scopeIsValid = RULE_SCOPES.includes(scope)
  const typeIsValid = RULE_TYPES.includes(type)
  const isCart = scope === 'cart'

  if (!scopeIsValid) {
    fail('scope', `scope must be "brand", "platform" or "cart", got ${show(scope)}`)
  }

  // A cart rule covers the whole cart, so any appliesTo text is ignored.
  // A brand/platform rule must name what it applies to.
  let cleanAppliesTo = ''
  if (scopeIsValid && !isCart) {
    if (typeof appliesTo !== 'string' || appliesTo.trim() === '') {
      fail('appliesTo', `applies_to is required for ${scope} rules (the ${scope} name)`)
    } else {
      cleanAppliesTo = appliesTo.trim()
    }
  }

  if (!typeIsValid) {
    fail('type', `type must be "percentage" or "flat", got ${show(type)}`)
  }

  const valueIsPositive = typeof value === 'number' && Number.isFinite(value) && value > 0
  if (!valueIsPositive) {
    fail('value', `value must be a positive number such as 10 or 10.5, got ${show(value)}`)
  } else if (type === 'percentage' && value > MAX_PERCENTAGE) {
    fail('value', `a percentage cannot be more than ${MAX_PERCENTAGE}, got ${show(value)}`)
  }

  if (typeof stackable !== 'boolean') {
    fail('stackable', `stackable must be true or false, got ${show(stackable)}`)
  }

  let cleanMinCartValue = null
  if (isCart) {
    if (type === 'flat') {
      fail('type', 'cart rules must be "percentage", got "flat"', { unsupported: true })
    }
    if (minCartValue === null || minCartValue === undefined) {
      fail('minCartValue', 'cart rules need a min_cart_value (e.g. 4000)')
    } else if (typeof minCartValue !== 'number' || !Number.isFinite(minCartValue) || minCartValue < 0) {
      fail('minCartValue', `min_cart_value must be a number of 0 or more, got ${show(minCartValue)}`)
    } else {
      cleanMinCartValue = minCartValue
    }
  } else if (scopeIsValid && minCartValue !== null && minCartValue !== undefined) {
    fail('minCartValue', `min_cart_value only applies to cart rules, but this is a ${scope} rule`)
  }

  if (errors.length > 0) return { rule: null, errors }

  // Built field by field, so unknown input fields never reach the engine
  return {
    rule: {
      scope,
      appliesTo: cleanAppliesTo,
      type,
      value,
      stackable,
      minCartValue: cleanMinCartValue,
    },
    errors: [],
  }
}

/**
 * Formats a received value for an error message.
 * Strings are quoted; long text is cut short so messages stay readable.
 */
function show(received) {
  if (received === undefined) return 'nothing'
  let text
  if (typeof received === 'string') text = `"${received}"`
  else if (typeof received === 'number' || typeof received === 'boolean' || received === null) text = String(received)
  else {
    try {
      text = JSON.stringify(received) ?? String(received)
    } catch {
      text = String(received)
    }
  }
  return text.length > 40 ? `${text.slice(0, 37)}...` : text
}
