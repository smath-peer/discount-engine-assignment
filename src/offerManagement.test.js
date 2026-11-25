/**
 * Tests for managing offers added here: duplicates, removal with Undo, and
 * the manual / "Edit details" form — run with `npm test`.
 * The form's logic lives in ruleInputState.js and the list's in appRules.js;
 * these tests drive both the way RuleInput and App do.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  combineRules, computeResults, addConfirmedRule, findDuplicateOffer, removeConfirmedRule, restoreConfirmedRule,
} from './appRules.js'
import {
  ruleInputReducer, initialRuleInputState, EMPTY_DRAFT, draftFromRule, draftToRule, updateDraft, buildConfirmedRule, canSubmit,
} from './components/ruleInputState.js'
import { parseRulesCSV, parseCartCSV } from './input/csvParser.js'
import { previewRule } from './engine/rulePreview.js'

const readSample = (name) => readFileSync(new URL(`../sample-data/${name}`, import.meta.url), 'utf8')
const CSV_RULES = parseRulesCSV(readSample('rules.csv')).data
const CART = parseCartCSV(readSample('cart.csv')).data
const NOON_20 = { scope: 'platform', appliesTo: 'Noon', type: 'percentage', value: 20, stackable: false, minCartValue: null }

const reduce = (...actions) => actions.reduce(ruleInputReducer, initialRuleInputState)
const edit = (field, value) => ({ type: 'updateDraft', field, value })
const payable = (rules) => computeResults({ hasCalculated: true, activeRules: rules, cartItems: CART }).finalTotal
/** The state after interpreting `rule` with the (mocked) rule assistant. */
const reviewing = (rule) => reduce({ type: 'submit', requestId: 1 }, { type: 'response', requestId: 1, result: { status: 'ok', rule } })

// ── Duplicates ───────────────────────────────────────────────────

describe('duplicate offers, from any source', () => {
  test('an offer with the same terms as a CSV rule is found, whatever its case or spacing', () => {
    const csvCopy = { scope: 'platform', appliesTo: '  flipkart ', type: 'percentage', value: 10, stackable: true, minCartValue: null }
    assert.equal(findDuplicateOffer(CSV_RULES, csvCopy).ruleId, 'RULE-03')
  })

  test('offers differing in any term are not duplicates', () => {
    const base = { scope: 'platform', appliesTo: 'Flipkart', type: 'percentage', value: 10, stackable: true, minCartValue: null }
    for (const change of [{ value: 15 }, { stackable: false }, { type: 'flat' }, { appliesTo: 'Noon' }, { scope: 'brand' }]) {
      assert.equal(findDuplicateOffer(CSV_RULES, { ...base, ...change }), null, JSON.stringify(change))
    }
    assert.equal(findDuplicateOffer(CSV_RULES, { ...CSV_RULES[3], minCartValue: 5000 }), null)
  })

  test('confirming the same offer twice is refused, and prices do not change', () => {
    const first = addConfirmedRule(CSV_RULES, [], { ruleId: 'NL-1', ...NOON_20 })
    const again = addConfirmedRule(CSV_RULES, first.confirmedRules, { ruleId: 'NL-2', ...NOON_20 })
    assert.equal(again.duplicateOf, 'NL-1')
    assert.match(again.error, /^This offer is already active as NL-1/)
    assert.equal(again.confirmedRules, undefined)
  })

  test('a different offer for the same platform is still added', () => {
    const first = addConfirmedRule(CSV_RULES, [], { ruleId: 'NL-1', ...NOON_20 })
    const other = addConfirmedRule(CSV_RULES, first.confirmedRules, { ruleId: 'NL-2', ...NOON_20, value: 25 })
    assert.equal(other.confirmedRules.length, 2)
  })
})

// ── Removal and Undo ─────────────────────────────────────────────

