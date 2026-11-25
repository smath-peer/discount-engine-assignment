/**
 * App.jsx
 *
 * Top-level component. Manages state for rules, cart items, and results.
 * Wires together file upload (rules CSV; cart CSV or PDF) / plain-language
 * rules → parse → engine → display. Cart files go through cartLoad.js, which
 * decides whether a file replaces the cart and keeps the cart Undo restores.
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
 * Layout: a checkout page. On wide screens, "Your cart" and "Offers" on the
 * left and a sticky "Checkout" panel on the right; on narrower screens the
 * same three sections stack in that order, which is also the reading and
 * keyboard order everywhere. In one column, once prices are calculated, a
 * bar fixed to the bottom of the screen (PayBar) keeps the amount to pay in
 * view. Styling follows the Opptra design system (see index.css).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import FileUploader from './components/FileUploader.jsx'
import CartLoadNotice from './components/CartLoadNotice.jsx'
import CartItemList from './components/CartItemList.jsx'
import CheckoutSummary from './components/CheckoutSummary.jsx'
import PayBar from './components/PayBar.jsx'
import DataTable from './components/DataTable.jsx'
import RuleInput from './components/RuleInput.jsx'
import { uploadStatus, progressSteps, plural } from './components/loadStatus.js'
import {
  combineRules, canCalculate as hasEnoughToCalculate, computeResults, addConfirmedRule, removeConfirmedRule, restoreConfirmedRule,
} from './appRules.js'
import { INITIAL_RULES_STATE, readRulesFile, applyRulesLoad, undoRulesLoad, withdrawRulesUndo } from './input/rulesLoad.js'
import { INITIAL_CART_STATE, readCartFile, applyCartLoad, undoCartLoad } from './input/cartLoad.js'
import { loadPdfjs } from './input/pdf/loadPdfjs.js'
import { checkoutSummary, partialCartWarning } from './checkout/checkoutSummary.js'
import {
  appliedOfferBreakdown, itemOfferOptions, previewOffer, openPreview, closePreview, currentPreview,
} from './checkout/offerComparison.js'

// The official logo from the Opptra design system; a text wordmark is shown if it cannot load
const LOGO_URL = 'https://cdn.prod.website-files.com/6933cd7135f6e590ffef0761/6937f6a9040488e80b8e30b0_logo.svg'

const rupees = (amount) => `Rs.${amount.toLocaleString('en-IN')}`

// ── Active offers table ──────────────────────────────────────────

const RULES_COLUMNS = [
  {
    key: 'ruleId',
    label: 'Offer',
    nowrap: true,
    render: (v, row) => (
      <>
        <strong>{v}</strong>
        {row.source === 'plain-language' && (
          <>
            {' '}<span className="tag" title="Added here, in plain language or manually">Added</span>
            <button type="button" className="btn secondary sm offer-remove" onClick={() => row.onRemove(v)}>
              Remove<span className="sr-only"> offer {v}</span>
            </button>
          </>
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

// ── Small presentational pieces ──────────────────────────────────

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

// ── Component ────────────────────────────────────────────────────

export default function App() {
  // The CSV offers in use and the offers Undo would restore (see rulesLoad.js)
  const [rulesState, setRulesState] = useState(INITIAL_RULES_STATE)
  const { rules: csvRules, errors: rulesErrors, fileName: rulesFileName } = rulesState.current
  // What the last rules upload or Undo did, shown under the rules file row
  const [rulesNotice, setRulesNotice] = useState(null)
  const [rulesBusyFile, setRulesBusyFile] = useState('')
  const rulesRequest = useRef(0)
  const rulesNoticeTitle = useRef(null)
  const [focusRulesNotice, setFocusRulesNotice] = useState(false)

  // Rules added in plain language; only ever added to by a confirmation
  const [confirmedRules, setConfirmedRules] = useState([])

  // The cart in use and the cart Undo would restore (see cartLoad.js)
  const [cartState, setCartState]   = useState(INITIAL_CART_STATE)
  // What the last cart upload or Undo did, shown under the cart file row
  const [cartNotice, setCartNotice] = useState(null)
  // The cart file being read right now ('' when none); PDFs take a moment
  const [cartBusyFile, setCartBusyFile] = useState('')
  const cartRequest = useRef(0)
  const cartNoticeTitle = useRef(null)
  const [focusCartNotice, setFocusCartNotice] = useState(false)
  const cart = cartState.cart
  const cartItems = cart.items

  // False until the first "Calculate Discounts" click; then results stay live
  const [hasCalculated, setHasCalculated] = useState(false)

  const activeRules = useMemo(() => combineRules(csvRules, confirmedRules), [csvRules, confirmedRules])
  const results = useMemo(
    () => computeResults({ hasCalculated, activeRules, cartItems }),
    [hasCalculated, activeRules, cartItems],
  )
  // The price breakdown, read from the actual result only (previews never reach it)
  const summary = useMemo(
    () => (results ? checkoutSummary(results, activeRules.filter((rule) => rule.scope === 'cart')) : null),
    [results, activeRules],
  )
  // For each priced item: what each applied offer took off, and its alternatives (or null)
  const breakdowns = useMemo(
    () => (results ? results.items.map((result, i) => appliedOfferBreakdown(cartItems[i], activeRules, result)) : []),
    [results, cartItems, activeRules],
  )
  const comparisons = useMemo(
    () => (results ? results.items.map((result, i) => itemOfferOptions(cartItems[i], activeRules, result)) : []),
    [results, cartItems, activeRules],
  )

  // Which item's offer list is open, and which preview: one of each at a time.
  // Both remember the cart and rules they were opened for, so any change to
  // either closes them (see currentPreview in offerComparison.js).
  const [compareState, setCompareState] = useState(null)
  const [previewState, setPreviewState] = useState(null)
  const comparing = results ? currentPreview(compareState, cartItems, activeRules) : null
  const previewing = results ? currentPreview(previewState, cartItems, activeRules) : null
  const preview = previewing ? previewOffer(cartItems, activeRules, results, previewing.itemIndex, previewing.ruleId) : null

  function handleToggleCompare(itemIndex) {
    const isOpen = comparing?.itemIndex === itemIndex
    setCompareState(isOpen ? closePreview() : openPreview(cartItems, activeRules, itemIndex, null))
    setPreviewState(closePreview())
  }

  function handlePreview(itemIndex, ruleId) {
    setPreviewState(openPreview(cartItems, activeRules, itemIndex, ruleId))
  }

  // After a preview closes, focus returns to the button that opened it
  const [returnFocusTo, setReturnFocusTo] = useState(null)
  useEffect(() => {
    if (!returnFocusTo) return
    document.getElementById(returnFocusTo)?.focus()
    setReturnFocusTo(null)
  }, [returnFocusTo])

  function handleClosePreview() {
    if (previewing) setReturnFocusTo(`preview-button-${previewing.itemIndex}-${previewing.ruleId}`)
    setPreviewState(closePreview())
  }

  // Rows for the active offers table, marking which were added in plain language
  // (built on every render, so each Remove button calls the current handler)
  const ruleRows = [
    ...csvRules.map((rule) => ({ ...rule, source: 'csv' })),
    ...confirmedRules.map((rule) => ({ ...rule, source: 'plain-language', onRemove: handleRemoveOffer })),
  ]

  // ── Handlers ──

  // Prices are already on screen, so a cart change re-prices them visibly
  const pricesShown = hasCalculated && activeRules.length > 0

  /**
   * Reads a rules CSV. A file with usable rules replaces the CSV offers (with
   * Undo); a file without any keeps the current offers. Plain-language offers
   * always stay. See rulesLoad.js.
   */
  async function handleRulesSelect(file) {
    const request = ++rulesRequest.current
    setRulesBusyFile(file.name)
    setRulesNotice(null) // an older Undo must not be pressed while the new file is read
    setRemovedOffer(null)
    const result = await readRulesFile(file, confirmedRules)
    if (request !== rulesRequest.current) return // a newer file was chosen meanwhile

    // Results are derived from the rules in use, so after a replacement prices
    // are on screen (and recalculated) exactly when Calculate was used and a cart is loaded
    const pricesShownAfter = hasCalculated && cartItems.length > 0
    const { state, notice } = applyRulesLoad(rulesState, result, { fileName: file.name, pricesShownAfter })
    setRulesState(state)
    setRulesNotice(notice)
    setRulesBusyFile('')
  }

  function handleRulesUndo() {
    const undone = undoRulesLoad(rulesState, { pricesShownAfter: hasCalculated && cartItems.length > 0 })
    if (!undone) return
    setRemovedOffer(null)
    setRulesState(undone.state)
    setRulesNotice(undone.notice)
    setFocusRulesNotice(true) // the Undo button is gone, so focus moves to the outcome
  }

  useEffect(() => {
    if (!focusRulesNotice) return
    rulesNoticeTitle.current?.focus()
    setFocusRulesNotice(false)
  }, [focusRulesNotice])

  // ── Removing an offer added here (plain language or manual), with Undo ──
  //
  // The outcome is shown in the same notice as rules uploads, so there is
  // only ever one Undo for the offers. Undo is withdrawn by any other change
  // to the offers (an upload, a confirmation, another removal).

  // The offer the last removal took out, as { rule, index }, while its Undo is offered
  const [removedOffer, setRemovedOffer] = useState(null)

  /** What the notice says about prices once `rules` are the offers in use. */
  function pricesLine(rules, recalculated) {
    if (!hasCalculated || cartItems.length === 0) return []
    return rules.length > 0
      ? [recalculated]
      : ['No offers are in use now, so prices are not shown until an offer is added.']
  }

  function handleRemoveOffer(ruleId) {
    const result = removeConfirmedRule(confirmedRules, ruleId)
    if (!result) return
    setConfirmedRules(result.confirmedRules)
    setRemovedOffer(result.removed)
    setRulesState(withdrawRulesUndo) // one Undo at a time: this notice replaces any upload's
    setRulesNotice({
      kind: 'removed',
      tone: 'success',
      title: `Offer ${ruleId} removed`,
      lines: pricesLine([...csvRules, ...result.confirmedRules], 'Prices were recalculated without it.'),
      skipped: [],
      notes: [],
      canUndo: true,
    })
    setFocusRulesNotice(true) // its Remove button is gone, so focus moves to the outcome
  }

  function handleRemovalUndo() {
    if (!removedOffer) return
    const restored = restoreConfirmedRule(csvRules, confirmedRules, removedOffer)
    const ruleId = removedOffer.rule.ruleId
    setRemovedOffer(null)
    if (!restored) {
      setRulesNotice({
        kind: 'removed', tone: 'danger', title: `Offer ${ruleId} could not be restored`,
        lines: ['Another active offer now uses its ID or its terms.'], skipped: [], notes: [], canUndo: false,
      })
    } else {
      setConfirmedRules(restored)
      setRulesNotice({
        kind: 'removed', tone: 'success', title: `Offer ${ruleId} restored`,
        lines: pricesLine([...csvRules, ...restored], 'Prices were recalculated with it.'), skipped: [], notes: [], canUndo: false,
      })
    }
    setFocusRulesNotice(true)
  }

  /**
   * Reads a cart CSV or PDF. A file with usable rows replaces the cart (with
   * Undo); a file without any keeps the current cart. See cartLoad.js.
   */
  async function handleCartSelect(file) {
    const request = ++cartRequest.current
    setCartBusyFile(file.name)
    setCartNotice(null) // an older Undo must not be pressed while the new file is read
    const result = await readCartFile(file, { loadPdfjs })
    if (request !== cartRequest.current) return // a newer file was chosen meanwhile

    const { state, notice } = applyCartLoad(cartState, result, { fileName: file.name, calculated: pricesShown })
    setCartState(state)
    setCartNotice(notice)
    setCartBusyFile('')
  }

  function handleCartUndo() {
    const undone = undoCartLoad(cartState, { calculated: pricesShown })
    if (!undone) return
    setCartState(undone.state)
    setCartNotice(undone.notice)
    setFocusCartNotice(true) // the Undo button is gone, so focus moves to the outcome
  }

  useEffect(() => {
    if (!focusCartNotice) return
    cartNoticeTitle.current?.focus()
    setFocusCartNotice(false)
  }, [focusCartNotice])

  // ── Checkout panel: focus, and whether it fits on screen ──

  const checkoutSection = useRef(null)
  const checkoutTitle = useRef(null)
  const [focusCheckout, setFocusCheckout] = useState(false)

  /** Brings the "Price details" heading into view and moves focus to it. */
  function showPriceDetails() {
    const heading = checkoutTitle.current
    if (!heading) return
    heading.focus({ preventScroll: true })
    heading.scrollIntoView({ block: 'start' }) // stops below the sticky header (scroll-padding-top)
  }

  // The Calculate button is replaced by the price details, so focus moves to them
  useEffect(() => {
    if (!focusCheckout) return
    showPriceDetails()
    setFocusCheckout(false)
  }, [focusCheckout])

  // On wide screens Checkout stays in view (sticky) only while it fits below
  // the header; a taller panel scrolls with the page, so none of it is cut off
  const [checkoutFits, setCheckoutFits] = useState(true)
  useEffect(() => {
    const section = checkoutSection.current
    if (!section) return undefined
    const check = () => {
      const top = parseFloat(getComputedStyle(section).top) || 0
      setCheckoutFits(section.offsetHeight <= window.innerHeight - top - 16)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(section)
    window.addEventListener('resize', check)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', check)
    }
  }, [])

  function handleCalculate() {
    setHasCalculated(true)
    setFocusCheckout(true)
  }

  /** Returns { error } when the rule is not added (invalid, or the same offer is already active). */
  function handleConfirmRule(rule) {
    const result = addConfirmedRule(csvRules, confirmedRules, rule)
    if (result.error) return { error: result.error } // never add an invalid or duplicate rule
    setConfirmedRules(result.confirmedRules)
    // Its ID was chosen to avoid the offers in use, so replaced or removed offers can no longer come back
    setRulesState(withdrawRulesUndo)
    setRemovedOffer(null)
    setRulesNotice((notice) => (notice?.canUndo ? { ...notice, canUndo: false } : notice))
    return {}
  }

  const canCalculate = hasEnoughToCalculate(activeRules, cartItems)

  // ── Display-only values ──

  const steps = progressSteps({ ruleCount: activeRules.length, cartCount: cartItems.length, calculated: results !== null })
  const rulesStatus = uploadStatus({ fileName: rulesFileName, rowCount: csvRules.length, errorCount: rulesErrors.length })
  const cartStatus = uploadStatus({ fileName: cart.fileName, rowCount: cartItems.length, errorCount: cart.skipped.length })
  const rulesDetail =
    plural(csvRules.length, 'offer') +
    (confirmedRules.length > 0 ? ` + ${confirmedRules.length} added here` : '')
  const partialWarning = partialCartWarning(cart)

  let calcTitle
  let calcNote
  if (!canCalculate) {
    calcTitle = cartItems.length === 0 && activeRules.length === 0
      ? 'Load a cart and offers to see your prices'
      : cartItems.length === 0 ? 'Load a cart to see your prices' : 'Load offers to see your prices'
    calcNote = hasCalculated
      ? 'Prices will update as soon as a cart and offers are loaded.'
      : 'Offers can come from a rules CSV or be described in plain language.'
  } else if (!hasCalculated) {
    calcTitle = 'Ready to calculate'
    calcNote = `${plural(cartItems.length, 'item')} and ${plural(activeRules.length, 'offer')} loaded.`
  } else {
    calcTitle = 'Prices are up to date'
    calcNote = 'They update automatically when the cart or the offers change.'
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
              Upload a cart and its offers, or describe an offer in plain language. See the best offer on each
              item, what you save and the amount to pay.
            </p>
          </div>
          <Progress steps={steps} />
        </div>

        <div className="checkout-layout">

          {/* 1. Your cart */}
          <section className="area-cart" aria-labelledby="cart-title">
            <SectionLabel id="cart-title" number={1}>Your cart</SectionLabel>
            <div className="card">
              <FileUploader
                label="the cart, a CSV or PDF file"
                title="Cart items"
                description="Choose a cart CSV or PDF. It is read in your browser."
                accept=".csv,.pdf,text/csv,application/pdf"
                fileName={cart.fileName}
                detail={plural(cartItems.length, 'item')}
                status={cartStatus}
                busyFileName={cartBusyFile}
                onSelect={handleCartSelect}
              />
              {/* A polite live region: the outcome is announced without moving focus */}
              <div aria-live="polite" className="cart-notice-region">
                {cartBusyFile && <p className="status-line">Reading {cartBusyFile}…</p>}
                {cartNotice && <CartLoadNotice notice={cartNotice} onUndo={handleCartUndo} titleRef={cartNoticeTitle} />}
              </div>

              {cartItems.length > 0 && (
                <div className="cart-items">
                  <div className="list-head">
                    <h3>Items</h3>
                    <span className="list-count">{plural(cartItems.length, 'item')}</span>
                  </div>
                  {!results && (
                    <p className="list-note">
                      Base prices are shown. Calculate to see the offers on each item.
                    </p>
                  )}
                  <CartItemList
                    items={cartItems}
                    results={results?.items ?? null}
                    breakdowns={breakdowns}
                    comparisons={comparisons}
                    comparingIndex={comparing?.itemIndex ?? null}
                    preview={preview}
                    onToggleCompare={handleToggleCompare}
                    onPreview={handlePreview}
                    onClosePreview={handleClosePreview}
                  />
                </div>
              )}
            </div>
          </section>

          {/* 2. Offers: rules CSV, plain-language offers (a candidate only joins once confirmed), the active list */}
          <section className="area-offers" aria-labelledby="offers-title">
            <SectionLabel id="offers-title" number={2}>Offers</SectionLabel>
            <div className="offers-stack">
              <div className="card">
                <FileUploader
                  label="rules.csv"
                  title="Discount rules"
                  description="Choose a rules.csv file. It is read in your browser."
                  accept=".csv,text/csv"
                  fileName={rulesFileName}
                  detail={rulesDetail}
                  status={rulesStatus}
                  busyFileName={rulesBusyFile}
                  onSelect={handleRulesSelect}
                />
                {/* A polite live region: the outcome is announced without moving focus */}
                <div aria-live="polite" className="cart-notice-region">
                  {rulesBusyFile && <p className="status-line">Reading {rulesBusyFile}…</p>}
                  {rulesNotice && (
                    <CartLoadNotice
                      notice={rulesNotice}
                      onUndo={rulesNotice.kind === 'removed' ? handleRemovalUndo : handleRulesUndo}
                      titleRef={rulesNoticeTitle}
                      undoLabel={rulesNotice.kind === 'removed' ? 'restore the removed offer' : 'restore the previous offers'}
                    />
                  )}
                </div>

                <div className="active-offers">
                  <div className="list-head">
                    <h3>Active offers</h3>
                    <span className="list-count">{plural(ruleRows.length, 'offer')}</span>
                  </div>
                  <DataTable
                    columns={RULES_COLUMNS}
                    rows={ruleRows}
                    label="Active offers"
                    cards
                    emptyMessage="No offers yet. Choose a rules.csv file above or describe an offer below."
                  />
                </div>
              </div>

              <RuleInput activeRules={activeRules} cartItems={cartItems} onConfirm={handleConfirmRule} />
            </div>
          </section>

          {/* 3. Checkout: the actual prices only; previews stay inside their product card */}
          <section
            ref={checkoutSection}
            className={checkoutFits ? 'area-checkout' : 'area-checkout too-tall'}
            aria-labelledby="checkout-title"
          >
            <SectionLabel id="checkout-title" number={3}>Checkout</SectionLabel>
            {/* Announces the amount to pay whenever it changes (a new cart, new offers) */}
            <p className="sr-only" aria-live="polite">
              {summary ? `Amount to pay: ${rupees(summary.finalTotal)}` : ''}
            </p>
            <div className="card checkout-card">
              {results ? (
                <>
                  {partialWarning && (
                    <div className="alert warning checkout-warning">
                      <span className="symbol" aria-hidden="true">!</span>
                      <div className="alert-body">
                        <p className="alert-title">Some cart rows were skipped</p>
                        <p>{partialWarning}</p>
                      </div>
                    </div>
                  )}
                  <CheckoutSummary summary={summary} titleRef={checkoutTitle} />
                  <p className="checkout-status">
                    <span className="badge success">Calculated</span>
                    <span>{calcNote}</span>
                  </p>
                </>
              ) : (
                <div className="checkout-empty">
                  <h3 className="price-details-title" ref={checkoutTitle} tabIndex={-1}>Price details</h3>
                  <p className="checkout-empty-title">{calcTitle}</p>
                  <p className="checkout-empty-note">{calcNote}</p>
                  <button className="btn accent lg checkout-calc" type="button" onClick={handleCalculate} disabled={!canCalculate}>
                    Calculate Discounts
                  </button>
                </div>
              )}
            </div>
          </section>

        </div>
      </main>

      {/* Below 1100px only (index.css); after the main content in reading and keyboard order */}
      {summary && (
        <PayBar finalTotal={summary.finalTotal} totalSavings={summary.totalSavings} onShowDetails={showPriceDetails} />
      )}
    </div>
  )
}
