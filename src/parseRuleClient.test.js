/**
 * Tests for parseRuleClient.js — run with `npm test`.
 * fetch is always a fake; no network request is made.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseRuleInstruction,
  PARSE_RULE_ENDPOINT,
  CLIENT_TIMEOUT_MS,
  MIN_TEXT_LENGTH,
  MAX_TEXT_LENGTH,
} from './parseRuleClient.js'
import * as server from '../api/_lib/interpretRule.js'

// ── Fixtures ──────────────────────────────────────────────────────

/** A fake fetch that records calls and answers with `responder(url, init)`. */
function fakeFetch(responder) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responder(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** A fake fetch whose server replies with this status and JSON body (or raw text). */
const server200 = (body) => reply(200, body)
const reply = (status, body, headers = {}) =>
  fakeFetch(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  }))

/** A fake fetch that never answers until its signal is aborted. */
const hangingFetch = () =>
  fakeFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  }))

const BRAND = { scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true, minCartValue: null }
const PLATFORM = { scope: 'platform', appliesTo: 'Flipkart', type: 'flat', value: 100, stackable: false, minCartValue: null }
const CART = { scope: 'cart', appliesTo: '', type: 'percentage', value: 10, stackable: false, minCartValue: 5000 }

const run = (fetchImpl, text = '20% off for Natura Casa brand, stackable', options = {}) =>
  parseRuleInstruction(text, { fetchImpl, ...options })

/** Every result has the same four fields, plus code (and maybe retryAfterSeconds) for errors. */
function assertShape(result) {
  const expected = ['message', 'missingFields', 'rule', 'status']
  if (result.status === 'error') expected.push('code')
  if ('retryAfterSeconds' in result) expected.push('retryAfterSeconds')
  assert.deepEqual(Object.keys(result).sort(), expected.sort())
  assert.ok(Array.isArray(result.missingFields))
  assert.equal(typeof result.message, 'string')
}

function assertError(result, code) {
  assertShape(result)
  assert.equal(result.status, 'error', JSON.stringify(result))
  assert.equal(result.code, code)
  assert.equal(result.rule, null)
  assert.ok(result.message.length > 10)
}

// ── Successful responses ──────────────────────────────────────────

describe('successful responses', () => {
  for (const [label, rule] of [['brand', BRAND], ['platform', PLATFORM], ['cart', CART]]) {
    test(`a valid ${label} rule`, async () => {
      const result = await run(server200({ status: 'ok', rule }))
      assertShape(result)
      assert.deepEqual(result, { status: 'ok', rule, missingFields: [], message: '' })
    })
  }

  test('the rule is re-checked: extra fields such as ruleId are dropped', async () => {
    const result = await run(server200({ status: 'ok', rule: { ...BRAND, ruleId: 'RULE-01', reasoning: 'hidden', saving: 999 } }))
    assert.deepEqual(result.rule, BRAND)
  })

  test('an "ok" with a rule the shared validator rejects is treated as an unexpected response', async () => {
    for (const rule of [{ ...BRAND, value: 200 }, { ...CART, type: 'flat' }, null, undefined, 'rule']) {
      assertError(await run(server200({ status: 'ok', rule })), 'invalid_response')
    }
  })

  test('a clarification keeps the server message and the missing fields', async () => {
    const result = await run(server200({
      status: 'needs_clarification',
      message: 'Please add the discount amount (e.g. 10% or Rs.100) and the minimum cart value (e.g. Rs.5,000).',
      missingFields: ['value', 'minCartValue'],
    }), 'Give a discount for big orders')
    assertShape(result)
    assert.deepEqual(result, {
      status: 'needs_clarification',
      rule: null,
      missingFields: ['value', 'minCartValue'],
      message: 'Please add the discount amount (e.g. 10% or Rs.100) and the minimum cart value (e.g. Rs.5,000).',
    })
  })

  test('clarification: unknown or repeated field names are dropped', async () => {
    const result = await run(server200({ status: 'needs_clarification', message: 'Please add details.', missingFields: ['value', 'value', 'apiKey', 3, 'appliesTo'] }))
    assert.deepEqual(result.missingFields, ['value', 'appliesTo'])
  })

  test('clarification: a missing, empty, overlong or multi-line message is replaced by a safe fallback', async () => {
    for (const message of [undefined, '', '   ', 42, 'x'.repeat(501), 'line one\nline two', 'tab\there']) {
      const result = await run(server200({ status: 'needs_clarification', message, missingFields: [] }))
      assert.match(result.message, /^Please describe the offer more specifically/, JSON.stringify(message))
    }
  })

  test('an unsupported request keeps the server message', async () => {
    const result = await run(server200({ status: 'unsupported', message: 'That kind of offer is not supported yet.' }), 'Buy one get one free')
    assertShape(result)
    assert.deepEqual(result, { status: 'unsupported', rule: null, missingFields: [], message: 'That kind of offer is not supported yet.' })
  })

  test('the result never contains a ruleId', async () => {
    const result = await run(server200({ status: 'ok', rule: { ...BRAND, ruleId: 'X' } }))
    assert.equal('ruleId' in result.rule, false)
  })
})

