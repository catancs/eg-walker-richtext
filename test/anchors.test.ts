import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOpLog, localInsert, localDelete, localMark, localSplitBlock, mergeOplogInto,
  checkoutSimpleString, checkoutWithItems, ItemState, type ListOpLog,
} from '../src/index.js'

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

// --- Task 3: sticky-skip insertion (expand semantics) ---

const kinds = (o: ListOpLog<string>) => checkoutWithItems(o).items
  .filter(i => i.curState === ItemState.Inserted)
  .map(i => i.kind === 'text' ? 't' : i.kind)

test('typing at end of bold span lands INSIDE (endSide before = right-sticky)', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'ab')
  localMark(o, 'a', 0, 2, 'bold', true)   // bold "ab", end anchor right-sticky
  localInsert(o, 'a', 2, 'X')             // type at boundary
  // Expected order: markStart a b X markEnd  -> X inside
  assert.deepEqual(kinds(o), ['markStart', 't', 't', 't', 'markEnd'])
})

test('typing at end of link span lands OUTSIDE (endSide after = left-sticky)', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'ab')
  localMark(o, 'a', 0, 2, 'link', 'https://x')
  localInsert(o, 'a', 2, 'X')
  // Expected: markStart a b markEnd X  -> X outside
  assert.deepEqual(kinds(o), ['markStart', 't', 't', 'markEnd', 't'])
})

test('typing at start of bold span lands OUTSIDE (start right-sticky)', () => {
  const o = createOpLog<string>()
  localInsert(o, 'a', 0, ...'ab')
  localMark(o, 'a', 0, 2, 'bold', true)
  localInsert(o, 'a', 0, 'X')
  // Expected: X markStart a b markEnd
  assert.deepEqual(kinds(o), ['t', 'markStart', 't', 't', 'markEnd'])
})
