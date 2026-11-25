/**
 * make-sample-pdfs.mjs
 *
 * Writes sample-data/cart.pdf and the test PDFs in test-fixtures/pdf/.
 * Run from the project root:  node scripts/make-sample-pdfs.mjs
 *
 * The files are generated from scripts/pdfFixtures.mjs; edit that file and
 * run this again to change them. The tests check that the committed files
 * still match what the generator produces.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureFiles } from './pdfFixtures.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

for (const { path, about, bytes } of fixtureFiles()) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  console.log(`${path.padEnd(42)} ${String(bytes.length).padStart(6)} bytes  ${about}`)
}
