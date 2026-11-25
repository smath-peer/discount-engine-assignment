/**
 * readPdfText.js
 *
 * Opens a PDF with PDF.js and returns every piece of text with its position,
 * or the reason the file cannot be used. It does not decide what the text
 * means: pdfCartParser.js turns the positioned text into cart items.
 *
 * The PDF.js library is passed in, so the same code runs in the browser
 * (loaded on demand by loadPdfjs.js) and in Node tests (the legacy build).
 *
 * Result:
 *   { ok: true,  pages: [{ pageNumber, items: [{ str, x, y, width, fontSize }] }] }
 *   { ok: false, reason }   reason is one of the keys of PDF_READ_MESSAGES
 *
 *   x, y:     where the text starts, in points from the page's bottom left
 *   width:    how wide the text is, in points
 *   fontSize: the text's height, in points
 * Blank pieces of text (the spaces PDF.js reports between words) are left out.
 */

export const MAX_PDF_BYTES = 5 * 1024 * 1024
export const MAX_PDF_PAGES = 20

/** A customer-facing explanation for each reason a PDF cannot be used. */
export const PDF_READ_MESSAGES = Object.freeze({
  not_pdf: 'This file is not a PDF. Choose a cart PDF or a cart CSV file.',
  too_large: 'This PDF is larger than 5 MB. A cart PDF is usually much smaller, so please check you chose the right file.',
  too_many_pages: `This PDF has more than ${MAX_PDF_PAGES} pages. Please upload a cart PDF with ${MAX_PDF_PAGES} pages or fewer.`,
  password: 'This PDF is password-protected. Save a copy without the password and upload that copy, or upload a cart CSV.',
  damaged: 'This PDF could not be opened. It may be damaged or incomplete; try downloading it again.',
  scanned: 'This PDF has no selectable text, so it looks like a scanned image. Upload the original PDF of the order or a cart CSV.',
  empty: 'This PDF has no text on its pages.',
  unreadable: 'This PDF could not be read. Try saving it again as a PDF, or upload a cart CSV.',
})

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"
const SIGNATURE_SEARCH_BYTES = 1024 // PDF readers accept a little junk before the signature

/** True when the "%PDF-" signature appears near the start of the bytes. */
export function looksLikePdf(bytes) {
  const end = Math.min(bytes.length, SIGNATURE_SEARCH_BYTES) - PDF_SIGNATURE.length
  for (let i = 0; i <= end; i++) {
    if (PDF_SIGNATURE.every((byte, k) => bytes[i + k] === byte)) return true
  }
  return false
}

/**
 * Reads the text of a PDF.
 *   data:  the file's bytes (ArrayBuffer or Uint8Array); never changed
 *   pdfjs: the PDF.js library module
 */
export async function readPdfText(data, pdfjs) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length > MAX_PDF_BYTES) return { ok: false, reason: 'too_large' }
  if (!looksLikePdf(bytes)) return { ok: false, reason: 'not_pdf' }

  let loadingTask
  try {
    loadingTask = pdfjs.getDocument({
      // A plain Uint8Array copy: PDF.js takes over the buffer it is given (and rejects Node Buffers)
      data: new Uint8Array(bytes),
      isEvalSupported: false, // never run code generated from the file
      verbosity: 0, // errors only; missing-font notices are irrelevant to text extraction
    })
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  try {
    let doc
    try {
      doc = await loadingTask.promise
    } catch (error) {
      if (error?.name === 'PasswordException') return { ok: false, reason: 'password' }
      if (error?.name === 'InvalidPDFException') return { ok: false, reason: 'damaged' }
      return { ok: false, reason: 'unreadable' }
    }

    if (doc.numPages > MAX_PDF_PAGES) return { ok: false, reason: 'too_many_pages' }

    const pages = []
    let hasImage = false
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      const items = content.items
        .filter((item) => typeof item.str === 'string' && item.str.trim() !== '')
        .map((item) => ({
          str: item.str.replace(/\s+/g, ' ').trim(),
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          fontSize: Math.abs(item.height || item.transform[3]) || 10,
        }))
      pages.push({ pageNumber, items })

      // Only needed to tell a scanned page from a blank one
      if (items.length === 0 && !hasImage) {
        const operators = await page.getOperatorList()
        hasImage = operators.fnArray.some((fn) =>
          fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject,
        )
      }
    }

    if (pages.every((page) => page.items.length === 0)) {
      return { ok: false, reason: hasImage ? 'scanned' : 'empty' }
    }
    return { ok: true, pages }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    await loadingTask.destroy()
  }
}
