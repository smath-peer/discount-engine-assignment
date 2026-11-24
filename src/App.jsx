/**
 * App.jsx
 *
 * Top-level component. Manages state for rules, cart items, and results.
 * Wires together CSV upload / plain-language rules → parse → engine → display.
 *
 * Two rule lists are kept apart:
 *   csvRules       — replaced by each rules.csv upload
 *   confirmedRules — rules added in plain language and confirmed by the user
 * The engine prices with activeRules = [...csvRules, ...confirmedRules].
 *
 * Results are calculated from state, not stored: nothing is shown until the
 * first "Calculate Discounts" click; after that, any change to the rules or
 * the cart re-prices automatically.
 *
 * Layout and styling follow the Opptra design system (see index.css); the
 * state and handlers below are unchanged by the redesign.
 */

import { useMemo, useState } from 'react'
import CsvUploader from './components/CsvUploader.jsx'
import DataTable from './components/DataTable.jsx'
import DataTabs from './components/DataTabs.jsx'
import ErrorBanner from './components/ErrorBanner.jsx'
import RuleInput from './components/RuleInput.jsx'
import { uploadStatus, progressSteps, plural } from './components/loadStatus.js'
import { parseRulesCSV, parseCartCSV } from './engine/csvParser.js'
import { combineRules, canCalculate as hasEnoughToCalculate, computeResults, addConfirmedRule, withoutConfirmedIdClashes } from './appRules.js'

// The official logo from the Opptra design system; a text wordmark is shown if it cannot load
const LOGO_URL = 'https://cdn.prod.website-files.com/6933cd7135f6e590ffef0761/6937f6a9040488e80b8e30b0_logo.svg'

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

// ── Column definitions ───────────────────────────────────────────

const RULES_COLUMNS = [
  {
    key: 'ruleId',
    label: 'Rule',
    nowrap: true,
    render: (v, row) => (
      <>
        <strong>{v}</strong>
        {row.source === 'plain-language' && (
          <> <span className="tag" title="Added in plain language">Added</span></>
        )}
      </>
    ),
  },
  {
    key: 'appliesTo',
    label: 'Applies to',
    render: (v, row) =>
      row.scope === 'cart' ? 'Entire cart' : `${row.scope === 'brand' ? 'Brand' : 'Platform'}: ${v}`,
  },
  {
    key: 'value',
    label: 'Discount',
    nowrap: true,
    render: (v, row) => (row.type === 'percentage' ? `${v}% off` : `${rupees(v)} off`),
  },
  {
    key: 'minCartValue',
    label: 'Condition',
    // The minimum is inclusive, as in the engine
    render: (v) => (v == null ? 'None' : `Cart total of ${rupees(v)} or more`),
  },
  { key: 'stackable', label: 'Stacks', render: (v) => (v ? 'Yes' : 'No') },
]

const CART_COLUMNS = [
  {
    key: 'product',
    label: 'Item',
    render: (v, row) => (
      <>
        <strong>{v}</strong>
        <span className="table-sub">{row.itemId}</span>
      </>
    ),
  },
  { key: 'brand',     label: 'Brand' },
  { key: 'platform',  label: 'Platform' },
  { key: 'basePrice', label: 'Base price', align: 'right', render: (v) => rupees(v) },
]

const RESULTS_COLUMNS = [
  {
    key: 'product',
    label: 'Item',
    render: (v, row) => (
      <>
        <strong>{v}</strong>
        <span className="table-sub">{row.itemId}</span>
        {/* May break only between the brand and the platform, never inside a name */}
        <span className="table-sub parts">
          <span className="keep">{row.brand}</span> · <span className="keep">{row.platform}</span>
        </span>
      </>
    ),
  },
  {
    key: 'reasoning',
    label: 'Offer applied',
    render: (v) => <OfferText text={v} />,
  },
  { key: 'basePrice', label: 'Base price', align: 'right', render: (v) => rupees(v) },
  {
    key: 'totalDiscount',
    label: 'You save',
    align: 'right',
    render: (v) => (v > 0 ? <span className="saving">{rupees(v)}</span> : <span className="none">{rupees(0)}</span>),
  },
  { key: 'finalPrice', label: 'Final price', align: 'right', render: (v) => <strong>{rupees(v)}</strong> },
]

