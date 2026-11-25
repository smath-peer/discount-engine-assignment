/**
 * Tests for pdfCartParser.js — run with `npm test` (Node's built-in test runner).
 *
 * These build the positioned text directly, so every layout case is exact and
 * no PDF library is involved. src/input/pdf/readPdfText.test.js covers real PDFs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCartPdf, PDF_FILE_ERRORS, PDF_CART_COLUMNS } from './pdfCartParser.js'

// ── Building positioned text ─────────────────────────────────────

/** One piece of text; width is roughly 5 points per character at size 10. */
const text = (str, x, y, fontSize = 10) => ({ str, x, y, width: str.length * fontSize * 0.5, fontSize })

const COLUMN_X = { product: 50, brand: 220, platform: 345, basePrice: 465 }
const HEADER_Y = 728
const ROW_GAP = 26

const headerLine = (y = HEADER_Y, x = COLUMN_X) => [
  text('Product', x.product, y),
  text('Brand', x.brand, y),
  text('Platform', x.platform, y),
  text('Base Price', x.basePrice, y),
]

/** A row's text at a vertical position: [product, brand, platform, price], '' for an empty cell. */
const rowLine = (cells, y, x = COLUMN_X) =>
  ['product', 'brand', 'platform', 'basePrice']
    .map((field, i) => cells[i] && text(cells[i], x[field], y))
    .filter(Boolean)

/** A page with a header and rows spaced ROW_GAP apart, plus any extra pieces. */
const page = (rows, { pageNumber = 1, extra = [], header = true } = {}) => ({
  pageNumber,
  items: [
    ...(header ? headerLine() : []),
    ...rows.flatMap((cells, i) => rowLine(cells, HEADER_Y - ROW_GAP * (i + 1))),
    ...extra,
  ],
})

const BRIEF_ROWS = [
  ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
  ['Bed Sheet Set', 'Natura Casa', 'Flipkart', 'Rs.849'],
  ['Wall Shelf', 'LivSpace Pro', 'Amazon India', 'Rs.599'],
  ['Ceramic Vase', 'LivSpace Pro', 'Noon', 'Rs.2,499'],
  ['Cutting Board', 'Nordic Basics', 'Amazon India', 'Rs.449'],
  ['Desk Organiser', 'Nordic Basics', 'Flipkart', 'Rs.899'],
]

const BRIEF_ITEMS = [
  { itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299 },
  { itemId: 'ITEM-02', product: 'Bed Sheet Set', brand: 'Natura Casa', platform: 'Flipkart', basePrice: 849 },
  { itemId: 'ITEM-03', product: 'Wall Shelf', brand: 'LivSpace Pro', platform: 'Amazon India', basePrice: 599 },
  { itemId: 'ITEM-04', product: 'Ceramic Vase', brand: 'LivSpace Pro', platform: 'Noon', basePrice: 2499 },
  { itemId: 'ITEM-05', product: 'Cutting Board', brand: 'Nordic Basics', platform: 'Amazon India', basePrice: 449 },
  { itemId: 'ITEM-06', product: 'Desk Organiser', brand: 'Nordic Basics', platform: 'Flipkart', basePrice: 899 },
]

// ── Tests ────────────────────────────────────────────────────────

describe('parseCartPdf: the brief cart', () => {
  test('six rows become the six CartItems with generated IDs', () => {
    const result = parseCartPdf([page(BRIEF_ROWS)])
    assert.deepEqual(result, { data: BRIEF_ITEMS, errors: [], notes: [], fileError: null })
  })

  test('text above the header (title, order number) is ignored', () => {
    const extra = [text('Cart', 40, 780, 14), text('Order #OP-9921 | Date: 15 Jan 2025', 40, 758)]
    assert.deepEqual(parseCartPdf([page(BRIEF_ROWS, { extra })]).data, BRIEF_ITEMS)
  })

  test('the order of pieces in the PDF does not matter, only their positions', () => {
    const shuffled = page(BRIEF_ROWS)
    shuffled.items.reverse()
    assert.deepEqual(parseCartPdf([shuffled]).data, BRIEF_ITEMS)
  })

  test('pieces on the same row a little off the baseline still form one row', () => {
    const items = [...headerLine(), text('Cushion Cover', 50, 702.4), text('Natura Casa', 220, 701.6), text('Amazon India', 345, 702), text('Rs.1,299', 465, 701.8)]
    assert.deepEqual(parseCartPdf([{ pageNumber: 1, items }]).data, [BRIEF_ITEMS[0]])
  })

  test('the input is not changed', () => {
    const pages = [page(BRIEF_ROWS)]
    const copy = structuredClone(pages)
    parseCartPdf(pages)
    assert.deepEqual(pages, copy)
  })

  test('the expected columns are the brief’s four', () => {
    assert.deepEqual(PDF_CART_COLUMNS.map((c) => c.label), ['Product', 'Brand', 'Platform', 'Base Price'])
  })
})

