/**
 * Tests for offerComparison.js — run with `npm test` (Node's built-in test runner).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  appliedOfferBreakdown, itemOfferOptions, previewOffer, previewMessages,
  openPreview, closePreview, currentPreview,
} from './offerComparison.js'
import { priceCart, applyDiscounts } from '../engine/discountEngine.js'
import { parseRulesCSV, parseCartCSV } from '../engine/csvParser.js'

const sample = (name) => readFileSync(new URL(`../../sample-data/${name}`, import.meta.url), 'utf8')
const RULES = parseRulesCSV(sample('rules.csv')).data
const CART = parseCartCSV(sample('cart.csv')).data

const item = (itemId, brand, platform, basePrice) => ({ itemId, product: itemId, brand, platform, basePrice })
const rule = (ruleId, fields) => ({ ruleId, appliesTo: '', type: 'percentage', stackable: false, minCartValue: null, ...fields })

/** Freezes an object and everything inside it, so any change would throw. */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

// A cart just below the Rs.4,000 cart offer: item A's best offer (30%) keeps
// the subtotal at 3,990; its weaker flat offer would lift it over the line.
const NEAR_CART = [item('A', 'Acme', 'Shop', 1000), item('C', 'Other', 'Elsewhere', 3290)]
const NEAR_RULES = [
  rule('P-30', { scope: 'platform', appliesTo: 'Shop', value: 30 }),
  rule('B-100', { scope: 'brand', appliesTo: 'Acme', type: 'flat', value: 100 }),
  rule('CART-10', { scope: 'cart', value: 10, minCartValue: 4000 }),
]

describe('appliedOfferBreakdown', () => {
  const actual = priceCart(CART, RULES)
  const breakdown = (i, cart = CART, rules = RULES, priced = actual) => appliedOfferBreakdown(cart[i], rules, priced.items[i])

  test('the sample items: each applied offer with what it took off', () => {
    assert.deepEqual(breakdown(0), [{ ruleId: 'RULE-01', name: 'Platform offer: 15% off', amount: 195, stackable: false }])
    // Bed Sheet Set: Rs.150 off 849 = 699, then 10% of 699 rounds to 70 → 629
    assert.deepEqual(breakdown(1), [
      { ruleId: 'RULE-02', name: 'Brand offer: Rs.150 off', amount: 150, stackable: false },
      { ruleId: 'RULE-03', name: 'Platform offer: 10% off', amount: 70, stackable: true },
    ])
    assert.deepEqual(breakdown(3), []) // Ceramic Vase: no offers
    assert.deepEqual(breakdown(5), [{ ruleId: 'RULE-03', name: 'Platform offer: 10% off', amount: 90, stackable: true }])
  })

  test('the amounts always add up to the engine’s saving, and the names to its reasoning', () => {
    const cases = [
      [CART, RULES],
      [NEAR_CART, NEAR_RULES],
      [[item('A', 'Acme', 'Shop', 1500)], [
        rule('B-2000', { scope: 'brand', appliesTo: 'Acme', type: 'flat', value: 2000 }),
        rule('S-10', { scope: 'platform', appliesTo: 'Shop', value: 10, stackable: true }),
      ]],
      [[item('A', 'Acme', 'Shop', 999)], [
        rule('S-15', { scope: 'platform', appliesTo: 'Shop', value: 15, stackable: true }),
        rule('S-50', { scope: 'brand', appliesTo: 'Acme', type: 'flat', value: 50, stackable: true }),
        rule('P-7', { scope: 'platform', appliesTo: 'Shop', value: 7 }),
      ]],
    ]
    for (const [cart, rules] of cases) {
      const priced = priceCart(cart, rules)
      priced.items.forEach((result, i) => {
        const parts = appliedOfferBreakdown(cart[i], rules, result)
        assert.equal(parts.reduce((sum, p) => sum + p.amount, 0), result.totalDiscount)
        assert.deepEqual(parts.map((p) => p.ruleId), result.appliedRules)
        if (parts.length > 0) assert.equal(parts.map((p) => p.name).join(' + '), result.reasoning)
      })
    }
  })
})

