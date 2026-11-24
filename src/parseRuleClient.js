/**
 * parseRuleClient.js (browser)
 *
 * Sends a natural-language discount instruction to this app's own server
 * endpoint, POST /api/parse-rule, and returns a clean result for the UI.
 * The browser never talks to Groq and never sees the API key: the server
 * holds the key and chooses the model.
 *
 * parseRuleInstruction(text, { signal, timeoutMs, fetchImpl }) never throws.
 * It always resolves to one result with the same four fields:
 *
 *   { status: "ok",                  rule, missingFields: [], message: "" }
 *   { status: "needs_clarification", rule: null, missingFields, message }
 *   { status: "unsupported",         rule: null, missingFields: [], message }
 *   { status: "error",               rule: null, missingFields: [], message, code, retryAfterSeconds? }
 *   { status: "cancelled",           rule: null, missingFields: [], message: "" }
 *
 * "cancelled" means the caller aborted on purpose (e.g. the user discarded the
 * request); the UI should simply ignore it. It is never shown as an error.
 *
 * Error messages are written here, chosen by HTTP status and the server's
 * error code — the server's error text is not displayed. Clarification and
 * unsupported messages are taken from the server only after basic checks.
 * The rule is re-checked with the shared validator; no ruleId is assigned here.
 */

import { validateRule } from './engine/discountRuleValidator.js'

export const PARSE_RULE_ENDPOINT = '/api/parse-rule'
export const CLIENT_TIMEOUT_MS = 20_000
// Same limits as the server (api/_lib/interpretRule.js). They are repeated
// rather than imported so no server code ends up in the browser bundle;
// a test checks the two stay equal.
export const MIN_TEXT_LENGTH = 3
export const MAX_TEXT_LENGTH = 300

const MAX_RESPONSE_CHARS = 64 * 1024
const MAX_MESSAGE_LENGTH = 500
const LONG_WAIT_SECONDS = 10 * 60
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60
const RULE_FIELDS = ['scope', 'appliesTo', 'type', 'value', 'minCartValue']

/** Every message the client can show for an error, keyed by its error code. */
const ERROR_MESSAGES = {
  invalid_text: `Please describe the discount in ${MIN_TEXT_LENGTH} to ${MAX_TEXT_LENGTH} characters.`,
  invalid_request: 'That request could not be processed. Please check the text and try again.',
  forbidden: 'The request was blocked for security reasons. Please reload the page and try again.',
  quota_exceeded: 'The free usage limit has been reached. Please try again shortly. CSV upload still works.',
  interpretation_failed: "Couldn't interpret that safely. Please rephrase the offer.",
  not_configured: 'The rule assistant is not set up on this server. CSV upload still works.',
  service_unavailable: 'The rule assistant is temporarily unavailable. CSV upload still works.',
  timeout: 'The rule assistant took too long to respond. Please try again.',
  network_error: 'Could not reach the server. Please check your connection and try again.',
  invalid_response: 'The server sent an unexpected response. Please try again.',
  server_error: 'Something went wrong on the server. Please try again.',
}

const FALLBACK_CLARIFICATION =
  'Please describe the offer more specifically, e.g. "20% off Natura Casa" or "10% off when the cart is above Rs.5,000".'
const FALLBACK_UNSUPPORTED = 'That kind of offer is not supported yet.'

/**
 * @param {string} text  the shop owner's instruction
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]   abort to cancel on purpose → { status: "cancelled" }
 * @param {number} [options.timeoutMs]     default 20 s → { status: "error", code: "timeout" }
 * @param {Function} [options.fetchImpl]   for tests; defaults to the browser's fetch
 */