describe('parseCartPdf: finding the header', () => {
  test('labels in any case, split into words or with a unit are recognised', () => {
    const items = [
      text('PRODUCT', 50, HEADER_Y), text('brand', 220, HEADER_Y), text('Platform', 345, HEADER_Y),
      text('Base', 465, HEADER_Y), text('Price (Rs.)', 490, HEADER_Y),
      ...rowLine(BRIEF_ROWS[0], 702),
    ]
    assert.deepEqual(parseCartPdf([{ pageNumber: 1, items }]).data, [BRIEF_ITEMS[0]])
  })

  test('columns in a different order are read by position', () => {
    const x = { brand: 50, product: 160, basePrice: 330, platform: 430 }
    const items = [
      text('Brand', x.brand, HEADER_Y), text('Product', x.product, HEADER_Y),
      text('Base Price', x.basePrice, HEADER_Y), text('Platform', x.platform, HEADER_Y),
      ...rowLine(BRIEF_ROWS[0], 702, x),
    ]
    assert.deepEqual(parseCartPdf([{ pageNumber: 1, items }]).data, [BRIEF_ITEMS[0]])
  })

  test('an extra column such as S.No is ignored, not merged into a neighbour', () => {
    const items = [
      text('S.No', 20, HEADER_Y), ...headerLine(), text('Note', 420, HEADER_Y),
      text('1', 22, 702), ...rowLine(BRIEF_ROWS[0], 702), text('gift', 422, 702),
    ]
    assert.deepEqual(parseCartPdf([{ pageNumber: 1, items }]).data, [BRIEF_ITEMS[0]])
  })

  test('a price wider than its header and starting to its left stays in the price column', () => {
    const items = [...headerLine(), ...rowLine(BRIEF_ROWS.slice(0, 3)[0], 702).slice(0, 3), text('Rs.1,23,456', 455, 702)]
    assert.equal(parseCartPdf([{ pageNumber: 1, items }]).data[0].basePrice, 123456)
  })

  test('no header line means no table', () => {
    const items = BRIEF_ROWS.flatMap((cells, i) => rowLine(cells, 700 - i * ROW_GAP))
    assert.deepEqual(parseCartPdf([{ pageNumber: 1, items }]), { data: [], errors: [], notes: [], fileError: PDF_FILE_ERRORS.no_table })
  })

  test('a header missing one of the four labels is not a header', () => {
    const items = [text('Product', 50, HEADER_Y), text('Brand', 220, HEADER_Y), text('Price', 465, HEADER_Y), ...rowLine(BRIEF_ROWS[0], 702)]
    assert.equal(parseCartPdf([{ pageNumber: 1, items }]).fileError, PDF_FILE_ERRORS.no_table)
  })

  test('a header with no rows under it reports no rows', () => {
    assert.deepEqual(parseCartPdf([page([])]), { data: [], errors: [], notes: [], fileError: PDF_FILE_ERRORS.no_rows })
  })

  test('no pages, or pages with no text, mean no table', () => {
    assert.equal(parseCartPdf([]).fileError, PDF_FILE_ERRORS.no_table)
    assert.equal(parseCartPdf(undefined).fileError, PDF_FILE_ERRORS.no_table)
    assert.equal(parseCartPdf([{ pageNumber: 1, items: [] }]).fileError, PDF_FILE_ERRORS.no_table)
  })
})

