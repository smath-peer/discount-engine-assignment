import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadStatus, progressSteps, plural } from './loadStatus.js'

test('uploadStatus: nothing chosen yet', () => {
  assert.deepEqual(uploadStatus({ fileName: '', rowCount: 0, errorCount: 0 }), { tone: 'neutral', label: 'Not loaded' })
})

test('uploadStatus: every row loaded', () => {
  assert.deepEqual(uploadStatus({ fileName: 'rules.csv', rowCount: 4, errorCount: 0 }), { tone: 'success', label: 'Loaded' })
})

test('uploadStatus: partial load is a warning, never a plain success', () => {
  assert.deepEqual(uploadStatus({ fileName: 'rules.csv', rowCount: 1, errorCount: 2 }), { tone: 'warning', label: 'Loaded with 2 issues' })
  assert.equal(uploadStatus({ fileName: 'cart.csv', rowCount: 5, errorCount: 1 }).label, 'Loaded with 1 issue')
})

test('uploadStatus: a file with only errors is reported as not loaded', () => {
  assert.deepEqual(uploadStatus({ fileName: 'bad.csv', rowCount: 0, errorCount: 3 }), { tone: 'danger', label: 'Not loaded — no usable rows' })
})

test('uploadStatus: a file with a header but no rows', () => {
  assert.deepEqual(uploadStatus({ fileName: 'empty.csv', rowCount: 0, errorCount: 0 }), { tone: 'warning', label: 'No rows found' })
})

test('progressSteps: nothing loaded — first step is current, none complete', () => {
  assert.deepEqual(progressSteps({ ruleCount: 0, cartCount: 0, calculated: false }), [
    { label: 'Cart loaded', state: 'current' },
    { label: 'Offers loaded', state: 'upcoming' },
    { label: 'Prices calculated', state: 'upcoming' },
  ])
})

test('progressSteps: cart only — cart complete, offers step current', () => {
  assert.deepEqual(progressSteps({ ruleCount: 0, cartCount: 6, calculated: false }).map((s) => s.state), ['complete', 'current', 'upcoming'])
})

test('progressSteps: offers only — the cart step stays current', () => {
  assert.deepEqual(progressSteps({ ruleCount: 4, cartCount: 0, calculated: false }).map((s) => s.state), ['current', 'complete', 'upcoming'])
})

test('progressSteps: both loaded but not calculated', () => {
  assert.deepEqual(progressSteps({ ruleCount: 4, cartCount: 6, calculated: false }).map((s) => s.state), ['complete', 'complete', 'current'])
})

test('progressSteps: all complete only when results exist', () => {
  assert.deepEqual(progressSteps({ ruleCount: 4, cartCount: 6, calculated: true }).map((s) => s.state), ['complete', 'complete', 'complete'])
  // results disappear (e.g. cart replaced by an unusable file) → no longer complete
  assert.deepEqual(progressSteps({ ruleCount: 0, cartCount: 6, calculated: false }).map((s) => s.state), ['complete', 'current', 'upcoming'])
})

test('plural', () => {
  assert.equal(plural(1, 'rule'), '1 rule')
  assert.equal(plural(0, 'item'), '0 items')
  assert.equal(plural(6, 'item'), '6 items')
})
