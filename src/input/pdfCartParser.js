/**
 * pdfCartParser.js
 *
 * Turns the positioned text of a cart PDF (from readPdfText) into CartItem
 * objects. It works from where the text sits on the page, not from spaces
 * in the text, because a table's columns are separated by position only.
 *
 * Steps:
 *   1. Group text into lines by vertical position.
 *   2. Find the header line holding Product, Brand, Platform and Base Price
 *      (any order, any case). Text above it is ignored (titles, order number).
 *   3. Give every piece of text below it to the column whose header it
 *      overlaps (see cellsOf), so a long name stays the product. An
 *      optional "Qty" (or "Quantity") column is read too; other columns in
 *      the header (such as "S.No") are ignored.
 *   4. Read each line as a row:
 *        - text in two or more columns starts a new row;
 *        - text with no price, just below a row and closer than the usual
 *          row spacing, continues that row's cells (a wrapped name or brand);
 *        - any other one-column line between rows is reported as an
 *          incomplete row, never silently merged or dropped;
 *        - a one-column line just above the first row or below the last one
 *          is reported too when it looks like table text (see rowsOf);
 *          other page text (titles, notes, footers, page numbers) is ignored;
 *        - a "Total" line with no brand or platform is ignored with a note,
 *          and compared with the items when that is clearly valid (step 6).
 *   5. Check each row with the shared validateCartItem (the same rules as
 *      the CSV cart) and its quantity (see "Quantity" below), then add one
 *      cart item per unit, numbered ITEM-01, ITEM-02, … in table order.
 *
 * Later pages continue the table: a repeated header there is used for that
 * page's columns; without one, the previous page's columns are kept.
 *
 * Output: { data, errors, notes, fileError }
 *   data:      CartItem[] in table order, one per unit, each with its own itemId
 *   errors:    one message per skipped row, e.g. 'Row 3 (Wall Shelf): missing Brand, Platform'
 *   notes:     lines that were deliberately not read as items, and rows
 *              added as several items because of their quantity
 *   fileError: null, or a message when no usable table exists at all
 */

import { validateCartItem, parsePrice } from '../engine/cartItemValidator.js'

/** The columns a cart PDF must have, with the CartItem field each fills. */
export const PDF_CART_COLUMNS = Object.freeze([
  { field: 'product', label: 'Product' },
  { field: 'brand', label: 'Brand' },
  { field: 'platform', label: 'Platform' },
  { field: 'basePrice', label: 'Base Price' },
])

export const PDF_FILE_ERRORS = Object.freeze({
  no_table: 'No cart table was found. The PDF needs a table with the columns Product, Brand, Platform and Base Price.',
  no_rows: 'The cart table in this PDF has no item rows.',
})

const LABEL = { ...Object.fromEntries(PDF_CART_COLUMNS.map((c) => [c.field, c.label])), quantity: 'Qty' }

// ── Quantity ─────────────────────────────────────────────────────
//
// A cart item is one unit at one price, and the engine prices each item on
// its own (a CSV cart repeats a row to buy two). So a row with Qty 3 becomes
// three cart items, each priced, discounted and rounded exactly as a single
// item, and each with its own itemId. Base Price is read as the unit price.
//   - No Qty column: every row is one unit, as before.
//   - A Qty column with a blank cell: the row is skipped ("missing Qty");
//     guessing 1 could under-price the cart.
//   - Qty must be a whole number from 1 to MAX_PDF_QUANTITY; otherwise the
//     row is skipped with the reason. The cap keeps the cart readable, as
//     every unit is shown as its own item.

/** The header labels that mark the optional quantity column. */
const QUANTITY_LABELS = ['qty', 'qty.', 'quantity']

export const MAX_PDF_QUANTITY = 20
const TOTAL_LINE = /^(?:sub[\s-]?total|grand total|order total|net total|total|amount payable)\b/i

const normalise = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase()
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// ── 1. Lines ─────────────────────────────────────────────────────

/** Groups text pieces that share a baseline into lines, top to bottom, each left to right. */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const item of sorted) {
    const line = lines[lines.length - 1]
    if (line && Math.abs(line.y - item.y) <= 0.5 * Math.min(line.fontSize, item.fontSize)) {
      line.items.push(item)
      line.fontSize = Math.max(line.fontSize, item.fontSize)
    } else {
      lines.push({ y: item.y, fontSize: item.fontSize, items: [item] })
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x)
  return lines
}

// ── 2. Header ────────────────────────────────────────────────────

/**
 * Finds where one header label sits in a line. A label may be one piece of
 * text ("Base Price") or several ("Base", "Price"), and may carry a unit
 * ("Base Price (Rs.)").
 */
