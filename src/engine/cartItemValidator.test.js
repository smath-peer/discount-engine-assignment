/**
 * Tests for cartItemValidator.js — run with `npm test` (Node's built-in test runner).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrice, validateCartItem, CART_ITEM_FIELDS } from './cartItemValidator.js'

const ROW = Object.freeze({
  itemId: 'ITEM-01',
  product: 'Cushion Cover',
  brand: 'Natura Casa',
  platform: 'Amazon India',
  basePrice: '1299',
})

describe('parsePrice: accepted amounts', () => {
  const cases = [
    ['1299', 1299],
    ['1,299', 1299],
    ['Rs.1,299', 1299],
    ['Rs. 1,299', 1299],
    ['Rs 1,299', 1299],
    ['rs1299', 1299],
    ['RS.1,299', 1299],
    ['₹1,299', 1299],
    ['₹ 1,299', 1299],
    ['INR 1,299', 1299],
    ['Rs.1,299/-', 1299],
    ['  1,299  ', 1299],
    ['123,456', 123456],
    ['1,234,567', 1234567],
    ['1,23,456', 123456],
    ['12,34,567', 1234567],
    ['449.50', 450],
    ['449.49', 449],
    ['849.5', 850],
    ['1,299.00', 1299],
    ['1', 1],
    ['0.5', 1],
    [1299, 1299],
  ]
  for (const [text, value] of cases) {
    test(`${JSON.stringify(text)} → ${value}`, () => {
      assert.deepEqual(parsePrice(text), { value })
    })
  }
})

describe('parsePrice: rejected amounts', () => {
  const formatCases = [
    '', '   ', 'abc', '1299abc', 'Rs.', '-5', '-1,299', '+5', '1e3', '0x10', '.5', '5.',
    '1 299', '12,99', '1,2,99', '1,,299', ',1299', '1299,', '123,45,678', '1,299.999',
    '$1,299', '1299 Rs', 'Rs.Rs.1299', 'NaN', 'Infinity', '99999999999999999999',
  ]
  for (const text of formatCases) {
    test(`${JSON.stringify(text)} is not a readable amount`, () => {
      assert.deepEqual(parsePrice(text), { error: 'price_format' })
    })
  }

  for (const text of ['0', '0.00', 'Rs.0', '0.49']) {
    test(`${JSON.stringify(text)} is below Rs.1`, () => {
      assert.deepEqual(parsePrice(text), { error: 'price_too_small' })
    })
  }

  test('non-text values are rejected', () => {
    for (const value of [null, undefined, {}, [], true]) {
      assert.deepEqual(parsePrice(value), { error: 'price_format' })
    }
  })
})

describe('validateCartItem', () => {
  test('a complete row becomes a trimmed CartItem', () => {
    const { item, errors } = validateCartItem({
      itemId: ' ITEM-01 ', product: ' Cushion Cover ', brand: 'Natura Casa ', platform: ' Amazon India', basePrice: 'Rs.1,299',
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(item, { itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299 })
  })

  test('only the CartItem fields are kept', () => {
    const { item } = validateCartItem({ ...ROW, quantity: '2', note: 'gift' })
    assert.deepEqual(Object.keys(item), CART_ITEM_FIELDS)
  })

  test('blank and space-only fields count as missing, all reported together', () => {
    const { item, errors } = validateCartItem({ itemId: '  ', product: '', brand: undefined, platform: null, basePrice: ' ' })
    assert.equal(item, null)
    assert.deepEqual(errors, CART_ITEM_FIELDS.map((field) => ({ field, code: 'missing' })))
  })

  test('a missing field and a bad price are both reported', () => {
    const { item, errors } = validateCartItem({ ...ROW, brand: '', basePrice: '1,2,99' })
    assert.equal(item, null)
    assert.deepEqual(errors, [
      { field: 'brand', code: 'missing' },
      { field: 'basePrice', code: 'price_format', received: '1,2,99' },
    ])
  })

  test('a price below Rs.1 is reported with the text received', () => {
    const { errors } = validateCartItem({ ...ROW, basePrice: ' 0 ' })
    assert.deepEqual(errors, [{ field: 'basePrice', code: 'price_too_small', received: '0' }])
  })

  test('the input is not changed', () => {
    const input = { ...ROW }
    validateCartItem(input)
    assert.deepEqual(input, ROW)
  })

  test('no argument means every field is missing', () => {
    assert.equal(validateCartItem().errors.length, CART_ITEM_FIELDS.length)
  })
})
