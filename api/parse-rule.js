/**
 * POST /api/parse-rule — Vercel Function (Node.js runtime, web-standard handler).
 *
 * A thin adapter: it reads the request, hands plain values to the shared
 * parseRuleHandler, and turns its result into a Response. All checks and
 * the Groq call live in api/_lib (folders starting with "_" are not
 * turned into endpoints by Vercel).
 *
 * GROQ_API_KEY comes from the Vercel project's environment variables and
 * stays on the server; it is never sent to the browser or logged.
 */

import { parseRuleHandler } from './_lib/parseRuleHandler.js'
import { readWebBodyCapped } from './_lib/readBody.js'

export default {
  async fetch(request) {
    const result = await parseRuleHandler({
      method: request.method,
      // The host this request was addressed to, as set by the platform (not X-Forwarded-Host)
      host: new URL(request.url).host,
      origin: request.headers.get('origin'),
      contentType: request.headers.get('content-type'),
      contentLength: request.headers.get('content-length'),
      fetchSite: request.headers.get('sec-fetch-site'),
      readBody: (maxBytes) => readWebBodyCapped(request.body, maxBytes),
      apiKey: process.env.GROQ_API_KEY,
      log: ({ code, detail }) => console.warn(`[parse-rule] ${code} (${detail})`),
    })
    return new Response(JSON.stringify(result.body), { status: result.statusCode, headers: result.headers })
  },
}
