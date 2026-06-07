// Validation of the SimpleRichDoc ORACLE against the SAME adversarial + block
// scenarios the engine passes (test/adversarial.test.ts + test/blocks.test.ts).
// Expected outputs are the engine's pinned values, copied here. If the oracle
// and engine ever disagree on these, the differential fuzzer (Task 8) is built
// on sand — so these run as a standalone gate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimpleRichDoc } from './simple-rich-doc.js'

const boldSpans = (d: SimpleRichDoc) =>
  d.materialize().spans.filter(s => s.markType === 'bold').map(s => [s.start, s.end])

// ---- P1: concurrent overlapping bolds UNION ----
test('oracle P1 concurrent overlap bold', () => {
  const a = new SimpleRichDoc(), b = new SimpleRichDoc()
  a.insert('a', 0, 0, 'The fox jumped.')
  b.merge(a)
  a.mark('a', 100, 0, 7, 'bold', true, true)
  b.mark('b', 100, 4, 14, 'bold', true, true)
  a.merge(b); b.merge(a)
  assert.deepEqual(boldSpans(a), [[0, 14]])
  assert.deepEqual(boldSpans(b), [[0, 14]])
})

// ---- P2: toggle-counting dog ----
test('oracle P2 toggle counting dog', () => {
  const a = new SimpleRichDoc(), b = new SimpleRichDoc()
  a.insert('a', 0, 0, 'The fox jumped over the dog.')
  a.mark('a', 100, 0, 28, 'bold', true, true)
  b.merge(a)
  a.mark('a', 101, 8, 14, 'bold', null, true)
  b.mark('b', 100, 4, 14, 'bold', null, true)
  b.mark('b', 101, 24, 27, 'bold', true, true)
  a.merge(b); b.merge(a)
  const sa = boldSpans(a)
  assert.deepEqual(sa, boldSpans(b), 'replicas converge')
  const covers = (p: number) => sa.some(([s, e]) => s <= p && p < e)
  assert.ok(covers(25), '"dog" stays bold')
  assert.ok(!covers(5) && !covers(10), '"fox jumped" unbolded')
  assert.ok(covers(0) && covers(16), 'rest stays bold')
})

// ---- P4: no unbounded bleed ----
test('oracle P4 unbounded bleed', () => {
  const a = new SimpleRichDoc(), b = new SimpleRichDoc()
  a.insert('a', 0, 0, 'The fox jumped over the dog.')
  a.mark('a', 100, 4, 14, 'bold', true, true)
  b.merge(a)
  a.mark('a', 101, 4, 8, 'bold', null, true)
  b.mark('b', 100, 8, 14, 'bold', null, true)
  a.merge(b); b.merge(a)
  const sa = boldSpans(a)
  assert.ok(sa.every(([s, e]) => e <= 14), 'no bleed past original span')
  assert.deepEqual(sa, boldSpans(b))
})

// ---- Example 1: concurrent insert inside span inherits mark ----
test('oracle example1 concurrent insert inside span', () => {
  const a = new SimpleRichDoc(), b = new SimpleRichDoc()
  a.insert('a', 0, 0, 'The fox jumped.')
  b.merge(a)
  a.mark('a', 100, 4, 14, 'bold', true, true)
  b.insert('b', 100, 8, 'quickly ')
  a.merge(b); b.merge(a)
  assert.equal(a.materialize().text, 'The fox quickly jumped.')
  assert.deepEqual(boldSpans(a), [[4, 22]])
})

// ---- yjs#197: empty after delete-all ----
test('oracle yjs197 orphaned markers', () => {
  const d = new SimpleRichDoc()
  d.insert('o', 0, 0, 'how now brown cow')
  d.mark('o', 100, 0, 17, 'bold', true, true)
  for (let i = 0; i < 17; i++) d.delete(0)
  const snap = d.materialize()
  assert.equal(snap.text, '')
  assert.deepEqual(snap.spans, [])
})

// ---- Table 1: overlapping comments both survive ----
test('oracle table1 overlapping comments', () => {
  const d = new SimpleRichDoc()
  d.insert('o', 0, 0, 'abcdef')
  d.mark('o', 100, 0, 4, 'comment', 'c1', false)
  d.mark('o', 101, 2, 6, 'comment', 'c2', false)
  const cs = d.materialize().spans.filter(s => s.markType === 'comment')
  assert.equal(cs.length, 2)
})

