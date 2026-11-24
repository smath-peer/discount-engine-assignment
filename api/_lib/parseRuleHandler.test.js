/**
 * Tests for parseRuleHandler.js and the Vercel adapter (api/parse-rule.js).
 * Run with `npm test`. No server is started and Groq is never contacted:
 * the interpreter is either a fake, or the real one given a fake fetch.
 *
 * (These tests live in api/_lib because every file directly in api/ would
 * become a public Vercel endpoint.)
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseRuleHandler, isSameOrigin, MAX_BODY_BYTES } from './parseRuleHandler.js'
import { readWebBodyCapped } from './readBody.js'
import { interpretRule, GROQ_MODEL } from './interpretRule.js'
import vercelFunction from '../parse-rule.js'

const TEST_KEY = 'test-key-not-a-real-secret'
const LOCAL = { origin: 'http://localhost:5173', host: 'localhost:5173' }
const PRODUCTION = { origin: 'https://discount-engine.vercel.app', host: 'discount-engine.vercel.app' }

const RULE = { scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 20, stackable: true, minCartValue: null }
const OK_RESULT = { status: 'ok', rule: RULE, missingFields: [], message: '' }

// ── Fixtures ──────────────────────────────────────────────────────

/** A readBody that streams `text` through the real capped reader, and records whether it was used. */
function bodyOf(text) {
  const readBody = async (maxBytes) => {
    readBody.called = true
    return readWebBodyCapped(new Request('http://x', { method: 'POST', body: text }).body, maxBytes)
  }
  readBody.called = false
  return readBody
}

/** A fake interpreter that records its calls and returns `result` (or throws it). */
function fakeInterpret(result) {
  const calls = []
  const interpret = async (args) => {
    calls.push(args)
    if (result instanceof Error) throw result
    return result
  }
  interpret.calls = calls
  return interpret
}

/** A request that passes every check; override any part of it. */
const request = (overrides = {}) => ({
  method: 'POST',
  ...LOCAL,
  contentType: 'application/json',
  fetchSite: 'same-origin',
  readBody: bodyOf('{"text":"20% off for Natura Casa brand, stackable"}'),
  apiKey: TEST_KEY,
  interpret: fakeInterpret(OK_RESULT),
  ...overrides,
})

/** Asserts an error response with this status and public code. */
function assertError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, JSON.stringify(response.body))
  assert.equal(response.body.status, 'error')
  assert.equal(response.body.code, code)
  assert.equal(typeof response.body.message, 'string')
  assert.ok(response.body.message.length > 10)
}

/** A Groq reply, for tests that run the real interpreter with a fake fetch. */
const groqReply = (answer, status = 200) =>
  new Response(
    status === 200
      ? JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer), reasoning: 'HIDDEN-REASONING-MARKER' } }],
        })
      : '{"error":{"message":"Invalid API Key provided: gsk_RAW_PROVIDER_TEXT","type":"invalid_request_error"}}',
    { status },
  )
const realInterpreterWith = (reply) => (args) => interpretRule({ ...args, fetchImpl: async () => reply })

// ── Method ────────────────────────────────────────────────────────

describe('method', () => {
  test('POST is accepted', async () => {
    const response = await parseRuleHandler(request())
    assert.equal(response.statusCode, 200)
  })

  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', undefined]) {
    test(`${method ?? 'no method'} → 405 with Allow: POST, nothing else is done`, async () => {
      const readBody = bodyOf('{"text":"20% off Natura Casa"}')
      const interpret = fakeInterpret(OK_RESULT)
      const response = await parseRuleHandler(request({ method, readBody, interpret }))
      assertError(response, 405, 'method_not_allowed')
      assert.equal(response.headers.Allow, 'POST')
      assert.equal(readBody.called, false)
      assert.equal(interpret.calls.length, 0)
    })
  }
})

// ── Origin ────────────────────────────────────────────────────────

