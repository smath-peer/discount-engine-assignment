/**
 * groundRule.js (server only)
 *
 * Checks that the rule the model returned says what the user's sentence
 * says, field by field. A rule can be valid JSON with grounded numbers and
 * still be wrong: a brand the sentence never named, a minimum read as the
 * discount, a percentage read as rupees. Anything that does not match the
 * wording is sent back for clarification instead of being shown for review.
 *
 * Checks, in order:
 *   1. Brand or platform: the name must be written in the sentence (case,
 *      spaces and punctuation ignored).
 *   2. Scope: "brand" or "platform" in the sentence must match the scope; a
 *      whole-cart offer needs whole-cart wording (cart, order, total, …).
 *   3. Type and amount: a percentage must be written with % or "percent"; a
 *      flat amount with Rs, ₹, INR, rupees or "flat", and not as a minimum.
 *   4. Minimum cart value: it must be written as a minimum ("above",
 *      "at least", "or more", …). A minimum in the sentence that the rule
 *      leaves out is never dropped silently.
 *   5. One offer: no other discount amount may be left unused.
 *
 * It is deliberately conservative: unusual wording may be asked about even
 * when the model was right, and the user can always edit the rule or enter
 * it manually. It runs after the number check (every number came from the
 * sentence) and before the shared validator (is the rule allowed at all).
 *
 * Returns null when the rule matches the sentence, otherwise
 *   { kind: 'clarify', fields, message } or { kind: 'cart_condition' }.
 */

export const GROUNDING_MESSAGES = Object.freeze({
  name:
    'Please write the brand or platform name exactly as it appears in the cart, for example "Natura Casa" or "Amazon India".',
  scope: 'Please say whether the offer is for a brand, a platform or the whole cart.',
  type: 'Please write the discount as a percentage (for example 10%) or a rupee amount (for example Rs.100).',
  minimum: 'Please write the minimum cart value after a word such as "above" or "at least", for example "above Rs.5,000".',
  oneOffer: 'Please describe one offer at a time, with one discount amount.',
})

const CART_WORDING = /\b(?:cart|carts|order|orders|basket|bill|total|purchase|purchases|spend\w*|everything|entire|whole)\b/
const BRAND_WORD = /\bbrands?\b/
const PLATFORM_WORD = /\bplatforms?\b/

/** Letters and digits only, lower case: "Natura  Casa," and "natura-casa" both become "naturacasa". */
const squash = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Every number in the sentence with the words just before and after it. */
function mentionsOf(sentence) {
  const mentions = []
  for (const match of sentence.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = Number(match[0].replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const end = match.index + match[0].length
    mentions.push({
      value,
      before: sentence.slice(Math.max(0, match.index - 40), match.index).toLowerCase(),
      after: sentence.slice(end, end + 25).toLowerCase(),
    })
  }
  return mentions
}

const isPercent = (m) => /^\s*(?:%|per\s?cent\b|percentage\b)/.test(m.after)
const isRupees = (m) =>
  /(?:\brs\.?|₹|\binr|\brupees?|\bflat)\s*$/.test(m.before) || /^\s*(?:\/-|rupees?\b|rs\b|inr\b)/.test(m.after)
const isMinimum = (m) =>
  /\b(?:above|over|more than|greater than|at least|minimum(?: of)?|min\.?|exceeds?|exceeding|spend(?:s|ing)?(?: over| above)?|worth)\s*(?:rs\.?|₹|inr|rupees)?\s*$/.test(m.before) ||
  /^\s*(?:rs\.?|rupees)?\s*(?:or more|or above|and above|\+)/.test(m.after)

/** A number written as a discount amount (a percentage, or rupees that are not a minimum). */
const isDiscountAmount = (m) => isPercent(m) || (isRupees(m) && !isMinimum(m))

export function groundRule(rule, sentence) {
  const text = sentence.normalize('NFKC').toLowerCase()
  const clarify = (fields, message) => ({ kind: 'clarify', fields, message })

  // 1. The brand or platform must be one the sentence names
  if (rule.scope === 'brand' || rule.scope === 'platform') {
    const name = squash(rule.appliesTo ?? '')
    if (name === '' || !squash(sentence).includes(name)) return clarify(['appliesTo'], GROUNDING_MESSAGES.name)
  }

  // 2. The scope must match the wording
  const saysBrand = BRAND_WORD.test(text)
  const saysPlatform = PLATFORM_WORD.test(text)
  if (saysBrand && saysPlatform) return clarify(['scope'], GROUNDING_MESSAGES.scope)
  if ((saysBrand && rule.scope !== 'brand') || (saysPlatform && rule.scope !== 'platform')) {
    return clarify(['scope'], GROUNDING_MESSAGES.scope)
  }
  if (rule.scope === 'cart') {
    if (!CART_WORDING.test(text)) return clarify(['scope'], GROUNDING_MESSAGES.scope)
    // A whole-cart rule must not quietly drop a brand or platform the sentence names
    const named = squash(rule.appliesTo ?? '')
    if (named !== '' && squash(sentence).includes(named)) return clarify(['scope'], GROUNDING_MESSAGES.scope)
  }

  // 3. The amount must be written as the type the rule says
  const mentions = mentionsOf(sentence)
  const amount = mentions.find(
    (m) => m.value === rule.value && (rule.type === 'percentage' ? isPercent(m) : isRupees(m) && !isMinimum(m)),
  )
  if (!amount) return clarify(['type', 'value'], GROUNDING_MESSAGES.type)

  // 4. The minimum must be written as a minimum, and never be dropped
  const minimums = mentions.filter((m) => isMinimum(m) && !isPercent(m))
  let minimum = null
  if (rule.minCartValue !== null && rule.minCartValue !== undefined) {
    minimum = minimums.find((m) => m.value === rule.minCartValue && m !== amount)
    if (!minimum) return clarify(['minCartValue'], GROUNDING_MESSAGES.minimum)
  } else if (minimums.length > 0) {
    // The sentence sets a minimum the rule leaves out
    return rule.scope === 'cart' ? clarify(['minCartValue'], GROUNDING_MESSAGES.minimum) : { kind: 'cart_condition' }
  }

  // 5. One offer at a time: no other discount amount is left unused
  if (mentions.some((m) => m !== amount && m !== minimum && isDiscountAmount(m))) {
    return clarify([], GROUNDING_MESSAGES.oneOffer)
  }

  return null
}
