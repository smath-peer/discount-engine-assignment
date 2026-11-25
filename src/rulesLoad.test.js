/**
 * Tests for rulesLoad.js — run with `npm test` (Node's built-in test runner).
 * They follow a rules file from upload to the prices the app would show.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  readRulesFile, parseRulesText, applyRulesLoad, undoRulesLoad, withdrawRulesUndo,
  INITIAL_RULES_STATE, RULES_FILE_MESSAGES,
} from './rulesLoad.js'
import { parseCartCSV } from './engine/csvParser.js'
import { combineRules, computeResults } from './appRules.js'
import { checkoutSummary } from './checkout/checkoutSummary.js'
import { appliedOfferBreakdown } from './checkout/offerComparison.js'

const projectText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const SAMPLE_RULES_TEXT = projectText('sample-data/rules.csv')
const CART = parseCartCSV(projectText('sample-data/cart.csv')).data
const HEADER = 'rule_id,scope,applies_to,type,value,stackable,min_cart_value'
const rulesText = (...rows) => [HEADER, ...rows].join('\n')

/** Uploads text as a file and applies it, as App does. */
async function upload(state, text, fileName, { confirmedRules = [], pricesShownAfter = false } = {}) {
  const result = await readRulesFile(new File([text], fileName, { type: 'text/csv' }), confirmedRules)
  return applyRulesLoad(state, result, { fileName, pricesShownAfter })
}

/** The amount to pay App would show for these CSV rules (after Calculate). */
const payable = (state, confirmedRules = []) =>
  computeResults({ hasCalculated: true, activeRules: combineRules(state.current.rules, confirmedRules), cartItems: CART })?.finalTotal ?? null

// ── Reading ──────────────────────────────────────────────────────

describe('readRulesFile / parseRulesText', () => {
  test('the sample rules load with no problems', async () => {
    const result = await readRulesFile(new File([SAMPLE_RULES_TEXT], 'rules.csv'), [])
    assert.equal(result.data.length, 4)
    assert.deepEqual(result.errors, [])
    assert.equal(result.fileError, null)
  })

  test('an empty or blank file says it is empty', () => {
    for (const text of ['', '   \n\n', '﻿']) {
      assert.deepEqual(parseRulesText(text, []), { data: [], errors: [], fileError: RULES_FILE_MESSAGES.empty })
    }
  })

  test('a binary file says it is not text', () => {
    assert.equal(parseRulesText('%PDF-1.7\u0000\u0001', []).fileError, RULES_FILE_MESSAGES.not_csv)
  })

  test('a header without the required columns is a file error naming them', () => {
    const result = parseRulesText('id,scope,applies_to,type,amount,stackable\nR1,brand,Natura Casa,flat,150,false', [])
    assert.deepEqual(result.data, [])
    assert.match(result.fileError, /^The header row is missing the columns rule_id, value\. /)
  })

  test('a malformed row is skipped and the good rows still load', () => {
    const result = parseRulesText(rulesText('R1,brand,Natura Casa,flat,150,false,,extra', 'R2,brand,Natura Casa,flat,100,false,'), [])
    assert.deepEqual(result.data.map((r) => r.ruleId), ['R2'])
    assert.equal(result.fileError, null)
    assert.match(result.errors[0], /^Row 2: has 8 values but the header has 7, so it was skipped\./)
  })

  test('a file whose rows are all invalid has row messages and no file error', () => {
    const result = parseRulesText(rulesText('R1,planet,Mars,percentage,10,false,'), [])
    assert.equal(result.fileError, null)
    assert.equal(result.data.length, 0)
    assert.match(result.errors[0], /^Row 2: /)
  })

  test('a file that cannot be opened gives a message instead of throwing', async () => {
    const broken = { name: 'rules.csv', text: () => Promise.reject(new Error('gone')) }
    assert.deepEqual(await readRulesFile(broken, []), { data: [], errors: [], fileError: RULES_FILE_MESSAGES.unreadable })
  })

  test('a row reusing a plain-language offer\'s ID is still skipped', () => {
    const result = parseRulesText(rulesText('NL-1,brand,Natura Casa,flat,150,false,'), [{ ruleId: 'NL-1' }])
    assert.equal(result.data.length, 0)
    assert.match(result.errors[0], /already used by a rule added in plain language/)
  })
})

// ── Applying ─────────────────────────────────────────────────────

