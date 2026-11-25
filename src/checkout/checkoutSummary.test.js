/**
 * Tests for checkoutSummary.js — run with `npm test` (Node's built-in test runner).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkoutSummary, partialCartWarning } from './checkoutSummary.js'
import { priceCart } from '../engine/discountEngine.js'
import { parseRulesCSV, parseCartCSV } from '../input/csvParser.js'

const sample = (name) => readFileSync(new URL(`../../sample-data/${name}`, import.meta.url), 'utf8')
const RULES = parseRulesCSV(sample('rules.csv')).data
const CART = parseCartCSV(sample('cart.csv')).data
const cartRules = (rules) => rules.filter((r) => r.scope === 'cart')
const summarise = (cart, rules = RULES) => checkoutSummary(priceCart(cart, rules), cartRules(rules))

const item = (itemId, brand, platform, basePrice) => ({ itemId, product: itemId, brand, platform, basePrice })
const rule = (ruleId, fields) => ({ ruleId, appliesTo: '', type: 'percentage', stackable: false, minCartValue: null, ...fields })

describe('checkoutSummary: the brief’s sample cart', () => {
  test('gives the expected breakdown', () => {
    const summary = summarise(CART)
    assert.deepEqual(
      {
        itemCount: summary.itemCount,
        originalTotal: summary.originalTotal,
        itemSavings: summary.itemSavings,
        subtotal: summary.subtotal,
        cartDiscount: summary.cartDiscount,
        finalTotal: summary.finalTotal,
        totalSavings: summary.totalSavings,
        cartOffers: summary.cartOffers.map((o) => [o.ruleId, o.amount]),
        cartOffersNotReached: summary.cartOffersNotReached,
      },
      {
        itemCount: 6,
        originalTotal: 6594,
        itemSavings: 662,
        subtotal: 5932,
        cartDiscount: 593,
        finalTotal: 5339,
        totalSavings: 1255,
        cartOffers: [['RULE-04', 593]],
        cartOffersNotReached: [],
      },
    )
  })

  test('the parts always add up', () => {
    const s = summarise(CART)
    assert.equal(s.originalTotal - s.itemSavings, s.subtotal)
    assert.equal(s.subtotal - s.cartDiscount, s.finalTotal)
    assert.equal(s.itemSavings + s.cartDiscount, s.totalSavings)
  })

  test('the priced cart is not changed', () => {
    const priced = priceCart(CART, RULES)
    const copy = structuredClone(priced)
    checkoutSummary(priced, cartRules(RULES))
    assert.deepEqual(priced, copy)
  })
})

describe('checkoutSummary: cart offers and their minimum', () => {
  const tenPercentFrom = (min) => [rule('CART-10', { scope: 'cart', value: 10, minCartValue: min })]

  test('applies at exactly the minimum (the minimum is inclusive)', () => {
    const s = summarise([item('A', 'X', 'Y', 4000)], tenPercentFrom(4000))
    assert.deepEqual([s.cartDiscount, s.finalTotal, s.cartOffersNotReached], [400, 3600, []])
  })

  test('just below the minimum: no cart offer, and how far below it is', () => {
    const s = summarise([item('A', 'X', 'Y', 3999)], tenPercentFrom(4000))
    assert.equal(s.cartDiscount, 0)
    assert.equal(s.finalTotal, 3999)
    assert.deepEqual(s.cartOffersNotReached, [{ ruleId: 'CART-10', value: 10, minCartValue: 4000, shortBy: 1 }])
  })

  test('the minimum is checked against the subtotal after item offers, not the base prices', () => {
    // Base prices add up to 4,100, but the 15% item offer brings the subtotal to 3,485
    const rules = [rule('ITEM-15', { scope: 'platform', appliesTo: 'Y', value: 15 }), ...tenPercentFrom(4000)]
    const s = summarise([item('A', 'X', 'Y', 4100)], rules)
    assert.equal(s.originalTotal, 4100)
    assert.equal(s.subtotal, 3485)
    assert.equal(s.cartDiscount, 0)
    assert.equal(s.cartOffersNotReached[0].shortBy, 515)
  })

  test('the sample cart without its 15% Amazon offer still reaches Rs.4,000', () => {
    const rules = RULES.filter((r) => r.ruleId !== 'RULE-01')
    const s = summarise(CART, rules)
    assert.ok(s.subtotal >= 4000)
    assert.deepEqual(s.cartOffersNotReached, [])
  })

  test('several unmet cart offers are listed from the lowest minimum up', () => {
    const rules = [
      rule('CART-B', { scope: 'cart', value: 15, minCartValue: 8000 }),
      rule('CART-A', { scope: 'cart', value: 5, minCartValue: 3000 }),
    ]
    const s = summarise([item('A', 'X', 'Y', 2500)], rules)
    assert.deepEqual(s.cartOffersNotReached.map((o) => [o.ruleId, o.shortBy]), [['CART-A', 500], ['CART-B', 5500]])
  })

  test('a met cart offer that loses to a bigger one is not listed as "not reached"', () => {
    const rules = [
      rule('CART-5', { scope: 'cart', value: 5, minCartValue: 1000 }),
      rule('CART-10', { scope: 'cart', value: 10, minCartValue: 2000 }),
    ]
    const s = summarise([item('A', 'X', 'Y', 2500)], rules)
    assert.deepEqual(s.cartOffers.map((o) => o.ruleId), ['CART-10'])
    assert.deepEqual(s.cartOffersNotReached, [])
  })

  test('no offers at all: no savings, totals equal the base prices', () => {
    const s = summarise([item('A', 'X', 'Y', 500)], [])
    assert.deepEqual([s.originalTotal, s.itemSavings, s.cartDiscount, s.finalTotal, s.totalSavings], [500, 0, 0, 500, 0])
  })
})

describe('partialCartWarning', () => {
  test('says the totals cover only the items that loaded', () => {
    const cart = { items: [{}, {}], fileName: 'order.pdf', skipped: ['Row 2: …', 'Row 3: …', 'Row 4: …'] }
    assert.equal(
      partialCartWarning(cart),
      '3 rows from order.pdf could not be read, so these totals include only the 2 items that loaded. The skipped rows are listed under Your cart.',
    )
  })

  test('singular wording for one row and one item', () => {
    assert.match(partialCartWarning({ items: [{}], fileName: 'c.csv', skipped: ['x'] }), /^1 row from c\.csv .* only the 1 item that loaded/)
  })

  test('no warning for a complete cart or no cart', () => {
    assert.equal(partialCartWarning({ items: [{}], fileName: 'c.csv', skipped: [] }), null)
    assert.equal(partialCartWarning({ items: [], fileName: '', skipped: [] }), null)
    assert.equal(partialCartWarning(null), null)
  })
})
