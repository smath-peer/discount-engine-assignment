/**
 * DataTabs.jsx
 *
 * Tabs (design system C13) that switch which panel is visible. Every panel
 * stays rendered from the parent's props; switching only hides or shows
 * panels, so the underlying data is never cleared, reloaded or reprocessed.
 *
 * Props:
 *   label     — accessible name of the tab list
 *   tabs      — [{ id, label, count, content }]
 *   activeId  — the visible tab's id
 *   onChange  — (id) => void
 *
 * Keyboard: Left/Right move between tabs, Home/End jump to the first/last.
 */

import { useRef } from 'react'

export default function DataTabs({ label, tabs, activeId, onChange }) {
  const tabRefs = useRef({})

  function select(id) {
    onChange(id)
    tabRefs.current[id]?.focus()
  }

  function handleKeyDown(event, index) {
    const last = tabs.length - 1
    let next = null
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
    if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    select(tabs[next].id)
  }

  return (
    <div>
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId
          return (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[tab.id] = el }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-controls={`panel-${tab.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className="tab"
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.label}
              <span className="count">{tab.count}</span>
            </button>
          )
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          className="tab-panel"
          hidden={tab.id !== activeId}
        >
          {tab.content}
        </div>
      ))}
    </div>
  )
}