describe('removing an offer added here, and Undo', () => {
  const confirmed = [{ ruleId: 'NL-1', ...NOON_20 }, { ruleId: 'NL-2', ...NOON_20, appliesTo: 'Natura Casa', scope: 'brand', value: 5 }]

  test('removal takes the offer out and re-prices; Undo puts it back in the same place', () => {
    const before = payable(combineRules(CSV_RULES, confirmed))
    const { confirmedRules, removed } = removeConfirmedRule(confirmed, 'NL-1')
    assert.deepEqual(confirmedRules.map((r) => r.ruleId), ['NL-2'])
    assert.deepEqual(removed, { rule: confirmed[0], index: 0 })
    assert.notEqual(payable(combineRules(CSV_RULES, confirmedRules)), before)

    const restored = restoreConfirmedRule(CSV_RULES, confirmedRules, removed)
    assert.deepEqual(restored, confirmed)
    assert.equal(payable(combineRules(CSV_RULES, restored)), before)
  })

  test('removing the only added offer leaves the sample at Rs.5,339', () => {
    const { confirmedRules } = removeConfirmedRule([confirmed[0]], 'NL-1')
    assert.equal(payable(combineRules(CSV_RULES, confirmedRules)), 5339)
  })

  test('an unknown ID removes nothing', () => {
    assert.equal(removeConfirmedRule(confirmed, 'RULE-01'), null)
  })

  test('Undo is refused if the offer\'s ID or terms are now used by another offer', () => {
    const { confirmedRules, removed } = removeConfirmedRule(confirmed, 'NL-1')
    // The same terms were added again meanwhile
    assert.equal(restoreConfirmedRule(CSV_RULES, [...confirmedRules, { ruleId: 'NL-3', ...NOON_20 }], removed), null)
    // Its ID was taken meanwhile
    assert.equal(restoreConfirmedRule(CSV_RULES, [...confirmedRules, { ruleId: 'NL-1', ...NOON_20, value: 30 }], removed), null)
  })
})

// ── The form ─────────────────────────────────────────────────────

