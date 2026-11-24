/**
 * ErrorBanner.jsx
 * Displays every parse or validation error for one uploaded file.
 *
 * Props:
 *   errors       — the error messages (all are listed, unchanged)
 *   fileName     — optional; named in the heading
 *   loadedCount  — optional; rows from the file that were still loaded,
 *                  used to say whether the rest of the file was used
 */

export default function ErrorBanner({ errors, fileName, loadedCount }) {
  if (!errors || errors.length === 0) return null

  const count = `${errors.length} issue${errors.length > 1 ? 's' : ''}`
  let summary = null
  if (typeof loadedCount === 'number') {
    summary =
      loadedCount > 0
        ? 'The other rows were loaded. Fix these rows and choose the file again to use them.'
        : 'No usable rows were found, so nothing from this file is in use.'
  }

  return (
    <div className="alert danger" role="alert">
      <span className="symbol" aria-hidden="true">!</span>
      <div className="alert-body">
        <p className="alert-title">{fileName ? `${count} found in ${fileName}` : `${count} found`}</p>
        {summary && <p>{summary}</p>}
        <ul>
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