function findLabel(items, label, used) {
  const target = label.toLowerCase()
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue
    let text = ''
    for (let j = i; j < items.length && !used.has(j); j++) {
      text = normalise(`${text} ${items[j].str}`)
      if (text === target || text.startsWith(`${target} `) || text.startsWith(`${target}(`)) {
        return { from: i, to: j, left: items[i].x, right: items[j].x + items[j].width }
      }
      if (!target.startsWith(text)) break
    }
  }
  return null
}

/**
 * The table's columns, left to right, if this line is the header; otherwise
 * null. Any other heading in the line (such as "S.No" or "Qty") becomes a
 * column whose text is ignored, so it never leaks into a neighbouring cell.
 */
function headerColumns(line) {
  const used = new Set()
  const columns = []
  for (const { field } of PDF_CART_COLUMNS) {
    const found = findLabel(line.items, LABEL[field], used)
    if (!found) return null
    for (let k = found.from; k <= found.to; k++) used.add(k)
    columns.push({ field, left: found.left, right: found.right })
  }
  for (const label of QUANTITY_LABELS) {
    const found = findLabel(line.items, label, used)
    if (!found) continue
    for (let k = found.from; k <= found.to; k++) used.add(k)
    columns.push({ field: 'quantity', left: found.left, right: found.right })
    break
  }
  line.items.forEach((item, k) => {
    if (!used.has(k)) columns.push({ field: null, left: item.x, right: item.x + item.width })
  })
  columns.sort((a, b) => a.left - b.left)
  // A column's area runs to halfway across the gap before the next header
  return columns.map((column, k) => ({
    field: column.field,
    left: column.left,
    right: column.right,
    start: k === 0 ? -Infinity : (columns[k - 1].right + column.left) / 2,
  }))
}

// ── 3. Cells ─────────────────────────────────────────────────────

/**
 * Puts each piece of a line under its column; extra columns are dropped.
 * The column is decided by the headers the piece overlaps:
 *   1. the column whose area holds the piece's left edge, if the piece
 *      overlaps that column's header (left-aligned text, including a long
 *      product name that runs on under the next header);
 *   2. otherwise the header the piece overlaps most (right-aligned text,
 *      such as a price wider than its header that starts to its left);
 *   3. otherwise the column its centre falls in (text overlapping no header).
 */
function cellsOf(line, columns) {
  const cells = {}
  for (const item of line.items) {
    const left = item.x
    const right = item.x + item.width
    const overlap = (column) => Math.min(right, column.right) - Math.max(left, column.left)
    const areaOf = (x) => {
      let found = columns[0]
      for (const column of columns) if (x >= column.start) found = column
      return found
    }

    let column = areaOf(left)
    if (!(overlap(column) > 0)) {
      const best = columns.reduce((a, b) => (overlap(b) > overlap(a) ? b : a))
      column = overlap(best) > 0 ? best : areaOf((left + right) / 2)
    }
    const { field } = column
    if (field === null) continue
    cells[field] = cells[field] ? `${cells[field]} ${item.str}` : item.str
  }
  return cells
}

// ── 4. Rows ──────────────────────────────────────────────────────

/** The table lines of every page, in reading order, with their cells. */
function tableLines(pages) {
  const result = []
  let columns = null
  for (const page of pages) {
    const lines = groupLines(page.items)
    const headerIndex = lines.findIndex((line) => headerColumns(line))
    if (headerIndex >= 0) columns = headerColumns(lines[headerIndex])
    if (!columns) continue // the table has not started yet

    const below = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines
    const quantityColumn = columns.some((column) => column.field === 'quantity')
    const pageLines = below
      .filter((line) => !headerColumns(line)) // a header repeated lower down
      .map((line) => ({
        y: line.y,
        fontSize: line.fontSize,
        cells: cellsOf(line, columns),
        quantityColumn,
        // The line's horizontal extent, and the header's, to tell table text from page text
        left: Math.min(...line.items.map((item) => item.x)),
        right: Math.max(...line.items.map((item) => item.x + item.width)),
        tableLeft: Math.min(...columns.map((column) => column.left)),
        tableRight: Math.max(...columns.map((column) => column.right)),
      }))
      .filter((line) => cellCount(line.cells) > 0) // text only in ignored columns
    result.push({ pageNumber: page.pageNumber, hasHeader: headerIndex >= 0, lines: pageLines })
  }
  return { found: columns !== null, pages: result }
}

const cellCount = (cells) => Object.keys(cells).length
// A line that is clearly a row: a price and at least one other cell (a
// wrapped line, which may now span two text cells, never has a price)
const isPricedRow = (line) => Boolean(line.cells.basePrice) && cellCount(line.cells) >= 2

