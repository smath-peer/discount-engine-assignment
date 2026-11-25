/**
 * csvParser.js
 *
 * Converts raw CSV text into the typed objects the discount engine expects.
 * Uses papaparse for reliable CSV parsing, then maps column names to the
 * internal data shapes.
 *
 * Expected rules.csv columns:
 *   rule_id, scope, applies_to, type, value, stackable, min_cart_value
 *
 *   min_cart_value is optional as a column (older 6-column files still load).
 *   It is required for cart rules and must be empty for brand/platform rules.
 *
 * Expected cart.csv columns:
 *   item_id, product, brand, platform, base_price
 */

import Papa from 'papaparse'
import { validateRule, ruleTermsKey } from './discountRuleValidator.js'
import { validateCartItem } from './cartItemValidator.js'

// ── Reading the CSV structure (shared by both files) ─────────────
//
// A malformed row does not discard the rest of the file. Each row is kept
// only when its boundaries are certain:
//   - A row with more values than the header (often an unquoted comma in a
//     name, or a price such as 1,299) is skipped: which value is extra cannot
//     be known, so none is guessed.
//   - A row with fewer values than the header is skipped the same way.
//   - A quote mark that is not closed on its own line makes every later line
//     uncertain (they may belong to the quoted value). The rows before it are
//     kept; that row and everything after it are reported as not read.
// The header must name every required column; otherwise the whole file is
// unusable and nothing in it is read (fileError).
// Values are always separated by commas: the separator is not guessed.

export const CART_REQUIRED_COLUMNS = Object.freeze(['item_id', 'product', 'brand', 'platform', 'base_price'])
// min_cart_value is optional as a column (older 6-column files still load)
export const RULES_REQUIRED_COLUMNS = Object.freeze(['rule_id', 'scope', 'applies_to', 'type', 'value', 'stackable'])

const hasLineBreak = (value) => typeof value === 'string' && /[\r\n]/.test(value)

/**
 * Splits CSV text into rows, keeping only rows whose boundaries are certain.
 * Returns { entries, fileError }:
 *   entries: [{ row, rowNum }] for rows to read, or [{ rowNum, problem }] for
 *            rows that could not be read, in file order
 *   fileError: null, or why the file cannot be used at all
 */
export function readCsvRows(csvText, requiredColumns) {
  const { data: rows, errors: parseErrors, meta } = Papa.parse(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    delimiter: ',',
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })

  const columns = meta.fields ?? []
  if (columns.length === 0) return { entries: [], fileError: null } // an empty file: no rows
  const missing = requiredColumns.filter((column) => !columns.includes(column))
  if (missing.length > 0) {
    return {
      entries: [],
      fileError:
        `The header row is missing ${missing.length === 1 ? 'the column' : 'the columns'} ${missing.join(', ')}. ` +
        `The first line must name the columns: ${requiredColumns.join(', ')}.`,
    }
  }

  const tooFew = new Set(parseErrors.filter((e) => e.code === 'TooFewFields').map((e) => e.row))
  // An unclosed quote either swallows later lines into one value (a line
  // break inside it) or, on the last line, just runs to the end of the file
  const quoteRow = parseErrors.some((e) => e.code === 'MissingQuotes')
    ? rows.findIndex((row) => Object.values(row).some(hasLineBreak)) : -1
  const unclosedAt = quoteRow >= 0 || !parseErrors.some((e) => e.code === 'MissingQuotes') ? quoteRow : rows.length - 1

  const entries = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2 // account for header row
    // A value spanning lines means a quote opened here was closed on a later
    // line: the lines in between cannot be told apart from this value
    if (i === unclosedAt || Object.values(row).some(hasLineBreak) || (row.__parsed_extra ?? []).some(hasLineBreak)) {
      entries.push({
        rowNum,
        problem:
          `Row ${rowNum}: a quote mark (") is not closed on this line, so this row and the rest of the file ` +
          'could not be read reliably. Rows before it were read.',
      })
      break
    }
    if (row.__parsed_extra) {
      const count = columns.length + row.__parsed_extra.length
      entries.push({
        rowNum,
        problem:
          `Row ${rowNum}: has ${count} values but the header has ${columns.length}, so it was skipped. ` +
          'This is often a comma inside a name or a price such as 1,299: put that value in double quotes.',
      })
      continue
    }
    if (tooFew.has(i)) {
      entries.push({
        rowNum,
        problem: `Row ${rowNum}: has ${Object.keys(row).length} values but the header has ${columns.length}, so it was skipped.`,
      })
      continue
    }
    entries.push({ row, rowNum })
  }
  return { entries, fileError: null }
}