describe('manual entry: the draft and its validation', () => {
  test('Enter manually opens an empty form and makes no request', () => {
    const state = reduce({ type: 'startManual' })
    assert.equal(state.phase, 'editing')
    assert.equal(state.origin, 'manual')
    assert.deepEqual(state.draft, EMPTY_DRAFT)
    assert.equal(state.requestId, 0) // no request was started
    assert.equal(canSubmit(state, '20% off Natura Casa'), false) // nor can one start while the form is open
  })

  test('a complete manual draft becomes the candidate for review, without ever loading', () => {
    const phases = []
    let state = initialRuleInputState
    for (const action of [
      { type: 'startManual' }, edit('scope', 'platform'), edit('appliesTo', ' Noon '), edit('value', '20'), { type: 'saveDraft' },
    ]) {
      state = ruleInputReducer(state, action)
      phases.push(state.phase)
    }
    assert.ok(!phases.includes('loading'))
    assert.equal(state.phase, 'review')
    assert.deepEqual(state.candidate, NOON_20)
    assert.equal(state.origin, 'manual')
  })

  test('switching scope: Cart hides the name, needs a minimum and allows only a percentage', () => {
    let draft = updateDraft({ ...EMPTY_DRAFT, type: 'flat', appliesTo: 'Natura Casa', value: '150' }, 'scope', 'cart')
    assert.equal(draft.type, 'percentage')
    // 150 is now a percentage (too high), and a minimum is needed
    assert.deepEqual(Object.keys(draftToRule(draft).errors), ['value', 'minCartValue'])
    draft = updateDraft(draft, 'minCartValue', '4000')
    // The flat 150 became 150%, which is not allowed: the value is reported, not the scope
    assert.equal(draftToRule(draft).rule, null)
    assert.deepEqual(draftToRule(draft).errors, { value: 'A percentage cannot be more than 100.' })
    // Back to Brand: the minimum is ignored, the name is needed again (kept from before)
    draft = updateDraft(updateDraft(draft, 'scope', 'brand'), 'value', '15')
    assert.deepEqual(draftToRule(draft).rule, { scope: 'brand', appliesTo: 'Natura Casa', type: 'percentage', value: 15, stackable: false, minCartValue: null })
  })

  test('switching Percentage and Flat changes the limit that applies', () => {
    const draft = { ...EMPTY_DRAFT, appliesTo: 'Natura Casa', value: '250' }
    assert.deepEqual(draftToRule(draft).errors, { value: 'A percentage cannot be more than 100.' })
    assert.equal(draftToRule(updateDraft(draft, 'type', 'flat')).rule.value, 250)
  })

  test('a missing or blank brand or platform name is reported on that field', () => {
    assert.deepEqual(draftToRule({ ...EMPTY_DRAFT, appliesTo: '   ', value: '10' }).errors, {
      appliesTo: 'Enter the brand name, as it appears in the cart.',
    })
    assert.deepEqual(draftToRule({ ...EMPTY_DRAFT, scope: 'platform', value: '10' }).errors, {
      appliesTo: 'Enter the platform name, as it appears in the cart.',
    })
  })

  test('zero, negative, malformed and missing values are reported in plain words', () => {
    const errorFor = (value) => draftToRule({ ...EMPTY_DRAFT, appliesTo: 'Noon', value }).errors.value
    assert.equal(errorFor(''), 'Enter the discount amount.')
    assert.equal(errorFor('0'), 'The discount must be more than 0.')
    assert.equal(errorFor('0.00'), 'The discount must be more than 0.')
    assert.equal(errorFor('-5'), 'The discount must be more than 0.')
    for (const text of ['10%', 'ten', '1,000', '1e3', '.5', 'Rs.100', '10 ']) {
      if (text === '10 ') assert.equal(errorFor(text), undefined) // spaces around a number are fine
      else assert.equal(errorFor(text), 'Enter the discount as a number, using digits only, for example 10 or 10.5.', text)
    }
    assert.equal(errorFor('100.5'), 'A percentage cannot be more than 100.')
  })

  test('invalid minimum cart values are reported; 0 is allowed', () => {
    const errorFor = (minCartValue) => draftToRule({ ...EMPTY_DRAFT, scope: 'cart', value: '10', minCartValue }).errors.minCartValue
    assert.equal(errorFor(''), 'Enter the minimum cart value, for example 5000.')
    assert.equal(errorFor('-100'), 'The minimum cart value cannot be negative.')
    assert.equal(errorFor('5,000'), 'Enter the minimum cart value using digits only, for example 5000.')
    assert.equal(errorFor('abc'), 'Enter the minimum cart value using digits only, for example 5000.')
    assert.equal(errorFor('0'), undefined)
  })

  test('saving an invalid draft keeps the form open and shows the errors', () => {
    const state = reduce({ type: 'startManual' }, { type: 'saveDraft' })
    assert.equal(state.phase, 'editing')
    assert.equal(state.showDraftErrors, true)
    assert.equal(state.candidate, null)
  })

  test('the same rule entered manually or interpreted is validated the same way', () => {
    const manual = reduce({ type: 'startManual' }, edit('scope', 'platform'), edit('appliesTo', 'Noon'), edit('value', '20'), { type: 'saveDraft' })
    const interpreted = reviewing(NOON_20)
    assert.deepEqual(manual.candidate, interpreted.candidate)
    assert.deepEqual(buildConfirmedRule(manual.candidate, []).rule, buildConfirmedRule(interpreted.candidate, []).rule)
  })
})

