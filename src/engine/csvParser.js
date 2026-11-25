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
import { validateRule } from './discountRuleValidator.js'
import { validateCartItem } from './cartItemValidator.js'

/**
 * Parses the raw text of rules.csv into an array of DiscountRule objects.
 * Returns { data, errors } where errors is an array of row-level issues.
 *
 * The work is split in two:
 *   - This parser handles the CSV itself: blank cells, turning text into
 *     numbers and booleans, and lower-casing scope and type.
 *   - validateRule (shared with the natural-language rule input) decides
 *     whether the typed rule is allowed: valid scope and type, positive
 *     value, the 100% cap, cart-rule constraints.
 * The parser then puts the row's own rule_id back on the validated rule.
 */
export function parseRulesCSV(csvText) {
  const { data: rows, errors: parseErrors } = Papa.parse(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })

  if (parseErrors.length > 0) {
    return { data: [], errors: parseErrors.map((e) => e.message) }
  }

  const data = []
  const errors = []

  rows.forEach((row, i) => {
    const rowNum = i + 2 // account for header row

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

    // ── Step 4: put the row's own ID back (the validator drops it) ──
    data.push({ ruleId: row.rule_id.trim(), ...rule })
  })

  return { data, errors }
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
 * Returns { data, errors } where errors is an array of row-level issues.
 *
 * This parser handles the CSV itself (columns, row numbers, messages);
 * validateCartItem (shared with the PDF parser) decides whether each row is
 * usable, including the strict price check.
 */
export function parseCartCSV(csvText) {
  const { data: rows, errors: parseErrors } = Papa.parse(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })

  if (parseErrors.length > 0) {
    return { data: [], errors: parseErrors.map((e) => e.message) }
  }

  const data = []
  const errors = []

  rows.forEach((row, i) => {
    const rowNum = i + 2 // account for header row
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