// ---- Example 4: color LWW, 'blue' (agent b) wins ----
test('oracle example4 color lww', () => {
  const a = new SimpleRichDoc(), b = new SimpleRichDoc()
  a.insert('a', 0, 0, 'word')
  b.merge(a)
  a.mark('a', 100, 0, 4, 'color', 'red', true)
  b.mark('b', 100, 0, 4, 'color', 'blue', true)
  a.merge(b); b.merge(a)
  const ca = a.materialize().spans.filter(s => s.markType === 'color')
  const cb = b.materialize().spans.filter(s => s.markType === 'color')
  assert.deepEqual(ca, cb)
  assert.equal(ca.length, 1)
  assert.equal(ca[0].value, 'blue')
})

// ---- #32: tombstone must not capture new text ----
test('oracle issue32 tombstone capture', () => {
  const d = new SimpleRichDoc()
  d.insert('o', 0, 0, 'AB')
  d.mark('o', 100, 0, 1, 'bold', true, true)
  d.delete(0)            // delete A
  d.insert('o', 101, 0, 'X')
  const snap = d.materialize()
  assert.equal(snap.text, 'XB')
  assert.deepEqual(snap.spans, [], 'dead bold must not capture X')
})

// ---- block basic split ----
test('oracle block basic split', () => {
  const d = new SimpleRichDoc()
  d.insert('o', 0, 0, 'helloworld')
  d.splitBlock('o', 100, 5, 'paragraph')
  assert.deepEqual(d.materialize().blocks,
    [{ start: 0, end: 5, blockType: 'paragraph' },
     { start: 5, end: 10, blockType: 'paragraph' }])
})

// ---- block concurrent split + edit ----
test('oracle block concurrent split edit', () => {
  const a = new SimpleRichDoc(), b = new SimpleRichDoc()
  a.insert('a', 0, 0, 'helloworld')
  b.merge(a)
  a.splitBlock('a', 100, 5, 'paragraph')
  b.insert('b', 100, 7, 'X')
  a.merge(b); b.merge(a)
  const sa = a.materialize(), sb = b.materialize()
  assert.equal(sa.text, 'hellowoXrld')
  assert.deepEqual(sa.blocks, sb.blocks)
  assert.deepEqual(sa.blocks.map(bl => [bl.start, bl.end]), [[0, 5], [5, 11]])
})

// ---- block same-position split dedupe ----
test('oracle block same position split', () => {
  const a = new SimpleRichDoc(), b = new SimpleRichDoc()
  a.insert('a', 0, 0, 'helloworld')
  b.merge(a)
  a.splitBlock('a', 100, 5, 'paragraph')
  b.splitBlock('b', 100, 5, 'paragraph')
  a.merge(b); b.merge(a)
  const sa = a.materialize()
  assert.deepEqual(sa.blocks.map(bl => [bl.start, bl.end]), [[0, 5], [5, 10]])
  assert.deepEqual(sa.blocks, b.materialize().blocks)
})

// ---- block v1 delete-all semantics ----
test('oracle block delete-all v1 semantics', () => {
  const d = new SimpleRichDoc()
  d.insert('o', 0, 0, 'ab')
  d.splitBlock('o', 100, 1, 'paragraph')
  d.delete(0); d.delete(0)
  const s = d.materialize()
  assert.equal(s.text, '')
  assert.deepEqual(s.blocks, [{ start: 0, end: 0, blockType: 'paragraph' }])
})

// ---- boundary insert lands in following block ----
test('oracle boundary insert following block', () => {
  const d = new SimpleRichDoc()
  d.insert('o', 0, 0, 'ab')
  d.splitBlock('o', 100, 1, 'paragraph')
  d.insert('o', 101, 1, 'X')
  const s = d.materialize()
  assert.equal(s.text, 'aXb')
  assert.deepEqual(s.blocks.map(b => [b.start, b.end]), [[0, 1], [1, 3]],
    'X belongs to block 2')
})

// ---- paragraph-start exception ----
test('oracle paragraph start exception', () => {
  const d = new SimpleRichDoc()
  d.insert('o', 0, 0, 'ab')
  d.splitBlock('o', 100, 1, 'paragraph')
  d.mark('o', 101, 1, 2, 'bold', true, true)
  d.insert('o', 102, 1, 'X')
  const s = d.materialize()
  assert.equal(s.text, 'aXb')
  assert.deepEqual(boldSpans(d), [[1, 3]],
    'X inherits bold from following char at paragraph start')
})
