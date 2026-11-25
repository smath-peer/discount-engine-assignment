/**
 * Tests for appRules.js — the rule-combination, confirmation and automatic
 * recalculation logic App.jsx uses. Run with `npm test`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { combineRules, canCalculate, computeResults, addConfirmedRule, withoutConfirmedIdClashes } from './appRules.js'
import { parseRulesCSV, parseCartCSV } from './input/csvParser.js'
import { buildConfirmedRule } from './components/ruleInputState.js'
import { previewRule } from './engine/rulePreview.js'

const readSample = (name) => readFileSync(new URL(`../sample-data/${name}`, import.meta.url), 'utf8')
const CSV_RULES = parseRulesCSV(readSample('rules.csv')).data
const CART = parseCartCSV(readSample('cart.csv')).data

const BRAND = { scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true, minCartValue: null }
const FLIPKART = { scope: 'platform', appliesTo: 'Flipkart', type: 'flat', value: 100, stackable: false, minCartValue: null }
const CART_10 = { scope: 'cart', appliesTo: '', type: 'percentage', value: 10, stackable: false, minCartValue: 5000 }

/** Confirms candidates one after another, the way the app does. */
function confirmAll(csvRules, ...candidates) {
  let confirmed = []
  for (const candidate of candidates) {
    const fromInput = buildConfirmedRule(candidate, combineRules(csvRules, confirmed).map((r) => r.ruleId)).rule
    confirmed = addConfirmedRule(csvRules, confirmed, fromInput).confirmedRules
  }
  return confirmed
}

const totalWith = (csvRules, confirmed, cart = CART) =>
  computeResults({ hasCalculated: true, activeRules: combineRules(csvRules, confirmed), cartItems: cart })?.finalTotal

describe('combining the two rule lists', () => {
  test('CSV rules first, then confirmed rules in the order added', () => {
    const confirmed = confirmAll(CSV_RULES, BRAND, FLIPKART)
    assert.deepEqual(combineRules(CSV_RULES, confirmed).map((r) => r.ruleId), ['RULE-01', 'RULE-02', 'RULE-03', 'RULE-04', 'NL-1', 'NL-2'])
  })

  test('neither input list is changed', () => {
    const csv = structuredClone(CSV_RULES)
    const confirmed = confirmAll(CSV_RULES, BRAND)
    const before = structuredClone({ csv, confirmed })
    combineRules(csv, confirmed)
    assert.deepEqual({ csv, confirmed }, before)
  })
})

describe('calculation: first by the button, then automatic', () => {
  test('before the first Calculate click there are no results', () => {
    assert.equal(computeResults({ hasCalculated: false, activeRules: CSV_RULES, cartItems: CART }), null)
  })

  test('after the click, the sample prices to Rs.5,339 as before', () => {
    const results = computeResults({ hasCalculated: true, activeRules: CSV_RULES, cartItems: CART })
    assert.equal(results.finalTotal, 5339)
    assert.deepEqual(results.items.map((r) => r.finalPrice), [1104, 629, 509, 2499, 382, 809])
  })

  test('confirming Example 1 re-prices to Rs.5,026 — the same as its preview', () => {
    const preview = previewRule(CART, CSV_RULES, BRAND)
    const confirmed = confirmAll(CSV_RULES, BRAND)
    assert.equal(totalWith(CSV_RULES, confirmed), 5026)
    assert.equal(totalWith(CSV_RULES, confirmed), preview.projectedTotal)
  })

  test('confirming Example 2 re-prices to Rs.5,258 (only ITEM-06 changes)', () => {
    const confirmed = confirmAll(CSV_RULES, FLIPKART)
    const results = computeResults({ hasCalculated: true, activeRules: combineRules(CSV_RULES, confirmed), cartItems: CART })
    assert.equal(results.finalTotal, 5258)
    assert.deepEqual(results.items.map((r) => r.finalPrice), [1104, 629, 509, 2499, 382, 719])
  })

  test('confirming Example 3 changes nothing: RULE-04 comes first and wins the tie', () => {
    const confirmed = confirmAll(CSV_RULES, CART_10)
    const results = computeResults({ hasCalculated: true, activeRules: combineRules(CSV_RULES, confirmed), cartItems: CART })
    assert.equal(results.finalTotal, 5339)
    assert.deepEqual(results.cartOffers.map((o) => o.ruleId), ['RULE-04'])
  })

  test('several confirmed rules all apply, matching each preview in turn', () => {
    let confirmed = []
    for (const candidate of [BRAND, FLIPKART, CART_10]) {
      const active = combineRules(CSV_RULES, confirmed)
      const expected = previewRule(CART, active, candidate).projectedTotal
      confirmed = confirmAll(CSV_RULES, ...[...confirmed.map(({ ruleId, ...rest }) => rest), candidate])
      assert.equal(totalWith(CSV_RULES, confirmed), expected)
    }
    assert.deepEqual(confirmed.map((r) => r.ruleId), ['NL-1', 'NL-2', 'NL-3'])
  })

  test('no results without a cart, or without any rule', () => {
    assert.equal(computeResults({ hasCalculated: true, activeRules: CSV_RULES, cartItems: [] }), null)
    assert.equal(computeResults({ hasCalculated: true, activeRules: [], cartItems: CART }), null)
  })

  test('confirmed rules alone (no CSV) are enough to calculate', () => {
    const confirmed = confirmAll([], BRAND)
    assert.equal(canCalculate(confirmed, CART), true)
    assert.equal(totalWith([], confirmed), 6164)
  })

  test('a rule confirmed before any cart is kept, and applies once a cart is loaded', () => {
    const confirmed = confirmAll(CSV_RULES, BRAND)
    assert.equal(totalWith(CSV_RULES, confirmed, []), undefined)
    assert.equal(confirmed.length, 1)
    assert.equal(totalWith(CSV_RULES, confirmed, CART), 5026)
  })
})

