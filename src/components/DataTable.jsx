/**
 * DataTable.jsx
 *
 * Renders a simple table from an array of objects.
 * Columns are defined as [{ key, label, render?, align?, nowrap? }].
 *   align: 'right' for numbers; nowrap: keep the cell on one line.
 * The table scrolls sideways inside its own region on narrow screens, so
 * the page itself never scrolls sideways.
 *
 * cards: on phone-width screens (see index.css) each row is shown as a
 * card with a visible label beside every value, so no column is ever off
 * screen. It stays one real <table> with the same rows and cells in the
 * same order; only the CSS layout changes. The explicit ARIA roles keep the
 * table semantics for browsers that drop them when a table's display
 * changes, and each cell's class (col-<key>) lets the CSS place it.
 * className: extra class on the wrapper, for table-specific card layout.
 */

export default function DataTable({ columns, rows, emptyMessage = 'No data loaded.', label = 'Table', rowClassName, cards = false, className }) {
  if (!rows || rows.length === 0) {
    return <div className="table-empty">{emptyMessage}</div>
  }

  const cellClass = (col) =>
    [`col-${col.key}`, col.align === 'right' ? 'align-right' : '', col.nowrap ? 'nowrap' : ''].filter(Boolean).join(' ')

  return (
    <div
      className={['table-wrap', cards && 'cards', className].filter(Boolean).join(' ')}
      role="region"
      aria-label={`${label}, scroll sideways if needed`}
      tabIndex={0}
    >
      <table role="table">
        <caption className="sr-only">{label}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((col) => (
              <th key={col.key} scope="col" role="columnheader" className={cellClass(col)}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row, i) => (
            <tr key={i} role="row" className={rowClassName?.(row)}>
              {columns.map((col) => (
                <td key={col.key} role="cell" className={cellClass(col)} data-label={col.label}>
                  {col.render ? col.render(row[col.key], row) : row[col.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