export async function parseRuleInstruction(text, { signal, timeoutMs = CLIENT_TIMEOUT_MS, fetchImpl } = {}) {
  // 1. Basic input checks (the server checks again)
  const instruction = typeof text === 'string' ? text.trim() : ''
  if (instruction.length < MIN_TEXT_LENGTH || instruction.length > MAX_TEXT_LENGTH) return error('invalid_text')
  if (signal?.aborted) return cancelled()

  // Calling a detached `fetch` throws "Illegal invocation" in browsers, so it is wrapped
  const send = fetchImpl ?? ((...args) => globalThis.fetch(...args))

  // 2. One controller, aborted either by our timeout or by the caller's signal
  const controller = new AbortController()
  let reason = null // 'timeout' | 'cancelled'
  const timer = setTimeout(() => {
    reason ??= 'timeout'
    controller.abort()
  }, timeoutMs)
  const onCallerAbort = () => {
    reason ??= 'cancelled'
    controller.abort()
  }
  signal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    let response
    let bodyText
    try {
      response = await send(PARSE_RULE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: instruction }),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      bodyText = await response.text()
    } catch {
      if (reason === 'cancelled') return cancelled()
      if (reason === 'timeout') return error('timeout')
      return error('network_error')
    }
    if (reason === 'cancelled') return cancelled()

    // 3. Read the reply
    return toResult(response.status, parseJsonObject(bodyText))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}

/** Parses the body as a JSON object, or returns null. */
function parseJsonObject(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.trim() === '' || bodyText.length > MAX_RESPONSE_CHARS) return null
  try {
    const value = JSON.parse(bodyText)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Turns the HTTP status and JSON body into a client result. */
function toResult(httpStatus, body) {
  if (httpStatus === 200) {
    if (!body) return error('invalid_response')
    switch (body.status) {
      case 'ok': {
        // Re-check with the shared validator; it also drops any field other than the six rule fields
        const { rule } = validateRule(body.rule)
        return rule ? { status: 'ok', rule, missingFields: [], message: '' } : error('invalid_response')
      }
      case 'needs_clarification': {
        const missingFields = Array.isArray(body.missingFields)
          ? [...new Set(body.missingFields.filter((f) => RULE_FIELDS.includes(f)))]
          : []
        return { status: 'needs_clarification', rule: null, missingFields, message: safeMessage(body.message, FALLBACK_CLARIFICATION) }
      }
      case 'unsupported':
        return { status: 'unsupported', rule: null, missingFields: [], message: safeMessage(body.message, FALLBACK_UNSUPPORTED) }
      default:
        return error('invalid_response')
    }
  }

  const serverCode = typeof body?.code === 'string' ? body.code : null
  switch (httpStatus) {
    case 400:
      return error(serverCode === 'invalid_text' ? 'invalid_text' : 'invalid_request')
    case 413:
      return error('invalid_text')
    case 403:
      return error('forbidden')
    case 429:
      return quotaError(body?.retryAfterSeconds)
    case 502:
      return error('interpretation_failed')
    case 503:
      return error(serverCode === 'not_configured' ? 'not_configured' : 'service_unavailable')
    case 504:
      return error('timeout')
    default:
      // 405, 500 and anything unexpected (including other 2xx codes)
      return error(httpStatus >= 500 ? 'server_error' : 'invalid_response')
  }
}

/** The 429 result, keeping a valid retry-after (whole seconds, up to a day). */
function quotaError(retryAfterSeconds) {
  const valid =
    Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
  if (!valid) return error('quota_exceeded')
  const message =
    retryAfterSeconds > LONG_WAIT_SECONDS
      ? 'The daily free limit has been reached. Please try again later. CSV upload still works.'
      : `The free usage limit has been reached. Please try again in ${retryAfterSeconds} seconds. CSV upload still works.`
  return { ...error('quota_exceeded'), message, retryAfterSeconds }
}

/** Uses the server's message only if it is a short, plain, single-paragraph string. */
function safeMessage(message, fallback) {
  if (typeof message !== 'string') return fallback
  const trimmed = message.trim()
  // eslint-disable-next-line no-control-regex
  if (trimmed === '' || trimmed.length > MAX_MESSAGE_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return fallback
  return trimmed
}

function error(code) {
  return { status: 'error', rule: null, missingFields: [], message: ERROR_MESSAGES[code], code }
}

function cancelled() {
  return { status: 'cancelled', rule: null, missingFields: [], message: '' }
}
