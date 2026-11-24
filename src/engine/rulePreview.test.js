/**
 * Tests for rulePreview.js — run with `npm test` (Node's built-in test runner).
 * Uses the real sample-data files and the real engine; nothing is mocked.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { previewRule } from './rulePreview.js'
import { priceCart } from './discountEngine.js'
import { parseRulesCSV, parseCartCSV } from './csvParser.js'

const readSample = (name) => readFileSync(new URL(`../../sample-data/${name}`, import.meta.url), 'utf8')
const SAMPLE_RULES = parseRulesCSV(readSample('rules.csv')).data
const SAMPLE_CART = parseCartCSV(readSample('cart.csv')).data

/** A candidate as the validator returns it (no ruleId). */
const candidate = (fields) => ({ appliesTo: '', stackable: false, minCartValue: null, ...fields })

// The three examples from the assignment brief
const EXAMPLE_1 = candidate({ scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true })
const EXAMPLE_2 = candidate({ scope: 'platform', appliesTo: 'Flipkart', type: 'flat', value: 100 })
const EXAMPLE_3 = candidate({ scope: 'cart', type: 'percentage', value: 10, minCartValue: 5000 })

/** Freezes an object and everything inside it, so any write throws. */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

/** Fresh deep copies of the sample data, so tests can't affect each other. */
const freshRules = () => structuredClone(SAMPLE_RULES)
const freshCart = () => structuredClone(SAMPLE_CART)

describe('sanity: the sample files load as expected', () => {
  test('4 rules, 6 items, current total Rs.5,339', () => {
    assert.deepEqual(SAMPLE_RULES.map((r) => r.ruleId), ['RULE-01', 'RULE-02', 'RULE-03', 'RULE-04'])
    assert.equal(SAMPLE_CART.length, 6)
    assert.equal(priceCart(SAMPLE_CART, SAMPLE_RULES).finalTotal, 5339)
  })
})

describe('previewRule: the three examples from the brief', () => {
  test('Example 1: 20% off Natura Casa, stackable → Rs.5,026, saves Rs.313', () => {
    const preview = previewRule(freshCart(), freshRules(), EXAMPLE_1)
    assert.equal(preview.currentTotal, 5339)
    assert.equal(preview.projectedTotal, 5026)
    assert.equal(preview.additionalSaving, 313)
    assert.equal(preview.outcome, 'saves')
    assert.equal(preview.reason, 'applies')
    assert.deepEqual(preview.affectedItemIds, ['ITEM-01', 'ITEM-02'])
    assert.equal(
      preview.explanation,
      'Total Rs.5,339 → Rs.5,026 (you save Rs.313 more). Item prices drop by Rs.347; ' +
        'the cart offer is worked out on the lower subtotal, so it shrinks by Rs.34.',
    )
  })

  test('Example 2: Rs.100 off Flipkart, not stackable → Rs.5,258, saves Rs.81', () => {
    const preview = previewRule(freshCart(), freshRules(), EXAMPLE_2)
    assert.equal(preview.currentTotal, 5339)
    assert.equal(preview.projectedTotal, 5258)
    assert.equal(preview.additionalSaving, 81)
    assert.equal(preview.outcome, 'saves')
    // ITEM-02 keeps RULE-02 (Rs.150 beats Rs.100); only ITEM-06 uses the new offer
    assert.deepEqual(preview.affectedItemIds, ['ITEM-06'])
    assert.match(preview.explanation, /Item prices drop by Rs\.90; .* shrinks by Rs\.9\./)
  })

  test('Example 3: 10% cart offer from Rs.5,000 → no change, RULE-04 already gives as much', () => {
    const preview = previewRule(freshCart(), freshRules(), EXAMPLE_3)
    assert.equal(preview.currentTotal, 5339)
    assert.equal(preview.projectedTotal, 5339)
    assert.equal(preview.additionalSaving, 0)
    assert.equal(preview.outcome, 'no_change')
    assert.equal(preview.reason, 'existing_offer_better')
    assert.deepEqual(preview.betterRuleIds, ['RULE-04'])
    assert.equal(
      preview.explanation,
      'No change: RULE-04 already gives an equal or larger saving, so this offer would not be used.',
    )
  })
})

