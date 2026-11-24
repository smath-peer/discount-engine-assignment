/**
 * parseRuleHandler.js (server only)
 *
 * The HTTP logic for POST /api/parse-rule, written without any framework so
 * the Vercel function and the Vite dev server can share it, and tests can
 * call it directly.
 *
 * Input (plain values the adapter reads from its own request object):
 *   method, host, origin, contentType, contentLength, fetchSite
 *   readBody(maxBytes) → Promise<{ text } | { tooLarge: true }>
 *   apiKey                — GROQ_API_KEY from the server environment
 *   interpret, model      — injectable for tests; default to the real interpreter and model
 *   log({ code, detail }) — optional; receives fixed labels only, never secrets
 *
 * Output: { statusCode, headers, body } — body is a plain object for JSON.
 *
 * Checks run in this order, and each stops the request:
 *   1. method is POST                                   → else 405
 *   2. Origin matches this server's Host                → else 403
 *   3. Content-Type is application/json                 → else 400
 *   4. body is at most 2 KB (header, then while reading) → else 413
 *   5. body is a JSON object with only a "text" string of 3–300 characters → else 400
 *   6. the API key is set and the model is the approved one → else 503
 *   7. interpretRule, with its result mapped to an HTTP status
 *
 * The body sent back never contains the key, the provider's own error text,
 * stack traces, hidden reasoning, or the interpreter's internal `detail`.
 * No CORS headers are sent: only this app's own pages may call the endpoint.
 */

import { interpretRule, GROQ_MODEL, ALLOWED_MODELS, MIN_TEXT_LENGTH, MAX_TEXT_LENGTH } from './interpretRule.js'

export const MAX_BODY_BYTES = 2 * 1024
/** Retry-after values longer than this are treated as the daily limit. */
const LONG_WAIT_SECONDS = 10 * 60
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60

const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
})

/** Fixed messages for every error the browser can receive. */
const MESSAGES = {
  method_not_allowed: 'Only POST requests are supported.',
  forbidden_origin: 'This endpoint only accepts requests from this app.',
  unsupported_content_type: 'The request must be JSON (Content-Type: application/json).',
  payload_too_large: 'The request is too large.',
  invalid_json: 'The request body must be a JSON object such as {"text": "20% off Natura Casa"}.',
  unexpected_field: 'Only a "text" field is accepted.',
  invalid_text: `Please describe the discount in ${MIN_TEXT_LENGTH} to ${MAX_TEXT_LENGTH} characters.`,
  not_configured: 'The rule assistant is not configured. CSV upload still works.',
  quota_exceeded: 'The free usage limit has been reached. Please try again shortly. CSV upload still works.',
  provider_unavailable: 'The rule assistant is temporarily unavailable. CSV upload still works.',
  provider_error: 'The rule assistant could not process that request. Please try again.',
  timeout: 'The rule assistant took too long to respond. Please try again shortly.',
  invalid_model_output: "Couldn't interpret that safely. Please rephrase the offer.",
  internal_error: 'Something went wrong. Please try again.',
}

/** interpretRule error code → [HTTP status, code sent to the browser] */
const INTERPRETER_ERRORS = {
  invalid_input: [400, 'invalid_text'],
  missing_api_key: [503, 'not_configured'],
  model_not_allowed: [503, 'not_configured'],
  provider_auth_failed: [503, 'not_configured'],
  quota_exceeded: [429, 'quota_exceeded'],
  provider_unavailable: [503, 'provider_unavailable'],
  provider_error: [502, 'provider_error'],
  timeout: [504, 'timeout'],
  invalid_model_output: [502, 'invalid_model_output'],
}