describe('parseCartPdf: incomplete and unreadable rows', () => {
  test('each problem row is skipped with its row number, product and reason; good rows still load', () => {
    const result = parseCartPdf([page([
      BRIEF_ROWS[0],
      ['Wall Shelf', '', '', 'Rs.599'],
      ['Ceramic Vase', 'LivSpace Pro', 'Noon', 'Rs.24,99'],
      ['Cutting Board', 'Nordic Basics', 'Amazon India', 'TBD'],
      ['Desk Organiser', 'Nordic Basics', 'Flipkart', 'Rs.0'],
      ['', 'Natura Casa', 'Flipkart', 'Rs.849'],
      BRIEF_ROWS[1],
    ])])
    assert.deepEqual(result.errors, [
      'Row 2 (Wall Shelf): missing Brand, Platform',
      'Row 3 (Ceramic Vase): Base Price "Rs.24,99" is not a readable amount (for example Rs.1,299)',
      'Row 4 (Cutting Board): Base Price "TBD" is not a readable amount (for example Rs.1,299)',
      'Row 5 (Desk Organiser): Base Price must be at least Rs.1, got "Rs.0"',
      'Row 6: missing Product',
    ])
    // Accepted rows are numbered without gaps
    assert.deepEqual(result.data, [BRIEF_ITEMS[0], { ...BRIEF_ITEMS[1], itemId: 'ITEM-02' }])
    assert.equal(result.fileError, null)
  })

  test('a one-column line between rows is reported as an incomplete row, not merged or dropped', () => {
    const result = parseCartPdf([page([BRIEF_ROWS[0], ['Desk Lamp', '', '', ''], BRIEF_ROWS[1]])])
    assert.deepEqual(result.errors, ['Row 2 (Desk Lamp): missing Brand, Platform, Base Price'])
    assert.deepEqual(result.data.map((item) => item.product), ['Cushion Cover', 'Bed Sheet Set'])
  })

  test('a lone price between rows is reported, never added to the row above', () => {
    const result = parseCartPdf([page([BRIEF_ROWS[0], ['', '', '', 'Rs.100'], BRIEF_ROWS[1]])])
    assert.deepEqual(result.errors, ['Row 2: missing Product, Brand, Platform'])
    assert.equal(result.data[0].basePrice, 1299)
  })

  test('when every row is unusable there is no data, but each reason is listed', () => {
    const result = parseCartPdf([page([['Wall Shelf', '', '', 'Rs.599'], ['Lamp', 'Acme', 'Noon', 'free']])])
    assert.deepEqual(result.data, [])
    assert.equal(result.errors.length, 2)
    assert.equal(result.fileError, null)
  })

  test('the same product twice is kept as two items', () => {
    const result = parseCartPdf([page([BRIEF_ROWS[0], BRIEF_ROWS[0]])])
    assert.deepEqual(result.data.map((item) => item.itemId), ['ITEM-01', 'ITEM-02'])
  })
})