describe('previewRule: offers that do not qualify say why', () => {
  test('a cart offer whose minimum is not met', () => {
    const preview = previewRule(freshCart(), freshRules(), candidate({ scope: 'cart', type: 'percentage', value: 15, minCartValue: 10000 }))
    assert.equal(preview.reason, 'below_threshold')
    assert.equal(preview.projectedTotal, 5339)
    assert.equal(
      preview.explanation,
      "The cart total before cart offers is Rs.5,932, below this offer's minimum of Rs.10,000, so it would not apply yet.",
    )
  })

  test('a cart offer exactly at its minimum does apply (>=, as in the engine)', () => {
    const preview = previewRule(freshCart(), freshRules(), candidate({ scope: 'cart', type: 'percentage', value: 15, minCartValue: 5932 }))
    assert.equal(preview.reason, 'applies')
    assert.equal(preview.projectedTotal, 5932 - 890)
  })

  test('a brand that is not in the cart', () => {
    const preview = previewRule(freshCart(), freshRules(), candidate({ scope: 'brand', appliesTo: 'Natura Kasa', type: 'percentage', value: 20 }))
    assert.equal(preview.reason, 'no_matching_items')
    assert.equal(preview.additionalSaving, 0)
    assert.equal(
      preview.explanation,
      'No item in the current cart is from the brand "Natura Kasa", so this offer would not change the total.',
    )
  })

  test('a platform that is not in the cart', () => {
    const preview = previewRule(freshCart(), freshRules(), candidate({ scope: 'platform', appliesTo: 'Myntra', type: 'flat', value: 50 }))
    assert.equal(preview.reason, 'no_matching_items')
    assert.match(preview.explanation, /^No item in the current cart is sold on "Myntra"/)
  })

  test('brand matching ignores case and spaces, like the engine', () => {
    const preview = previewRule(freshCart(), freshRules(), { ...EXAMPLE_1, appliesTo: '  natura casa ' })
    assert.equal(preview.projectedTotal, 5026)
  })
})

describe('previewRule: rule order and tie-breaking', () => {
  test('a tie with an existing rule goes to the existing rule (it comes first)', () => {
    // 15% off Amazon India, not stackable: the same saving as RULE-01 on every Amazon item
    const preview = previewRule(freshCart(), freshRules(), candidate({ scope: 'platform', appliesTo: 'Amazon India', type: 'percentage', value: 15 }))
    assert.equal(preview.reason, 'existing_offer_better')
    assert.deepEqual(preview.betterRuleIds, ['RULE-01'])
    assert.equal(preview.additionalSaving, 0)
  })

  test('the candidate goes last, so stackable offers apply after the existing ones', () => {
    // Order matters here: Rs.100 after RULE-03's 10% gives Rs.5,159; before it would give Rs.5,177
    const stackableFlat = { ...EXAMPLE_2, stackable: true }
    const preview = previewRule(freshCart(), freshRules(), stackableFlat)
    assert.equal(preview.projectedTotal, 5159)
    assert.equal(priceCart(SAMPLE_CART, [{ ...stackableFlat, ruleId: 'X' }, ...SAMPLE_RULES]).finalTotal, 5177)
  })

  test('the preview always equals what confirming the rule would give', () => {
    const candidates = [
      EXAMPLE_1, EXAMPLE_2, EXAMPLE_3,
      { ...EXAMPLE_2, stackable: true },
      candidate({ scope: 'cart', type: 'percentage', value: 15, minCartValue: 4000 }),
      candidate({ scope: 'cart', type: 'percentage', value: 5, stackable: true, minCartValue: 0 }),
      candidate({ scope: 'brand', appliesTo: 'Nordic Basics', type: 'flat', value: 1000 }),
    ]
    for (const c of candidates) {
      const confirmed = priceCart(SAMPLE_CART, [...SAMPLE_RULES, { ...c, ruleId: 'NL-1' }])
      assert.equal(previewRule(SAMPLE_CART, SAMPLE_RULES, c).projectedTotal, confirmed.finalTotal, JSON.stringify(c))
    }
  })

  test('a bigger cart offer replaces RULE-04 and says so', () => {
    const preview = previewRule(freshCart(), freshRules(), candidate({ scope: 'cart', type: 'percentage', value: 15, minCartValue: 4000 }))
    assert.equal(preview.projectedTotal, 5042)
    assert.equal(preview.additionalSaving, 297)
    assert.deepEqual(preview.lostCartOfferIds, [])
    assert.match(preview.explanation, /It replaces RULE-04, which gave a smaller saving\./)
  })
})

describe('previewRule: when a new offer would raise the total', () => {
  // ITEM-01, ITEM-02 and ITEM-04: Rs.4,232 before cart offers, just above RULE-04's Rs.4,000 minimum
  const smallCart = () => [SAMPLE_CART[0], SAMPLE_CART[1], SAMPLE_CART[3]].map((item) => ({ ...item }))

  test('an item discount that drops the cart below a cart-offer minimum is flagged', () => {
    const preview = previewRule(smallCart(), freshRules(), candidate({ scope: 'brand', appliesTo: 'LivSpace Pro', type: 'percentage', value: 10 }))
    assert.equal(preview.currentTotal, 3809)
    assert.equal(preview.projectedTotal, 3982)
    assert.equal(preview.additionalSaving, -173)
    assert.equal(preview.outcome, 'costs_more')
    assert.deepEqual(preview.lostCartOfferIds, ['RULE-04'])
    assert.equal(
      preview.explanation,
      'Careful: the total would rise from Rs.3,809 to Rs.3,982. This is because the item prices drop by Rs.250, ' +
        'which takes the cart below the minimum for RULE-04, so that cart offer no longer applies.',
    )
  })
})

