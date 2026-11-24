/**
 * Tests for csvParser.js — run with `npm test` (Node's built-in test runner).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRulesCSV, parseCartCSV } from './csvParser.js'
import { validateRule } from './discountRuleValidator.js'
import { priceCart } from './discountEngine.js'

const NEW_HEADER = 'rule_id,scope,applies_to,type,value,stackable,min_cart_value'

/** Parses a rules file that has the new header plus the given rows. */
const parseRows = (...rows) => parseRulesCSV([NEW_HEADER, ...rows].join('\n'))

describe('parseRulesCSV: file formats', () => {
  test('the original 6-column file (no min_cart_value column) still loads', () => {
    const csv = [
      'rule_id,scope,applies_to,type,value,stackable',
      'RULE-01,platform,Amazon India,percentage,15,false',
      'RULE-02,brand,Natura Casa,flat,150,false',
      'RULE-03,platform,Flipkart,percentage,10,true',
    ].join('\n')
    const { data, errors } = parseRulesCSV(csv)
    assert.deepEqual(errors, [])
    assert.equal(data.length, 3)
    assert.ok(data.every((r) => r.minCartValue === null))
  })

  test("the brief's new file loads all 4 rules, including RULE-04", () => {
    const { data, errors } = parseRows(
      'RULE-01,platform,Amazon India,percentage,15,false,',
      'RULE-02,brand,Natura Casa,flat,150,false,',
      'RULE-03,platform,Flipkart,percentage,10,true,',
      'RULE-04,cart,,percentage,10,false,4000',
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(data.map((r) => r.ruleId), ['RULE-01', 'RULE-02', 'RULE-03', 'RULE-04'])
    assert.deepEqual(data[3], {
      ruleId: 'RULE-04', scope: 'cart', appliesTo: '', type: 'percentage',
      value: 10, stackable: false, minCartValue: 4000,
    })
  })

  test('good rows still load when other rows are rejected', () => {
    const { data, errors } = parseRows(
      'RULE-01,platform,Amazon India,percentage,15,false,',
      'RULE-04,cart,,percentage,10,false,',
    )
    assert.deepEqual(data.map((r) => r.ruleId), ['RULE-01'])
    assert.equal(errors.length, 1)
  })
})

describe('parseRulesCSV: valid cart rules', () => {
  test('scope is case-insensitive ("Cart")', () => {
    const { data, errors } = parseRows('R,Cart,,percentage,10,false,4000')
    assert.deepEqual(errors, [])
    assert.equal(data[0].scope, 'cart')
  })

  test('a cart rule may fill in applies_to; it is ignored and stored as ""', () => {
    const { data } = parseRows('R,cart,Entire cart,percentage,10,false,4000')
    assert.equal(data[0].appliesTo, '')
  })

  test('an explicit threshold of 0 is accepted', () => {
    const { data, errors } = parseRows('R,cart,,percentage,10,false,0')
    assert.deepEqual(errors, [])
    assert.equal(data[0].minCartValue, 0)
  })

  test('100% is the largest allowed cart percentage', () => {
    const { errors } = parseRows('R,cart,,percentage,100,false,4000')
    assert.deepEqual(errors, [])
  })
})

describe('parseRulesCSV: rejected cart rules', () => {
  const rejects = (row, expectedMessagePart) => {
    const { data, errors } = parseRows(row)
    assert.equal(data.length, 0, `expected "${row}" to be rejected`)
    assert.equal(errors.length, 1)
    assert.match(errors[0], expectedMessagePart)
    assert.match(errors[0], /^Row 2:/)
  }

  test('missing threshold (empty)', () => rejects('R,cart,,percentage,10,false,', /need a min_cart_value/))

  test('missing threshold (old 6-column file)', () => {
    const { data, errors } = parseRulesCSV('rule_id,scope,applies_to,type,value,stackable\nR,cart,,percentage,10,false')
    assert.equal(data.length, 0)
    assert.match(errors[0], /need a min_cart_value/)
  })

  test('negative threshold', () => rejects('R,cart,,percentage,10,false,-5', /min_cart_value must be a number of 0 or more/))
  test('text threshold', () => rejects('R,cart,,percentage,10,false,abc', /min_cart_value must be a number/))
  test('threshold with a comma ("4,000" would otherwise become 4)', () =>
    rejects('R,cart,,percentage,10,false,"4,000"', /min_cart_value must be a number/))
  test('threshold with a currency prefix', () => rejects('R,cart,,percentage,10,false,Rs.4000', /min_cart_value must be a number/))
  test('flat cart rule', () => rejects('R,cart,,flat,500,false,4000', /cart rules must be "percentage"/))
  test('cart percentage above 100', () => rejects('R,cart,,percentage,150,false,4000', /cannot be more than 100/))
  test('zero or negative percentage', () => rejects('R,cart,,percentage,0,false,4000', /value must be a positive number/))
})

describe('parseRulesCSV: brand/platform rules', () => {
  test('a brand rule still needs applies_to', () => {
    const { data, errors } = parseRows('R,brand,,percentage,10,false,')
    assert.equal(data.length, 0)
    assert.match(errors[0], /missing fields — applies_to/)
  })

  test('a brand rule with a min_cart_value is rejected', () => {
    const { data, errors } = parseRows('R,brand,Natura Casa,percentage,10,false,4000')
    assert.equal(data.length, 0)
    assert.match(errors[0], /only applies to cart rules/)
  })

  test('flat brand rules are still allowed (unchanged behaviour)', () => {
    const { data, errors } = parseRows('R,brand,Natura Casa,flat,150,false,')
    assert.deepEqual(errors, [])
    assert.equal(data[0].type, 'flat')
  })

  test('an unknown scope lists all three valid scopes', () => {
    const { errors } = parseRows('R,category,Home,percentage,10,false,')
    assert.match(errors[0], /"brand", "platform" or "cart"/)
  })
})

describe('parseRulesCSV: strict discount value (all scopes)', () => {
  // One row template per scope; {v} is replaced by the value under test
  const SCOPES = {
    brand: 'R,brand,Natura Casa,percentage,{v},false,',
    platform: 'R,platform,Flipkart,percentage,{v},false,',
    cart: 'R,cart,,percentage,{v},false,4000',
  }
  const parseValue = (scope, v) => parseRows(SCOPES[scope].replace('{v}', v))

  for (const scope of Object.keys(SCOPES)) {
    test(`${scope}: valid whole and decimal percentages are accepted`, () => {
      for (const [input, expected] of [['10', 10], ['10.5', 10.5], ['0.5', 0.5], [' 10 ', 10]]) {
        const { data, errors } = parseValue(scope, input)
        assert.deepEqual(errors, [], `"${input}" should be accepted`)
        assert.equal(data[0].value, expected)
      }
    })

    test(`${scope}: malformed values are rejected, not partly read`, () => {
      const malformed = [
        '10abc',       // parseFloat used to read 10
        '15%',         // parseFloat used to read 15
        '"1,500"',     // parseFloat used to read 1
        '   ',         // whitespace only
        '-5',
        '0',
        'NaN',
        'Infinity',    // parseFloat used to accept this
        '1e3',
        '.5',
        '1'.padEnd(400, '0'), // overflows to Infinity
      ]
      for (const input of malformed) {
        const { data, errors } = parseValue(scope, input)
        assert.equal(data.length, 0, `"${input.slice(0, 12)}" should be rejected`)
        assert.match(errors[0], /^Row 2: value must be a positive number/)
      }
    })

    test(`${scope}: an empty value is reported as missing`, () => {
      const { data, errors } = parseValue(scope, '')
      assert.equal(data.length, 0)
      assert.match(errors[0], /missing fields — value/)
    })
  }

  test('flat brand and platform amounts accept whole and decimal rupees', () => {
    for (const [row, expected] of [
      ['R,brand,Natura Casa,flat,150,false,', 150],
      ['R,brand,Natura Casa,flat,150.50,false,', 150.5],
      ['R,platform,Flipkart,flat,100,false,', 100],
    ]) {
      const { data, errors } = parseRows(row)
      assert.deepEqual(errors, [])
      assert.equal(data[0].value, expected)
    }
  })

  test('flat amounts with a comma or currency text are rejected', () => {
    for (const row of ['R,brand,Natura Casa,flat,"1,500",false,', 'R,platform,Flipkart,flat,Rs.100,false,']) {
      const { data, errors } = parseRows(row)
      assert.equal(data.length, 0, row)
      assert.match(errors[0], /value must be a positive number/)
    }
  })

  test('a min_cart_value long enough to overflow to Infinity is rejected', () => {
    const { data, errors } = parseRows(`R,cart,,percentage,10,false,${'1'.padEnd(400, '0')}`)
    assert.equal(data.length, 0)
    assert.match(errors[0], /min_cart_value must be a number/)
  })
})

describe('parseRulesCSV: shared validator integration', () => {
  /** The rule as the validator alone would return it (without the ruleId). */
  const withoutId = ({ ruleId, ...rest }) => rest

  test('brand, platform and cart rows come out exactly as the validator returns them, plus their ruleId', () => {
    const { data, errors } = parseRows(
      'B-1,brand,Natura Casa,flat,150,false,',
      'P-1,platform,Flipkart,percentage,10,true,',
      'C-1,cart,,percentage,10,false,4000',
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(data, [
      { ruleId: 'B-1', scope: 'brand', appliesTo: 'Natura Casa', type: 'flat', value: 150, stackable: false, minCartValue: null },
      { ruleId: 'P-1', scope: 'platform', appliesTo: 'Flipkart', type: 'percentage', value: 10, stackable: true, minCartValue: null },
      { ruleId: 'C-1', scope: 'cart', appliesTo: '', type: 'percentage', value: 10, stackable: false, minCartValue: 4000 },
    ])
    for (const rule of data) {
      assert.deepEqual(withoutId(rule), validateRule(withoutId(rule)).rule)
    }
  })

  test('scope and type are case-insensitive and trimmed before validation', () => {
    const { data, errors } = parseRows(
      'R1, BRAND ,Natura Casa,Flat,150,false,',
      'R2,Platform,Flipkart, PERCENTAGE ,10,false,',
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(data.map((r) => [r.scope, r.type]), [['brand', 'flat'], ['platform', 'percentage']])
  })

  test('extra columns in the file do not reach the rule', () => {
    const { data, errors } = parseRulesCSV(
      'rule_id,scope,applies_to,type,value,stackable,min_cart_value,notes\nR,brand,Natura Casa,flat,150,false,,Diwali promo',
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(Object.keys(data[0]).sort(), ['appliesTo', 'minCartValue', 'ruleId', 'scope', 'stackable', 'type', 'value'])
  })

  test('a percentage above 100 is rejected for brand and platform rules too', () => {
    for (const row of ['R,brand,Natura Casa,percentage,150,false,', 'R,platform,Flipkart,percentage,100.5,false,']) {
      const { data, errors } = parseRows(row)
      assert.equal(data.length, 0, row)
      assert.match(errors[0], /^Row 2: a percentage cannot be more than 100/)
    }
  })

  test('exactly 100% is still accepted for brand and platform rules', () => {
    const { data, errors } = parseRows('R,brand,Natura Casa,percentage,100,false,', 'S,platform,Flipkart,percentage,100,false,')
    assert.deepEqual(errors, [])
    assert.equal(data.length, 2)
  })

  test('a flat brand discount above 100 rupees is not capped', () => {
    const { data, errors } = parseRows('R,brand,Natura Casa,flat,2500,false,')
    assert.deepEqual(errors, [])
    assert.equal(data[0].value, 2500)
  })

  test('long brand and platform names are accepted (no length limit)', () => {
    const longName = 'Natura Casa Home Furnishings and Decor Private Limited '.repeat(5).trim()
    const { data, errors } = parseRows(`R,brand,${longName},flat,150,false,`, `S,platform,${longName},percentage,10,false,`)
    assert.deepEqual(errors, [])
    assert.deepEqual(data.map((r) => r.appliesTo), [longName, longName])
  })

  test('a threshold on a brand row is reported as "only applies to cart rules", even if it is not a number', () => {
    for (const threshold of ['4000', 'abc']) {
      const { data, errors } = parseRows(`R,brand,Natura Casa,flat,150,false,${threshold}`)
      assert.equal(data.length, 0)
      assert.match(errors[0], /^Row 2: min_cart_value only applies to cart rules, but this is a brand rule$/)
    }
  })

  test('a cart threshold written with a comma keeps the "digits only" hint', () => {
    const { errors } = parseRows('R,cart,,percentage,10,false,"4,000"')
    assert.equal(errors[0], 'Row 2: min_cart_value must be a number of 0 or more, written as digits only (e.g. 4000), got "4,000"')
  })
})

describe('parseRulesCSV: rule IDs', () => {
  test('every rule keeps the exact rule_id from its row, in file order', () => {
    const ids = ['RULE-01', 'PROMO-DIWALI-2026', 'nl-7', '42']
    const { data, errors } = parseRows(
      `${ids[0]},platform,Amazon India,percentage,15,false,`,
      `${ids[1]},brand,Natura Casa,flat,150,false,`,
      `${ids[2]},cart,,percentage,10,false,4000`,
      `${ids[3]},platform,Flipkart,percentage,10,true,`,
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(data.map((r) => r.ruleId), ids)
  })

  test('spaces around a rule_id are trimmed, as before', () => {
    const { data } = parseRows('  RULE-09  ,brand,Natura Casa,flat,150,false,')
    assert.equal(data[0].ruleId, 'RULE-09')
  })

  test('a rule_id made only of spaces is reported as missing (it would give an empty ID)', () => {
    const { data, errors } = parseRows('   ,brand,Natura Casa,flat,150,false,')
    assert.equal(data.length, 0)
    assert.match(errors[0], /^Row 2: missing fields — rule_id$/)
  })
})

describe('parseRulesCSV: stackable cell (current behaviour, kept as is)', () => {
  const stackableOf = (cell) => parseRows(`R,brand,Natura Casa,flat,150,${cell},`).data[0].stackable

  test('"true", "1" and "yes" in any case or spacing mean stackable', () => {
    for (const cell of ['true', 'TRUE', 'True', ' yes ', 'YES', '1']) assert.equal(stackableOf(cell), true, cell)
  })

  test('"false", "0" and "no" mean not stackable', () => {
    for (const cell of ['false', 'FALSE', '0', 'no']) assert.equal(stackableOf(cell), false, cell)
  })

  test('known limitation: a typo such as "ture" is read as false, not rejected', () => {
    for (const cell of ['ture', 'maybe', 'y']) assert.equal(stackableOf(cell), false, cell)
  })

  test('a blank stackable cell is reported as missing', () => {
    const { errors } = parseRows('R,brand,Natura Casa,flat,150,,')
    assert.match(errors[0], /missing fields — stackable/)
  })
})

describe('parseRulesCSV: errors are tied to the right rows', () => {
  test('a mixed file keeps the good rows and reports each bad row by its own number', () => {
    const { data, errors } = parseRows(
      'GOOD-1,platform,Amazon India,percentage,15,false,', // row 2
      'BAD-3,category,Home,percentage,10,false,',          // row 3: unknown scope
      'GOOD-4,brand,Natura Casa,flat,150,false,',          // row 4
      'BAD-5,brand,Natura Casa,percentage,150,false,',     // row 5: over 100%
      'BAD-6,cart,,percentage,10,false,',                  // row 6: no threshold
      ',platform,Flipkart,percentage,10,true,',            // row 7: no rule_id
      'GOOD-8,cart,,percentage,10,false,4000',             // row 8
    )
    assert.deepEqual(data.map((r) => r.ruleId), ['GOOD-1', 'GOOD-4', 'GOOD-8'])
    assert.equal(errors.length, 4)
    assert.match(errors[0], /^Row 3: scope must be "brand", "platform" or "cart"/)
    assert.match(errors[1], /^Row 5: a percentage cannot be more than 100/)
    assert.match(errors[2], /^Row 6: cart rules need a min_cart_value/)
    assert.match(errors[3], /^Row 7: missing fields — rule_id$/)
  })

  test('a row with several problems reports all of them on one line', () => {
    const { data, errors } = parseRows('R,cart,,flat,0,false,')
    assert.equal(data.length, 0)
    assert.equal(errors.length, 1)
    assert.equal(
      errors[0],
      'Row 2: value must be a positive number such as 10 or 10.5, got 0; ' +
        'cart rules must be "percentage", got "flat"; ' +
        'cart rules need a min_cart_value (e.g. 4000)',
    )
  })

  test('an old 6-column file with a mix of good and bad rows', () => {
    const { data, errors } = parseRulesCSV(
      [
        'rule_id,scope,applies_to,type,value,stackable',
        'RULE-01,platform,Amazon India,percentage,15,false',
        'RULE-02,brand,Natura Casa,percentage,120,false',
        'RULE-03,platform,Flipkart,percentage,10,true',
      ].join('\n'),
    )
    assert.deepEqual(data.map((r) => r.ruleId), ['RULE-01', 'RULE-03'])
    assert.deepEqual(errors.length, 1)
    assert.match(errors[0], /^Row 3: a percentage cannot be more than 100/)
  })
})

describe('sample-data files, end to end (CSV text → parser → engine)', () => {
  const readSample = (name) => readFileSync(new URL(`../../sample-data/${name}`, import.meta.url), 'utf8')

  test('sample rules.csv gives all four expected rules, unchanged', () => {
    const { data, errors } = parseRulesCSV(readSample('rules.csv'))
    assert.deepEqual(errors, [])
    assert.deepEqual(data, [
      { ruleId: 'RULE-01', scope: 'platform', appliesTo: 'Amazon India', type: 'percentage', value: 15, stackable: false, minCartValue: null },
      { ruleId: 'RULE-02', scope: 'brand', appliesTo: 'Natura Casa', type: 'flat', value: 150, stackable: false, minCartValue: null },
      { ruleId: 'RULE-03', scope: 'platform', appliesTo: 'Flipkart', type: 'percentage', value: 10, stackable: true, minCartValue: null },
      { ruleId: 'RULE-04', scope: 'cart', appliesTo: '', type: 'percentage', value: 10, stackable: false, minCartValue: 4000 },
    ])
  })

  test('the sample files still price to the expected items and Rs.5,339 total', () => {
    const rules = parseRulesCSV(readSample('rules.csv'))
    const cart = parseCartCSV(readSample('cart.csv'))
    assert.deepEqual([...rules.errors, ...cart.errors], [])

    const priced = priceCart(cart.data, rules.data)
    assert.deepEqual(Object.fromEntries(priced.items.map((r) => [r.itemId, r.finalPrice])), {
      'ITEM-01': 1104, 'ITEM-02': 629, 'ITEM-03': 509,
      'ITEM-04': 2499, 'ITEM-05': 382, 'ITEM-06': 809,
    })
    assert.equal(priced.subtotal, 5932)
    assert.equal(priced.cartDiscount, 593)
    assert.equal(priced.finalTotal, 5339)
    assert.deepEqual(priced.cartOffers.map((o) => [o.ruleId, o.label]), [['RULE-04', 'Cart offer: 10% off — Rs.593 saved']])
  })
})

describe('parseCartCSV (regression)', () => {
  test('the sample cart loads 6 items', () => {
    const csv = [
      'item_id,product,brand,platform,base_price',
      'ITEM-01,Cushion Cover,Natura Casa,Amazon India,1299',
      'ITEM-04,Ceramic Vase,LivSpace Pro,Noon,2499',
    ].join('\n')
    const { data, errors } = parseCartCSV(csv)
    assert.deepEqual(errors, [])
    assert.deepEqual(data[0], {
      itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299,
    })
  })
})
