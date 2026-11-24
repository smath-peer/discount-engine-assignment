/**
 * CsvUploader.jsx
 *
 * One file row in the Load Data card: file name, what was loaded, a status
 * badge and a real button that opens the file picker (reachable by keyboard).
 * Calls onLoad(rawText, fileName) when a file is selected.
 *
 * Props:
 *   label        — the expected file, e.g. "rules.csv" (used in the button's accessible name)
 *   title        — what the file holds, e.g. "Discount rules"
 *   description  — shown before any file is chosen
 *   fileName     — the last file chosen ('' if none)
 *   detail       — what is loaded, e.g. "4 rules"
 *   status       — { tone, label } from uploadStatus()
 *   onLoad       — (rawText, fileName) => void
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

export default function CsvUploader({ label, title, description, fileName, detail, status, onLoad }) {
  const inputRef = useRef(null)

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => onLoad(evt.target.result, file.name)
    reader.readAsText(file)
    // Reset input so the same file can be re-uploaded
    e.target.value = ''
  }

  const chosen = Boolean(fileName)

  return (
    <div className={`file-row${chosen ? '' : ' is-empty'}`}>
      <span className="file-icon">{chosen ? <FileIcon /> : <UploadIcon />}</span>
      <span className="file-meta">
        <span className="file-name">{chosen ? fileName : title}</span>
        <span className="file-sub">{chosen ? `${title} · ${detail}` : description}</span>
        {chosen && status && <span className={`badge ${status.tone}`}>{status.label}</span>}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={handleFile}
        tabIndex={-1}
        aria-hidden="true"
      />
      <button type="button" className="btn secondary sm" onClick={() => inputRef.current?.click()}>
        {chosen ? 'Replace file' : 'Choose file'}
        <span className="sr-only"> for {label}</span>
      </button>
    </div>
  )
}
