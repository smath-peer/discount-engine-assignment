/**
 * Tests for csvParser.js — run with `npm test` (Node's built-in test runner).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRulesCSV, parseCartCSV } from './csvParser.js'
import { validateRule } from '../engine/discountRuleValidator.js'
import { priceCart } from '../engine/discountEngine.js'

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

describe('parseCartCSV: strict base_price (shared validator)', () => {
  const CART_HEADER = 'item_id,product,brand,platform,base_price'
  const parseCart = (...rows) => parseCartCSV([CART_HEADER, ...rows].join('\n'))

  test('comma-grouped and rupee-marked prices load at full value, not Rs.1', () => {
    const { data, errors } = parseCart(
      'ITEM-01,Cushion Cover,Natura Casa,Amazon India,"1,299"',
      'ITEM-02,Bed Sheet Set,Natura Casa,Flipkart,Rs.849',
      'ITEM-03,Wall Shelf,LivSpace Pro,Amazon India,"Rs.1,23,456"',
      'ITEM-04,Ceramic Vase,LivSpace Pro,Noon,₹2499',
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(data.map((item) => item.basePrice), [1299, 849, 123456, 2499])
  })

  test('decimals are still rounded to whole rupees, as before', () => {
    const { data } = parseCart('ITEM-05,Cutting Board,Nordic Basics,Amazon India,449.50')
    assert.equal(data[0].basePrice, 450)
  })

  test('text after the digits is rejected instead of being cut off', () => {
    const { data, errors } = parseCart(
      'ITEM-01,Cushion Cover,Natura Casa,Amazon India,1299abc',
      'ITEM-02,Bed Sheet Set,Natura Casa,Flipkart,1e3',
      'ITEM-03,Wall Shelf,LivSpace Pro,Amazon India,"12,99"',
    )
    assert.deepEqual(data, [])
    assert.deepEqual(errors, [
      'Row 2: base_price must be an amount in rupees such as 1299, 1,299 or Rs.1,299, got "1299abc"',
      'Row 3: base_price must be an amount in rupees such as 1299, 1,299 or Rs.1,299, got "1e3"',
      'Row 4: base_price must be an amount in rupees such as 1299, 1,299 or Rs.1,299, got "12,99"',
    ])
  })

  test('zero, negative and below-Rs.1 prices are rejected', () => {
    const { data, errors } = parseCart(
      'ITEM-01,Cushion Cover,Natura Casa,Amazon India,0',
      'ITEM-02,Bed Sheet Set,Natura Casa,Flipkart,-5',
      'ITEM-03,Wall Shelf,LivSpace Pro,Amazon India,0.4',
    )
    assert.deepEqual(data, [])
    assert.deepEqual(errors, [
      'Row 2: base_price must be at least Rs.1, got "0"',
      'Row 3: base_price must be an amount in rupees such as 1299, 1,299 or Rs.1,299, got "-5"',
      'Row 4: base_price must be at least Rs.1, got "0.4"',
    ])
  })

  test('space-only cells count as missing (they used to load as empty text)', () => {
    const { data, errors } = parseCart('  ,Cushion Cover,   ,Amazon India,1299')
    assert.deepEqual(data, [])
    assert.deepEqual(errors, ['Row 2: missing fields — item_id, brand'])
  })

  test('missing fields and a bad price in one row are reported in one message', () => {
    const { errors } = parseCart('ITEM-01,,Natura Casa,,abc')
    assert.deepEqual(errors, [
      'Row 2: missing fields — product, platform; base_price must be an amount in rupees such as 1299, 1,299 or Rs.1,299, got "abc"',
    ])
  })

  test('a missing base_price cell is reported as missing, as before', () => {
    const { errors } = parseCart('ITEM-01,Cushion Cover,Natura Casa,Amazon India,')
    assert.deepEqual(errors, ['Row 2: missing fields — base_price'])
  })

  test('good rows still load when other rows are rejected, in file order', () => {
    const { data, errors } = parseCart(
      'ITEM-01,Cushion Cover,Natura Casa,Amazon India,1299',
      'ITEM-02,Bed Sheet Set,Natura Casa,Flipkart,oops',
      'ITEM-03,Wall Shelf,LivSpace Pro,Amazon India,599',
    )
    assert.deepEqual(data.map((item) => item.itemId), ['ITEM-01', 'ITEM-03'])
    assert.equal(errors.length, 1)
    assert.match(errors[0], /^Row 3: /)
  })

  test('a header with spaces and capitals still maps to the right fields', () => {
    const { data, errors } = parseCartCSV('Item ID,Product,Brand,Platform,Base Price\nITEM-01,Lamp,Acme,Noon,"Rs.1,050"')
    assert.deepEqual(errors, [])
    assert.deepEqual(data, [{ itemId: 'ITEM-01', product: 'Lamp', brand: 'Acme', platform: 'Noon', basePrice: 1050 }])
  })
})

describe('parseRulesCSV: duplicate rules', () => {
  test('an identical repeated row is skipped, so a stackable discount is applied once', () => {
    const { data, errors } = parseRows(
      'RULE-03,platform,Flipkart,percentage,10,true,',
      'RULE-03,platform,Flipkart,percentage,10,true,',
    )
    assert.deepEqual(data.map((r) => r.ruleId), ['RULE-03'])
    assert.deepEqual(errors, [
      'Row 3: duplicate of row 2 (same rule_id "RULE-03" and same terms), skipped so the discount is not applied twice',
    ])
    // Rs.1,000 on Flipkart: 10% once is Rs.900 (it was Rs.810 when the row applied twice)
    const priced = priceCart([{ itemId: 'I1', product: 'P', brand: 'B', platform: 'Flipkart', basePrice: 1000 }], data)
    assert.equal(priced.finalTotal, 900)
    assert.deepEqual(priced.items[0].appliedRules, ['RULE-03'])
  })

  test('a repeated stackable cart rule is applied once', () => {
    const { data, errors } = parseRows('C1,cart,,percentage,10,true,1000', 'C1,cart,,percentage,10,true,1000')
    assert.equal(errors.length, 1)
    const priced = priceCart([{ itemId: 'I1', product: 'P', brand: 'B', platform: 'X', basePrice: 2000 }], data)
    assert.equal(priced.finalTotal, 1800)
    assert.equal(priced.cartOffers.length, 1)
  })

  test('a rule_id reused with different terms keeps the first row and explains the conflict', () => {
    const { data, errors } = parseRows(
      'R1,platform,Amazon India,percentage,15,false,',
      'R1,brand,Natura Casa,flat,50,true,',
    )
    assert.deepEqual(data.map((r) => [r.ruleId, r.scope]), [['R1', 'platform']])
    assert.deepEqual(errors, [
      'Row 3: rule_id "R1" is already used by row 2 with different terms, so this row was skipped. Give each offer its own rule_id',
    ])
  })

  test('rule_id is compared ignoring case and outer spaces', () => {
    const { data, errors } = parseRows('RULE-01,platform,Amazon India,percentage,15,false,', ' rule-01 ,brand,Natura Casa,flat,150,false,')
    assert.equal(data.length, 1)
    assert.match(errors[0], /^Row 3: rule_id "rule-01" is already used by row 2/)
  })

  test('the same terms under another rule_id are skipped, matching brand and platform as the engine does', () => {
    const { data, errors } = parseRows(
      'RULE-03,platform,Flipkart,percentage,10,true,',
      'RULE-07,platform, flipkart ,Percentage,10,yes,',
    )
    assert.deepEqual(data.map((r) => r.ruleId), ['RULE-03'])
    assert.deepEqual(errors, ['Row 3: same offer as row 2 (RULE-03), skipped so the discount is not applied twice'])
  })

  test('distinct offers are all kept, even when they share a brand, platform or value', () => {
    const { data, errors } = parseRows(
      'A,brand,Natura Casa,percentage,10,false,',
      'B,brand,Natura Casa,percentage,15,false,', // another value
      'C,brand,Natura Casa,percentage,10,true,', // stacks
      'D,brand,Natura Casa,flat,10,false,', // another type
      'E,platform,Natura Casa,percentage,10,false,', // another scope
      'F,brand,LivSpace Pro,percentage,10,false,', // another brand
      'G,cart,,percentage,10,false,4000',
      'H,cart,,percentage,10,false,5000', // another minimum
    )
    assert.deepEqual(errors, [])
    assert.deepEqual(data.map((r) => r.ruleId), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
  })

  test('a rejected row does not block a later valid row with the same rule_id', () => {
    const { data, errors } = parseRows('R1,brand,Natura Casa,percentage,150,false,', 'R1,brand,Natura Casa,percentage,15,false,')
    assert.deepEqual(data.map((r) => [r.ruleId, r.value]), [['R1', 15]])
    assert.equal(errors.length, 1)
    assert.match(errors[0], /^Row 2: /)
  })

  test('the sample rules have no duplicates, so the sample cart still totals Rs.5,339', () => {
    const rules = parseRulesCSV(readFileSync(new URL('../../sample-data/rules.csv', import.meta.url), 'utf8'))
    const cart = parseCartCSV(readFileSync(new URL('../../sample-data/cart.csv', import.meta.url), 'utf8'))
    assert.deepEqual(rules.errors, [])
    assert.equal(priceCart(cart.data, rules.data).finalTotal, 5339)
  })
})

describe('malformed CSV rows: good rows are kept only when row boundaries are certain', () => {
  const CART = 'item_id,product,brand,platform,base_price'
  const cart = (...rows) => parseCartCSV([CART, ...rows].join('\n'))
  const GOOD_1 = 'ITEM-01,Cushion Cover,Natura Casa,Amazon India,1299'
  const GOOD_3 = 'ITEM-03,Wall Shelf,LivSpace Pro,Amazon India,599'

  test('an unquoted comma in a price skips only that row, without guessing which value is extra', () => {
    const { data, errors, fileError } = cart(GOOD_1, 'ITEM-02,Bed Sheet Set,Natura Casa,Flipkart,1,299', GOOD_3)
    assert.equal(fileError, undefined)
    assert.deepEqual(data.map((item) => item.itemId), ['ITEM-01', 'ITEM-03'])
    assert.deepEqual(errors, [
      'Row 3: has 6 values but the header has 5, so it was skipped. ' +
        'This is often a comma inside a name or a price such as 1,299: put that value in double quotes.',
    ])
  })

  test('an unquoted comma in a product name skips only that row', () => {
    const { data, errors } = cart(GOOD_1, 'ITEM-02,Cushion Cover, Large,Natura Casa,Amazon India,1299', GOOD_3)
    assert.equal(data.length, 2)
    assert.match(errors[0], /^Row 3: has 6 values but the header has 5/)
  })

  test('the same values in double quotes are read correctly', () => {
    const { data, errors } = cart('ITEM-02,"Cushion Cover, Large",Natura Casa,Amazon India,"1,299"')
    assert.deepEqual(errors, [])
    assert.deepEqual(data[0], { itemId: 'ITEM-02', product: 'Cushion Cover, Large', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299 })
  })

  test('a row with too few values is skipped with its count', () => {
    const { data, errors } = cart(GOOD_1, 'ITEM-02,Bed Sheet Set,Flipkart,849', GOOD_3)
    assert.equal(data.length, 2)
    assert.deepEqual(errors, ['Row 3: has 4 values but the header has 5, so it was skipped.'])
  })

  test('an unclosed quote keeps the rows before it and reports that the rest could not be read', () => {
    const { data, errors } = cart(GOOD_1, 'ITEM-02,"Bed Sheet Set,Natura Casa,Flipkart,849', GOOD_3, 'ITEM-04,Ceramic Vase,LivSpace Pro,Noon,2499')
    assert.deepEqual(data.map((item) => item.itemId), ['ITEM-01'])
    assert.deepEqual(errors, [
      'Row 3: a quote mark (") is not closed on this line, so this row and the rest of the file could not be read reliably. Rows before it were read.',
    ])
  })

  test('an unclosed quote on the last line is reported the same way', () => {
    const { data, errors } = cart(GOOD_1, 'ITEM-02,"Bed Sheet Set,Natura Casa,Flipkart,849')
    assert.equal(data.length, 1)
    assert.ok(errors[0].startsWith('Row 3: a quote mark (") is not closed on this line'))
  })

  test('a quote closed on a later line is not trusted: the lines in between are not read as rows', () => {
    const { data, errors } = cart(GOOD_1, 'ITEM-02,"Bed Sheet', 'Set",Natura Casa,Flipkart,849', GOOD_3)
    assert.deepEqual(data.map((item) => item.itemId), ['ITEM-01'])
    assert.ok(errors[0].startsWith('Row 3: a quote mark (") is not closed on this line'))
  })

  test('a header missing required columns is one file error, not an error per row', () => {
    const { data, errors, fileError } = parseCartCSV('item_id,product,brand,platform,price\nITEM-01,Cushion Cover,Natura Casa,Amazon India,1299')
    assert.deepEqual(data, [])
    assert.deepEqual(errors, [])
    assert.equal(
      fileError,
      'The header row is missing the column base_price. The first line must name the columns: item_id, product, brand, platform, base_price.',
    )
  })

  test('an empty file has no rows and no raw parser message', () => {
    assert.deepEqual(parseCartCSV(''), { data: [], errors: [] })
    assert.deepEqual(parseRulesCSV('  \n '), { data: [], errors: [] })
  })

  test('values are always separated by commas, never by a guessed separator', () => {
    const { fileError } = parseCartCSV('item_id;product;brand;platform;base_price\nITEM-01;Cushion Cover;Natura Casa;Amazon India;1299')
    assert.match(fileError, /^The header row is missing the columns item_id, product, brand, platform, base_price\./)
  })

  test('rules: a malformed row is skipped and the other rules load (an older 6-column file still loads)', () => {
    const { data, errors } = parseRows(
      'RULE-01,platform,Amazon India,percentage,15,false,',
      'RULE-02,brand,Natura Casa,flat,150,false', // one value short of the 7-column header
      'RULE-03,platform,Flipkart,percentage,10,true,,extra',
      'RULE-04,cart,,percentage,10,false,4000',
    )
    assert.deepEqual(data.map((r) => r.ruleId), ['RULE-01', 'RULE-04'])
    assert.deepEqual(errors, [
      'Row 3: has 6 values but the header has 7, so it was skipped.',
      'Row 4: has 8 values but the header has 7, so it was skipped. ' +
        'This is often a comma inside a name or a price such as 1,299: put that value in double quotes.',
    ])
    assert.deepEqual(parseRulesCSV('rule_id,scope,applies_to,type,value,stackable\nR1,brand,Natura Casa,flat,150,false').errors, [])
  })

  test('the sample files still read cleanly and price to Rs.5,339', () => {
    const rules = parseRulesCSV(readFileSync(new URL('../../sample-data/rules.csv', import.meta.url), 'utf8'))
    const cartFile = parseCartCSV(readFileSync(new URL('../../sample-data/cart.csv', import.meta.url), 'utf8'))
    assert.deepEqual([rules.errors, cartFile.errors], [[], []])
    assert.equal(priceCart(cartFile.data, rules.data).finalTotal, 5339)
  })
})