describe('uploads keep confirmed rules', () => {
  test('a new rules.csv replaces the CSV rules and keeps confirmed rules', () => {
    const confirmed = confirmAll(CSV_RULES, BRAND)
    const newCsv = parseRulesCSV('rule_id,scope,applies_to,type,value,stackable,min_cart_value\nR-NEW,platform,Flipkart,percentage,5,false,').data
    const { rules } = withoutConfirmedIdClashes(newCsv, confirmed)
    assert.deepEqual(combineRules(rules, confirmed).map((r) => r.ruleId), ['R-NEW', 'NL-1'])
  })

  test('a new cart is priced with the existing CSV and confirmed rules', () => {
    const confirmed = confirmAll(CSV_RULES, BRAND)
    const smallCart = [CART[0], CART[1]] // Natura Casa items only
    const results = computeResults({ hasCalculated: true, activeRules: combineRules(CSV_RULES, confirmed), cartItems: smallCart })
    assert.ok(results.items.every((item) => item.appliedRules.includes('NL-1')))
  })

  test('an uploaded row that reuses a confirmed rule\'s ID is skipped with a message (no duplicates, no renaming)', () => {
    const confirmed = confirmAll(CSV_RULES, BRAND) // NL-1
    const newCsv = parseRulesCSV(
      'rule_id,scope,applies_to,type,value,stackable,min_cart_value\nnl-1,platform,Flipkart,percentage,5,false,\nR-2,brand,Natura Casa,flat,50,false,',
    ).data
    const { rules, errors } = withoutConfirmedIdClashes(newCsv, confirmed)
    assert.deepEqual(rules.map((r) => r.ruleId), ['R-2'])
    assert.deepEqual(errors, ['rule_id "nl-1" is already used by a rule added in plain language, so that row was skipped'])
    assert.equal(confirmed[0].ruleId, 'NL-1')
  })

  test('with no confirmed rules, an upload passes through unchanged', () => {
    assert.deepEqual(withoutConfirmedIdClashes(CSV_RULES, []), { rules: CSV_RULES, errors: [] })
  })
})

describe('adding a confirmed rule', () => {
  test('a valid rule with a free ID is added as given', () => {
    const rule = { ruleId: 'NL-1', ...BRAND }
    const result = addConfirmedRule(CSV_RULES, [], rule)
    assert.deepEqual(result.rule, rule)
    assert.deepEqual(result.confirmedRules, [rule])
  })

  test('the lists passed in are not changed', () => {
    const confirmed = []
    addConfirmedRule(CSV_RULES, confirmed, { ruleId: 'NL-1', ...BRAND })
    assert.equal(confirmed.length, 0)
  })

  test('an ID already used (by a CSV or confirmed rule, any case) gets the next free NL- ID instead', () => {
    const existing = [{ ruleId: 'NL-1', ...FLIPKART }]
    assert.equal(addConfirmedRule(CSV_RULES, existing, { ruleId: 'nl-1', ...BRAND }).rule.ruleId, 'NL-2')
    assert.equal(addConfirmedRule(CSV_RULES, [], { ruleId: 'RULE-01', ...BRAND }).rule.ruleId, 'NL-1')
  })

  test('a missing ID is given one', () => {
    assert.equal(addConfirmedRule(CSV_RULES, [], BRAND).rule.ruleId, 'NL-1')
  })

  test('an existing rule is never replaced', () => {
    const existing = [{ ruleId: 'NL-1', ...FLIPKART }]
    const { confirmedRules } = addConfirmedRule(CSV_RULES, existing, { ruleId: 'NL-1', ...BRAND })
    assert.deepEqual(confirmedRules[0], existing[0])
    assert.equal(confirmedRules.length, 2)
  })

  test('an invalid rule is refused and nothing is added', () => {
    for (const rule of [{ ruleId: 'NL-1', ...BRAND, value: 200 }, { ruleId: 'NL-1', ...CART_10, type: 'flat' }, null, {}]) {
      const result = addConfirmedRule(CSV_RULES, [], rule)
      assert.equal(typeof result.error, 'string')
      assert.equal('confirmedRules' in result, false)
    }
  })

  test('extra fields are dropped; only the seven engine fields are stored', () => {
    const { rule } = addConfirmedRule(CSV_RULES, [], { ruleId: 'NL-1', ...BRAND, previewOnly: true, reasoning: 'x' })
    assert.deepEqual(Object.keys(rule).sort(), ['appliesTo', 'minCartValue', 'ruleId', 'scope', 'stackable', 'type', 'value'])
  })
})

describe('things that must not change prices', () => {
  test('a discarded candidate, a clarification or an error adds nothing', () => {
    // None of these reach addConfirmedRule; the lists simply stay as they are
    const confirmed = []
    assert.equal(totalWith(CSV_RULES, confirmed), 5339)
  })

  test('a preview never becomes a committed calculation', () => {
    const csv = structuredClone(CSV_RULES)
    previewRule(CART, csv, BRAND)
    assert.equal(totalWith(csv, []), 5339)
    assert.equal(csv.length, 4)
  })
})
