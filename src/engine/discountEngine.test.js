/**
 * Tests for discountEngine.js — run with `npm test` (Node's built-in test runner).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ruleMatchesItem,
  applyDiscounts,
  processCart,
  applyCartRules,
  priceCart,
} from './discountEngine.js'

// ── Sample data from the assignment brief ────────────────────────

const ITEM_RULES = [
  { ruleId: 'RULE-01', scope: 'platform', appliesTo: 'Amazon India', type: 'percentage', value: 15, stackable: false, minCartValue: null },
  { ruleId: 'RULE-02', scope: 'brand', appliesTo: 'Natura Casa', type: 'flat', value: 150, stackable: false, minCartValue: null },
  { ruleId: 'RULE-03', scope: 'platform', appliesTo: 'Flipkart', type: 'percentage', value: 10, stackable: true, minCartValue: null },
]
const RULE_04 = { ruleId: 'RULE-04', scope: 'cart', appliesTo: '', type: 'percentage', value: 10, stackable: false, minCartValue: 4000 }
const SAMPLE_RULES = [...ITEM_RULES, RULE_04]

const SAMPLE_CART = [
  { itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299 },
  { itemId: 'ITEM-02', product: 'Bed Sheet Set', brand: 'Natura Casa', platform: 'Flipkart', basePrice: 849 },
  { itemId: 'ITEM-03', product: 'Wall Shelf', brand: 'LivSpace Pro', platform: 'Amazon India', basePrice: 599 },
  { itemId: 'ITEM-04', product: 'Ceramic Vase', brand: 'LivSpace Pro', platform: 'Noon', basePrice: 2499 },
  { itemId: 'ITEM-05', product: 'Cutting Board', brand: 'Nordic Basics', platform: 'Amazon India', basePrice: 449 },
  { itemId: 'ITEM-06', product: 'Desk Organiser', brand: 'Nordic Basics', platform: 'Flipkart', basePrice: 899 },
]

/** Builds a cart rule with sensible defaults. */
const cartRule = (ruleId, value, minCartValue, stackable = false) => ({
  ruleId, scope: 'cart', appliesTo: '', type: 'percentage', value, stackable, minCartValue,
})

// ── Item-level regression (behaviour that existed before Task 1) ──

describe('item-level pricing (regression)', () => {
  test('sample cart gives the expected final price for every item', () => {
    const results = processCart(SAMPLE_CART, ITEM_RULES)
    const prices = Object.fromEntries(results.map((r) => [r.itemId, r.finalPrice]))
    assert.deepEqual(prices, {
      'ITEM-01': 1104, 'ITEM-02': 629, 'ITEM-03': 509,
      'ITEM-04': 2499, 'ITEM-05': 382, 'ITEM-06': 809,
    })
  })

  test('ITEM-01: the bigger saving wins and the other rule is skipped', () => {
    const r = applyDiscounts(SAMPLE_CART[0], ITEM_RULES)
    assert.deepEqual(r.appliedRules, ['RULE-01'])
    assert.deepEqual(r.skippedRules, ['RULE-02'])
    assert.equal(r.reasoning, 'Platform offer: 15% off')
  })

  test('ITEM-02: the stackable rule applies on top of the winner', () => {
    const r = applyDiscounts(SAMPLE_CART[1], ITEM_RULES)
    assert.deepEqual(r.appliedRules, ['RULE-02', 'RULE-03'])
    assert.equal(r.reasoning, 'Brand offer: Rs.150 off + Platform offer: 10% off')
  })

  test('ITEM-04: no match gives the base price and a "No offers available" note', () => {
    const r = applyDiscounts(SAMPLE_CART[3], ITEM_RULES)
    assert.equal(r.finalPrice, 2499)
    assert.equal(r.totalDiscount, 0)
    assert.equal(r.reasoning, 'No offers available')
  })

  test('a flat discount bigger than the price stops at 0, not below', () => {
    const item = { itemId: 'X', product: 'P', brand: 'B', platform: 'Z', basePrice: 300 }
    const rule = { ruleId: 'F', scope: 'brand', appliesTo: 'B', type: 'flat', value: 500, stackable: false }
    const r = applyDiscounts(item, [rule])
    assert.equal(r.finalPrice, 0)
    assert.equal(r.totalDiscount, 300)
  })

  test('a cart rule never matches an individual item', () => {
    for (const item of SAMPLE_CART) assert.equal(ruleMatchesItem(item, RULE_04), false)
  })
})

// ── priceCart: the full flow ─────────────────────────────────────