describe('previewRule: edge cases', () => {
  test('an empty cart asks for a cart to be loaded', () => {
    const preview = previewRule([], freshRules(), EXAMPLE_1)
    assert.equal(preview.reason, 'empty_cart')
    assert.equal(preview.currentTotal, 0)
    assert.equal(preview.projectedTotal, 0)
    assert.equal(preview.explanation, 'Load a cart to see the effect of this offer.')
  })

  test('no active rules: the candidate is measured against the full prices', () => {
    const preview = previewRule(freshCart(), [], EXAMPLE_1)
    assert.equal(preview.currentTotal, 6594)
    assert.equal(preview.projectedTotal, 6164)
    assert.equal(preview.additionalSaving, 430)
  })

  test('no active rules and a cart offer that qualifies', () => {
    const preview = previewRule(freshCart(), [], EXAMPLE_3)
    assert.equal(preview.currentTotal, 6594)
    assert.equal(preview.projectedTotal, 6594 - 659)
    assert.equal(preview.reason, 'applies')
  })

  test('an invalid candidate is not priced, and the reason is given', () => {
    const preview = previewRule(freshCart(), freshRules(), { ...EXAMPLE_1, value: 200 })
    assert.equal(preview.reason, 'invalid_rule')
    assert.equal(preview.projectedTotal, preview.currentTotal)
    assert.match(preview.explanation, /cannot be more than 100/)
  })

  test('an offer that applies but changes nothing after rounding', () => {
    const cart = [{ itemId: 'I', product: 'P', brand: 'B', platform: 'Z', basePrice: 4 }]
    const preview = previewRule(cart, [], candidate({ scope: 'brand', appliesTo: 'B', type: 'percentage', value: 10 }))
    assert.equal(preview.reason, 'applies')
    assert.equal(preview.outcome, 'no_change')
    assert.equal(preview.explanation, 'This offer would apply, but the total stays at Rs.4.')
  })
})

describe('previewRule: no side effects', () => {
  test('frozen inputs are never written to', () => {
    const cart = deepFreeze(freshCart())
    const rules = deepFreeze(freshRules())
    const cand = deepFreeze({ ...EXAMPLE_1 })
    assert.doesNotThrow(() => previewRule(cart, rules, cand))
  })

  test('active rules, cart and candidate are unchanged afterwards', () => {
    const cart = freshCart()
    const rules = freshRules()
    const cand = { ...EXAMPLE_2 }
    const before = structuredClone({ cart, rules, cand })
    for (const c of [EXAMPLE_1, cand, EXAMPLE_3]) previewRule(cart, rules, c)
    assert.deepEqual({ cart, rules, cand }, before)
    assert.equal(rules.length, 4)
    assert.equal('ruleId' in cand, false)
  })

  test('the same inputs always give the same preview', () => {
    assert.deepEqual(previewRule(SAMPLE_CART, SAMPLE_RULES, EXAMPLE_2), previewRule(SAMPLE_CART, SAMPLE_RULES, EXAMPLE_2))
  })

  test('a ruleId on the candidate is ignored, not used', () => {
    const preview = previewRule(freshCart(), freshRules(), { ...EXAMPLE_1, ruleId: 'RULE-01' })
    assert.equal(preview.projectedTotal, 5026)
  })
})

describe('previewRule: the preview-only rule ID', () => {
  test('it never appears in the result', () => {
    for (const c of [EXAMPLE_1, EXAMPLE_2, EXAMPLE_3]) {
      assert.doesNotMatch(JSON.stringify(previewRule(SAMPLE_CART, SAMPLE_RULES, c)), /PREVIEW/)
    }
  })

  test('it does not collide with an existing rule that uses the same name', () => {
    // An existing rule called PREVIEW-CANDIDATE gives 15% on Amazon India
    const rules = [
      { ruleId: 'PREVIEW-CANDIDATE', scope: 'platform', appliesTo: 'Amazon India', type: 'percentage', value: 15, stackable: false, minCartValue: null },
      { ruleId: 'PREVIEW-CANDIDATE-2', scope: 'brand', appliesTo: 'Nordic Basics', type: 'flat', value: 10, stackable: false, minCartValue: null },
    ]
    // The candidate is not in the cart, so if its ID clashed with an applied rule it would wrongly count as "used"
    const preview = previewRule(freshCart(), rules, candidate({ scope: 'brand', appliesTo: 'Natura Kasa', type: 'flat', value: 50 }))
    assert.equal(preview.reason, 'no_matching_items')
    assert.deepEqual(preview.affectedItemIds, [])
  })
})