/**
 * Parses the raw text of rules.csv into an array of DiscountRule objects.
 * Returns { data, errors } where errors is an array of row-level issues
 * (including rows skipped by readCsvRows), or { data: [], errors: [], fileError }
 * when the header does not name every required column.
 *
 * The work is split in two:
 *   - This parser handles the CSV itself: blank cells, turning text into
 *     numbers and booleans, and lower-casing scope and type.
 *   - validateRule (shared with the natural-language rule input) decides
 *     whether the typed rule is allowed: valid scope and type, positive
 *     value, the 100% cap, cart-rule constraints.
 * The parser then skips duplicate rules (see "Duplicate rules" below) and
 * puts the row's own rule_id back on the validated rule.
 */
export function parseRulesCSV(csvText) {
  const { entries, fileError } = readCsvRows(csvText, RULES_REQUIRED_COLUMNS)
  if (fileError) return { data: [], errors: [], fileError }

  const data = []
  const errors = []
  const seenIds = new Map() // rule_id key → { rowNum, terms } of the row that kept it
  const seenTerms = new Map() // terms key → { rowNum, ruleId }

  entries.forEach(({ row, rowNum, problem }) => {
    if (problem) {
      errors.push(problem)
      return
    }

    // ── Step 1: blank cells (CSV structure) ──
    // All blank required cells are reported together in one message.
    const missing = []
    const isCartRule = row.scope?.trim().toLowerCase() === 'cart'

    if (!row.rule_id?.trim()) missing.push('rule_id')
    if (!row.scope) missing.push('scope')
    // Cart rules apply to the whole cart, so they don't name a brand or platform
    if (!isCartRule && !row.applies_to?.trim()) missing.push('applies_to')
    if (!row.type) missing.push('type')
    if (row.value === undefined || row.value === '') missing.push('value')
    if (row.stackable === undefined || row.stackable === '') missing.push('stackable')

    if (missing.length > 0) {
      errors.push(`Row ${rowNum}: missing fields — ${missing.join(', ')}`)
      return
    }

    // ── Step 2: text → typed values ──
    // Text that is not a strictly written number is passed on unchanged,
    // so the validator rejects it with the received text in the message.
    const value = parseDecimal(row.value) ?? row.value
    const minCartText = (row.min_cart_value ?? '').trim()
    const minCartValue = minCartText === '' ? null : (parseDecimal(minCartText) ?? minCartText)

    const candidate = {
      scope: row.scope.trim().toLowerCase(),
      appliesTo: row.applies_to ?? '',
      type: row.type.trim().toLowerCase(),
      value,
      stackable: parseStackable(row.stackable),
      minCartValue,
    }

    // ── Step 3: business rules (shared validator) ──
    const { rule, errors: ruleErrors } = validateRule(candidate)

    if (ruleErrors.length > 0) {
      const messages = ruleErrors.map((error) =>
        // A cart threshold like "4,000" or "Rs.4000" gets a CSV-specific hint.
        // (On a brand/platform row the validator's "only applies to cart rules" is kept.)
        error.field === 'minCartValue' && candidate.scope === 'cart' && typeof minCartValue === 'string'
          ? `min_cart_value must be a number of 0 or more, written as digits only (e.g. 4000), got "${row.min_cart_value}"`
          : error.message
      )
      errors.push(`Row ${rowNum}: ${messages.join('; ')}`)
      return
    }

    // ── Step 4: duplicates (see the policy above duplicateMessage) ──
    const ruleId = row.rule_id.trim()
    const duplicate = duplicateMessage(ruleId, rule, seenIds, seenTerms)
    if (duplicate) {
      errors.push(`Row ${rowNum}: ${duplicate}`)
      return
    }
    seenIds.set(ruleIdKey(ruleId), { rowNum, terms: termsKey(rule) })
    seenTerms.set(termsKey(rule), { rowNum, ruleId })

    // ── Step 5: put the row's own ID back (the validator drops it) ──
    data.push({ ruleId, ...rule })
  })

  return { data, errors }
}

// ── Duplicate rules ──────────────────────────────────────────────
//
// The app tells offers apart by rule_id (the applied-offer breakdown, the
// offer comparison and previews all look rules up by it), and the engine
// applies every matching stackable rule, so a repeated row would take the
// same discount twice. Within one rules file:
//   - the first row with a given rule_id or a given set of terms is kept;
//   - a later row reusing that rule_id is skipped, whether its terms are the
//     same (a repeated row) or different (two offers sharing one ID);
//   - a later row with exactly the same terms under another rule_id is
//     skipped too, so the same offer can never apply twice.
// Offers that differ in any term (scope, brand or platform, type, value,
// stackable, minimum) are kept. Every skipped row gets its own message.
// rule_id is compared ignoring case and outer spaces, as everywhere else.