describe('parseCartPdf: wrapped cells, totals and notes', () => {
  test('a product name wrapped onto a second, closer line joins its row', () => {
    const items = [
      ...headerLine(),
      ...rowLine(['Handwoven Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'], 702),
      text('(Set of 2)', 50, 690),
      ...rowLine(BRIEF_ROWS[1], 664),
      ...rowLine(BRIEF_ROWS[2], 638),
    ]
    const result = parseCartPdf([{ pageNumber: 1, items }])
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.data.map((item) => item.product), ['Handwoven Cushion Cover (Set of 2)', 'Bed Sheet Set', 'Wall Shelf'])
  })

  test('a name wrapped over three lines joins in reading order', () => {
    const items = [
      ...headerLine(),
      ...rowLine(['Handwoven', 'Natura Casa', 'Amazon India', 'Rs.1,299'], 702),
      text('Cushion Cover', 50, 690),
      text('(Set of 2)', 50, 678),
      ...rowLine(BRIEF_ROWS[1], 652),
      ...rowLine(BRIEF_ROWS[2], 626),
    ]
    assert.equal(parseCartPdf([{ pageNumber: 1, items }]).data[0].product, 'Handwoven Cushion Cover (Set of 2)')
  })

  test('with a single row, a wrapped line one line-height below still joins it', () => {
    const items = [...headerLine(), ...rowLine(['Handwoven Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'], 702), text('(Set of 2)', 50, 690)]
    const result = parseCartPdf([{ pageNumber: 1, items }])
    assert.deepEqual(result.data.map((item) => item.product), ['Handwoven Cushion Cover (Set of 2)'])
  })

  test('in a tightly spaced table, a one-column line at row spacing is a row, not a wrap', () => {
    const items = [
      ...headerLine(),
      ...rowLine(BRIEF_ROWS[0], 712), ...rowLine(BRIEF_ROWS[1], 698), ...rowLine(BRIEF_ROWS[2], 684),
      text('Desk Lamp', 50, 670),
      ...rowLine(BRIEF_ROWS[3], 656),
    ]
    const result = parseCartPdf([{ pageNumber: 1, items }])
    assert.deepEqual(result.errors, ['Row 4 (Desk Lamp): missing Brand, Platform, Base Price'])
    assert.equal(result.data.length, 4)
  })

  test('a "Total" line is not read as an item, and says so', () => {
    const extra = [text('Total', 50, HEADER_Y - ROW_GAP * 3), text('Rs.2,148', 465, HEADER_Y - ROW_GAP * 3)]
    const result = parseCartPdf([page(BRIEF_ROWS.slice(0, 2), { extra })])
    assert.equal(result.data.length, 2)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.notes, ['The "Total Rs.2,148" line was not read as an item; totals are calculated from the items.'])
  })

  test('subtotal and grand total lines are treated the same way', () => {
    for (const label of ['Subtotal', 'Sub-total', 'Grand Total', 'TOTAL']) {
      const extra = [text(label, 50, HEADER_Y - ROW_GAP * 2), text('Rs.1,299', 465, HEADER_Y - ROW_GAP * 2)]
      const result = parseCartPdf([page([BRIEF_ROWS[0]], { extra })])
      assert.equal(result.notes.length, 1, label)
      assert.equal(result.data.length, 1, label)
    }
  })

  test('a product whose name starts with "Total" but has a brand is still an item', () => {
    const result = parseCartPdf([page([['Total Care Kit', 'Acme', 'Noon', 'Rs.399']])])
    assert.equal(result.data[0].product, 'Total Care Kit')
    assert.deepEqual(result.notes, [])
  })

  test('notes and page numbers below the table are ignored', () => {
    const extra = [text('Prices include taxes. Thank you for shopping.', 40, 120, 8), text('Page 1 of 1', 40, 40, 8)]
    const result = parseCartPdf([page(BRIEF_ROWS, { extra })])
    assert.deepEqual(result, { data: BRIEF_ITEMS, errors: [], notes: [], fileError: null })
  })
})

describe('parseCartPdf: several pages', () => {
  test('a header repeated on the next page continues the table', () => {
    const pages = [page(BRIEF_ROWS.slice(0, 4)), page(BRIEF_ROWS.slice(4), { pageNumber: 2 })]
    assert.deepEqual(parseCartPdf(pages).data, BRIEF_ITEMS)
  })

  test('a next page without a header keeps the previous columns', () => {
    const page2 = { pageNumber: 2, items: BRIEF_ROWS.slice(4).flatMap((cells, i) => rowLine(cells, 780 - i * ROW_GAP)) }
    assert.deepEqual(parseCartPdf([page(BRIEF_ROWS.slice(0, 4)), page2]).data, BRIEF_ITEMS)
  })

  test('pages before the table starts (a cover page) are ignored', () => {
    const cover = { pageNumber: 1, items: [text('Order summary', 50, 700, 14), text('Customer copy', 50, 680)] }
    assert.deepEqual(parseCartPdf([cover, { ...page(BRIEF_ROWS), pageNumber: 2 }]).data, BRIEF_ITEMS)
  })

  test('a page title above rows on a page without a header is ignored', () => {
    const page2 = {
      pageNumber: 2,
      items: [text('Cart (continued)', 40, 800, 14), ...BRIEF_ROWS.slice(4).flatMap((cells, i) => rowLine(cells, 760 - i * ROW_GAP))],
    }
    const result = parseCartPdf([page(BRIEF_ROWS.slice(0, 4)), page2])
    assert.deepEqual(result.data, BRIEF_ITEMS)
    assert.deepEqual(result.errors, [])
  })

  test('IDs keep counting across pages and past 99', () => {
    const rows = Array.from({ length: 101 }, (_, i) => [`Item ${i + 1}`, 'Acme', 'Noon', 'Rs.100'])
    const pages = [page(rows.slice(0, 26)), ...[26, 52, 78].map((from, k) => page(rows.slice(from, from + 26), { pageNumber: k + 2 }))]
    const ids = parseCartPdf(pages).data.map((item) => item.itemId)
    assert.equal(ids.length, 101)
    assert.deepEqual([ids[0], ids[98], ids[100]], ['ITEM-01', 'ITEM-99', 'ITEM-101'])
  })
})