describe('itemOfferOptions: the sample cart', () => {
  const actual = priceCart(CART, RULES)

  test('Cushion Cover: the 15% platform offer is applied over the Rs.150 brand offer', () => {
    assert.deepEqual(itemOfferOptions(CART[0], RULES, actual.items[0]), {
      options: [
        { ruleId: 'RULE-01', name: 'Platform offer: 15% off', ownSaving: 195, itemPrice: 1104, itemSaving: 195, applied: true },
        { ruleId: 'RULE-02', name: 'Brand offer: Rs.150 off', ownSaving: 150, itemPrice: 1149, itemSaving: 150, applied: false },
      ],
      stackable: [],
      reason: 'Applied because it takes Rs.195 off, the largest saving; Brand offer: Rs.150 off would take Rs.150 off.',
    })
  })

  test('items with fewer than two non-stackable offers have nothing to compare', () => {
    // ITEM-02: one non-stackable brand offer plus a stackable platform offer
    // ITEM-04: no offers; ITEM-03, 05, 06: one offer each
    for (const i of [1, 2, 3, 4, 5]) assert.equal(itemOfferOptions(CART[i], RULES, actual.items[i]), null, CART[i].itemId)
  })

  test('the applied option is always the engine’s choice and is listed first', () => {
    const options = itemOfferOptions(CART[0], RULES, actual.items[0]).options
    assert.equal(options[0].applied, true)
    assert.equal(options[0].ruleId, actual.items[0].appliedRules[0])
  })
})

describe('itemOfferOptions: stacking, ties and the zero floor', () => {
  test('stackable offers are listed separately and included in every option’s price', () => {
    const cart = [item('A', 'Acme', 'Shop', 2000)]
    const rules = [
      rule('P-20', { scope: 'platform', appliesTo: 'Shop', value: 20 }),
      rule('B-300', { scope: 'brand', appliesTo: 'Acme', type: 'flat', value: 300 }),
      rule('S-10', { scope: 'brand', appliesTo: 'Acme', value: 10, stackable: true }),
    ]
    const actual = priceCart(cart, rules)
    const result = itemOfferOptions(cart[0], rules, actual.items[0])
    assert.deepEqual(result.stackable, ['Brand offer: 10% off'])
    // 20%: 2,000 - 400 = 1,600, then 10% = 1,440. Rs.300: 1,700, then 10% = 1,530.
    assert.deepEqual(result.options.map((o) => [o.ruleId, o.itemPrice, o.itemSaving, o.applied]), [
      ['P-20', 1440, 560, true],
      ['B-300', 1530, 470, false],
    ])
    assert.equal(result.options[0].itemPrice, actual.items[0].finalPrice)
  })

  test('equal savings: the first listed offer is applied, exactly as the engine does', () => {
    const cart = [item('A', 'Acme', 'Shop', 1000)]
    const flat = rule('B-100', { scope: 'brand', appliesTo: 'Acme', type: 'flat', value: 100 })
    const pct = rule('P-10', { scope: 'platform', appliesTo: 'Shop', value: 10 })
    for (const rules of [[flat, pct], [pct, flat]]) {
      const actual = priceCart(cart, rules)
      const result = itemOfferOptions(cart[0], rules, actual.items[0])
      assert.equal(result.options[0].ruleId, rules[0].ruleId)
      assert.equal(actual.items[0].appliedRules[0], rules[0].ruleId)
      assert.match(result.reason, /both take Rs\.100 off, so the first listed offer is applied\.$/)
    }
  })

  test('a flat offer larger than the price is floored at zero, as in the engine', () => {
    const cart = [item('A', 'Acme', 'Shop', 1500)]
    const rules = [
      rule('B-2000', { scope: 'brand', appliesTo: 'Acme', type: 'flat', value: 2000 }),
      rule('P-10', { scope: 'platform', appliesTo: 'Shop', value: 10 }),
    ]
    const actual = priceCart(cart, rules)
    const result = itemOfferOptions(cart[0], rules, actual.items[0])
    assert.deepEqual(result.options.map((o) => [o.ruleId, o.itemPrice]), [['B-2000', 0], ['P-10', 1350]])
    assert.equal(actual.items[0].finalPrice, 0)
  })
})

