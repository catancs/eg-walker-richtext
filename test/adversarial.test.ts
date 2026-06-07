import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpLog, localInsert, localDelete, localMark, mergeOplogInto, type ListOpLog } from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'

const spansOf = (o: ListOpLog<string>, type: string) =>
  checkoutRich(o).spans.filter(s => s.markType === type)
    .map(s => [s.start, s.end])

// Peritext CSCW'22 §2.3.2 / Example 2: concurrent overlapping bolds must
// UNION, not invert. Naive toggle-rendering yields "jumped" unbolded.
test('peritext_P1_concurrent_overlap_bold', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'The fox jumped.')
  mergeOplogInto(b, a)
  localMark(a, 'a', 0, 7, 'bold', true)    // Alice: "The fox"
  localMark(b, 'b', 4, 14, 'bold', true)   // Bob:   "fox jumped"
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  assert.deepEqual(spansOf(a, 'bold'), [[0, 14]])
  assert.deepEqual(spansOf(b, 'bold'), [[0, 14]])
})

// Peritext §2.3.3: toggle-counting loses Bob's bold("dog"). Per-position
// causal LWW must keep it while both unbolds apply.
test('peritext_P2_toggle_counting_dog', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  //                0123456789012345678901234567
  localInsert(a, 'a', 0, ...'The fox jumped over the dog.')
  localMark(a, 'a', 0, 28, 'bold', true)            // all bold (shared history)
  mergeOplogInto(b, a)
  localMark(a, 'a', 8, 14, 'bold', null)            // Alice unbolds "jumped"
  localMark(b, 'b', 4, 14, 'bold', null)            // Bob unbolds "fox jumped"
  localMark(b, 'b', 24, 27, 'bold', true)           // Bob re-bolds "dog"
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const sa = spansOf(a, 'bold')
  assert.deepEqual(sa, spansOf(b, 'bold'), 'replicas converge')
  // "dog" (24..27) must be bold; "fox jumped" (4..14) must not.
  const covers = (p: number) => sa.some(([s, e]) => s <= p && p < e)
  assert.ok(covers(25), '"dog" stays bold')
  assert.ok(!covers(5) && !covers(10), '"fox jumped" unbolded')
  assert.ok(covers(0) && covers(16), 'rest stays bold')
})

// Peritext §2.3.3 p.7: unbalanced toggle state must not bleed formatting
// to end-of-document. Set-coverage has no running state -> no bleed.
test('peritext_P4_unbounded_bleed', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'The fox jumped over the dog.')
  localMark(a, 'a', 4, 14, 'bold', true)            // shared: bold "fox jumped"
  mergeOplogInto(b, a)
  localMark(a, 'a', 4, 8, 'bold', null)             // Alice unbolds "fox "
  localMark(b, 'b', 8, 14, 'bold', null)            // Bob unbolds "jumped"
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const sa = spansOf(a, 'bold')
  // Nothing after position 14 may be bold; ideally no bold at all remains.
  assert.ok(sa.every(([s, e]) => e <= 14), 'no bleed past original span')
  assert.deepEqual(sa, spansOf(b, 'bold'))
})

// Peritext Example 1: text inserted concurrently INSIDE a marked range
// inherits the mark after merge.
test('peritext_example1_concurrent_insert_inside_span', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'The fox jumped.')
  mergeOplogInto(b, a)
  localMark(a, 'a', 4, 14, 'bold', true)            // Alice bolds "fox jumped"
  localInsert(b, 'b', 8, ...'quickly ')             // Bob inserts inside
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const text = checkoutRich(a).text.join('')
  assert.equal(text, 'The fox quickly jumped.')
  assert.deepEqual(spansOf(a, 'bold'), [[4, 22]])   // covers inserted text
})

// yjs#197 (dmonad): deleting all text inside a span must leave NO active
// formatting in the materialized result (empty spans dropped).
test('yjs_197_orphaned_markers', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'how now brown cow')
  localMark(o, 'o', 0, 17, 'bold', true)
  localDelete(o, 'o', 0, 17)
  const snap = checkoutRich(o)
  assert.equal(snap.text.join(''), '')
  assert.deepEqual(snap.spans, [])
})

// Comments may overlap; both survive (Peritext Table 1).
test('peritext_table1_overlapping_comments', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'abcdef')
  localMark(o, 'o', 0, 4, 'comment', 'c1')
  localMark(o, 'o', 2, 6, 'comment', 'c2')
  const cs = checkoutRich(o).spans.filter(s => s.markType === 'comment')
  assert.equal(cs.length, 2)
})

// Exclusive valued mark (color): concurrent conflict resolves LWW
// deterministically and identically on both replicas (Peritext Example 4).
test('peritext_example4_color_lww', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'word')
  mergeOplogInto(b, a)
  localMark(a, 'a', 0, 4, 'color', 'red')
  localMark(b, 'b', 0, 4, 'color', 'blue')
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const ca = checkoutRich(a).spans.filter(s => s.markType === 'color')
  const cb = checkoutRich(b).spans.filter(s => s.markType === 'color')
  assert.deepEqual(ca, cb)
  assert.equal(ca.length, 1)
  assert.equal(ca[0].value, 'blue')   // tie-break by (agent,seq): 'b' > 'a'
})

// inkandswitch/peritext#32: a tombstoned span (all its text deleted) must
// not capture newly inserted text at its position.
test('peritext_issue32_tombstone_capture', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'AB')
  localMark(o, 'o', 0, 1, 'bold', true)   // bold "A"
  localDelete(o, 'o', 0, 1)               // delete "A" - span now empty
  localInsert(o, 'o', 0, 'X')             // type where A was
  const snap = checkoutRich(o)
  assert.equal(snap.text.join(''), 'XB')
  assert.deepEqual(snap.spans, [], 'dead bold must not capture X')
})
