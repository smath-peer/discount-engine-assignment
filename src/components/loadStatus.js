/**
 * loadStatus.js
 *
 * Display-only helpers for the Load Data card and the progress indicator.
 * They read existing state (rows loaded, errors, results); they never change
 * it. Kept free of React so they can be tested directly.
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The status badge for one uploaded file.
 *   fileName    — the last file chosen ('' if none yet)
 *   rowCount    — rows from that file now in use
 *   errorCount  — problems reported for that file
 * Returns { tone: 'neutral' | 'success' | 'warning' | 'danger', label }.
 */
export function uploadStatus({ fileName, rowCount, errorCount }) {
  if (!fileName) return { tone: 'neutral', label: 'Not loaded' }
  if (rowCount > 0 && errorCount === 0) return { tone: 'success', label: 'Loaded' }
  if (rowCount > 0) return { tone: 'warning', label: `Loaded with ${plural(errorCount, 'issue')}` }
  if (errorCount > 0) return { tone: 'danger', label: 'Not loaded — no usable rows' }
  return { tone: 'warning', label: 'No rows found' }
}

/**
 * The three progress steps, in the page's order (cart, offers, checkout).
 * A step is complete only when its condition is true right now: cart items
 * loaded, offers (rules) in use, results calculated.
 * The first step that is not complete is the current one.
 * Returns [{ label, state: 'complete' | 'current' | 'upcoming' }].
 */
export function progressSteps({ ruleCount, cartCount, calculated }) {
  const steps = [
    ['Cart loaded', cartCount > 0],
    ['Offers loaded', ruleCount > 0],
    ['Prices calculated', Boolean(calculated)],
  ]
  const currentIndex = steps.findIndex(([, done]) => !done)
  return steps.map(([label, done], i) => ({
    label,
    state: done ? 'complete' : i === currentIndex ? 'current' : 'upcoming',
  }))
}

export { plural }