describe('origin', () => {
  const accepted = [
    ['local dev (localhost)', LOCAL],
    ['local dev (127.0.0.1)', { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' }],
    ['local dev (IPv6 loopback)', { origin: 'http://[::1]:5173', host: '[::1]:5173' }],
    ['production on its own domain', PRODUCTION],
    ['production with an explicit :443 in Host', { origin: PRODUCTION.origin, host: 'discount-engine.vercel.app:443' }],
    ['Host in capitals', { origin: PRODUCTION.origin, host: 'Discount-Engine.Vercel.App' }],
  ]
  for (const [label, headers] of accepted) {
    test(`accepted: ${label}`, async () => {
      assert.equal((await parseRuleHandler(request(headers))).statusCode, 200)
    })
  }

  const rejected = [
    ['an unrelated website', { origin: 'https://evil.example', host: PRODUCTION.host }],
    ['a look-alike domain', { origin: 'https://discount-engine.vercel.app.evil.example', host: PRODUCTION.host }],
    ['a different port (host/origin mismatch)', { origin: 'http://localhost:5174', host: LOCAL.host }],
    ['a different subdomain', { origin: 'https://other.vercel.app', host: PRODUCTION.host }],
    ['plain http on a public domain', { origin: 'http://discount-engine.vercel.app', host: PRODUCTION.host }],
    ['missing Origin (policy: browsers always send it on POST)', { origin: undefined }],
    ['empty Origin', { origin: '' }],
    ['"null" Origin (sandboxed page or file://)', { origin: 'null' }],
    ['not a URL', { origin: 'localhost:5173' }],
    ['an origin with a path', { origin: 'http://localhost:5173/app' }],
    ['an origin with a trailing slash', { origin: 'http://localhost:5173/' }],
    ['an origin with credentials', { origin: 'http://user:pass@localhost:5173' }],
    ['a non-web scheme', { origin: 'file://localhost:5173' }],
    ['missing Host', { host: undefined }],
    ['Sec-Fetch-Site: cross-site', { fetchSite: 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { fetchSite: 'same-site' }],
  ]
  for (const [label, headers] of rejected) {
    test(`rejected: ${label} → 403`, async () => {
      const readBody = bodyOf('{"text":"20% off Natura Casa"}')
      const interpret = fakeInterpret(OK_RESULT)
      const response = await parseRuleHandler(request({ ...headers, readBody, interpret }))
      assertError(response, 403, 'forbidden_origin')
      assert.equal(readBody.called, false, 'the body is not read for a rejected origin')
      assert.equal(interpret.calls.length, 0)
    })
  }

  test('a missing Sec-Fetch-Site header (older browsers) is fine when Origin matches', async () => {
    assert.equal((await parseRuleHandler(request({ fetchSite: undefined }))).statusCode, 200)
  })

  test('isSameOrigin can be used on its own', () => {
    assert.equal(isSameOrigin(LOCAL), true)
    assert.equal(isSameOrigin({ origin: 'https://evil.example', host: 'localhost:5173' }), false)
  })
})

// ── Content type and body ─────────────────────────────────────────

describe('content type', () => {
  for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
    test(`"${contentType}" is accepted`, async () => {
      assert.equal((await parseRuleHandler(request({ contentType }))).statusCode, 200)
    })
  }
  for (const contentType of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp']) {
    test(`${JSON.stringify(contentType) ?? 'no content type'} → 400`, async () => {
      assertError(await parseRuleHandler(request({ contentType })), 400, 'unsupported_content_type')
    })
  }
})

describe('body size (2 KB)', () => {
  const padded = (bytes) => {
    const json = '{"text":"20% off Natura Casa"}'
    return json + ' '.repeat(bytes - json.length) // JSON allows trailing whitespace
  }

  test('a body of exactly 2,048 bytes is accepted', async () => {
    assert.equal(padded(MAX_BODY_BYTES).length, 2048)
    assert.equal((await parseRuleHandler(request({ readBody: bodyOf(padded(MAX_BODY_BYTES)) }))).statusCode, 200)
  })

  test('2,049 bytes → 413, found while reading (no Content-Length header)', async () => {
    const interpret = fakeInterpret(OK_RESULT)
    assertError(await parseRuleHandler(request({ readBody: bodyOf(padded(MAX_BODY_BYTES + 1)), interpret })), 413, 'payload_too_large')
    assert.equal(interpret.calls.length, 0)
  })

  test('a declared Content-Length over 2 KB → 413 before reading anything', async () => {
    const readBody = bodyOf('{"text":"20% off Natura Casa"}')
    assertError(await parseRuleHandler(request({ contentLength: '5000', readBody })), 413, 'payload_too_large')
    assert.equal(readBody.called, false)
  })

  test('a small or unreadable Content-Length still has the body checked while reading', async () => {
    assertError(await parseRuleHandler(request({ contentLength: '10', readBody: bodyOf(padded(4000)) })), 413, 'payload_too_large')
    assertError(await parseRuleHandler(request({ contentLength: 'abc', readBody: bodyOf(padded(4000)) })), 413, 'payload_too_large')
  })

  test('a broken body stream → 400', async () => {
    const readBody = async () => { throw new Error('socket hang up') }
    assertError(await parseRuleHandler(request({ readBody })), 400, 'invalid_json')
  })
})

describe('JSON body and text', () => {
  for (const [label, body] of [
    ['empty body', ''],
    ['malformed JSON', '{"text": "20% off'],
    ['a JSON array', '["20% off Natura Casa"]'],
    ['a JSON string', '"20% off Natura Casa"'],
    ['JSON null', 'null'],
  ]) {
    test(`${label} → 400 invalid_json`, async () => {
      assertError(await parseRuleHandler(request({ readBody: bodyOf(body) })), 400, 'invalid_json')
    })
  }

  for (const [label, body] of [
    ['no text field', '{}'],
    ['text is a number', '{"text": 20}'],
    ['text is null', '{"text": null}'],
    ['whitespace only', '{"text": "     "}'],
    ['2 characters', '{"text": "hi"}'],
    ['301 characters', JSON.stringify({ text: 'x'.repeat(301) })],
  ]) {
    test(`${label} → 400 invalid_text`, async () => {
      const interpret = fakeInterpret(OK_RESULT)
      assertError(await parseRuleHandler(request({ readBody: bodyOf(body), interpret })), 400, 'invalid_text')
      assert.equal(interpret.calls.length, 0)
    })
  }

  test('exactly 300 characters is accepted', async () => {
    assert.equal((await parseRuleHandler(request({ readBody: bodyOf(JSON.stringify({ text: 'x'.repeat(300) })) }))).statusCode, 200)
  })

  test('unknown fields are rejected, so callers cannot think they choose a model or option', async () => {
    for (const body of ['{"text":"20% off Natura Casa","model":"openai/gpt-oss-120b"}', '{"text":"20% off Natura Casa","apiKey":"x"}']) {
      const interpret = fakeInterpret(OK_RESULT)
      assertError(await parseRuleHandler(request({ readBody: bodyOf(body), interpret })), 400, 'unexpected_field')
      assert.equal(interpret.calls.length, 0)
    }
  })

  test('the interpreter gets the trimmed text, the key and the approved model — once', async () => {
    const interpret = fakeInterpret(OK_RESULT)
    await parseRuleHandler(request({ readBody: bodyOf('{"text":"   20% off Natura Casa   "}'), interpret }))
    assert.deepEqual(interpret.calls, [{ text: '20% off Natura Casa', apiKey: TEST_KEY, model: GROQ_MODEL }])
  })
})

// ── Configuration ─────────────────────────────────────────────────

describe('configuration', () => {
  for (const [label, apiKey] of [['missing', undefined], ['empty', ''], ['spaces', '   ']]) {
    test(`API key ${label} → 503 not_configured, interpreter not called`, async () => {
      const interpret = fakeInterpret(OK_RESULT)
      assertError(await parseRuleHandler(request({ apiKey, interpret })), 503, 'not_configured')
      assert.equal(interpret.calls.length, 0)
    })
  }

  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b:free', '']) {
    test(`model "${model}" → 503 before the interpreter is called`, async () => {
      const interpret = fakeInterpret(OK_RESULT)
      assertError(await parseRuleHandler(request({ model, interpret })), 503, 'not_configured')
      assert.equal(interpret.calls.length, 0)
    })
  }

  test('request problems are reported before configuration problems', async () => {
    assertError(await parseRuleHandler(request({ apiKey: undefined, readBody: bodyOf('{"text":"hi"}') })), 400, 'invalid_text')
  })
})

// ── Interpreter results → HTTP ────────────────────────────────────

describe('interpreter results', () => {
  test('a valid rule → 200 with just status and the six rule fields', async () => {
    const leaky = { ...OK_RESULT, rule: { ...RULE, ruleId: 'X', reasoning: 'r' }, detail: 'internal', reasoning: 'r' }
    const response = await parseRuleHandler(request({ interpret: fakeInterpret(leaky) }))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body, { status: 'ok', rule: RULE })
  })

  test('clarification → 200 with the message and missing fields', async () => {
    const result = { status: 'needs_clarification', rule: null, missingFields: ['value', 'minCartValue'], message: 'Please add the discount amount.' }
    const response = await parseRuleHandler(request({ interpret: fakeInterpret(result) }))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body, { status: 'needs_clarification', message: 'Please add the discount amount.', missingFields: ['value', 'minCartValue'] })
  })

  test('unsupported → 200 with the message', async () => {
    const result = { status: 'unsupported', rule: null, missingFields: [], message: 'That kind of offer is not supported yet.' }
    const response = await parseRuleHandler(request({ interpret: fakeInterpret(result) }))
    assert.deepEqual([response.statusCode, response.body], [200, { status: 'unsupported', message: 'That kind of offer is not supported yet.' }])
  })

  const errorCases = [
    ['quota_exceeded', 429, 'quota_exceeded'],
    ['provider_unavailable', 503, 'provider_unavailable'],
    ['provider_auth_failed', 503, 'not_configured'],
    ['missing_api_key', 503, 'not_configured'],
    ['model_not_allowed', 503, 'not_configured'],
    ['timeout', 504, 'timeout'],
    ['invalid_model_output', 502, 'invalid_model_output'],
    ['provider_error', 502, 'provider_error'],
    ['invalid_input', 400, 'invalid_text'],
    ['some_future_code', 500, 'internal_error'],
  ]
  for (const [interpreterCode, statusCode, publicCode] of errorCases) {
    test(`interpreter error ${interpreterCode} → ${statusCode} ${publicCode}, without the internal detail`, async () => {
      const result = { status: 'error', code: interpreterCode, detail: 'http_500', message: 'internal text' }
      const response = await parseRuleHandler(request({ interpret: fakeInterpret(result) }))
      assertError(response, statusCode, publicCode)
      assert.equal('detail' in response.body, false)
      assert.notEqual(response.body.message, 'internal text')
    })
  }

  test('429 keeps a valid retry-after as a field and a Retry-After header', async () => {
    const result = { status: 'error', code: 'quota_exceeded', detail: 'http_429', retryAfterSeconds: 7 }
    const response = await parseRuleHandler(request({ interpret: fakeInterpret(result) }))
    assert.equal(response.statusCode, 429)
    assert.equal(response.body.retryAfterSeconds, 7)
    assert.equal(response.headers['Retry-After'], '7')
    assert.match(response.body.message, /try again in 7 seconds/)
  })

  test('a long wait (over 10 minutes) is described as the daily limit', async () => {
    const result = { status: 'error', code: 'quota_exceeded', retryAfterSeconds: 7200 }
    const response = await parseRuleHandler(request({ interpret: fakeInterpret(result) }))
    assert.match(response.body.message, /daily free limit/)
    assert.equal(response.body.retryAfterSeconds, 7200)
  })

  for (const retryAfterSeconds of [undefined, 0, -5, 1.5, '7', Infinity, 999999]) {
    test(`429 with an invalid retry-after (${String(retryAfterSeconds)}) sends none`, async () => {
      const result = { status: 'error', code: 'quota_exceeded', retryAfterSeconds }
      const response = await parseRuleHandler(request({ interpret: fakeInterpret(result) }))
      assertError(response, 429, 'quota_exceeded')
      assert.equal('retryAfterSeconds' in response.body, false)
      assert.equal('Retry-After' in response.headers, false)
    })
  }

  test('an unexpected result shape → 500', async () => {
    for (const result of [undefined, null, { status: 'maybe' }, 'ok']) {
      assertError(await parseRuleHandler(request({ interpret: fakeInterpret(result) })), 500, 'internal_error')
    }
  })

  test('an exception inside the interpreter → 500 with no stack trace or error text', async () => {
    const error = new Error(`boom with key ${TEST_KEY}`)
    const response = await parseRuleHandler(request({ interpret: fakeInterpret(error) }))
    assertError(response, 500, 'internal_error')
    const text = JSON.stringify(response)
    assert.doesNotMatch(text, /boom|at .*\.js|stack/)
    assert.doesNotMatch(text, new RegExp(TEST_KEY))
  })

  test('the interpreter is called exactly once per request (no retries)', async () => {
    const interpret = fakeInterpret({ status: 'error', code: 'provider_unavailable' })
    await parseRuleHandler(request({ interpret }))
    assert.equal(interpret.calls.length, 1)
  })
})

