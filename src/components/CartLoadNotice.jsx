/**
 * CartLoadNotice.jsx
 *
 * What happened to the cart after the last upload or Undo: the file, how many
 * items were accepted, every skipped row with its reason, any notes, and an
 * Undo button after a replacement. The wording comes from applyCartLoad and
 * undoCartLoad (cartLoad.js); this component only displays it.
 *
 * Props:
 *   notice   — { tone, title, lines, skipped, notes, canUndo }
 *   onUndo   — called when Undo is pressed
 *   titleRef — lets the parent move focus to the title (after Undo removes the button)
 *
 * The parent places it inside a polite live region, so screen readers hear
 * the outcome without the customer moving focus.
 */

const SYMBOL = { success: '✓', warning: '!', danger: '!' }

export default function CartLoadNotice({ notice, onUndo, titleRef }) {
  const { tone, title, lines, skipped, notes, canUndo } = notice
  const longList = skipped.length > 6

  return (
    <div className={`alert ${tone} cart-notice`}>
      <span className="symbol" aria-hidden="true">{SYMBOL[tone]}</span>
      <div className="alert-body">
        <p className="alert-title" ref={titleRef} tabIndex={-1}>{title}</p>
        {lines.map((line) => <p key={line}>{line}</p>)}
        {skipped.length > 0 && (
          <ul
            className={longList ? 'skipped-list scroll' : 'skipped-list'}
            aria-label={`Skipped rows (${skipped.length})`}
            tabIndex={longList ? 0 : undefined}
          >
            {skipped.map((reason, i) => <li key={i}>{reason}</li>)}
          </ul>
        )}
        {notes.map((note) => <p key={note} className="notice-note">Note: {note}</p>)}
        {canUndo && (
          <div className="alert-actions">
            <button type="button" className="btn secondary sm" onClick={onUndo}>
              Undo<span className="sr-only">: restore the previous cart</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