describe('previewOffer', () => {
  test('sample: Cushion Cover with the Rs.150 brand offer instead', () => {
    const actual = priceCart(CART, RULES)
    const preview = previewOffer(CART, RULES, actual, 0, 'RULE-02')
    assert.deepEqual(
      {
        applied: preview.applied, offer: preview.offer,
        itemPrice: preview.itemPrice, actualItemPrice: preview.actualItemPrice, itemDifference: preview.itemDifference,
        subtotal: preview.subtotal, cartDiscount: preview.cartDiscount,
        finalTotal: preview.finalTotal, actualFinalTotal: preview.actualFinalTotal, totalDifference: preview.totalDifference,
        gained: preview.cartOffersGained, lost: preview.cartOffersLost,
      },
      {
        applied: false, offer: 'Brand offer: Rs.150 off',
        itemPrice: 1149, actualItemPrice: 1104, itemDifference: 45,
        // 5,932 - 1,104 + 1,149 = 5,977; 10% of 5,977 rounds to 598
        subtotal: 5977, cartDiscount: 598,
        finalTotal: 5379, actualFinalTotal: 5339, totalDifference: 40,
        gained: [], lost: [],
      },
    )
    assert.deepEqual(previewMessages(preview), [
      'This item would cost Rs.45 more than with the applied offer.',
      'You would pay Rs.40 more in total: Rs.5,379 instead of Rs.5,339.',
    ])
  })

  test('only the previewed item changes; every other item keeps its actual price', () => {
    const actual = priceCart(CART, RULES)
    const preview = previewOffer(CART, RULES, actual, 0, 'RULE-02')
    const others = actual.items.slice(1).reduce((sum, r) => sum + r.finalPrice, 0)
    assert.equal(preview.subtotal, others + preview.itemPrice)
  })

  test('previewing the applied offer reproduces the actual prices exactly, for every item that has options', () => {
    const carts = [
      [CART, RULES],
      [NEAR_CART, NEAR_RULES],
    ]
    for (const [cart, rules] of carts) {
      const actual = priceCart(cart, rules)
      cart.forEach((cartItem, i) => {
        const options = itemOfferOptions(cartItem, rules, actual.items[i])
        if (!options) return
        const preview = previewOffer(cart, rules, actual, i, actual.items[i].appliedRules[0])
        assert.equal(preview.applied, true)
        assert.equal(preview.itemPrice, actual.items[i].finalPrice)
        assert.equal(preview.subtotal, actual.subtotal)
        assert.equal(preview.finalTotal, actual.finalTotal)
        assert.equal(preview.totalDifference, 0)
        assert.deepEqual(preview.cartOffers, actual.cartOffers)
        assert.deepEqual(previewMessages(preview), ['This is the offer already applied, so nothing would change.'])
      })
    }
  })

  test('an alternative can lift the cart over a threshold and lower the total; this is said plainly', () => {
    const actual = priceCart(NEAR_CART, NEAR_RULES)
    assert.equal(actual.subtotal, 3990) // 700 + 3,290: just below Rs.4,000
    assert.equal(actual.finalTotal, 3990)

    const preview = previewOffer(NEAR_CART, NEAR_RULES, actual, 0, 'B-100')
    assert.deepEqual(
      [preview.itemPrice, preview.subtotal, preview.cartDiscount, preview.finalTotal, preview.totalDifference],
      [900, 4190, 419, 3771, -219],
    )
    assert.deepEqual(preview.cartOffersGained.map((o) => o.ruleId), ['CART-10'])
    assert.deepEqual(previewMessages(preview), [
      'This item would cost Rs.200 more than with the applied offer.',
      'The cart would then reach the 10% cart offer (from Rs.4,000).',
      'The cart total would be Rs.219 lower: Rs.3,771 instead of Rs.3,990. ' +
        'Offers are still chosen item by item, so the applied offer stays the one with the largest saving on this item.',
    ])
    // The actual pricing still applies the larger item saving
    assert.equal(actual.items[0].appliedRules[0], 'P-30')
  })

  test('the preview item is priced by the engine with the chosen offer and the stackable ones', () => {
    const cart = [item('A', 'Acme', 'Shop', 2000)]
    const rules = [
      rule('P-20', { scope: 'platform', appliesTo: 'Shop', value: 20 }),
      rule('B-300', { scope: 'brand', appliesTo: 'Acme', type: 'flat', value: 300 }),
      rule('S-10', { scope: 'brand', appliesTo: 'Acme', value: 10, stackable: true }),
    ]
    const preview = previewOffer(cart, rules, priceCart(cart, rules), 0, 'B-300')
    assert.equal(preview.itemPrice, applyDiscounts(cart[0], [rules[1], rules[2]]).finalPrice)
    assert.equal(preview.offer, 'Brand offer: Rs.300 off + Brand offer: 10% off')
  })

  test('offers that are not non-stackable alternatives for that item give no preview', () => {
    const actual = priceCart(CART, RULES)
    assert.equal(previewOffer(CART, RULES, actual, 0, 'RULE-03'), null) // Flipkart offer: not this item's
    assert.equal(previewOffer(CART, RULES, actual, 1, 'RULE-03'), null) // stackable: not an alternative
    assert.equal(previewOffer(CART, RULES, actual, 0, 'RULE-04'), null) // cart rule
    assert.equal(previewOffer(CART, RULES, actual, 0, 'NOPE'), null)
    assert.equal(previewOffer(CART, RULES, actual, 99, 'RULE-01'), null)
  })

  test('a total that stays the same is reported as the same', () => {
    const preview = { applied: false, itemDifference: 0, cartOffersGained: [], cartOffersLost: [], totalDifference: 0, finalTotal: 500, actualFinalTotal: 500 }
    assert.deepEqual(previewMessages(preview), [
      'This item would cost the same as with the applied offer.',
      'The cart total would be the same: Rs.500.',
    ])
  })
})