export async function parseRuleHandler({
  method,
  host,
  origin,
  contentType,
  contentLength,
  fetchSite,
  readBody,
  apiKey,
  interpret = interpretRule,
  model = GROQ_MODEL,
  log = () => {},
} = {}) {
  try {
    // 1. Method
    if (method !== 'POST') return errorResponse(405, 'method_not_allowed', { Allow: 'POST' })

    // 2. Origin
    if (!isSameOrigin({ origin, host, fetchSite })) return errorResponse(403, 'forbidden_origin')

    // 3. Content type
    if (!isJsonContentType(contentType)) return errorResponse(400, 'unsupported_content_type')

    // 4. Size: the declared length first, then the real length while reading
    const declared = Number(contentLength)
    if (contentLength != null && contentLength !== '' && Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return errorResponse(413, 'payload_too_large')
    }
    if (typeof readBody !== 'function') return errorResponse(500, 'internal_error')
    let body
    try {
      body = await readBody(MAX_BODY_BYTES)
    } catch {
      return errorResponse(400, 'invalid_json') // broken stream or invalid UTF-8
    }
    if (body?.tooLarge) return errorResponse(413, 'payload_too_large')

    // 5. JSON with exactly one field, "text"
    let payload
    try {
      payload = JSON.parse(body?.text ?? '')
    } catch {
      return errorResponse(400, 'invalid_json')
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return errorResponse(400, 'invalid_json')
    }
    if (Object.keys(payload).some((key) => key !== 'text')) return errorResponse(400, 'unexpected_field')
    const text = typeof payload.text === 'string' ? payload.text.trim() : null
    if (text === null || text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) {
      return errorResponse(400, 'invalid_text')
    }

    // 6. Configuration (checked before any call to the interpreter)
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      log({ code: 'not_configured', detail: 'missing_api_key' })
      return errorResponse(503, 'not_configured')
    }
    if (!ALLOWED_MODELS.includes(model)) {
      log({ code: 'not_configured', detail: 'model_not_allowed' })
      return errorResponse(503, 'not_configured')
    }

    // 7. Interpret (one attempt; interpretRule itself never retries)
    const result = await interpret({ text, apiKey, model })
    return toHttpResponse(result, log)
  } catch (error) {
    log({ code: 'internal_error', detail: error?.name ?? 'unknown' })
    return errorResponse(500, 'internal_error')
  }
}

/**
 * Same-origin check (a safeguard, not authentication: a script outside a
 * browser can send any headers it likes).
 *
 * Policy:
 *   - Origin is required. Browsers send it on every POST made with fetch, so a
 *     missing Origin means the caller is not this app's page → 403.
 *   - It must be a plain origin ("scheme://host[:port]", no path), and its host
 *     must equal this request's Host header (default ports ignored).
 *   - http:// is allowed only for localhost, 127.0.0.1 and [::1] (local dev).
 *   - If the browser sent Sec-Fetch-Site, it must be "same-origin".
 *   - Forwarded headers (X-Forwarded-Host etc.) are never consulted.
 */
export function isSameOrigin({ origin, host, fetchSite }) {
  if (fetchSite != null && fetchSite !== 'same-origin') return false
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false
  if (typeof host !== 'string' || host.trim() === '') return false

  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.origin !== origin) return false // rejects paths, credentials, trailing slashes, odd casing
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) return false

  return url.host === withoutDefaultPort(host.trim().toLowerCase(), url.protocol)
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function withoutDefaultPort(host, protocol) {
  if (protocol === 'https:' && host.endsWith(':443')) return host.slice(0, -4)
  if (protocol === 'http:' && host.endsWith(':80')) return host.slice(0, -3)
  return host
}

function isJsonContentType(contentType) {
  if (typeof contentType !== 'string') return false
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** Maps interpretRule's result to an HTTP response with only allowed fields. */
function toHttpResponse(result, log) {
  switch (result?.status) {
    case 'ok': {
      // Copy only the six rule fields, so nothing else can ride along
      const { scope, appliesTo, type, value, stackable, minCartValue } = result.rule ?? {}
      return jsonResponse(200, { status: 'ok', rule: { scope, appliesTo, type, value, stackable, minCartValue } })
    }
    case 'needs_clarification':
      return jsonResponse(200, {
        status: 'needs_clarification',
        message: result.message,
        missingFields: result.missingFields,
      })
    case 'unsupported':
      return jsonResponse(200, { status: 'unsupported', message: result.message })
    case 'error': {
      log({ code: result.code, detail: result.detail })
      const [statusCode, code] = Object.hasOwn(INTERPRETER_ERRORS, result.code)
        ? INTERPRETER_ERRORS[result.code]
        : [500, 'internal_error']
      if (code === 'quota_exceeded') return quotaResponse(result.retryAfterSeconds)
      return errorResponse(statusCode, code)
    }
    default:
      log({ code: 'internal_error', detail: 'unexpected_interpreter_result' })
      return errorResponse(500, 'internal_error')
  }
}

function quotaResponse(retryAfterSeconds) {
  const seconds =
    Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
      ? retryAfterSeconds
      : null
  if (seconds === null) return errorResponse(429, 'quota_exceeded')

  const message =
    seconds > LONG_WAIT_SECONDS
      ? 'The daily free limit has been reached. Please try again later. CSV upload still works.'
      : `The free usage limit has been reached. Please try again in ${seconds} seconds. CSV upload still works.`
  return jsonResponse(
    429,
    { status: 'error', code: 'quota_exceeded', message, retryAfterSeconds: seconds },
    { 'Retry-After': String(seconds) },
  )
}

function errorResponse(statusCode, code, extraHeaders = {}) {
  return jsonResponse(statusCode, { status: 'error', code, message: MESSAGES[code] }, extraHeaders)
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return { statusCode, headers: { ...BASE_HEADERS, ...extraHeaders }, body }
}