// ── Quantity ─────────────────────────────────────────────────────

describe('parseCartPdf: the Qty column', () => {
  /** A page with S.No and Qty columns; rows are [product, brand, platform, price, qty]. */
  const QTY_X = 420
  const qtyPage = (rows, { label = 'Qty' } = {}) => ({
    pageNumber: 1,
    items: [
      text('S.No', 20, HEADER_Y), ...headerLine(), text(label, QTY_X, HEADER_Y),
      ...rows.flatMap((cells, i) => {
        const y = HEADER_Y - ROW_GAP * (i + 1)
        return [text(String(i + 1), 22, y), ...rowLine(cells.slice(0, 4), y), ...(cells[4] ? [text(cells[4], QTY_X + 2, y)] : [])]
      }),
    ],
  })

  test('quantity 1 gives one item, exactly as without the column', () => {
    const result = parseCartPdf([qtyPage([[...BRIEF_ROWS[0], '1']])])
    assert.deepEqual(result, { data: [BRIEF_ITEMS[0]], errors: [], notes: [], fileError: null })
  })

  test('quantity 3 gives three items with their own IDs, and a note says so', () => {
    const result = parseCartPdf([qtyPage([[...BRIEF_ROWS[0], '1'], [...BRIEF_ROWS[2], '3'], [...BRIEF_ROWS[1], '1']])])
    assert.deepEqual(result.data.map((item) => item.itemId), ['ITEM-01', 'ITEM-02', 'ITEM-03', 'ITEM-04', 'ITEM-05'])
    assert.deepEqual(result.data.map((item) => item.product), [
      'Cushion Cover', 'Wall Shelf', 'Wall Shelf', 'Wall Shelf', 'Bed Sheet Set',
    ])
    assert.equal(new Set(result.data.map((item) => item.itemId)).size, 5)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.notes, ['Row 2 (Wall Shelf): quantity 3, added as 3 items (ITEM-02 to ITEM-04).'])
  })

  test('"Quantity" and "Qty." headers are read too', () => {
    for (const label of ['Quantity', 'Qty.', 'QTY']) {
      assert.equal(parseCartPdf([qtyPage([[...BRIEF_ROWS[0], '2']], { label })]).data.length, 2, label)
    }
  })

  test('a blank quantity skips the row instead of guessing 1', () => {
    const result = parseCartPdf([qtyPage([[...BRIEF_ROWS[0], '1'], [...BRIEF_ROWS[2], '']])])
    assert.deepEqual(result.data, [BRIEF_ITEMS[0]])
    assert.deepEqual(result.errors, ['Row 2 (Wall Shelf): missing Qty'])
  })

  test('an unreadable or out-of-range quantity skips the row with the reason', () => {
    for (const qty of ['0', '-1', '1.5', 'two', '21', '2 pcs']) {
      const result = parseCartPdf([qtyPage([[...BRIEF_ROWS[2], qty]])])
      assert.deepEqual(result.data, [], qty)
      assert.deepEqual(result.errors, [`Row 1 (Wall Shelf): Qty must be a whole number from 1 to 20, got "${qty}"`], qty)
    }
  })

  test('the largest quantity (20) is accepted', () => {
    assert.equal(parseCartPdf([qtyPage([[...BRIEF_ROWS[2], '20']])]).data.length, 20)
  })

  test('a quantity problem is reported together with the other problems in its row', () => {
    const result = parseCartPdf([qtyPage([['Wall Shelf', '', 'Amazon India', 'Rs.599', 'x']])])
    assert.deepEqual(result.errors, ['Row 1 (Wall Shelf): missing Brand; Qty must be a whole number from 1 to 20, got "x"'])
  })
})