describe('previews never change the actual cart, offers or totals', () => {
  test('frozen inputs: comparing and previewing every option throws nothing and changes nothing', () => {
    for (const [cart, rules] of [[CART, RULES], [NEAR_CART, NEAR_RULES]]) {
      const cartCopy = structuredClone(cart)
      const rulesCopy = structuredClone(rules)
      const actual = deepFreeze(priceCart(structuredClone(cart), structuredClone(rules)))
      const actualCopy = structuredClone(actual)
      const frozenCart = deepFreeze(structuredClone(cart))
      const frozenRules = deepFreeze(structuredClone(rules))

      frozenCart.forEach((cartItem, i) => {
        const options = itemOfferOptions(cartItem, frozenRules, actual.items[i])
        for (const option of options?.options ?? []) {
          const preview = previewOffer(frozenCart, frozenRules, actual, i, option.ruleId)
          previewMessages(preview)
        }
      })

      assert.deepEqual(actual, actualCopy)
      assert.deepEqual(frozenCart, cartCopy)
      assert.deepEqual(frozenRules, rulesCopy)
      // Pricing again gives the same result: Rs.5,339 for the sample
      assert.deepEqual(priceCart(cart, rules), actualCopy)
    }
    assert.equal(priceCart(CART, RULES).finalTotal, 5339)
  })
})

describe('open, close and reset', () => {
  test('one preview at a time: opening another replaces the first', () => {
    let state = openPreview(CART, RULES, 0, 'RULE-02')
    assert.deepEqual(currentPreview(state, CART, RULES), { itemIndex: 0, ruleId: 'RULE-02' })
    state = openPreview(CART, RULES, 0, 'RULE-01')
    assert.deepEqual(currentPreview(state, CART, RULES), { itemIndex: 0, ruleId: 'RULE-01' })
  })

  test('closing returns to the actual prices only', () => {
    const state = closePreview(openPreview(CART, RULES, 0, 'RULE-02'))
    assert.equal(currentPreview(state, CART, RULES), null)
  })

  test('a new cart or new rules close the preview', () => {
    const state = openPreview(CART, RULES, 0, 'RULE-02')
    assert.equal(currentPreview(state, [...CART], RULES), null)
    assert.equal(currentPreview(state, CART, [...RULES]), null)
    assert.deepEqual(currentPreview(state, CART, RULES), { itemIndex: 0, ruleId: 'RULE-02' })
  })

  test('nothing open', () => {
    assert.equal(currentPreview(null, CART, RULES), null)
  })
})
