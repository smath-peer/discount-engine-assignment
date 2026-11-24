import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { parseRuleHandler } from './api/_lib/parseRuleHandler.js'
import { readNodeBodyCapped } from './api/_lib/readBody.js'

/**
 * Development-only route for POST /api/parse-rule, so `npm run dev` works
 * without a Vercel account. It uses the same parseRuleHandler as the Vercel
 * function in api/parse-rule.js, so responses are identical.
 *
 * apply: 'serve' keeps it out of `vite build`; this config file is never
 * part of the browser bundle.
 *
 * GROQ_API_KEY is read here, in Node, with loadEnv limited to that one name.
 * Only VITE_-prefixed variables reach the browser (import.meta.env), and the
 * key has no such prefix. The key is never printed.
 */
function parseRuleDevRoute() {
  let apiKey
  return {
    name: 'parse-rule-dev-route',
    apply: 'serve',
    configResolved(config) {
      apiKey = loadEnv(config.mode, config.envDir, 'GROQ_API_KEY').GROQ_API_KEY
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/api/parse-rule') return next()

        let result
        try {
          result = await parseRuleHandler({
            method: req.method,
            host: req.headers.host,
            origin: req.headers.origin,
            contentType: req.headers['content-type'],
            contentLength: req.headers['content-length'],
            fetchSite: req.headers['sec-fetch-site'],
            readBody: (maxBytes) => readNodeBodyCapped(req, maxBytes),
            apiKey,
            log: ({ code, detail }) => server.config.logger.warn(`[parse-rule] ${code} (${detail})`),
          })
        } catch {
          result = {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            body: { status: 'error', code: 'internal_error', message: 'Something went wrong. Please try again.' },
          }
        }
        res.statusCode = result.statusCode
        for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value)
        res.end(JSON.stringify(result.body))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), parseRuleDevRoute()],
})