// ── End to end with the real interpreter (fake fetch) ─────────────

describe('with the real interpreter and a fake Groq reply', () => {
  test('a Groq answer becomes a 200 rule', async () => {
    const answer = { status: 'ok', rule: RULE, missingFields: [], message: 'Parsed' }
    const response = await parseRuleHandler(request({ interpret: realInterpreterWith(groqReply(answer)) }))
    assert.deepEqual([response.statusCode, response.body], [200, { status: 'ok', rule: RULE }])
  })

  test('hidden reasoning in Groq\'s reply never reaches the response', async () => {
    const answer = { status: 'ok', rule: RULE, missingFields: [], message: '' }
    const response = await parseRuleHandler(request({ interpret: realInterpreterWith(groqReply(answer)) }))
    assert.doesNotMatch(JSON.stringify(response), /HIDDEN-REASONING-MARKER|reasoning/)
  })

  test('Groq\'s raw error text never reaches the response', async () => {
    for (const status of [400, 401, 429, 500, 503]) {
      const response = await parseRuleHandler(request({ interpret: realInterpreterWith(groqReply(null, status)) }))
      assert.equal(response.body.status, 'error')
      assert.doesNotMatch(JSON.stringify(response), /RAW_PROVIDER_TEXT|gsk_|invalid_request_error|Invalid API Key/)
    }
  })
})