// ── Rows at the edges of the table, long names, wraps and totals ──

describe('parseCartPdf: incomplete rows next to the first or last row', () => {
  const rowY = (i) => HEADER_Y - ROW_GAP * (i + 1)

  test('a last row with only a price is reported, not dropped', () => {
    const result = parseCartPdf([page(BRIEF_ROWS.slice(0, 2), { extra: [text('Rs.2,000', COLUMN_X.basePrice, rowY(2))] })])
    assert.deepEqual(result.data, BRIEF_ITEMS.slice(0, 2))
    assert.deepEqual(result.errors, ['Row 3: missing Product, Brand, Platform'])
  })

  test('a last row with only a product name is reported, not dropped', () => {
    const result = parseCartPdf([page(BRIEF_ROWS.slice(0, 2), { extra: [text('Desk Lamp', COLUMN_X.product, rowY(2))] })])
    assert.deepEqual(result.errors, ['Row 3 (Desk Lamp): missing Brand, Platform, Base Price'])
  })

  test('a first row with only a product name, between the header and the first full row, is reported', () => {
    const items = [
      ...headerLine(),
      text('Desk Lamp', COLUMN_X.product, rowY(0)),
      ...BRIEF_ROWS.slice(0, 2).flatMap((cells, i) => rowLine(cells, rowY(i + 1))),
    ]
    const result = parseCartPdf([{ pageNumber: 1, items }])
    assert.deepEqual(result.errors, ['Row 1 (Desk Lamp): missing Brand, Platform, Base Price'])
    assert.equal(result.data.length, 2)
  })

  test('a name alone at the top of a page without a header is reported, with a hint that it may continue the previous page', () => {
    const page2 = {
      pageNumber: 2,
      items: [text('(Set of 2)', COLUMN_X.product, 780), ...rowLine(BRIEF_ROWS[2], 780 - ROW_GAP), ...rowLine(BRIEF_ROWS[3], 780 - 2 * ROW_GAP)],
    }
    const result = parseCartPdf([page(BRIEF_ROWS.slice(0, 2)), page2])
    assert.equal(result.data.length, 4)
    assert.deepEqual(result.errors, [
      'Row 3 ((Set of 2)): missing Brand, Platform, Base Price (it may continue a row from the previous page, so check it in the PDF)',
    ])
  })

  test('page text is not read as a row: a smaller footer, text left of the table, a far note and a page number', () => {
    const extra = [
      text('Prices include taxes.', COLUMN_X.product, rowY(2), 8), // close, but smaller type
      text('Thank you for shopping', 10, rowY(3)), // starts left of the table
      text('Delivery in 3 days', COLUMN_X.product, rowY(7)), // far below the last row
      text('Page 1 of 2', COLUMN_X.platform, rowY(2) - 6), // a page number
    ]
    const result = parseCartPdf([page(BRIEF_ROWS.slice(0, 2), { extra })])
    assert.deepEqual(result, { data: BRIEF_ITEMS.slice(0, 2), errors: [], notes: [], fileError: null })
  })

  test('nothing after a Total line is read as a row', () => {
    const extra = [
      ...rowLine(['Total', '', '', 'Rs.2,148'], rowY(2)),
      text('Gift wrap', COLUMN_X.product, rowY(3)),
    ]
    const result = parseCartPdf([page(BRIEF_ROWS.slice(0, 2), { extra })])
    assert.deepEqual(result.errors, [])
    assert.equal(result.data.length, 2)
  })
})

