/**
 * cartItemValidator.js
 *
 * The single place that decides whether a cart row is a usable CartItem.
 * Every cart input (the CSV parser, the PDF parser) reads its own format into
 * plain text fields first, then calls validateCartItem, so both formats accept
 * and reject exactly the same values.
 *
 * It does not read files, touch the UI or price anything. Error messages are
 * left to each parser, because a CSV names its columns differently from a PDF.
 *
 * Input fields (text, as read from the file; anything else is ignored):
 *   itemId, product, brand, platform, basePrice
 *
 * Output: { item, errors }
 *   item:   a CartItem { itemId, product, brand, platform, basePrice } or null
 *   errors: [{ field, code, received? }] — empty when the row is usable
 *     code 'missing'         — the field is absent or blank
 *     code 'price_format'    — basePrice is not a readable rupee amount
 *     code 'price_too_small' — basePrice is below Rs.1 once rounded
 *   All problems in a row are reported together, so they can be fixed at once.
 */

export const CART_ITEM_FIELDS = Object.freeze(['itemId', 'product', 'brand', 'platform', 'basePrice'])

// An optional currency mark before the amount: "Rs.", "Rs", "INR" or "₹",
// in any case, with or without a space after it.
const CURRENCY_PREFIX = /^(?:rs\.?|inr|₹)\s*/i

// The amount itself: digits written plainly ("1299"), with thousands commas
// ("1,299", "123,456", "1,234,567") or with Indian lakh commas ("1,23,456"),
// and at most two decimal places (paise).
const AMOUNT = /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d{1,2})?$/

// The Indian invoice ending "/-" ("Rs.1,299/-") means "and no paise".
const INVOICE_SUFFIX = /\/-$/

/**
 * Strictly reads a rupee amount and rounds it to whole rupees, as the cart
 * has always done. Spaces around the text are ignored.
 *
 * Accepted: "1299", "1,299", "Rs.1,299", "Rs 1,299", "₹1,299", "INR 1299",
 *           "1,23,456", "449.50", "Rs.1,299/-"
 * Rejected: "", "abc", "1299abc", "-5", "1e3", "1 299", "12,99", "1,2,99",
 *           "1,299.999", "$1,299", "0x10"
 *
 * Why not parseFloat: it stops at the first character it cannot read, so
 * parseFloat("1,299") is 1 and parseFloat("1299abc") is 1299.
 *
 * Returns { value } with a whole number of rupees, or { error } with
 * 'price_format' or 'price_too_small' (below Rs.1 after rounding).
 */
export function parsePrice(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return { error: 'price_format' }
  const amount = String(text).trim().replace(CURRENCY_PREFIX, '').replace(INVOICE_SUFFIX, '')
  if (!AMOUNT.test(amount)) return { error: 'price_format' }

  const value = Math.round(Number(amount.replaceAll(',', '')))
  if (!Number.isSafeInteger(value)) return { error: 'price_format' }
  if (value < 1) return { error: 'price_too_small' }
  return { value }
}

const isBlank = (value) => value == null || String(value).trim() === ''

/**
 * Checks one cart row read as text. Text fields are trimmed; a field that is
 * blank or only spaces counts as missing.
 */
export function validateCartItem(fields = {}) {
  const errors = []

  for (const field of CART_ITEM_FIELDS) {
    if (isBlank(fields[field])) errors.push({ field, code: 'missing' })
  }

  let basePrice = null
  if (!isBlank(fields.basePrice)) {
    const price = parsePrice(fields.basePrice)
    if (price.error) errors.push({ field: 'basePrice', code: price.error, received: String(fields.basePrice).trim() })
    else basePrice = price.value
  }

  if (errors.length > 0) return { item: null, errors }

  return {
    item: {
      itemId: String(fields.itemId).trim(),
      product: String(fields.product).trim(),
      brand: String(fields.brand).trim(),
      platform: String(fields.platform).trim(),
      basePrice,
    },
    errors: [],
  }
}