// ── Security properties across every kind of response ────────────

describe('every response', () => {
  const scenarios = [
    request(),
    request({ method: 'GET' }),
    request({ origin: 'https://evil.example' }),
    request({ contentType: 'text/plain' }),
    request({ contentLength: '9999' }),
    request({ readBody: bodyOf('{bad') }),
    request({ apiKey: undefined }),
    request({ interpret: fakeInterpret({ status: 'error', code: 'quota_exceeded', retryAfterSeconds: 3 }) }),
    request({ interpret: fakeInterpret(new Error('boom')) }),
  ]

  test('is JSON, not cached, nosniff — and has no CORS headers', async () => {
    for (const scenario of scenarios) {
      const { headers } = await parseRuleHandler(scenario)
      assert.equal(headers['Content-Type'], 'application/json; charset=utf-8')
      assert.equal(headers['Cache-Control'], 'no-store')
      assert.equal(headers['X-Content-Type-Options'], 'nosniff')
      assert.equal(Object.keys(headers).some((name) => name.toLowerCase().startsWith('access-control-')), false)
    }
  })

  test('never contains the API key or an internal detail', async () => {
    for (const scenario of scenarios) {
      const response = await parseRuleHandler(scenario)
      assert.doesNotMatch(JSON.stringify(response), new RegExp(TEST_KEY))
      assert.equal('detail' in response.body, false)
    }
  })

  test('server log entries are fixed labels only, never the key', async () => {
    const entries = []
    const log = (entry) => entries.push(entry)
    await parseRuleHandler(request({ log, interpret: fakeInterpret({ status: 'error', code: 'timeout', detail: 'timeout' }) }))
    await parseRuleHandler(request({ log, apiKey: '' }))
    await parseRuleHandler(request({ log, interpret: fakeInterpret(new TypeError(`bad ${TEST_KEY}`)) }))
    assert.deepEqual(entries, [
      { code: 'timeout', detail: 'timeout' },
      { code: 'not_configured', detail: 'missing_api_key' },
      { code: 'internal_error', detail: 'TypeError' },
    ])
  })

  test('called with nothing at all → 405, not a crash', async () => {
    assert.equal((await parseRuleHandler()).statusCode, 405)
  })
})