describe('parseCartPdf: long names and wrapped cells', () => {
  test('a long product name that runs under the Brand header stays the product', () => {
    const name = 'Handwoven Premium Cotton Cushion Cover Large'
    const result = parseCartPdf([page([[name, 'Natura Casa', 'Amazon India', 'Rs.1,299']])])
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.data, [{ ...BRIEF_ITEMS[0], product: name }])
  })

  test('a brand and a product name wrapped onto the same next line are both joined to their row', () => {
    const items = [
      ...headerLine(),
      ...rowLine(['Cushion Cover', 'Natura', 'Amazon India', 'Rs.1,299'], 702),
      text('(Set of 2)', COLUMN_X.product, 690), text('Casa', COLUMN_X.brand, 690),
      ...rowLine(BRIEF_ROWS[1], 676),
      ...rowLine(BRIEF_ROWS[2], 650),
    ]
    const result = parseCartPdf([{ pageNumber: 1, items }])
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.data[0], { ...BRIEF_ITEMS[0], product: 'Cushion Cover (Set of 2)' })
    assert.deepEqual(result.data.slice(1), [BRIEF_ITEMS[1], { ...BRIEF_ITEMS[2], itemId: 'ITEM-03' }])
  })
})

describe('parseCartPdf: the printed total', () => {
  const rowY = (i) => HEADER_Y - ROW_GAP * (i + 1)
  const withTotal = (rows, label, amount) => page(rows, { extra: rowLine([label, '', '', amount], rowY(rows.length)) })
  const totalNotes = (result) => result.notes.filter((note) => note.startsWith("The PDF's"))

  test('a Total equal to the base prices read adds nothing', () => {
    assert.deepEqual(totalNotes(parseCartPdf([withTotal(BRIEF_ROWS.slice(0, 2), 'Total', 'Rs.2,148')])), [])
  })

  test('a different Total gives a neutral note and keeps the cart', () => {
    const result = parseCartPdf([withTotal(BRIEF_ROWS.slice(0, 2), 'Subtotal', 'Rs.3,000')])
    assert.equal(result.data.length, 2)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(totalNotes(result), [
      "The PDF's Subtotal (Rs.3,000) is not the same as the base prices read (Rs.2,148 for 2 items). " +
        'The PDF may count something differently, or a line may not have been read: please compare the cart with the PDF.',
    ])
  })

  test('quantities count in the sum', () => {
    const QTY_X = 420
    const items = [
      ...headerLine(), text('Qty', QTY_X, HEADER_Y),
      ...rowLine(BRIEF_ROWS[2], rowY(0)), text('3', QTY_X + 2, rowY(0)),
      ...rowLine(['Total', '', '', 'Rs.1,797'], rowY(1)),
    ]
    const result = parseCartPdf([{ pageNumber: 1, items }])
    assert.equal(result.data.length, 3)
    assert.deepEqual(totalNotes(result), [])
  })

  test('no comparison when the total may include other amounts', () => {
    // A grand total or amount payable may include tax or delivery
    assert.deepEqual(totalNotes(parseCartPdf([withTotal(BRIEF_ROWS.slice(0, 2), 'Grand Total', 'Rs.3,000')])), [])
    // A delivery charge line in the table
    const rows = [...BRIEF_ROWS.slice(0, 2), ['Delivery charges', '', '', 'Rs.99']]
    assert.deepEqual(totalNotes(parseCartPdf([withTotal(rows, 'Total', 'Rs.3,000')])), [])
    // Paise: whole-rupee prices may not add up exactly
    const paise = [['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299.50'], BRIEF_ROWS[1]]
    assert.deepEqual(totalNotes(parseCartPdf([withTotal(paise, 'Total', 'Rs.2,149')])), [])
    // Two total lines: which one to compare is not clear
    const two = page(BRIEF_ROWS.slice(0, 2), {
      extra: [...rowLine(['Subtotal', '', '', 'Rs.3,000'], rowY(2)), ...rowLine(['Total', '', '', 'Rs.3,100'], rowY(3))],
    })
    assert.deepEqual(totalNotes(parseCartPdf([two])), [])
  })
})