describe('applyRulesLoad: the first upload', () => {
  test('loads the offers without Undo (there is nothing to go back to)', async () => {
    const { state, notice } = await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')
    assert.equal(state.current.rules.length, 4)
    assert.equal(state.current.fileName, 'rules.csv')
    assert.equal(state.undo, null)
    assert.deepEqual(notice, { tone: 'success', title: '4 offers loaded from rules.csv', lines: [], skipped: [], notes: [], canUndo: false })
  })

  test('an unusable first file leaves no offers and says so', async () => {
    const { state, notice } = await upload(INITIAL_RULES_STATE, '', 'empty.csv')
    assert.deepEqual(state.current.rules, [])
    assert.equal(notice.tone, 'danger')
    assert.deepEqual(notice.lines, [RULES_FILE_MESSAGES.empty, 'No offers from a rules file are in use yet.'])
  })
})

describe('applyRulesLoad: an upload that cannot be used keeps the current offers and prices', () => {
  const cases = [
    ['an empty file', '', [RULES_FILE_MESSAGES.empty]],
    ['a header-only file', HEADER, [RULES_FILE_MESSAGES.no_rows]],
    ['a file of invalid rows', rulesText('R1,planet,Mars,percentage,10,false,', 'R2,brand,Natura Casa,percentage,150,false,'), ['2 rows found, but none could be used:']],
    ['a malformed CSV', rulesText('R1,brand,Natura Casa,flat,150'), ['1 row found, but none could be used:']],
    ['a header without the required columns', 'id,offer\nR1,10', [
      'The header row is missing the columns rule_id, scope, applies_to, type, value, stackable. ' +
      'The first line must name the columns: rule_id, scope, applies_to, type, value, stackable.',
    ]],
    ['non-text bytes', 'PK\u0003\u0004\u0000\u0000', [RULES_FILE_MESSAGES.not_csv]],
  ]
  for (const [name, text, firstLines] of cases) {
    test(name, async () => {
      const loaded = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')).state
      assert.equal(payable(loaded), 5339)

      const { state, notice } = await upload(loaded, text, 'bad.csv', { pricesShownAfter: true })
      // The offers in use, their file name and their badge are exactly as before
      assert.deepEqual(state.current, loaded.current)
      assert.equal(payable(state), 5339)
      assert.equal(notice.tone, 'danger')
      assert.equal(notice.title, 'Nothing was loaded from bad.csv')
      assert.deepEqual(notice.lines, [...firstLines, 'Your offers are unchanged: 4 offers from rules.csv.'])
      assert.equal(notice.canUndo, false)
      // Never claims prices changed when they did not
      assert.ok(!notice.lines.some((line) => /recalculated/.test(line)))
    })
  }

  test('a rejected upload withdraws the Undo of an earlier replacement', async () => {
    const first = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')).state
    const second = (await upload(first, rulesText('X1,brand,Natura Casa,percentage,50,false,'), 'new.csv')).state
    assert.notEqual(second.undo, null)
    const { state } = await upload(second, '', 'bad.csv')
    assert.equal(state.undo, null)
    assert.deepEqual(state.current, second.current)
  })
})