const ruleIdKey = (id) => id.trim().toUpperCase()

// Shared with the plain-language and manual offers (appRules.js), so every
// source agrees on what "the same offer" means
const termsKey = ruleTermsKey

/** Why this rule is a duplicate of an earlier row, or null if it is not one. */
function duplicateMessage(ruleId, rule, seenIds, seenTerms) {
  const sameId = seenIds.get(ruleIdKey(ruleId))
  if (sameId) {
    return sameId.terms === termsKey(rule)
      ? `duplicate of row ${sameId.rowNum} (same rule_id "${ruleId}" and same terms), skipped so the discount is not applied twice`
      : `rule_id "${ruleId}" is already used by row ${sameId.rowNum} with different terms, so this row was skipped. Give each offer its own rule_id`
  }
  const sameTerms = seenTerms.get(termsKey(rule))
  if (sameTerms) {
    return `same offer as row ${sameTerms.rowNum} (${sameTerms.ruleId}), skipped so the discount is not applied twice`
  }
  return null
}

/**
 * Reads the stackable cell. "true", "1" and "yes" (any case) mean true;
 * anything else means false. This is the long-standing CSV behaviour:
 * a typo such as "ture" silently becomes false (a known limitation).
 */
function parseStackable(text) {
  const normalised = text.trim().toLowerCase()
  return normalised === 'true' || normalised === '1' || normalised === 'yes'
}

/**
 * Strictly reads a number written as digits with an optional decimal part:
 * "10", "10.5", "150.50", "4000", "0". Spaces around it are ignored.
 * Returns null for anything else: "", "10abc", "15%", "1,500", "Rs.4000",
 * "-5", "NaN", "Infinity", "1e3", ".5", "0x10".
 *
 * Why not parseFloat: it reads the leading digits and ignores the rest,
 * so parseFloat("1,500") is 1 and parseFloat("10abc") is 10.
 * Why not Number alone: Number("") is 0 and Number("0x10") is 16.
 * The isFinite check catches very long digit strings that overflow to Infinity.
 */
function parseDecimal(text) {
  const trimmed = (text ?? '').trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : null
}

// The cart.csv column for each CartItem field, used in error messages
const CART_COLUMNS = {
  itemId: 'item_id',
  product: 'product',
  brand: 'brand',
  platform: 'platform',
  basePrice: 'base_price',
}

/**
 * Turns the shared validator's errors for one row into one CSV message, e.g.
 *   Row 3: missing fields — brand
 *   Row 4: base_price must be an amount in rupees such as 1299, 1,299 or Rs.1,299, got "abc"
 */
function cartRowMessage(rowNum, errors) {
  const parts = []
  const missing = errors.filter((e) => e.code === 'missing').map((e) => CART_COLUMNS[e.field])
  if (missing.length > 0) parts.push(`missing fields — ${missing.join(', ')}`)
  for (const error of errors) {
    if (error.code === 'price_format') {
      parts.push(`base_price must be an amount in rupees such as 1299, 1,299 or Rs.1,299, got "${error.received}"`)
    }
    if (error.code === 'price_too_small') {
      parts.push(`base_price must be at least Rs.1, got "${error.received}"`)
    }
  }
  return `Row ${rowNum}: ${parts.join('; ')}`
}

/**
 * Parses the raw text of cart.csv into an array of CartItem objects.
 * Returns { data, errors } where errors is an array of row-level issues
 * (including rows skipped by readCsvRows), or { data: [], errors: [], fileError }
 * when the header does not name every required column.
 *
 * This parser handles the CSV itself (columns, row numbers, messages);
 * validateCartItem (shared with the PDF parser) decides whether each row is
 * usable, including the strict price check.
 */
export function parseCartCSV(csvText) {
  const { entries, fileError } = readCsvRows(csvText, CART_REQUIRED_COLUMNS)
  if (fileError) return { data: [], errors: [], fileError }

  const data = []
  const errors = []

  entries.forEach(({ row, rowNum, problem }) => {
    if (problem) {
      errors.push(problem)
      return
    }
    const { item, errors: rowErrors } = validateCartItem({
      itemId: row.item_id,
      product: row.product,
      brand: row.brand,
      platform: row.platform,
      basePrice: row.base_price,
    })

    if (rowErrors.length > 0) {
      errors.push(cartRowMessage(rowNum, rowErrors))
      return
    }
    data.push(item)
  })

  return { data, errors }
}
