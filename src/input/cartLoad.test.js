/**
 * Tests for cartLoad.js — run with `npm test` (Node's built-in test runner).
 * PDFs are read with the PDF.js legacy build, passed in as the app's loader would.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  readCartFile, applyCartLoad, undoCartLoad, detectCartFormat,
  EMPTY_CART, INITIAL_CART_STATE, CART_FILE_MESSAGES,
} from './cartLoad.js'
import { PDF_READ_MESSAGES } from './pdf/readPdfText.js'
import { PDF_FILE_ERRORS } from './pdfCartParser.js'
import { parseRulesCSV } from './csvParser.js'
import { computeResults } from '../appRules.js'

const projectFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url))
const fileFrom = (path, name = path.split('/').pop(), type = '') => new File([projectFile(path)], name, { type })
const textFile = (text, name, type = 'text/csv') => new File([text], name, { type })
const loadPdfjs = async () => pdfjs
const read = (file) => readCartFile(file, { loadPdfjs })

const SAMPLE_RULES = parseRulesCSV(projectFile('sample-data/rules.csv').toString('utf8')).data
const encode = (text) => new TextEncoder().encode(text)

// ── Reading files ────────────────────────────────────────────────

describe('detectCartFormat', () => {
  test('a PDF signature wins over the name', () => {
    assert.equal(detectCartFormat({ name: 'cart.csv', type: 'text/csv', bytes: encode('%PDF-1.4 ...') }), 'pdf')
  })
  test('.pdf without a signature is still sent to the PDF reader, which explains', () => {
    assert.equal(detectCartFormat({ name: 'cart.PDF', type: '', bytes: encode('hello') }), 'pdf')
  })
  test('.csv, .txt and CSV or plain-text types are read as CSV', () => {
    for (const [name, type] of [['cart.csv', ''], ['CART.CSV', ''], ['cart.txt', ''], ['cart', 'text/csv'], ['cart', 'application/vnd.ms-excel; csv'], ['cart', 'text/plain']]) {
      assert.equal(detectCartFormat({ name, type, bytes: encode('a,b') }), 'csv', `${name} ${type}`)
    }
  })
  test('anything else is unsupported', () => {
    for (const name of ['cart.xlsx', 'photo.jpg', 'cart']) {
      assert.equal(detectCartFormat({ name, type: '', bytes: encode('x') }), 'unsupported', name)
    }
  })
})

describe('readCartFile', () => {
  test('the sample CSV and the sample PDF give the same items', async () => {
    const csv = await read(fileFrom('sample-data/cart.csv', 'cart.csv', 'text/csv'))
    const pdf = await read(fileFrom('sample-data/cart.pdf', 'cart.pdf', 'application/pdf'))
    assert.equal(csv.format, 'csv')
    assert.equal(pdf.format, 'pdf')
    assert.equal(pdf.data.length, 6)
    assert.deepEqual(pdf.data, csv.data)
    assert.deepEqual([csv.errors, pdf.errors, csv.fileError, pdf.fileError], [[], [], null, null])
  })

  test('a CSV with a byte-order mark still reads its first column', async () => {
    const result = await read(textFile('﻿item_id,product,brand,platform,base_price\nITEM-01,Lamp,Acme,Noon,"1,050"', 'cart.csv'))
    assert.deepEqual(result.data, [{ itemId: 'ITEM-01', product: 'Lamp', brand: 'Acme', platform: 'Noon', basePrice: 1050 }])
  })

  test('a binary file named .csv is refused', async () => {
    const result = await read(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])], 'cart.csv'))
    assert.deepEqual(result, { format: 'csv', data: [], errors: [], notes: [], fileError: CART_FILE_MESSAGES.not_csv })
  })

  test('an unsupported type is refused without reading further', async () => {
    let loaded = false
    const result = await readCartFile(textFile('x', 'cart.xlsx', ''), { loadPdfjs: async () => { loaded = true } })
    assert.equal(result.fileError, CART_FILE_MESSAGES.unsupported)
    assert.equal(loaded, false)
  })

  test('PDF.js is loaded only for PDFs', async () => {
    let loads = 0
    await readCartFile(fileFrom('sample-data/cart.csv', 'cart.csv'), { loadPdfjs: async () => { loads++; return pdfjs } })
    assert.equal(loads, 0)
    await readCartFile(fileFrom('sample-data/cart.pdf'), { loadPdfjs: async () => { loads++; return pdfjs } })
    assert.equal(loads, 1)
  })

  test('if the PDF reader cannot be loaded, the customer is told and nothing throws', async () => {
    const result = await readCartFile(fileFrom('sample-data/cart.pdf'), { loadPdfjs: async () => { throw new Error('offline') } })
    assert.equal(result.fileError, CART_FILE_MESSAGES.pdf_reader_unavailable)
    assert.deepEqual(result.data, [])
  })

  const unusable = [
    ['password.pdf', PDF_READ_MESSAGES.password],
    ['scanned.pdf', PDF_READ_MESSAGES.scanned],
    ['empty.pdf', PDF_READ_MESSAGES.empty],
    ['damaged.pdf', PDF_READ_MESSAGES.damaged],
    ['not-a-pdf.pdf', PDF_READ_MESSAGES.not_pdf],
    ['no-table.pdf', PDF_FILE_ERRORS.no_table],
    ['header-only.pdf', PDF_FILE_ERRORS.no_rows],
  ]
  for (const [name, message] of unusable) {
    test(`${name} gives no items and its message`, async () => {
      const result = await read(fileFrom(`test-fixtures/pdf/${name}`))
      assert.deepEqual(result.data, [])
      assert.equal(result.fileError, message)
    })
  }

  test('a file that cannot be opened is reported, not thrown', async () => {
    const result = await read({ name: 'cart.csv', type: 'text/csv', arrayBuffer: async () => { throw new Error('gone') } })
    assert.equal(result.fileError, 'This file could not be opened. Please choose it again.')
  })
})

// ── Replacing the cart ───────────────────────────────────────────

const csvCart = async () => read(fileFrom('sample-data/cart.csv', 'cart.csv'))
const loadInto = async (state, path, name, calculated = false) =>
  applyCartLoad(state, await read(fileFrom(path, name)), { fileName: name, calculated })

describe('applyCartLoad', () => {
  test('the first cart loads with a plain success and nothing to undo', async () => {
    const { state, notice } = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    assert.equal(state.cart.items.length, 6)
    assert.deepEqual([state.cart.fileName, state.cart.format, state.undo], ['cart.csv', 'csv', null])
    assert.deepEqual(notice, { tone: 'success', title: '6 items loaded from cart.csv', lines: [], skipped: [], notes: [], canUndo: false })
  })

  test('a cart CSV whose header lacks a column keeps the current cart and says which column', async () => {
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    const bad = await read(textFile('item_id,product,brand,platform,price\nITEM-01,Cushion Cover,Natura Casa,Amazon India,1299', 'bad.csv'))
    const { state, notice } = applyCartLoad(first.state, bad, { fileName: 'bad.csv', calculated: true })
    assert.equal(state.cart, first.state.cart)
    assert.equal(notice.tone, 'danger')
    assert.deepEqual(notice.lines, [
      'The header row is missing the column base_price. The first line must name the columns: item_id, product, brand, platform, base_price.',
      'Your cart is unchanged: 6 items from cart.csv.',
    ])
  })

  test('a cart CSV with one malformed row loads the other rows and lists that row', async () => {
    const text = 'item_id,product,brand,platform,base_price\nITEM-01,Cushion Cover,Natura Casa,Amazon India,1299\nITEM-02,Bed Sheet Set,Natura Casa,Flipkart,1,299'
    const { state, notice } = applyCartLoad(INITIAL_CART_STATE, await read(textFile(text, 'cart.csv')), { fileName: 'cart.csv' })
    assert.equal(state.cart.items.length, 1)
    assert.equal(notice.tone, 'warning')
    assert.match(notice.skipped[0], /^Row 3: has 6 values but the header has 5/)
  })

  test('a new file replaces the whole cart and can be undone', async () => {
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    const { state, notice } = await loadInto(first.state, 'sample-data/cart.pdf', 'cart.pdf', true)
    assert.equal(state.cart.fileName, 'cart.pdf')
    assert.equal(state.undo, first.state.cart)
    assert.deepEqual(notice, {
      tone: 'success',
      title: 'Cart replaced: 6 items from cart.pdf',
      lines: ['It replaced your previous cart: 6 items from cart.csv.', 'Prices were recalculated with the current offers.'],
      skipped: [], notes: [], canUndo: true,
    })
  })

  test('a partly usable file replaces the cart, as a warning listing every skipped row', async () => {
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    const { state, notice } = await loadInto(first.state, 'test-fixtures/pdf/malformed-rows.pdf', 'order.pdf')
    assert.equal(state.cart.items.length, 2)
    assert.equal(state.cart.skipped.length, 5)
    assert.equal(notice.tone, 'warning')
    assert.equal(notice.title, 'Cart replaced: 2 items from order.pdf, 5 rows skipped')
    assert.deepEqual(notice.lines, [
      'It replaced your previous cart: 6 items from cart.csv.',
      'Skipped rows are not in your cart. Check them in the PDF, or upload the cart as a CSV to include them.',
    ])
    assert.deepEqual(notice.skipped, state.cart.skipped)
    assert.equal(notice.notes.length, 2) // the Total line, and that it differs from the rows read
    assert.equal(notice.canUndo, true)
  })

  test('a CSV with skipped rows gives CSV advice', async () => {
    const result = await read(textFile('item_id,product,brand,platform,base_price\nITEM-01,Lamp,Acme,Noon,100\nITEM-02,Vase,Acme,Noon,abc', 'mixed.csv'))
    const { notice } = applyCartLoad(INITIAL_CART_STATE, result, { fileName: 'mixed.csv' })
    assert.equal(notice.title, '1 item loaded from mixed.csv, 1 row skipped')
    assert.deepEqual(notice.lines, ['Skipped rows are not in your cart. Fix them in the file and choose it again to include them.'])
  })

  for (const name of ['scanned.pdf', 'password.pdf', 'no-table.pdf', 'not-a-pdf.pdf']) {
    test(`an unusable file (${name}) keeps the current cart and says so`, async () => {
      const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
      const { state, notice } = await loadInto(first.state, `test-fixtures/pdf/${name}`, name)
      assert.equal(state.cart, first.state.cart) // the very same cart object: nothing changed
      assert.equal(notice.tone, 'danger')
      assert.equal(notice.title, `Nothing was loaded from ${name}`)
      assert.equal(notice.lines.at(-1), 'Your cart is unchanged: 6 items from cart.csv.')
      assert.equal(notice.canUndo, false)
    })
  }

  test('a file whose rows are all unusable keeps the cart and lists each reason', async () => {
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    const bad = await read(textFile('item_id,product,brand,platform,base_price\nITEM-09,Lamp,Acme,Noon,abc\n,Vase,Acme,Noon,100', 'bad.csv'))
    const { state, notice } = applyCartLoad(first.state, bad, { fileName: 'bad.csv' })
    assert.equal(state.cart, first.state.cart)
    assert.deepEqual(notice.lines, ['2 rows found, but none could be used:', 'Your cart is unchanged: 6 items from cart.csv.'])
    assert.equal(notice.skipped.length, 2)
  })

  test('an unusable first file leaves no cart and says so', async () => {
    const { state, notice } = await loadInto(INITIAL_CART_STATE, 'test-fixtures/pdf/scanned.pdf', 'scan.pdf')
    assert.equal(state.cart, EMPTY_CART)
    assert.deepEqual(notice.lines, [PDF_READ_MESSAGES.scanned, 'No cart is loaded yet.'])
  })

  test('a CSV with a header and no rows is "no cart rows", not a success', async () => {
    const { state, notice } = applyCartLoad(INITIAL_CART_STATE, await read(textFile('item_id,product,brand,platform,base_price\n', 'empty.csv')), { fileName: 'empty.csv' })
    assert.equal(state.cart, EMPTY_CART)
    assert.equal(notice.tone, 'danger')
    assert.equal(notice.lines[0], 'The file has no cart rows.')
  })

  test('a failed upload withdraws the earlier Undo but keeps the cart', async () => {
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    const second = await loadInto(first.state, 'sample-data/cart.pdf', 'cart.pdf')
    const third = await loadInto(second.state, 'test-fixtures/pdf/scanned.pdf', 'scan.pdf')
    assert.equal(third.state.cart, second.state.cart)
    assert.equal(third.state.undo, null)
  })

  test('the state passed in is never changed', async () => {
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    const frozen = structuredClone(first.state)
    await loadInto(first.state, 'sample-data/cart.pdf', 'cart.pdf')
    await loadInto(first.state, 'test-fixtures/pdf/scanned.pdf', 'scan.pdf')
    assert.deepEqual(first.state, frozen)
  })
})

describe('undoCartLoad', () => {
  test('restores the replaced cart exactly, once', async () => {
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    const second = await loadInto(first.state, 'test-fixtures/pdf/malformed-rows.pdf', 'order.pdf')
    const undone = undoCartLoad(second.state, { calculated: true })
    assert.equal(undone.state.cart, first.state.cart)
    assert.equal(undone.state.undo, null)
    assert.deepEqual(undone.notice, {
      tone: 'success',
      title: 'Previous cart restored: 6 items from cart.csv',
      lines: ['Prices were recalculated with the current offers.'],
      skipped: [], notes: [], canUndo: false,
    })
    assert.equal(undoCartLoad(undone.state), null)
  })

  test('a restored cart with skipped rows lists them again, as a warning', async () => {
    const first = await loadInto(INITIAL_CART_STATE, 'test-fixtures/pdf/malformed-rows.pdf', 'order.pdf')
    const second = await loadInto(first.state, 'sample-data/cart.pdf', 'cart.pdf')
    const undone = undoCartLoad(second.state)
    assert.equal(undone.notice.tone, 'warning')
    assert.equal(undone.notice.skipped.length, 5)
  })

  test('nothing to undo before any replacement', () => {
    assert.equal(undoCartLoad(INITIAL_CART_STATE), null)
  })
})

describe('re-pricing follows the cart (results are derived, never stored)', () => {
  test('replacing, failing and undoing each give the prices of the cart in use', async () => {
    const price = (state) => computeResults({ hasCalculated: true, activeRules: SAMPLE_RULES, cartItems: state.cart.items }).finalTotal
    const first = applyCartLoad(INITIAL_CART_STATE, await csvCart(), { fileName: 'cart.csv' })
    assert.equal(price(first.state), 5339)

    const partial = await loadInto(first.state, 'test-fixtures/pdf/malformed-rows.pdf', 'order.pdf')
    // Natura Casa cushion (Amazon India): 1,299 - 15% = 1,104; bed sheet set: 849 - 150 = 699, - 10% = 629; 1,733 < 4,000
    assert.equal(price(partial.state), 1733)

    const failed = await loadInto(partial.state, 'test-fixtures/pdf/scanned.pdf', 'scan.pdf')
    assert.equal(price(failed.state), 1733)

    const back = await loadInto(failed.state, 'sample-data/cart.pdf', 'cart.pdf')
    assert.equal(price(back.state), 5339)
    assert.equal(price(undoCartLoad(back.state).state), 1733)
  })
})
