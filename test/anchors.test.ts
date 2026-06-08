import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOpLog, localInsert, localDelete, localMark, localSplitBlock, mergeOplogInto,
  checkoutSimpleString, checkoutWithItems,
} from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'

test('anchors do not perturb text', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'hello')
  localMark(o, 'a', 1, 4, 'bold', true)        // bold "ell"
  localSplitBlock(o, 'a', 3, 'paragraph')
  assert.equal(checkoutSimpleString(o), 'hello')
})

test('concurrent anchors converge (item order identical)', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'abc')
  mergeOplogInto(b, a)
  localMark(a, 'a', 0, 2, 'bold', true)        // concurrent marks
  localMark(b, 'b', 1, 3, 'italic', true)
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const ia = checkoutWithItems(a), ib = checkoutWithItems(b)
  assert.equal(ia.snapshot.join(''), 'abc')
  // Convergence = identical item ORDER + identical MERGED state. We compare
  // endState, not curState: curState is transient scratch state reflecting
  // whichever version the topological traversal happened to finish at, which
  // legitimately differs per replica (each replica's own ops sort earlier in
  // ops[], so the final-processed op + its retreat/advance set differ).
  // endState is the merged truth and the real convergence invariant. The kind
  // sequence (item order) IS identical across replicas — that's the FugueMax
  // guarantee this test exercises. See task report for the full finding.
  assert.deepEqual(
    ia.items.map(i => [i.kind, i.endState]),
    ib.items.map(i => [i.kind, i.endState]))
})

test('delete skips anchors and deletes text', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'ab')
  localMark(o, 'a', 0, 1, 'bold', true)        // anchors around 'a'
  localDelete(o, 'a', 0, 1)                    // delete 'a' (not an anchor!)
  assert.equal(checkoutSimpleString(o), 'b')
})

// --- Expand semantics (was Task 3: sticky-skip at insert; now RESOLUTION) ---
//
// LAYER MOVE (task A/B): placement is now pure base FugueMax — anchors integrate
// as plain zero-width items with NO side-based skip, so the item ORDER no longer
// encodes expand/contract (it would read replica-dependent transient arrangement
// and break convergence). The expand/contract SEMANTIC moved to pure resolution
// (resolve.ts), so these tests now assert the resolved SPAN via checkoutRich
// instead of the item order. The pinned SEMANTIC is unchanged and preserved:
//   - typing at the END of a bold (expanding) span -> the char is INSIDE
//   - typing at the END of a link (non-expanding) span -> the char is OUTSIDE
//   - typing at the START of a bold span -> the char is OUTSIDE (start right-sticky)
// (Previously these asserted item order: bold='markStart t t t markEnd',
// link='markStart t t markEnd t', start='t markStart t t markEnd'. That order
// is no longer load-bearing; the span it implied is what's asserted now.)

test('typing at end of bold span lands INSIDE (expanding end) [resolution]', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'ab')
  localMark(o, 'a', 0, 2, 'bold', true)   // bold "ab"
  localInsert(o, 'a', 2, 'X')             // type at the span end
  assert.equal(checkoutRich(o).text.join(''), 'abX')
  // bold covers a, b AND the typed X -> span [0,3)
  assert.deepEqual(checkoutRich(o).spans,
    [{ start: 0, end: 3, markType: 'bold', value: true }])
})

test('typing at end of link span lands OUTSIDE (non-expanding end) [resolution]', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'ab')
  localMark(o, 'a', 0, 2, 'link', 'https://x')
  localInsert(o, 'a', 2, 'X')
  assert.equal(checkoutRich(o).text.join(''), 'abX')
  // link covers a, b but NOT the typed X -> span [0,2)
  assert.deepEqual(checkoutRich(o).spans,
    [{ start: 0, end: 2, markType: 'link', value: 'https://x' }])
})

test('typing at start of bold span lands OUTSIDE (start right-sticky) [resolution]', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'ab')
  localMark(o, 'a', 0, 2, 'bold', true)
  localInsert(o, 'a', 0, 'X')             // type at the span start
  assert.equal(checkoutRich(o).text.join(''), 'Xab')
  // bold covers a, b but NOT the typed X -> span [1,3)
  assert.deepEqual(checkoutRich(o).spans,
    [{ start: 1, end: 3, markType: 'bold', value: true }])
})