// ── Small presentational pieces ──────────────────────────────────

/**
 * The engine's reasoning text, unchanged, shown so that one offer
 * ("Platform offer: 15% off") never breaks across lines; a combined offer
 * may break only after its " + ". The visible and spoken text is identical.
 */
function OfferText({ text }) {
  if (text === 'No offers available') return <span className="none">{text}</span>
  const parts = text.split(' + ')
  return (
    <span>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' '}
          <span className="offer-part">{i < parts.length - 1 ? `${part} +` : part}</span>
        </span>
      ))}
    </span>
  )
}

function Logo() {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="logo-text">Opptra</span>
  return <img className="logo" src={LOGO_URL} alt="Opptra" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

function Progress({ steps }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((step, i) => (
        <li
          key={step.label}
          className={step.state === 'complete' ? 'complete' : undefined}
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          <span className="step-num" aria-hidden="true">{step.state === 'complete' ? '✓' : i + 1}</span>
          {step.label}
          <span className="sr-only">{step.state === 'complete' ? ' (done)' : ' (not done yet)'}</span>
        </li>
      ))}
    </ol>
  )
}

function SectionLabel({ id, number, children }) {
  return (
    <h2 className="section-label" id={id}>
      <span className="step-no" aria-hidden="true">{number}</span>
      {children}
    </h2>
  )
}

function EmptyState({ title, children, bordered, icon }) {
  return (
    <div className={`empty${bordered ? ' bordered' : ''}`}>
      <div className="empty-mark" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}

const TableIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 9.5h17M9.5 9.5v10" />
  </svg>
)
const PlusIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M5 12h14M12 5v14" />
  </svg>
)

function CartTotal({ results }) {
  const items = plural(results.items.length, 'item')
  if (results.cartOffers.length === 0) {
    return (
      <aside className="summary" aria-labelledby="summary-title">
        <h3 id="summary-title" className="sr-only">Cart total</h3>
        <div className="summary-total first">
          <span>Cart total</span>
          <span className="total-value">{rupees(results.subtotal)}</span>
        </div>
        <p className="summary-note">{items} after item offers. No cart-level offer applies.</p>
      </aside>
    )
  }
  return (
    <aside className="summary" aria-labelledby="summary-title">
      <h3 id="summary-title">Cart total</h3>
      <div className="summary-line">
        <span>Cart total before offer<span className="sub">{items} after item offers</span></span>
        <span className="num">{rupees(results.subtotal)}</span>
      </div>
      {results.cartOffers.map((offer) => (
        <div key={offer.ruleId} className="summary-line offer">
          <span>
            {offer.label}
            <span className="sub">{offer.ruleId} · cart total of {rupees(offer.minCartValue)} or more</span>
          </span>
          <span className="num">−{rupees(offer.amount)}</span>
        </div>
      ))}
      <div className="summary-total">
        <span>Final cart total</span>
        <span className="total-value">{rupees(results.finalTotal)}</span>
      </div>
    </aside>
  )
}

// ── Component ────────────────────────────────────────────────────

