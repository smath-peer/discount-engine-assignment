/**
 * Tests for readBody.js — run with `npm test`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readWebBodyCapped, readNodeBodyCapped } from './readBody.js'

const encode = (text) => new TextEncoder().encode(text)

/** A web stream that hands out the given chunks one at a time and records whether it was cancelled. */
function webStream(chunks) {
  const state = { pulled: 0, cancelled: false }
  const stream = new ReadableStream({
    pull(controller) {
      if (state.pulled < chunks.length) controller.enqueue(chunks[state.pulled++])
      else controller.close()
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { stream, state }
}

describe('readWebBodyCapped (Vercel)', () => {
  test('reads a small body', async () => {
    assert.deepEqual(await readWebBodyCapped(new Request('http://x', { method: 'POST', body: '{"text":"hi"}' }).body, 2048), { text: '{"text":"hi"}' })
  })

  test('no body gives empty text', async () => {
    assert.deepEqual(await readWebBodyCapped(null, 2048), { text: '' })
  })

  test('exactly the limit is accepted; one byte more is too large', async () => {
    assert.equal((await readWebBodyCapped(webStream([encode('a'.repeat(10))]).stream, 10)).text, 'a'.repeat(10))
    assert.deepEqual(await readWebBodyCapped(webStream([encode('a'.repeat(11))]).stream, 10), { tooLarge: true })
  })

  test('stops reading and cancels the stream once the limit is passed', async () => {
    const chunks = Array.from({ length: 100 }, () => encode('x'.repeat(100)))
    const { stream, state } = webStream(chunks)
    assert.deepEqual(await readWebBodyCapped(stream, 250), { tooLarge: true })
    assert.ok(state.pulled < 10, `read ${state.pulled} of 100 chunks`)
    assert.equal(state.cancelled, true)
  })

  test('a character split across two chunks is decoded correctly', async () => {
    const bytes = encode('₹5,000')
    const { stream } = webStream([bytes.slice(0, 1), bytes.slice(1)])
    assert.equal((await readWebBodyCapped(stream, 100)).text, '₹5,000')
  })

  test('invalid UTF-8 is rejected', async () => {
    await assert.rejects(readWebBodyCapped(webStream([new Uint8Array([0xff, 0xfe])]).stream, 100))
  })
})

describe('readNodeBodyCapped (Vite dev server)', () => {
  test('reads a body sent in several chunks', async () => {
    const req = Readable.from([Buffer.from('{"text":'), Buffer.from('"hi"}')])
    assert.deepEqual(await readNodeBodyCapped(req, 2048), { text: '{"text":"hi"}' })
  })

  test('an empty body gives empty text', async () => {
    assert.deepEqual(await readNodeBodyCapped(Readable.from([]), 2048), { text: '' })
  })

  test('exactly the limit is accepted; one byte more is too large', async () => {
    assert.equal((await readNodeBodyCapped(Readable.from([Buffer.from('a'.repeat(10))]), 10)).text, 'a'.repeat(10))
    assert.deepEqual(await readNodeBodyCapped(Readable.from([Buffer.from('a'.repeat(11))]), 10), { tooLarge: true })
  })

  test('after the limit, the rest is drained (not stored), so a reply can still be sent', async () => {
    const req = Readable.from(Array.from({ length: 50 }, () => Buffer.from('x'.repeat(100))))
    assert.deepEqual(await readNodeBodyCapped(req, 250), { tooLarge: true })
    if (!req.readableEnded) await new Promise((resolve) => req.on('end', resolve))
    assert.equal(req.readableEnded, true, 'the stream was read to the end (drained), not destroyed early')
  })

  test('a stream error rejects', async () => {
    const req = new Readable({ read() { this.destroy(new Error('socket hang up')) } })
    await assert.rejects(readNodeBodyCapped(req, 100))
  })

  test('invalid UTF-8 is rejected', async () => {
    await assert.rejects(readNodeBodyCapped(Readable.from([Buffer.from([0xff, 0xfe])]), 100))
  })
})
