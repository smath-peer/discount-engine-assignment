/**
 * pdfFixtures.mjs
 *
 * Builds the sample cart PDF and the test PDFs from plain descriptions, with
 * no dependencies: each file is written directly in PDF syntax, using the
 * Helvetica font every PDF reader has built in. The output is byte-for-byte
 * the same on every run, so the committed files can be checked against it
 * (see src/pdf/pdfFixtures.test.js).
 *
 * Run `node scripts/make-sample-pdfs.mjs` to write the files.
 *
 * Only what the fixtures need is supported: text at a position, thin lines,
 * one grey image (for the "scanned" file) and the PDF 1.4 password
 * protection a PDF reader asks a password for (RC4, 40-bit, revision 2).
 */

import { createHash } from 'node:crypto'

// ── Building blocks ──────────────────────────────────────────────

const latin1 = (text) => Buffer.from(text, 'latin1')

/** Escapes the characters that end or break a PDF text string. */
const pdfString = (text) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`

const PAGE_WIDTH = 595 // A4, in points
const PAGE_HEIGHT = 842

/** The drawing instructions for one page. */
function pageContent(page) {
  const out = []
  for (const [x1, y1, x2, y2] of page.lines ?? []) {
    out.push(`0.82 G 0.6 w ${x1} ${y1} m ${x2} ${y2} l S`)
  }
  if (page.image) out.push('q 360 0 0 480 118 220 cm /Im1 Do Q')
  for (const t of page.texts ?? []) {
    out.push(`BT /${t.bold ? 'F2' : 'F1'} ${t.size ?? 10} Tf 1 0 0 1 ${t.x} ${t.y} Tm ${pdfString(t.str)} Tj ET`)
  }
  return latin1(out.join('\n'))
}

// A small grey gradient, standing in for a scanned page
const IMAGE_SIZE = 8
const IMAGE_PIXELS = Buffer.from(Array.from({ length: IMAGE_SIZE * IMAGE_SIZE }, (_, i) => 120 + (i % IMAGE_SIZE) * 12))

// ── Password protection (PDF 1.4 standard security handler, revision 2) ──

const PASSWORD_PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
)

const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest()

const padPassword = (password) => Buffer.concat([latin1(password), PASSWORD_PADDING]).subarray(0, 32)

/** RC4, the cipher revision 2 uses. */
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = Buffer.alloc(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

function encryptionSetup({ userPassword, ownerPassword }, fileId) {
  const permissions = -44 // print and copy allowed; the value only matters to viewers
  const ownerEntry = rc4(md5(padPassword(ownerPassword)).subarray(0, 5), padPassword(userPassword))
  const p = Buffer.alloc(4)
  p.writeInt32LE(permissions)
  const fileKey = md5(padPassword(userPassword), ownerEntry, p, fileId).subarray(0, 5)
  const userEntry = rc4(fileKey, PASSWORD_PADDING)

  const objectKey = (objectNumber) => {
    const id = Buffer.alloc(5)
    id.writeUIntLE(objectNumber, 0, 3) // generation 0 in the last two bytes
    return md5(fileKey, id).subarray(0, 10)
  }
  return {
    dictionary: `<< /Filter /Standard /V 1 /R 2 /O <${ownerEntry.toString('hex')}> /U <${userEntry.toString('hex')}> /P ${permissions} >>`,
    encryptStream: (objectNumber, data) => rc4(objectKey(objectNumber), data),
  }
}

// ── The PDF file ─────────────────────────────────────────────────

/**
 * Builds a PDF from { pages: [{ texts, lines, image }], password? }.
 *   texts: [{ x, y, str, size?, bold? }]  (x, y in points from the bottom left)
 *   lines: [[x1, y1, x2, y2]]
 *   password: { userPassword, ownerPassword } — the file then needs the user password to open
 * Returns a Buffer.
 */
export function buildPdf({ pages, password }) {
  // Object numbers: 1 catalog, 2 page list, 3–4 fonts, then each page's objects
  const objects = [] // [number, Buffer header, Buffer stream?]
  const pageNumbers = []
  let next = 5
  const pageObjects = pages.map((page) => {
    const pageNo = next++
    const contentNo = next++
    const imageNo = page.image ? next++ : null
    pageNumbers.push(pageNo)
    return { page, pageNo, contentNo, imageNo }
  })
  const encryptNo = password ? next++ : null

  const fileId = md5(latin1(JSON.stringify(pages))) // deterministic file identifier
  const security = password ? encryptionSetup(password, fileId) : null
  const stream = (number, data) => (security ? security.encryptStream(number, data) : data)

  objects.push([1, '<< /Type /Catalog /Pages 2 0 R >>'])
  objects.push([2, `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`])
  objects.push([3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'])
  objects.push([4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'])

  for (const { page, pageNo, contentNo, imageNo } of pageObjects) {
    const xObject = imageNo ? ` /XObject << /Im1 ${imageNo} 0 R >>` : ''
    objects.push([
      pageNo,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xObject} >> /Contents ${contentNo} 0 R >>`,
    ])
    const content = stream(contentNo, pageContent(page))
    objects.push([contentNo, `<< /Length ${content.length} >>`, content])
    if (imageNo) {
      const pixels = stream(imageNo, IMAGE_PIXELS)
      objects.push([
        imageNo,
        `<< /Type /XObject /Subtype /Image /Width ${IMAGE_SIZE} /Height ${IMAGE_SIZE} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>`,
        pixels,
      ])
    }
  }
  if (security) objects.push([encryptNo, security.dictionary])

  objects.sort((a, b) => a[0] - b[0])
  const chunks = [latin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')]
  let offset = chunks[0].length
  const offsets = []
  for (const [number, header, data] of objects) {
    const parts = [latin1(`${number} 0 obj\n${header}\n`)]
    if (data) parts.push(latin1('stream\n'), data, latin1('\nendstream\n'))
    parts.push(latin1('endobj\n'))
    const bytes = Buffer.concat(parts)
    offsets[number] = offset
    offset += bytes.length
    chunks.push(bytes)
  }

  const size = objects.length + 1
  const xref = [`xref\n0 ${size}\n`, '0000000000 65535 f \n']
  for (let n = 1; n < size; n++) xref.push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  const id = fileId.toString('hex')
  const encrypt = security ? ` /Encrypt ${encryptNo} 0 R` : ''
  chunks.push(latin1(
    `${xref.join('')}trailer\n<< /Size ${size} /Root 1 0 R${encrypt} /ID [<${id}> <${id}>] >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  ))
  return Buffer.concat(chunks)
}

// ── Cart tables ──────────────────────────────────────────────────

const HEADER = ['Product', 'Brand', 'Platform', 'Base Price']
const COLUMN_X = [50, 220, 345, 465] // left edge of each column
const TABLE_LEFT = 40
const TABLE_RIGHT = 555
const ROW_GAP = 26

/**
 * One page with a cart table.
 *   heading:  lines of text above the table
 *   rows:     arrays of cell text in column order ('' for an empty cell), or
 *             { cells, wrap } where wrap is a second line under the first cell
 *   after:    lines of text below the table (totals, notes)
 *   footer:   text at the bottom of the page
 *   columnX / header: to change the column positions or order
 */
function cartPage({ heading = [], rows, after = [], footer, columnX = COLUMN_X, header = HEADER }) {
  const texts = []
  const lines = []
  let y = 780
  for (const [i, text] of heading.entries()) {
    texts.push({ x: TABLE_LEFT, y, str: text, size: i === 0 ? 14 : 10, bold: i === 0 })
    y -= i === 0 ? 22 : 16
  }

  y -= 14
  lines.push([TABLE_LEFT, y + 16, TABLE_RIGHT, y + 16])
  header.forEach((label, c) => texts.push({ x: columnX[c], y, str: label, bold: true }))
  lines.push([TABLE_LEFT, y - 9, TABLE_RIGHT, y - 9])

  for (const row of rows) {
    const { cells, wrap } = Array.isArray(row) ? { cells: row } : row
    y -= ROW_GAP
    cells.forEach((cell, c) => cell && texts.push({ x: columnX[c], y, str: cell }))
    if (wrap) {
      y -= 12
      texts.push({ x: columnX[0], y, str: wrap })
    }
    lines.push([TABLE_LEFT, y - 9, TABLE_RIGHT, y - 9])
  }

  for (const cells of after) {
    y -= ROW_GAP
    cells.forEach((cell, c) => cell && texts.push({ x: columnX[c], y, str: cell, bold: true }))
  }
  if (footer) texts.push({ x: TABLE_LEFT, y: 40, str: footer, size: 8 })
  return { texts, lines }
}

// The cart from the assignment brief, in the brief's order and format
const BRIEF_ROWS = [
  ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
  ['Bed Sheet Set', 'Natura Casa', 'Flipkart', 'Rs.849'],
  ['Wall Shelf', 'LivSpace Pro', 'Amazon India', 'Rs.599'],
  ['Ceramic Vase', 'LivSpace Pro', 'Noon', 'Rs.2,499'],
  ['Cutting Board', 'Nordic Basics', 'Amazon India', 'Rs.449'],
  ['Desk Organiser', 'Nordic Basics', 'Flipkart', 'Rs.899'],
]
const BRIEF_HEADING = ['Cart', 'Order #OP-9921 | Date: 15 Jan 2025']

// ── The files ────────────────────────────────────────────────────

/**
 * Every generated file: its path (relative to the project root), a
 * description and its bytes. Text files that only pretend to be PDFs are
 * included too, to test file-type checks.
 */
export function fixtureFiles() {
  return [
    {
      path: 'sample-data/cart.pdf',
      about: 'The sample cart from the brief: six items, prices like Rs.1,299',
      bytes: buildPdf({ pages: [cartPage({ heading: BRIEF_HEADING, rows: BRIEF_ROWS })] }),
    },
    {
      path: 'test-fixtures/pdf/price-formats.pdf',
      about: 'Each row writes its price differently; all are readable',
      bytes: buildPdf({
        pages: [cartPage({
          heading: ['Cart', 'Price formats'],
          rows: [
            ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
            ['Bed Sheet Set', 'Natura Casa', 'Flipkart', 'Rs 849'],
            ['Wall Shelf', 'LivSpace Pro', 'Amazon India', 'INR 599'],
            ['Ceramic Vase', 'LivSpace Pro', 'Noon', '2,499.00'],
            ['Cutting Board', 'Nordic Basics', 'Amazon India', 'Rs.449/-'],
            ['Dining Table', 'Nordic Basics', 'Flipkart', 'Rs.1,23,456'],
          ],
        })],
      }),
    },
    {
      path: 'test-fixtures/pdf/malformed-rows.pdf',
      about: 'Good rows mixed with incomplete and unreadable rows, a wrapped name, a total line and a note',
      bytes: buildPdf({
        pages: [cartPage({
          heading: ['Cart', 'Order #OP-9922 | Date: 16 Jan 2025'],
          rows: [
            { cells: ['Handwoven Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'], wrap: '(Set of 2)' },
            ['Wall Shelf', '', '', 'Rs.599'],
            ['Ceramic Vase', 'LivSpace Pro', 'Noon', 'Rs.24,99'],
            ['Desk Lamp', '', '', ''],
            ['Cutting Board', 'Nordic Basics', 'Amazon India', 'TBD'],
            ['Desk Organiser', 'Nordic Basics', 'Flipkart', 'Rs.0'],
            ['Bed Sheet Set', 'Natura Casa', 'Flipkart', 'Rs.849'],
          ],
          after: [['Total', '', '', 'Rs.5,095']],
          footer: 'Prices include taxes. Thank you for shopping.',
        })],
      }),
    },
    {
      path: 'test-fixtures/pdf/multi-page.pdf',
      about: 'The brief cart split over two pages, with the header repeated and page numbers',
      bytes: buildPdf({
        pages: [
          cartPage({ heading: BRIEF_HEADING, rows: BRIEF_ROWS.slice(0, 4), footer: 'Page 1 of 2' }),
          cartPage({ heading: ['Cart (continued)'], rows: BRIEF_ROWS.slice(4), footer: 'Page 2 of 2' }),
        ],
      }),
    },
    {
      path: 'test-fixtures/pdf/reordered-columns.pdf',
      about: 'The brief cart with the columns in a different order and shifted positions',
      bytes: buildPdf({
        pages: [cartPage({
          heading: BRIEF_HEADING,
          header: ['Brand', 'Product', 'Base Price', 'Platform'],
          columnX: [50, 160, 330, 430],
          rows: BRIEF_ROWS.map(([product, brand, platform, price]) => [brand, product, price, platform]),
        })],
      }),
    },
    {
      path: 'test-fixtures/pdf/extra-columns.pdf',
      about: 'The brief cart with S.No and Qty columns (quantity 1 on every row)',
      bytes: buildPdf({
        pages: [cartPage({
          heading: BRIEF_HEADING,
          header: ['S.No', 'Product', 'Brand', 'Platform', 'Qty', 'Base Price'],
          columnX: [45, 85, 215, 325, 425, 470],
          rows: BRIEF_ROWS.map(([product, brand, platform, price], i) => [String(i + 1), product, brand, platform, '1', price]),
        })],
      }),
    },
    {
      path: 'test-fixtures/pdf/quantity.pdf',
      about: 'A Qty column: quantity 1, quantity 3, quantity 2, a blank quantity and an unreadable one',
      bytes: buildPdf({
        pages: [cartPage({
          heading: BRIEF_HEADING,
          header: ['Product', 'Brand', 'Platform', 'Qty', 'Base Price'],
          columnX: [50, 190, 310, 420, 470],
          rows: [
            ['Cushion Cover', 'Natura Casa', 'Amazon India', '1', 'Rs.1,299'],
            ['Wall Shelf', 'LivSpace Pro', 'Amazon India', '3', 'Rs.599'],
            ['Bed Sheet Set', 'Natura Casa', 'Flipkart', '2', 'Rs.849'],
            ['Cutting Board', 'Nordic Basics', 'Amazon India', '', 'Rs.449'],
            ['Desk Organiser', 'Nordic Basics', 'Flipkart', 'two', 'Rs.899'],
          ],
        })],
      }),
    },
    {
      path: 'test-fixtures/pdf/edge-rows.pdf',
      about: 'A long product name, an incomplete last row and a page footer',
      bytes: buildPdf({
        pages: [cartPage({
          heading: BRIEF_HEADING,
          rows: [
            ['Handwoven Premium Cotton Cushion Cover Large', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
            ['Bed Sheet Set', 'Natura Casa', 'Flipkart', 'Rs.849'],
            ['Desk Lamp', '', '', ''],
          ],
          footer: 'Page 1 of 1. Prices include taxes.',
        })],
      }),
    },
    {
      path: 'test-fixtures/pdf/header-only.pdf',
      about: 'A cart table with its header and no rows',
      bytes: buildPdf({ pages: [cartPage({ heading: ['Cart'], rows: [] })] }),
    },
    {
      path: 'test-fixtures/pdf/no-table.pdf',
      about: 'A text document with no cart table',
      bytes: buildPdf({
        pages: [{
          texts: [
            { x: 50, y: 780, str: 'Delivery note', size: 14, bold: true },
            { x: 50, y: 750, str: 'Your order has been packed and will arrive within three days.' },
            { x: 50, y: 734, str: 'Please keep this note for your records.' },
          ],
        }],
      }),
    },
    {
      path: 'test-fixtures/pdf/empty.pdf',
      about: 'One blank page',
      bytes: buildPdf({ pages: [{}] }),
    },
    {
      path: 'test-fixtures/pdf/scanned.pdf',
      about: 'A page that is only an image, as a scan would be: no selectable text',
      bytes: buildPdf({ pages: [{ image: true }] }),
    },
    {
      path: 'test-fixtures/pdf/password.pdf',
      about: 'The sample cart, protected with the password "opptra"',
      bytes: buildPdf({
        pages: [cartPage({ heading: BRIEF_HEADING, rows: BRIEF_ROWS })],
        password: { userPassword: 'opptra', ownerPassword: 'opptra-owner' },
      }),
    },
    {
      path: 'test-fixtures/pdf/not-a-pdf.pdf',
      about: 'A CSV file renamed to .pdf',
      bytes: latin1('item_id,product,brand,platform,base_price\nITEM-01,Cushion Cover,Natura Casa,Amazon India,1299\n'),
    },
    {
      path: 'test-fixtures/pdf/damaged.pdf',
      about: 'Starts like a PDF but the rest is missing',
      bytes: latin1('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\n'),
    },
  ]
}
