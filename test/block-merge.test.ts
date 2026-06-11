import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOpLog, localInsert, localSplitBlock, localDeleteBoundary, mergeOplogInto,
  boundaryIdsByPos, localMergeBlock, localDeleteRange, localDelete,
} from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'

// Deleting a boundary merges the two paragraphs into one (text untouched).
// Op ids: insert 'ab' uses seqs 0,1; localSplitBlock uses seq 2 -> boundary id ['o', 2].
test('block_merge_basic', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'ab')
  localSplitBlock(o, 'o', 1)              // a | b
  assert.equal(checkoutRich(o).blocks.length, 2, 'precondition: split made 2 blocks')
  localDeleteBoundary(o, 'o', ['o', 2])   // merge
  const s = checkoutRich(o)
  assert.equal(s.text.join(''), 'ab')
  assert.deepEqual(s.blocks, [{ start: 0, end: 2, blockType: 'paragraph' }])
})

// boundaryIdsByPos returns each live boundary's resolved gap position + raw id.
// 'helloworld' = seqs 0..9; split@5 = seq 10; split@8 = seq 11.
test('boundaryIdsByPos reports live boundaries with pos + id', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'helloworld')
  localSplitBlock(o, 'o', 5)
  localSplitBlock(o, 'o', 8)
  assert.deepEqual(
    boundaryIdsByPos(o).sort((a: { pos: number }, b: { pos: number }) => a.pos - b.pos),
    [{ pos: 5, id: ['o', 10] }, { pos: 8, id: ['o', 11] }])
})

// Backspace at a paragraph start merges into the previous block.
test('localMergeBlock merges at a boundary position', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'ab')
  localSplitBlock(o, 'o', 1)              // a | b
  localMergeBlock(o, 'o', 1)
  const s = checkoutRich(o)
  assert.equal(s.text.join(''), 'ab')
  assert.deepEqual(s.blocks, [{ start: 0, end: 2, blockType: 'paragraph' }])
})

// No-op at doc start and when no boundary sits at pos.
test('localMergeBlock is a no-op at doc start and off-boundary', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'ab')
  localSplitBlock(o, 'o', 1)
  localMergeBlock(o, 'o', 0)              // doc start: no-op
  localMergeBlock(o, 'o', 2)              // no boundary here: no-op
  assert.equal(checkoutRich(o).blocks.length, 2, 'both no-ops; still 2 blocks')
})

// A delete range crossing a boundary deletes the text AND merges (boundary
// strictly inside the range). 'helloworld', split@5; delete [3,7) = 'lowo'.
test('localDeleteRange merges a boundary strictly inside the range', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'helloworld')
  localSplitBlock(o, 'o', 5)
  localDeleteRange(o, 'o', 3, 4)          // deletes positions 3,4,5,6
  const s = checkoutRich(o)
  assert.equal(s.text.join(''), 'helrld')
  assert.deepEqual(s.blocks, [{ start: 0, end: 6, blockType: 'paragraph' }])
})

// A boundary exactly at the range edge is NOT merged (strictly-inside rule).
test('localDeleteRange leaves a boundary at the range edge', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'helloworld')
  localSplitBlock(o, 'o', 5)
  localDeleteRange(o, 'o', 5, 2)          // boundary at pos 5 == range start: kept
  const s = checkoutRich(o)
  assert.equal(s.text.join(''), 'hellorld')
  assert.deepEqual(s.blocks.map(b => [b.start, b.end]), [[0, 5], [5, 8]])
})

test('block_merge_concurrent_double', () => {
  // Two peers both delete the same boundary concurrently; result must converge.
  const a = createOpLog<string>()
  localInsert(a, 'a', 0, ...'ab')
  localSplitBlock(a, 'a', 1)             // boundary ['a', 2]

  const b = createOpLog<string>()
  mergeOplogInto(b, a)

  localDeleteBoundary(a, 'a', ['a', 2])  // peer A merges
  localDeleteBoundary(b, 'b', ['a', 2])  // peer B merges concurrently

  mergeOplogInto(a, b)
  mergeOplogInto(b, a)

  const sa = checkoutRich(a)
  const sb = checkoutRich(b)
  assert.deepEqual(sa.blocks, [{ start: 0, end: 2, blockType: 'paragraph' }])
  assert.deepEqual(sa.blocks, sb.blocks, 'convergence')
  assert.equal(sa.text.join(''), 'ab')
})
