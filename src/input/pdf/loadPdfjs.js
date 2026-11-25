/**
 * loadPdfjs.js
 *
 * Loads PDF.js in the browser the first time a PDF is chosen, so the page's
 * first download does not include it. Later calls reuse the same copy.
 * PDF.js parses files in a background worker; Vite bundles the worker as a
 * separate file and gives its URL here.
 *
 * Browser only (the "?url" import is a Vite feature). Node tests load the
 * legacy build directly and pass it to readPdfText.
 */

let loading = null

export function loadPdfjs() {
  loading ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
    .then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })
    .catch((error) => {
      loading = null // a failed download (for example while offline) can be retried
      throw error
    })
  return loading
}
