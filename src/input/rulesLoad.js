/**
 * rulesLoad.js
 *
 * Loading a rules.csv file and deciding what happens to the CSV offers.
 * The same pattern as cartLoad.js, kept free of React so every rule here can
 * be tested directly.
 *
 *   readRulesFile   — file → { data, errors, fileError }
 *   applyRulesLoad  — decides whether the file replaces the CSV offers, and what to tell the user
 *   undoRulesLoad   — puts the previous CSV offers back
 *
 * The rules:
 *   - A file with at least one usable rule replaces the CSV offers, even if
 *     other rows were skipped (they are listed, and the badge says so).
 *   - A file with no usable rule changes nothing: the current offers, their
 *     file name and their badge stay, and the notice explains why.
 *   - After a replacement, Undo restores the offers that were replaced. It is
 *     offered until the next upload attempt, until it is used, or until an
 *     offer is confirmed in plain language (whose ID was chosen to avoid the
 *     current offers, not the replaced ones).
 * Plain-language offers are never touched here.
 * Prices are not stored: they are derived from the cart and the rules, so a
 * replacement re-prices at once. The notice says prices were recalculated
 * only when the caller says prices are on screen after the change.
 */

import { parseRulesCSV } from './csvParser.js'
import { withoutConfirmedIdClashes } from '../appRules.js'
import { plural } from '../components/loadStatus.js'

/** The CSV offers in use: the rules, the file they came from and that file's skipped rows. */
export const EMPTY_RULES = Object.freeze({ rules: [], fileName: '', errors: [] })

/** What App keeps: the CSV offers in use and the offers Undo would restore (or null). */
export const INITIAL_RULES_STATE = Object.freeze({ current: EMPTY_RULES, undo: null })

export const RULES_FILE_MESSAGES = Object.freeze({
  unreadable: 'This file could not be opened. Please choose it again.',
  empty: 'The file is empty.',
  not_csv: 'This file does not contain readable text, so it cannot be a rules CSV.',
  no_rows: 'The file has a header but no rule rows.',
})

/**
 * Reads a rules file, never throwing.
 *   file:           a File (or anything with text())
 *   confirmedRules: the plain-language offers, whose IDs a CSV row may not reuse
 * Returns { data, errors, fileError }: fileError is set when the file cannot be used at all.
 */
export async function readRulesFile(file, confirmedRules) {
  let text
  try {
    text = await file.text()
  } catch {
    return { data: [], errors: [], fileError: RULES_FILE_MESSAGES.unreadable }
  }
  return parseRulesText(text, confirmedRules)
}

/** The text part of readRulesFile, separate so it can be tested without a File. */
export function parseRulesText(text, confirmedRules) {
  if (text.includes('\u0000')) return { data: [], errors: [], fileError: RULES_FILE_MESSAGES.not_csv }
  if (text.replace(/^﻿/, '').trim() === '') return { data: [], errors: [], fileError: RULES_FILE_MESSAGES.empty }

  const { data, errors, fileError } = parseRulesCSV(text)
  if (fileError) return { data: [], errors: [], fileError } // e.g. the header lacks a required column
  const { rules, errors: clashErrors } = withoutConfirmedIdClashes(data, confirmedRules)
  return { data: rules, errors: [...errors, ...clashErrors], fileError: null }
}

const describeRules = (rules) => `${plural(rules.rules.length, 'offer')} from ${rules.fileName}`

/**
 * Applies a read file to the rules state.
 *   state:  { current, undo }
 *   result: from readRulesFile
 *   file:   { fileName, pricesShownAfter } — pricesShownAfter: prices will be
 *           on screen once the new offers are in use (calculated, with a cart)
 * Returns { state, notice }, where notice is what the user is told:
 *   { tone: 'success' | 'warning' | 'danger', title, lines, skipped, notes, canUndo }
 */
export function applyRulesLoad(state, result, { fileName, pricesShownAfter = false }) {
  const current = state.current
  const hadRules = current.rules.length > 0

  if (result.data.length === 0) {
    const lines = []
    if (result.fileError) lines.push(result.fileError)
    else if (result.errors.length > 0) lines.push(plural(result.errors.length, 'row') + ' found, but none could be used:')
    else lines.push(RULES_FILE_MESSAGES.no_rows)
    lines.push(hadRules ? `Your offers are unchanged: ${describeRules(current)}.` : 'No offers from a rules file are in use yet.')
    return {
      // Nothing changes; the earlier Undo is withdrawn because a new upload was attempted
      state: { current, undo: null },
      notice: { tone: 'danger', title: `Nothing was loaded from ${fileName}`, lines, skipped: result.errors, notes: [], canUndo: false },
    }
  }

  const next = { rules: result.data, fileName, errors: result.errors }
  const count = plural(result.data.length, 'offer')
  const skippedText = result.errors.length > 0 ? `, ${plural(result.errors.length, 'row')} skipped` : ''

  const lines = []
  if (hadRules) lines.push(`They replaced your previous offers: ${describeRules(current)}.`)
  if (result.errors.length > 0) lines.push('Skipped rows are not in use. Fix them in the file and choose it again to include them.')
  if (pricesShownAfter) lines.push('Prices were recalculated with the new offers.')

  return {
    state: { current: next, undo: hadRules ? current : null },
    notice: {
      tone: result.errors.length > 0 ? 'warning' : 'success',
      title: hadRules ? `Offers replaced: ${count} from ${fileName}${skippedText}` : `${count} loaded from ${fileName}${skippedText}`,
      lines,
      skipped: result.errors,
      notes: [],
      canUndo: hadRules,
    },
  }
}

/** Restores the offers that the last upload replaced. Returns { state, notice }, or null if there is nothing to undo. */
export function undoRulesLoad(state, { pricesShownAfter = false } = {}) {
  if (!state.undo) return null
  const restored = state.undo
  return {
    state: { current: restored, undo: null },
    notice: {
      tone: restored.errors.length > 0 ? 'warning' : 'success',
      title: `Previous offers restored: ${describeRules(restored)}`,
      lines: pricesShownAfter ? ['Prices were recalculated with the restored offers.'] : [],
      skipped: restored.errors,
      notes: [],
      canUndo: false,
    },
  }
}

/** A plain-language offer was confirmed: the Undo, if any, is withdrawn (see the file header). */
export function withdrawRulesUndo(state) {
  return state.undo ? { ...state, undo: null } : state
}
