/**
 * cartLoad.js
 *
 * Loading a cart file (CSV or PDF) and deciding what happens to the cart.
 * Kept free of React so every rule here can be tested directly.
 *
 *   readCartFile   — file → { format, data, errors, notes, fileError }
 *   applyCartLoad  — decides whether the file replaces the cart, and what to tell the customer
 *   undoCartLoad   — puts the previous cart back
 *
 * The rules:
 *   - A file with at least one usable row replaces the whole cart, even if
 *     other rows were skipped (they are listed, and the badge says so).
 *   - A file with no usable row changes nothing: the current cart and its
 *     prices stay, and the notice explains why.
 *   - After a replacement, Undo restores the cart that was replaced. It is
 *     offered until the next upload attempt or until it is used.
 * Prices are not stored anywhere: they are derived from the cart and the
 * rules, so every change here re-prices automatically.
 */

import { parseCartCSV } from './csvParser.js'
import { parseCartPdf } from './pdfCartParser.js'
import { readPdfText, looksLikePdf, PDF_READ_MESSAGES } from './pdf/readPdfText.js'
import { plural } from '../components/loadStatus.js'

/** The cart in use: its items, the file they came from, and that file's skipped rows and notes. */
export const EMPTY_CART = Object.freeze({ items: [], fileName: '', format: null, skipped: [], notes: [] })

/** What App keeps: the cart in use and the cart Undo would restore (or null). */
export const INITIAL_CART_STATE = Object.freeze({ cart: EMPTY_CART, undo: null })

export const CART_FILE_MESSAGES = Object.freeze({
  unsupported: 'This file type is not supported. Choose a cart CSV or a cart PDF.',
  not_csv: 'This file does not contain readable text, so it cannot be a CSV. Choose a cart CSV or a cart PDF.',
  pdf_reader_unavailable: 'The PDF reader could not be loaded. Check your connection and try again, or upload a cart CSV.',
})

const extension = (name) => (/\.([a-z0-9]+)$/i.exec(name ?? '')?.[1] ?? '').toLowerCase()

/**
 * Decides how to read a file: by its contents first (a PDF signature wins
 * whatever the name says), then by its name or type.
 * Returns 'pdf', 'csv' or 'unsupported'.
 */
export function detectCartFormat({ name, type, bytes }) {
  if (looksLikePdf(bytes)) return 'pdf'
  const ext = extension(name)
  if (ext === 'pdf') return 'pdf' // named .pdf but not one: the PDF reader explains
  if (ext === 'csv' || ext === 'txt' || /csv|text\/plain/i.test(type ?? '')) return 'csv'
  return 'unsupported'
}

/**
 * Reads a cart file into cart items, never throwing.
 *   file:      a File (or anything with name, type and arrayBuffer())
 *   loadPdfjs: () => Promise<PDF.js module>; only called for PDFs
 * Returns { format, data, errors, notes, fileError }, the parsers' shape:
 *   fileError is set when the file cannot be used at all.
 */
export async function readCartFile(file, { loadPdfjs }) {
  const failed = (format, fileError) => ({ format, data: [], errors: [], notes: [], fileError })

  let bytes
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return failed(null, 'This file could not be opened. Please choose it again.')
  }

  const format = detectCartFormat({ name: file.name, type: file.type, bytes })
  if (format === 'unsupported') return failed(null, CART_FILE_MESSAGES.unsupported)

  if (format === 'csv') {
    const text = new TextDecoder('utf-8').decode(bytes) // drops a byte-order mark, as before
    if (text.includes('\u0000')) return failed('csv', CART_FILE_MESSAGES.not_csv)
    return { format, notes: [], fileError: null, ...parseCartCSV(text) }
  }

  let pdfjs
  try {
    pdfjs = await loadPdfjs()
  } catch {
    return failed('pdf', CART_FILE_MESSAGES.pdf_reader_unavailable)
  }
  const read = await readPdfText(bytes, pdfjs)
  if (!read.ok) return failed('pdf', PDF_READ_MESSAGES[read.reason])
  return { format, ...parseCartPdf(read.pages) }
}

const describeCart = (cart) => `${plural(cart.items.length, 'item')} from ${cart.fileName}`

const SKIPPED_HINT = {
  csv: 'Skipped rows are not in your cart. Fix them in the file and choose it again to include them.',
  pdf: 'Skipped rows are not in your cart. Check them in the PDF, or upload the cart as a CSV to include them.',
}

/**
 * Applies a read file to the cart state.
 *   state:  { cart, undo }
 *   result: from readCartFile
 *   file:   { fileName, calculated } — calculated: prices are already shown
 * Returns { state, notice }, where notice is what the customer is told:
 *   { tone: 'success' | 'warning' | 'danger', title, lines, skipped, notes, canUndo }
 */
export function applyCartLoad(state, result, { fileName, calculated = false }) {
  const current = state.cart
  const hadCart = current.items.length > 0

  if (result.data.length === 0) {
    const lines = []
    if (result.fileError) lines.push(result.fileError)
    else if (result.errors.length > 0) lines.push(plural(result.errors.length, 'row') + ' found, but none could be used:')
    else lines.push('The file has no cart rows.')
    lines.push(hadCart ? `Your cart is unchanged: ${describeCart(current)}.` : 'No cart is loaded yet.')
    return {
      // Nothing changes; the earlier Undo is withdrawn because a new upload was attempted
      state: { cart: current, undo: null },
      notice: { tone: 'danger', title: `Nothing was loaded from ${fileName}`, lines, skipped: result.errors, notes: result.notes ?? [], canUndo: false },
    }
  }

  const cart = {
    items: result.data,
    fileName,
    format: result.format,
    skipped: result.errors,
    notes: result.notes ?? [],
  }
  const count = plural(result.data.length, 'item')
  const skippedText = result.errors.length > 0 ? `, ${plural(result.errors.length, 'row')} skipped` : ''

  const lines = []
  if (hadCart) lines.push(`It replaced your previous cart: ${describeCart(current)}.`)
  if (result.errors.length > 0) lines.push(SKIPPED_HINT[result.format] ?? SKIPPED_HINT.csv)
  if (calculated) lines.push('Prices were recalculated with the current offers.')

  return {
    state: { cart, undo: hadCart ? current : null },
    notice: {
      tone: result.errors.length > 0 ? 'warning' : 'success',
      title: hadCart ? `Cart replaced: ${count} from ${fileName}${skippedText}` : `${count} loaded from ${fileName}${skippedText}`,
      lines,
      skipped: result.errors,
      notes: cart.notes,
      canUndo: hadCart,
    },
  }
}

/** Restores the cart that the last upload replaced. Returns { state, notice }, or null if there is nothing to undo. */
export function undoCartLoad(state, { calculated = false } = {}) {
  if (!state.undo) return null
  const restored = state.undo
  return {
    state: { cart: restored, undo: null },
    notice: {
      // The restored cart's own skipped rows are listed again, so the badge and the notice agree
      tone: restored.skipped.length > 0 ? 'warning' : 'success',
      title: `Previous cart restored: ${describeCart(restored)}`,
      lines: calculated ? ['Prices were recalculated with the current offers.'] : [],
      skipped: restored.skipped,
      notes: restored.notes,
      canUndo: false,
    },
  }
}
