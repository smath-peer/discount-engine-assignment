/**
 * readBody.js (server only)
 *
 * Reads a request body as UTF-8 text, stopping as soon as it passes a byte
 * limit, so an oversized body is never held in memory in full.
 *
 * Two readers, because the two servers hand over the body differently:
 *   - readWebBodyCapped:  a web ReadableStream (Vercel's fetch-style handler)
 *   - readNodeBodyCapped: a Node request stream (the Vite dev server)
 *
 * Both resolve to { text } or { tooLarge: true }, and reject on a broken
 * stream or invalid UTF-8.
 */

/** Reads a web ReadableStream (or any async iterable of bytes). */
export async function readWebBodyCapped(stream, maxBytes) {
  if (stream == null) return { text: '' }
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    total += bytes.byteLength
    // Leaving the loop cancels the rest of the stream
    if (total > maxBytes) return { tooLarge: true }
    chunks.push(bytes)
  }
  return { text: decodeUtf8(chunks, total) }
}

/**
 * Reads a Node request stream. Once the limit is passed, the remaining data
 * is drained and discarded (not stored), so the server can still send a 413
 * reply instead of dropping the connection.
 */
export function readNodeBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    req.on('data', (chunk) => {
      if (settled) return // already too large: discard
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += bytes.byteLength
      if (total > maxBytes) {
        chunks.length = 0
        settle(resolve, { tooLarge: true })
        return
      }
      chunks.push(bytes)
    })
    req.on('end', () => {
      try {
        settle(resolve, { text: decodeUtf8(chunks, total) })
      } catch (error) {
        settle(reject, error)
      }
    })
    req.on('error', (error) => settle(reject, error))
  })
}

/** Joins byte chunks and decodes them; invalid UTF-8 throws. */
function decodeUtf8(chunks, total) {
  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all)
}