/** Turns each page's lines into rows, joining wrapped cells (see the steps above). */
function rowsOf(tablePages) {
  // The usual spacing between rows: measured only between two neighbouring
  // lines that are both clearly rows, so a wrapped name or an incomplete row
  // in between never stretches it
  const gaps = []
  for (const { lines } of tablePages) {
    for (let k = 1; k < lines.length; k++) {
      if (isPricedRow(lines[k - 1]) && isPricedRow(lines[k])) gaps.push(lines[k - 1].y - lines[k].y)
    }
  }
  const rowPitch = gaps.length > 0 ? median(gaps) : null

  // What table rows look like: their font size and how far across the page
  // they reach (with the header), so page text outside the table is told apart
  const rowLines = tablePages.flatMap(({ lines }) => lines.filter((line) => cellCount(line.cells) >= 2))
  const rowFont = rowLines.length > 0 ? median(rowLines.map((line) => line.fontSize)) : null
  const allLines = tablePages.flatMap(({ lines }) => lines)
  const tableLeft = Math.min(...allLines.map((line) => line.tableLeft), ...rowLines.map((line) => line.left))
  const tableRight = Math.max(...allLines.map((line) => line.tableRight), ...rowLines.map((line) => line.right))

  const rows = []
  for (const { lines, hasHeader } of tablePages) {
    const entries = []
    let previous = null // the last line of the row being built
    for (const line of lines) {
      const count = cellCount(line.cells)
      const limit = rowPitch ? 0.75 * rowPitch : 1.3 * line.fontSize
      // A wrapped line continues the row above: it is closer than the usual
      // row spacing and holds only text cells (a name, brand or platform
      // running on), never a price or quantity
      const wraps =
        count >= 1 && !line.cells.basePrice && !line.cells.quantity && previous && previous.y - line.y <= limit &&
        entries.length > 0

      if (wraps) {
        const row = entries[entries.length - 1]
        for (const [field, text] of Object.entries(line.cells)) {
          row.cells[field] = row.cells[field] ? `${row.cells[field]} ${text}` : text
        }
      } else {
        entries.push({ kind: count >= 2 ? 'row' : 'single', cells: { ...line.cells }, quantityColumn: line.quantityColumn, line })
      }
      previous = line
    }

    const first = entries.findIndex((e) => e.kind === 'row')
    const last = entries.findLastIndex((e) => e.kind === 'row')
    if (first < 0) continue

    // One-column lines between rows are rows. Next to the first or last row,
    // a one-column line is a row too when it looks like table text: close to
    // that row (within 1.5 row spacings), inside the table's left and right
    // edges, in the rows' font size, and not a page number. Anything else
    // (titles, notes, footers) is page text and is ignored, as before.
    // Nothing is read after a total line: the table has ended.
    const reach = 1.5 * (rowPitch ?? 2 * (rowFont ?? 10))
    const looksLikeTableText = (entry, neighbour) =>
      Math.abs(entry.line.y - neighbour.line.y) <= reach &&
      entry.line.left >= tableLeft - 2 &&
      entry.line.right <= tableRight + 2 &&
      (rowFont === null || Math.abs(entry.line.fontSize - rowFont) <= 0.15 * rowFont) &&
      !PAGE_NUMBER.test(Object.values(entry.cells).join(' ').trim())

    let from = first
    while (from > 0 && looksLikeTableText(entries[from - 1], entries[from])) from--
    let to = last
    if (!isTotalLine(entries[last].cells)) {
      while (to < entries.length - 1 && looksLikeTableText(entries[to + 1], entries[to])) to++
    }
    for (let k = from; k < first; k++) {
      // At the top of a page without its own header, it may be the rest of
      // the last row on the previous page: say so, rather than guess
      if (!hasHeader) entries[k].hint = 'it may continue a row from the previous page, so check it in the PDF'
    }
    rows.push(...entries.slice(from, to + 1))
  }
  return rows
}

const PAGE_NUMBER = /^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i
const isTotalLine = (cells) => TOTAL_LINE.test(cells.product ?? '') && !cells.brand && !cells.platform

// ── 5. Validation ────────────────────────────────────────────────