// ── HTTP failures ─────────────────────────────────────────────────

describe('HTTP failures', () => {
  // The server's own message is deliberately unusual, to prove the client shows its own text instead
  const serverError = (code, extra = {}) => ({ status: 'error', code, message: 'RAW SERVER TEXT: Invalid API Key gsk_abc', ...extra })

  const cases = [
    [400, serverError('invalid_text'), 'invalid_text', /3 to 300 characters/],
    [400, serverError('invalid_json'), 'invalid_request', /could not be processed/],
    [400, serverError('unexpected_field'), 'invalid_request', /could not be processed/],
    [413, serverError('payload_too_large'), 'invalid_text', /3 to 300 characters/],
    [403, serverError('forbidden_origin'), 'forbidden', /blocked for security reasons/],
    [429, serverError('quota_exceeded'), 'quota_exceeded', /free usage limit/],
    [502, serverError('invalid_model_output'), 'interpretation_failed', /Couldn't interpret that safely/],
    [502, serverError('provider_error'), 'interpretation_failed', /Couldn't interpret that safely/],
    [503, serverError('not_configured'), 'not_configured', /not set up on this server/],
    [503, serverError('provider_unavailable'), 'service_unavailable', /temporarily unavailable/],
    [504, serverError('timeout'), 'timeout', /took too long/],
    [500, serverError('internal_error'), 'server_error', /went wrong on the server/],
    [405, serverError('method_not_allowed'), 'invalid_response', /unexpected response/],
    [418, { status: 'error' }, 'invalid_response', /unexpected response/],
    [201, { status: 'ok', rule: BRAND }, 'invalid_response', /unexpected response/],
  ]
  for (const [status, body, code, message] of cases) {
    test(`${status} ${body.code ?? body.status} → ${code}`, async () => {
      const result = await run(reply(status, body))
      assertError(result, code)
      assert.match(result.message, message)
      assert.doesNotMatch(result.message, /RAW SERVER TEXT|gsk_/)
    })
  }

  test('a 503 without a JSON body is still a service error', async () => {
    assertError(await run(reply(503, '<html>Service Unavailable</html>')), 'service_unavailable')
  })

  test('429 keeps a valid retry-after and says how long to wait', async () => {
    const result = await run(reply(429, serverError('quota_exceeded', { retryAfterSeconds: 7 }), { 'retry-after': '7' }))
    assertError(result, 'quota_exceeded')
    assert.equal(result.retryAfterSeconds, 7)
    assert.match(result.message, /try again in 7 seconds/)
  })

  test('429 with a long wait mentions the daily limit', async () => {
    const result = await run(reply(429, serverError('quota_exceeded', { retryAfterSeconds: 7200 })))
    assert.equal(result.retryAfterSeconds, 7200)
    assert.match(result.message, /daily free limit/)
  })

  for (const retryAfterSeconds of [0, -1, 2.5, '7', null, Infinity, 100000]) {
    test(`429 with an invalid retry-after (${String(retryAfterSeconds)}) gives none`, async () => {
      const result = await run(reply(429, serverError('quota_exceeded', { retryAfterSeconds })))
      assertError(result, 'quota_exceeded')
      assert.equal('retryAfterSeconds' in result, false)
    })
  }
})

// ── Network and response failures ─────────────────────────────────

describe('network and response failures', () => {
  test('a network failure → network_error', async () => {
    const fetchImpl = fakeFetch(() => { throw new TypeError('Failed to fetch') })
    assertError(await run(fetchImpl), 'network_error')
  })

  test('the connection drops while the body is being read → network_error', async () => {
    const broken = new ReadableStream({ start(controller) { controller.error(new TypeError('network error')) } })
    assertError(await run(fakeFetch(() => new Response(broken, { status: 200 }))), 'network_error')
  })

  for (const [label, body] of [
    ['invalid JSON', '{"status": "ok", "rule": '],
    ['an HTML page', '<!doctype html><title>Error</title>'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['an unknown status', { status: 'maybe' }],
    ['no status at all', { rule: BRAND }],
    ['an error status inside HTTP 200', { status: 'error', code: 'timeout' }],
    ['a reply over 64 KB', JSON.stringify({ status: 'unsupported', message: 'x'.repeat(70000) })],
  ]) {
    test(`HTTP 200 with ${label} → invalid_response`, async () => {
      assertError(await run(server200(body)), 'invalid_response')
    })
  }
})

// ── Timeout and cancellation ──────────────────────────────────────

describe('timeout and cancellation', () => {
  test('the default timeout is 20 seconds', () => {
    assert.equal(CLIENT_TIMEOUT_MS, 20000)
  })

  test('no reply within the timeout → the request is aborted and a timeout error returned', async () => {
    const fetchImpl = hangingFetch()
    const started = Date.now()
    const result = await run(fetchImpl, undefined, { timeoutMs: 30 })
    assertError(result, 'timeout')
    assert.equal(fetchImpl.calls[0].init.signal.aborted, true)
    assert.ok(Date.now() - started < 2000)
  })

  test('a server 504 and a client timeout look the same to the UI', async () => {
    const clientTimeout = await run(hangingFetch(), undefined, { timeoutMs: 10 })
    const serverTimeout = await run(reply(504, { status: 'error', code: 'timeout' }))
    assert.deepEqual(clientTimeout, serverTimeout)
  })

  test('cancelling on purpose → "cancelled", not an error', async () => {
    const controller = new AbortController()
    const fetchImpl = hangingFetch()
    const pending = run(fetchImpl, undefined, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const result = await pending
    assert.deepEqual(result, { status: 'cancelled', rule: null, missingFields: [], message: '' })
    assert.equal(fetchImpl.calls[0].init.signal.aborted, true, 'the request itself was aborted')
  })

  test('an already-cancelled signal → "cancelled" without sending anything', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = server200({ status: 'ok', rule: BRAND })
    assert.equal((await run(fetchImpl, undefined, { signal: controller.signal })).status, 'cancelled')
    assert.equal(fetchImpl.calls.length, 0)
  })

  test('a cancel that lands after the reply arrived is still reported as cancelled', async () => {
    const controller = new AbortController()
    const fetchImpl = fakeFetch(() => {
      controller.abort() // the user discards while the reply is in flight
      return new Response(JSON.stringify({ status: 'ok', rule: BRAND }), { status: 200 })
    })
    assert.equal((await run(fetchImpl, undefined, { signal: controller.signal })).status, 'cancelled')
  })

  test('cancellation wins over the timeout, and the timeout wins over a later cancel', async () => {
    const early = new AbortController()
    const pending = run(hangingFetch(), undefined, { signal: early.signal, timeoutMs: 50 })
    early.abort()
    assert.equal((await pending).status, 'cancelled')

    const late = new AbortController()
    const result = await run(hangingFetch(), undefined, { signal: late.signal, timeoutMs: 10 })
    late.abort()
    assert.equal(result.code, 'timeout')
  })

  test('the caller\'s signal listener is removed afterwards (no leaks)', async () => {
    const controller = new AbortController()
    let added = 0
    let removed = 0
    const { signal } = controller
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (...args) => { added++; add(...args) }
    signal.removeEventListener = (...args) => { removed++; remove(...args) }
    for (const fetchImpl of [server200({ status: 'ok', rule: BRAND }), reply(500, {}), fakeFetch(() => { throw new TypeError('x') })]) {
      await run(fetchImpl, undefined, { signal })
    }
    assert.equal(added, 3)
    assert.equal(removed, 3)
  })

  test('the timer is cleared after a reply, so the finished request is never aborted later', async () => {
    const fetchImpl = server200({ status: 'ok', rule: BRAND })
    const result = await run(fetchImpl, undefined, { timeoutMs: 20 })
    assert.equal(result.status, 'ok')
    await new Promise((resolve) => setTimeout(resolve, 60)) // well past the 20 ms timeout
    assert.equal(fetchImpl.calls[0].init.signal.aborted, false)
  })
})

// ── Input checks ──────────────────────────────────────────────────

describe('input checks (no request is sent)', () => {
  for (const [label, text] of [
    ['empty', ''], ['only spaces', '   '], ['2 characters', 'hi'], ['301 characters', 'x'.repeat(301)],
    ['a number', 20], ['null', null], ['undefined', undefined],
  ]) {
    test(`${label} → invalid_text`, async () => {
      const fetchImpl = server200({ status: 'ok', rule: BRAND })
      assertError(await parseRuleInstruction(text, { fetchImpl }), 'invalid_text')
      assert.equal(fetchImpl.calls.length, 0)
    })
  }

  test('300 characters is sent', async () => {
    const fetchImpl = server200({ status: 'ok', rule: BRAND })
    await run(fetchImpl, 'x'.repeat(300))
    assert.equal(fetchImpl.calls.length, 1)
  })

  test('the limits match the server\'s', () => {
    assert.equal(MIN_TEXT_LENGTH, server.MIN_TEXT_LENGTH)
    assert.equal(MAX_TEXT_LENGTH, server.MAX_TEXT_LENGTH)
  })
})

// ── The request itself ────────────────────────────────────────────

describe('the request', () => {
  test('one POST to the same-origin /api/parse-rule, JSON, with only the trimmed text', async () => {
    const fetchImpl = server200({ status: 'ok', rule: BRAND })
    await run(fetchImpl, '   20% off Natura Casa   ')
    assert.equal(fetchImpl.calls.length, 1)
    const [{ url, init }] = fetchImpl.calls
    assert.equal(url, '/api/parse-rule')
    assert.equal(url, PARSE_RULE_ENDPOINT)
    assert.equal(init.method, 'POST')
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' })
    assert.equal(init.body, '{"text":"20% off Natura Casa"}')
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['text'])
    assert.equal(init.credentials, 'same-origin')
    assert.ok(init.signal instanceof AbortSignal)
  })

  test('the browser sends no model, key or other option', async () => {
    const fetchImpl = server200({ status: 'ok', rule: BRAND })
    await run(fetchImpl)
    const { init } = fetchImpl.calls[0]
    assert.doesNotMatch(init.body, /model|gpt|apiKey|key/i)
    assert.equal(Object.keys(init.headers).some((h) => /authorization|key/i.test(h)), false)
  })

  test('the default fetch is called through globalThis (a detached fetch fails in browsers)', async () => {
    const original = globalThis.fetch
    let calledWithThis = 'not called'
    globalThis.fetch = function (url) {
      calledWithThis = this
      return Promise.resolve(new Response(JSON.stringify({ status: 'ok', rule: BRAND }), { status: 200 }))
    }
    try {
      const result = await parseRuleInstruction('20% off Natura Casa')
      assert.equal(result.status, 'ok')
      assert.equal(calledWithThis, globalThis)
    } finally {
      globalThis.fetch = original
    }
  })

  test('the client source never mentions Groq, the key or environment variables', () => {
    const source = readFileSync(new URL('./parseRuleClient.js', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /groq\.com|GROQ_API_KEY|import\.meta\.env|process\.env|gpt-oss|Authorization/)
    assert.doesNotMatch(source, /from ['"][./]*api\//, 'no server module is imported into browser code')
  })
})