describe('applyRulesLoad: a replacement', () => {
  const NEW_RULES = rulesText('X1,brand,Natura Casa,percentage,50,false,', 'X2,planet,Mars,percentage,10,false,')

  test('replaces the CSV offers, lists skipped rows, and offers Undo', async () => {
    const loaded = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')).state
    const { state, notice } = await upload(loaded, NEW_RULES, 'new.csv', { pricesShownAfter: true })
    assert.deepEqual(state.current.rules.map((r) => r.ruleId), ['X1'])
    assert.equal(state.current.errors.length, 1)
    assert.deepEqual(state.undo, loaded.current)
    assert.equal(notice.tone, 'warning')
    assert.equal(notice.title, 'Offers replaced: 1 offer from new.csv, 1 row skipped')
    assert.deepEqual(notice.lines, [
      'They replaced your previous offers: 4 offers from rules.csv.',
      'Skipped rows are not in use. Fix them in the file and choose it again to include them.',
      'Prices were recalculated with the new offers.',
    ])
    assert.equal(notice.canUndo, true)
  })

  test('the prices shown are those of the new offers, not the old ones', async () => {
    const loaded = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')).state
    const { state } = await upload(loaded, NEW_RULES, 'new.csv', { pricesShownAfter: true })
    // Worked by hand: 50% off the two Natura Casa items only; the discount is
    // rounded to whole rupees (half up) before it is taken off
    //   1299 - 650 (649.5) = 649, 849 - 425 (424.5) = 424; the other four at base price
    //   649 + 424 + 599 + 2499 + 449 + 899 = 5519; no cart offer
    assert.equal(payable(state), 5519)
  })

  test('says prices were recalculated only when prices are on screen', async () => {
    const loaded = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')).state
    const { notice } = await upload(loaded, NEW_RULES, 'new.csv', { pricesShownAfter: false })
    assert.ok(!notice.lines.some((line) => /recalculated/.test(line)))
  })

  test('Undo restores the previous offers, their badge and their prices', async () => {
    const loaded = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')).state
    const replaced = (await upload(loaded, NEW_RULES, 'new.csv')).state
    const { state, notice } = undoRulesLoad(replaced, { pricesShownAfter: true })
    assert.deepEqual(state, { current: loaded.current, undo: null })
    assert.equal(payable(state), 5339)
    assert.deepEqual(notice, {
      tone: 'success',
      title: 'Previous offers restored: 4 offers from rules.csv',
      lines: ['Prices were recalculated with the restored offers.'],
      skipped: [],
      notes: [],
      canUndo: false,
    })
    assert.equal(undoRulesLoad(state), null) // one level only
  })

  test('confirming a plain-language offer withdraws Undo', async () => {
    const loaded = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv')).state
    const replaced = (await upload(loaded, NEW_RULES, 'new.csv')).state
    const after = withdrawRulesUndo(replaced)
    assert.equal(after.undo, null)
    assert.deepEqual(after.current, replaced.current)
    assert.equal(withdrawRulesUndo(after), after)
  })

  test('plain-language offers stay in use across a replacement and a rejected upload', async () => {
    const confirmed = [{ ruleId: 'NL-1', scope: 'platform', appliesTo: 'Noon', type: 'percentage', value: 20, stackable: false, minCartValue: null }]
    const loaded = (await upload(INITIAL_RULES_STATE, SAMPLE_RULES_TEXT, 'rules.csv', { confirmedRules: confirmed })).state
    // Sample prices plus 20% off the Ceramic Vase (2499 -> 1999.2 -> 1999):
    // subtotal 5932 - 500 = 5432, minus the 10% cart offer (543) = 4889
    assert.equal(payable(loaded, confirmed), 4889)
    const { state } = await upload(loaded, '', 'bad.csv', { confirmedRules: confirmed })
    assert.equal(payable(state, confirmed), 4889)
  })
})

describe('duplicate rules, through to the price breakdown', () => {
  test('a repeated row is skipped and the breakdown adds up to what the engine charges', async () => {
    const text = rulesText(
      'RULE-01,platform,Amazon India,percentage,15,false,',
      'RULE-03,platform,Flipkart,percentage,10,true,',
      'RULE-03,platform,Flipkart,percentage,10,true,',
      'RULE-02,brand,Natura Casa,flat,150,false,',
      'RULE-02,brand,Natura Casa,flat,50,true,',
      'RULE-04,cart,,percentage,10,false,4000',
    )
    const { state, notice } = await upload(INITIAL_RULES_STATE, text, 'dupes.csv')
    assert.deepEqual(state.current.rules.map((r) => r.ruleId), ['RULE-01', 'RULE-03', 'RULE-02', 'RULE-04'])
    assert.equal(notice.skipped.length, 2)
    assert.match(notice.skipped[0], /^Row 4: duplicate of row 3/)
    assert.match(notice.skipped[1], /^Row 6: rule_id "RULE-02" is already used by row 5 with different terms/)

    // The kept rules are the sample rules, so the sample cart prices exactly as before
    const results = computeResults({ hasCalculated: true, activeRules: state.current.rules, cartItems: CART })
    assert.equal(results.finalTotal, 5339)
    results.items.forEach((result, i) => {
      const breakdown = appliedOfferBreakdown(CART[i], state.current.rules, result)
      assert.equal(breakdown.reduce((sum, offer) => sum + offer.amount, 0), result.totalDiscount)
      assert.deepEqual(breakdown.map((offer) => offer.ruleId), result.appliedRules)
    })
    const summary = checkoutSummary(results, state.current.rules.filter((r) => r.scope === 'cart'))
    assert.equal(summary.finalTotal, 5339)
  })
})
