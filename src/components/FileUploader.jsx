/**
 * FileUploader.jsx
 *
 * One file row in the Load Data card: file name, what is loaded, a status
 * badge and a real button that opens the file picker (reachable by keyboard).
 * It only hands the chosen File to the parent; reading it is the parent's job,
 * so the same row serves the rules CSV and the cart (CSV or PDF).
 *
 * Props:
 *   label        — what to choose, e.g. "rules.csv" (used in the button's accessible name)
 *   title        — what the file holds, e.g. "Discount rules"
 *   description  — shown before any file is chosen
 *   accept       — the picker's file filter, e.g. ".csv" or ".csv,.pdf"
 *   fileName     — the file in use ('' if none)
 *   detail       — what is loaded, e.g. "4 rules"
 *   status       — { tone, label } from uploadStatus()
 *   busyFileName — the file being read right now ('' if none); the button waits meanwhile
 *   onSelect     — (file: File) => void
 */

import { useRef } from 'react'

const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </svg>
)

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
  </svg>
)

export default function FileUploader({ label, title, description, accept, fileName, detail, status, busyFileName = '', onSelect }) {
  const inputRef = useRef(null)
  const busy = Boolean(busyFileName)

  function handleFile(e) {
    const file = e.target.files[0]
    // Reset the input so choosing the same file again still triggers a change
    e.target.value = ''
    if (file) onSelect(file)
  }

  const chosen = Boolean(fileName)

  return (
    <div className={`file-row${chosen ? '' : ' is-empty'}`} aria-busy={busy}>
      <span className="file-icon">{chosen ? <FileIcon /> : <UploadIcon />}</span>
      <span className="file-meta">
        <span className="file-name">{chosen ? fileName : title}</span>
        <span className="file-sub">{chosen ? `${title} · ${detail}` : description}</span>
        {chosen && status && <span className={`badge ${status.tone}`}>{status.label}</span>}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={handleFile}
        tabIndex={-1}
        aria-hidden="true"
      />
      {/* aria-disabled, not disabled: a disabled button would drop keyboard focus while the file is read */}
      <button
        type="button"
        className="btn secondary sm"
        onClick={() => { if (!busy) inputRef.current?.click() }}
        aria-disabled={busy || undefined}
      >
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy ? 'Reading…' : chosen ? 'Replace file' : 'Choose file'}
        <span className="sr-only"> for {label}</span>
      </button>
    </div>
  )
}