// ── The Vercel adapter (api/parse-rule.js) ────────────────────────
// Only paths that stop before Groq are exercised, and GROQ_API_KEY is removed
// from this process for the duration, so no real request can be made.

describe('Vercel adapter', () => {
  const callVercel = async (init, { key } = {}) => {
    const saved = process.env.GROQ_API_KEY
    delete process.env.GROQ_API_KEY
    if (key !== undefined) process.env.GROQ_API_KEY = key
    try {
      return await vercelFunction.fetch(new Request(`${PRODUCTION.origin}/api/parse-rule`, init))
    } finally {
      if (saved === undefined) delete process.env.GROQ_API_KEY
      else process.env.GROQ_API_KEY = saved
    }
  }
  const sameOriginPost = (body, headers = {}) => ({
    method: 'POST',
    headers: { origin: PRODUCTION.origin, 'content-type': 'application/json', ...headers },
    body,
  })

  test('exports the web-standard { fetch } handler', () => {
    assert.equal(typeof vercelFunction.fetch, 'function')
  })

  test('GET → 405 JSON response', async () => {
    const response = await callVercel({ method: 'GET' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal((await response.json()).code, 'method_not_allowed')
  })

  test('the host comes from the request URL; another site\'s Origin → 403', async () => {
    const response = await callVercel(sameOriginPost('{"text":"20% off Natura Casa"}', { origin: 'https://evil.example' }))
    assert.equal(response.status, 403)
  })

  test('X-Forwarded-Host cannot be used to pass the origin check', async () => {
    const response = await callVercel(
      sameOriginPost('{"text":"20% off Natura Casa"}', { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }),
    )
    assert.equal(response.status, 403)
  })

  test('malformed JSON → 400', async () => {
    assert.equal((await callVercel(sameOriginPost('{bad'))).status, 400)
  })

  test('a body over 2 KB → 413', async () => {
    assert.equal((await callVercel(sameOriginPost(JSON.stringify({ text: 'x'.repeat(3000) })))).status, 413)
  })

  test('no GROQ_API_KEY in the environment → 503 not_configured', async () => {
    const response = await callVercel(sameOriginPost('{"text":"20% off Natura Casa"}'))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'not_configured')
  })

  test('no CORS headers on its responses', async () => {
    const response = await callVercel(sameOriginPost('{bad'))
    assert.equal([...response.headers.keys()].some((name) => name.startsWith('access-control-')), false)
  })
})