function rowMessage(rowNumber, cells, errors) {
  const parts = []
  const missing = errors.filter((e) => e.code === 'missing').map((e) => LABEL[e.field])
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`)
  for (const error of errors) {
    if (error.code === 'price_format') parts.push(`Base Price "${error.received}" is not a readable amount (for example Rs.1,299)`)
    if (error.code === 'price_too_small') parts.push(`Base Price must be at least Rs.1, got "${error.received}"`)
    if (error.code === 'quantity_format') {
      parts.push(`Qty must be a whole number from 1 to ${MAX_PDF_QUANTITY}, got "${error.received}"`)
    }
  }
  return `${rowLabel(rowNumber, cells)}: ${parts.join('; ')}`
}

const rowLabel = (rowNumber, cells) => `Row ${rowNumber}${cells.product ? ` (${cells.product})` : ''}`

/**
 * The row's quantity: { quantity } or { error } (in validateCartItem's error
 * shape). Without a Qty column every row is 1 unit.
 */
function readQuantity(cells, quantityColumn) {
  if (!quantityColumn) return { quantity: 1 }
  const text = (cells.quantity ?? '').trim()
  if (text === '') return { error: { field: 'quantity', code: 'missing' } }
  const quantity = /^\d+$/.test(text) ? Number(text) : NaN
  if (!(quantity >= 1 && quantity <= MAX_PDF_QUANTITY)) return { error: { field: 'quantity', code: 'quantity_format', received: text } }
  return { quantity }
}

const itemId = (n) => `ITEM-${String(n).padStart(2, '0')}`

/** See the file header for the steps and the output. */
export function parseCartPdf(pages) {
  const table = tableLines(pages ?? [])
  if (!table.found) return { data: [], errors: [], notes: [], fileError: PDF_FILE_ERRORS.no_table }

  const data = []
  const errors = []
  const notes = []
  let rowNumber = 0
  const totals = [] // { label, amount } of every total line
  let comparable = true // false once anything makes a printed total unlike the sum of base prices

  for (const { cells, quantityColumn, hint } of rowsOf(table.pages)) {
    if (isTotalLine(cells)) {
      const text = [cells.product, cells.basePrice].filter(Boolean).join(' ')
      notes.push(`The "${text}" line was not read as an item; totals are calculated from the items.`)
      totals.push({ label: cells.product.trim(), amount: cells.basePrice ?? '' })
      continue
    }
    // A discount, tax or delivery line means a printed total is not just the items
    if (CHARGE_LINE.test(cells.product ?? '')) comparable = false

    rowNumber++
    const { quantity: _quantityText, ...itemCells } = cells
    const { item, errors: itemErrors } = validateCartItem({ itemId: 'pending', ...itemCells })
    const { quantity, error: quantityError } = readQuantity(cells, quantityColumn)
    const rowErrors = quantityError ? [...itemErrors, quantityError] : itemErrors
    if (rowErrors.length > 0) {
      errors.push(rowMessage(rowNumber, cells, rowErrors) + (hint ? ` (${hint})` : ''))
      continue
    }
    if (HAS_PAISE.test(cells.basePrice)) comparable = false // paise: the rounded prices may not add up exactly
    const first = data.length + 1
    for (let unit = 0; unit < quantity; unit++) data.push({ ...item, itemId: itemId(data.length + 1) })
    if (quantity > 1) {
      notes.push(`${rowLabel(rowNumber, cells)}: quantity ${quantity}, added as ${quantity} items (${itemId(first)} to ${itemId(data.length)}).`)
    }
  }

  if (rowNumber === 0) return { data: [], errors: [], notes, fileError: PDF_FILE_ERRORS.no_rows }
  const check = totalCheck(totals, data, comparable)
  if (check) notes.push(check)
  return { data, errors, notes, fileError: null }
}

// ── 6. The printed total ─────────────────────────────────────────
//
// A total printed in the PDF is compared with the sum of the base prices
// read (one per unit, so quantities count) only when the two are clearly the
// same kind of number:
//   - there is exactly one total line, labelled just "Total" or "Subtotal"
//     ("Grand total" or "Amount payable" may include tax or delivery);
//   - its amount is a readable whole-rupee amount;
//   - no accepted price has paise (whole-rupee rounding could differ);
//   - the table has no discount, tax, delivery or other charge line.
// A difference is a neutral note: it never rejects the cart and never
// assumes which row is missing, since the PDF's total may differ for its
// own reasons.

const COMPARABLE_TOTAL = /^(?:sub[\s-]?total|total)\s*:?$/i
const HAS_PAISE = /\d\.\d/ // "1,299.50", not the dot in "Rs.1,299"
const CHARGE_LINE = /\b(?:discount|coupon|tax|gst|vat|shipping|delivery|charges?|fees?)\b/i
const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

function totalCheck(totals, data, comparable) {
  if (!comparable || totals.length !== 1 || data.length === 0) return null
  const [{ label, amount }] = totals
  if (!COMPARABLE_TOTAL.test(label) || HAS_PAISE.test(amount)) return null
  const { value: printed } = parsePrice(amount)
  if (printed === undefined) return null
  const sum = data.reduce((total, item) => total + item.basePrice, 0)
  if (printed === sum) return null
  return (
    `The PDF's ${label.replace(/:$/, '')} (${rupees(printed)}) is not the same as the base prices read ` +
    `(${rupees(sum)} for ${data.length} ${data.length === 1 ? 'item' : 'items'}). ` +
    'The PDF may count something differently, or a line may not have been read: please compare the cart with the PDF.'
  )
}