export default function App() {
  const [csvRules, setCsvRules]     = useState([])
  const [rulesErrors, setRulesErr]  = useState([])
  const [rulesFileName, setRulesFileName] = useState('')

  // Rules added in plain language; only ever added to by a confirmation
  const [confirmedRules, setConfirmedRules] = useState([])

  const [cartItems, setCartItems]   = useState([])
  const [cartErrors, setCartErrors] = useState([])
  const [cartFileName, setCartFileName]   = useState('')

  // False until the first "Calculate Discounts" click; then results stay live
  const [hasCalculated, setHasCalculated] = useState(false)

  // Which table the Load Data tabs show; display only
  const [dataTab, setDataTab] = useState('rules')

  const activeRules = useMemo(() => combineRules(csvRules, confirmedRules), [csvRules, confirmedRules])
  const results = useMemo(
    () => computeResults({ hasCalculated, activeRules, cartItems }),
    [hasCalculated, activeRules, cartItems],
  )
  // Rows for the rules table, marking which rules were added in plain language
  const ruleRows = useMemo(
    () => [
      ...csvRules.map((rule) => ({ ...rule, source: 'csv' })),
      ...confirmedRules.map((rule) => ({ ...rule, source: 'plain-language' })),
    ],
    [csvRules, confirmedRules],
  )

  // ── Handlers ──

  function handleRulesLoad(csvText, fileName) {
    const { data, errors } = parseRulesCSV(csvText)
    // Replaces only the CSV rules; confirmed plain-language rules stay
    const { rules, errors: clashErrors } = withoutConfirmedIdClashes(data, confirmedRules)
    setCsvRules(rules)
    setRulesErr([...errors, ...clashErrors])
    setRulesFileName(fileName)
  }

  function handleCartLoad(csvText, fileName) {
    const { data, errors } = parseCartCSV(csvText)
    setCartItems(data)
    setCartErrors(errors)
    setCartFileName(fileName)
  }

  function handleCalculate() {
    setHasCalculated(true)
  }

  function handleConfirmRule(rule) {
    const result = addConfirmedRule(csvRules, confirmedRules, rule)
    if (result.error) return // RuleInput validated it already; never add an invalid rule
    setConfirmedRules(result.confirmedRules)
  }

  const canCalculate = hasEnoughToCalculate(activeRules, cartItems)

  // ── Display-only values ──

  const steps = progressSteps({ ruleCount: activeRules.length, cartCount: cartItems.length, calculated: results !== null })
  const rulesStatus = uploadStatus({ fileName: rulesFileName, rowCount: csvRules.length, errorCount: rulesErrors.length })
  const cartStatus = uploadStatus({ fileName: cartFileName, rowCount: cartItems.length, errorCount: cartErrors.length })
  const rulesDetail =
    plural(csvRules.length, 'rule') +
    (confirmedRules.length > 0 ? ` + ${confirmedRules.length} added in plain language` : '')

  let calcTitle
  let calcNote
  if (!canCalculate) {
    calcTitle = 'Load rules and a cart to calculate'
    calcNote = hasCalculated
      ? 'Results will update once rules and a cart are loaded'
      : 'Load rules (CSV or plain language) and a cart to calculate'
  } else if (!hasCalculated) {
    calcTitle = 'Ready to calculate'
    calcNote = `${plural(activeRules.length, 'rule')} and ${plural(cartItems.length, 'cart item')} loaded`
  } else {
    calcTitle = 'Prices are up to date'
    calcNote = 'Results update automatically when the rules or the cart change'
  }

  // ── Render ──

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Logo />
          <span className="topbar-label">Discount engine</span>
        </div>
      </header>

      <main className="page">
        <div className="page-head">
          <div>
            <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Cart pricing</span>
            <h1>Price a cart</h1>
            <p className="lead">
              Load discount rules and a cart, or describe an offer in plain language. See each item’s final
              price, the offer behind it and the final cart total.
            </p>
          </div>
          <Progress steps={steps} />
        </div>

        <div className="stack">

          {/* 1. Load data */}
          <section aria-labelledby="load-title">
            <SectionLabel id="load-title" number={1}>Load data</SectionLabel>
            <div className="card">
              <div className="grid-2">
                <div className="file-col">
                  <CsvUploader
                    label="rules.csv"
                    title="Discount rules"
                    description="Choose a rules.csv file. It is read in your browser."
                    fileName={rulesFileName}
                    detail={rulesDetail}
                    status={rulesStatus}
                    onLoad={handleRulesLoad}
                  />
                  <ErrorBanner errors={rulesErrors} fileName={rulesFileName} loadedCount={csvRules.length} />
                </div>
                <div className="file-col">
                  <CsvUploader
                    label="cart.csv"
                    title="Cart items"
                    description="Choose a cart.csv file. It is read in your browser."
                    fileName={cartFileName}
                    detail={plural(cartItems.length, 'item')}
                    status={cartStatus}
                    onLoad={handleCartLoad}
                  />
                  <ErrorBanner errors={cartErrors} fileName={cartFileName} loadedCount={cartItems.length} />
                </div>
              </div>

              <div className="data-panel">
                {ruleRows.length === 0 && cartItems.length === 0 ? (
                  <EmptyState title="No rules or cart loaded yet" bordered icon={TableIcon}>
                    Choose a rules file and a cart file above. Their contents appear here so you can check them
                    before calculating.
                  </EmptyState>
                ) : (
                  <DataTabs
                    label="Loaded data"
                    activeId={dataTab}
                    onChange={setDataTab}
                    tabs={[
                      {
                        id: 'rules',
                        label: 'Rules',
                        count: ruleRows.length,
                        content: (
                          <>
                            {ruleRows.length > 0 && (
                              <p className="tab-note">
                                {csvRules.length} rule{csvRules.length === 1 ? '' : 's'} loaded
                                {confirmedRules.length > 0 && ` + ${confirmedRules.length} added in plain language`}
                              </p>
                            )}
                            <DataTable
                              columns={RULES_COLUMNS}
                              rows={ruleRows}
                              label="Discount rules in use"
                              cards
                              emptyMessage="No rules yet. Choose a rules.csv file above or add a rule in plain language."
                            />
                          </>
                        ),
                      },
                      {
                        id: 'cart',
                        label: 'Cart items',
                        count: cartItems.length,
                        content: (
                          <>
                            {cartItems.length > 0 && (
                              <p className="tab-note">
                                {cartItems.length} item{cartItems.length > 1 ? 's' : ''} loaded
                              </p>
                            )}
                            <DataTable
                              columns={CART_COLUMNS}
                              rows={cartItems}
                              label="Cart items"
                              cards
                              emptyMessage="No cart items yet. Choose a cart.csv file above."
                            />
                          </>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            </div>
          </section>

          {/* 2. Plain-language rules (a candidate only joins the rules once confirmed) */}
          <section aria-labelledby="rule-input-section">
            <SectionLabel id="rule-input-section" number={2}>
              Add a rule in plain language <span className="optional">(optional)</span>
            </SectionLabel>
            <RuleInput activeRules={activeRules} cartItems={cartItems} onConfirm={handleConfirmRule} />
          </section>

          {/* 3. Calculate */}
          <section aria-labelledby="calc-title">
            <SectionLabel id="calc-title" number={3}>Calculate</SectionLabel>
            <div className="action-bar">
              <div className="action-status">
                {results && <span className="badge success">Calculated</span>}
                <p>
                  <strong>{calcTitle}</strong>
                  <span className="tiny">{calcNote}</span>
                </p>
              </div>
              <button className="btn accent lg" type="button" onClick={handleCalculate} disabled={!canCalculate}>
                Calculate Discounts
              </button>
            </div>
          </section>

          {/* 4. Results */}
          <section aria-labelledby="results-title">
            <SectionLabel id="results-title" number={4}>Cart summary</SectionLabel>
            <div className="card">
              {results ? (
                <div className="results-grid">
                  <DataTable
                    columns={RESULTS_COLUMNS}
                    rows={results.items}
                    label="Final price of each cart item and the offer applied"
                    cards
                    className="results-table"
                  />
                  <CartTotal results={results} />
                </div>
              ) : (
                <EmptyState title="No prices yet" icon={PlusIcon}>
                  {canCalculate
                    ? 'Select “Calculate Discounts” to price each item and the cart.'
                    : 'Load rules and a cart, then calculate. Each item’s final price and the offer behind it appear here.'}
                </EmptyState>
              )}
            </div>
          </section>

        </div>
      </main>
    </div>
  )
}