describe('Edit details on an interpreted offer', () => {
  test('the form opens with the interpreted values', () => {
    const state = reduce({ type: 'submit', requestId: 1 }, { type: 'response', requestId: 1, result: { status: 'ok', rule: NOON_20 } }, { type: 'startEdit' })
    assert.equal(state.phase, 'editing')
    assert.deepEqual(state.draft, { scope: 'platform', appliesTo: 'Noon', type: 'percentage', value: '20', minCartValue: '', stackable: false })
    assert.deepEqual(draftFromRule({ ...NOON_20, scope: 'cart', appliesTo: '', minCartValue: 4000 }).minCartValue, '4000')
  })

  test('Cancel restores the previous candidate exactly; edit again and save changes it', () => {
    const start = reviewing(NOON_20)
    const cancelled = [{ type: 'startEdit' }, edit('value', '35'), edit('stackable', true), { type: 'cancelEdit' }].reduce(ruleInputReducer, start)
    assert.equal(cancelled.phase, 'review')
    assert.equal(cancelled.candidate, start.candidate)
    assert.equal(cancelled.origin, 'ai')

    const saved = [{ type: 'startEdit' }, edit('value', '35'), { type: 'saveDraft' }].reduce(ruleInputReducer, cancelled)
    assert.equal(saved.phase, 'review')
    assert.deepEqual(saved.candidate, { ...NOON_20, value: 35 })
    assert.equal(saved.origin, 'edited')
  })

  test('Cancel on a new manual offer returns to the start', () => {
    assert.equal(reduce({ type: 'startManual' }, edit('value', '10'), { type: 'cancelEdit' }).phase, 'idle')
  })

  test('editing changes only the draft: the actual prices stay the same until confirmed', () => {
    const before = payable(CSV_RULES)
    const state = [{ type: 'startEdit' }, edit('value', '90')].reduce(ruleInputReducer, reviewing(NOON_20))
    // The preview reflects the edited values...
    const { rule } = draftToRule(state.draft)
    const preview = previewRule(CART, CSV_RULES, rule)
    assert.ok(preview.projectedTotal < before)
    // ...while the active rules, and so the amount to pay, are unchanged
    assert.equal(payable(CSV_RULES), before)
    assert.equal(before, 5339)
  })

  test('editing an offer into a duplicate of an active one blocks confirmation', () => {
    // Interpreted as Flipkart 15%, then edited to RULE-03's terms (Flipkart 10%, stackable)
    const state = [{ type: 'startEdit' }, edit('value', '10'), edit('stackable', true), { type: 'saveDraft' }]
      .reduce(ruleInputReducer, reviewing({ ...NOON_20, appliesTo: 'Flipkart', value: 15 }))
    assert.equal(findDuplicateOffer(CSV_RULES, state.candidate).ruleId, 'RULE-03')
    const result = addConfirmedRule(CSV_RULES, [], buildConfirmedRule(state.candidate, CSV_RULES.map((r) => r.ruleId)).rule)
    assert.equal(result.duplicateOf, 'RULE-03')
  })

  test('a refused confirmation keeps the review open with the reason', () => {
    const state = ruleInputReducer(reviewing(NOON_20), { type: 'confirmRejected', message: 'This offer is already active as NL-1.' })
    assert.equal(state.phase, 'review')
    assert.equal(state.confirmError, 'This offer is already active as NL-1.')
    // Editing clears it
    assert.equal(ruleInputReducer(state, { type: 'startEdit' }).confirmError, '')
  })

  test('only the final, validated version is confirmed', () => {
    const state = [{ type: 'startEdit' }, edit('value', '12.5'), { type: 'saveDraft' }].reduce(ruleInputReducer, reviewing(NOON_20))
    const { rule } = buildConfirmedRule(state.candidate, CSV_RULES.map((r) => r.ruleId))
    assert.deepEqual(rule, { ruleId: 'NL-1', ...NOON_20, value: 12.5 })
    const confirmed = ruleInputReducer(state, { type: 'confirmed', ruleId: rule.ruleId })
    assert.equal(confirmed.phase, 'idle')
    assert.equal(confirmed.candidate, null)
  })

  test('form actions are ignored outside the form', () => {
    for (const action of [edit('value', '5'), { type: 'saveDraft' }, { type: 'cancelEdit' }]) {
      assert.equal(ruleInputReducer(initialRuleInputState, action), initialRuleInputState)
    }
    assert.equal(ruleInputReducer(reduce({ type: 'submit', requestId: 1 }), { type: 'startManual' }).phase, 'loading')
  })
})