describe('priceCart', () => {
  test('assignment sample: Rs.5,932 subtotal, Rs.593 cart offer, Rs.5,339 final', () => {
    const result = priceCart(SAMPLE_CART, SAMPLE_RULES)
    assert.equal(result.subtotal, 5932)
    assert.equal(result.cartDiscount, 593)
    assert.equal(result.finalTotal, 5339)
    assert.deepEqual(result.cartOffers, [{
      ruleId: 'RULE-04', type: 'percentage', value: 10, minCartValue: 4000,
      amount: 593, label: 'Cart offer: 10% off — Rs.593 saved',
    }])
  })

  test('adding a cart rule does not change any item result', () => {
    const without = priceCart(SAMPLE_CART, ITEM_RULES).items
    const withCart = priceCart(SAMPLE_CART, SAMPLE_RULES).items
    assert.deepEqual(withCart, without)
    assert.equal(withCart[3].reasoning, 'No offers available')
  })

  test('no cart rules: no offers and the final total equals the subtotal', () => {
    const result = priceCart(SAMPLE_CART, ITEM_RULES)
    assert.deepEqual(result.cartOffers, [])
    assert.equal(result.cartDiscount, 0)
    assert.equal(result.finalTotal, 5932)
  })

  test('the threshold is checked against the DISCOUNTED subtotal, not base prices', () => {
    // Base prices add up to Rs.6,594 (above 6,000) but the discounted subtotal is Rs.5,932
    const result = priceCart(SAMPLE_CART, [...ITEM_RULES, cartRule('C', 10, 6000)])
    assert.deepEqual(result.cartOffers, [])
    assert.equal(result.finalTotal, 5932)
  })

  test('empty cart: everything is 0 and no offer appears', () => {
    const result = priceCart([], SAMPLE_RULES)
    assert.deepEqual(result, { items: [], subtotal: 0, cartOffers: [], cartDiscount: 0, finalTotal: 0 })
  })
})

// ── applyCartRules: the cart-level rules on their own ────────────

describe('applyCartRules', () => {
  test('exactly at the threshold: the offer applies (>=)', () => {
    const r = applyCartRules(4000, [RULE_04])
    assert.equal(r.cartDiscount, 400)
    assert.equal(r.finalTotal, 3600)
  })

  test('just below the threshold: no offer, total unchanged', () => {
    const r = applyCartRules(3999, [RULE_04])
    assert.deepEqual(r, { cartOffers: [], cartDiscount: 0, finalTotal: 3999 })
  })

  test('the saving is rounded to whole rupees (400.5 → 401)', () => {
    const r = applyCartRules(4005, [RULE_04])
    assert.equal(r.cartDiscount, 401)
    assert.equal(r.finalTotal, 3604)
  })

  test('several eligible non-stackable rules: only the biggest saving applies', () => {
    const rules = [cartRule('A', 10, 4000), cartRule('B', 15, 5000), cartRule('C', 20, 10000)]
    const r = applyCartRules(5932, rules)
    assert.deepEqual(r.cartOffers.map((o) => o.ruleId), ['B']) // C is not eligible
    assert.equal(r.cartDiscount, 890) // 15% of 5,932 = 889.8 → 890
  })

  test('equal savings: the rule that comes first wins (deterministic)', () => {
    const r = applyCartRules(5000, [cartRule('FIRST', 10, 1000), cartRule('SECOND', 10, 2000)])
    assert.deepEqual(r.cartOffers.map((o) => o.ruleId), ['FIRST'])
  })

  test('a stackable rule applies on top of the winner, on the reduced total', () => {
    const r = applyCartRules(5000, [cartRule('NS', 10, 1000), cartRule('S', 5, 1000, true)])
    assert.deepEqual(r.cartOffers.map((o) => [o.ruleId, o.amount]), [['NS', 500], ['S', 225]])
    assert.equal(r.finalTotal, 4275)
  })

  test('a stackable rule applies on its own when no non-stackable rule qualifies', () => {
    const r = applyCartRules(5000, [cartRule('NS', 10, 9000), cartRule('S', 5, 1000, true)])
    assert.deepEqual(r.cartOffers.map((o) => o.ruleId), ['S'])
    assert.equal(r.finalTotal, 4750)
  })

  test('several stackable rules apply one after another, in the given order', () => {
    const r = applyCartRules(1000, [cartRule('S1', 10, 0, true), cartRule('S2', 10, 0, true)])
    assert.deepEqual(r.cartOffers.map((o) => [o.ruleId, o.amount]), [['S1', 100], ['S2', 90]])
    assert.equal(r.finalTotal, 810)
  })

  test('every threshold is checked against the subtotal before cart discounts', () => {
    // After A the running total is 4,500, but B is still eligible because 5,000 >= 5,000
    const r = applyCartRules(5000, [cartRule('A', 10, 4000), cartRule('B', 5, 5000, true)])
    assert.deepEqual(r.cartOffers.map((o) => o.ruleId), ['A', 'B'])
  })

  test('a 100% cart offer brings the total to 0, never below', () => {
    const r = applyCartRules(5000, [cartRule('ALL', 100, 0), cartRule('MORE', 10, 0, true)])
    assert.equal(r.finalTotal, 0)
    assert.equal(r.cartDiscount, 5000)
    assert.deepEqual(r.cartOffers.map((o) => o.ruleId), ['ALL']) // no "Rs.0 saved" line
  })

  test('large savings are formatted the Indian way in the label', () => {
    const r = applyCartRules(150000, [cartRule('BIG', 10, 0)])
    assert.equal(r.cartOffers[0].label, 'Cart offer: 10% off — Rs.15,000 saved')
  })
})
