import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOpLog, localInsert, localSplitBlock, localDeleteBoundary, mergeOplogInto,
  boundaryIdsByPos, localMergeBlock, localDeleteRange, localDelete,
} from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'
import { SimpleRichDoc } from './simple-rich-doc.js'

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

// Merged block keeps the PRECEDING block's type.
// 'helloworld'=seqs 0..9; split@0 'heading'=seq 10; split@5 'paragraph'=seq 11.
test('block_merge_preceding_type_wins', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'helloworld')
  localSplitBlock(o, 'o', 0, 'heading')   // first block is a heading
  localSplitBlock(o, 'o', 5, 'paragraph')
  assert.deepEqual(checkoutRich(o).blocks,
    [{ start: 0, end: 5, blockType: 'heading' },
     { start: 5, end: 10, blockType: 'paragraph' }])
  localDeleteBoundary(o, 'o', ['o', 11])  // merge: remove the paragraph boundary
  assert.deepEqual(checkoutRich(o).blocks,
    [{ start: 0, end: 10, blockType: 'heading' }], 'preceding (heading) type wins')
})

// Merge + concurrent edit in a block: both apply, single merged block, converge.
test('block_merge_concurrent_edit_converges', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'helloworld')
  localSplitBlock(a, 'a', 5)              // boundary id ['a', 10]
  mergeOplogInto(b, a)
  localDeleteBoundary(a, 'a', ['a', 10])  // A merges the blocks
  localInsert(b, 'b', 7, 'X')             // B edits concurrently
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const sa = checkoutRich(a), sb = checkoutRich(b)
  assert.equal(sa.text.join(''), 'hellowoXrld')
  assert.deepEqual(sa.blocks, sb.blocks)
  assert.deepEqual(sa.blocks, [{ start: 0, end: 11, blockType: 'paragraph' }])
})

// Merge + a concurrent split elsewhere are independent; both survive.
test('block_merge_vs_concurrent_split_elsewhere', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'helloworld')
  localSplitBlock(a, 'a', 3)              // boundary id ['a', 10]
  mergeOplogInto(b, a)
  localDeleteBoundary(a, 'a', ['a', 10])  // A removes boundary at 3
  localSplitBlock(b, 'b', 7)              // B splits at 7
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const sa = checkoutRich(a), sb = checkoutRich(b)
  assert.deepEqual(sa.blocks, sb.blocks)
  assert.deepEqual(sa.blocks.map(bl => [bl.start, bl.end]), [[0, 7], [7, 10]])
})

// Oracle must mirror the engine when a boundary is deleted.
test('oracle matches engine on block merge', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'helloworld')
  localSplitBlock(o, 'o', 5)
  localDeleteBoundary(o, 'o', ['o', 10])
  const eng = checkoutRich(o)

  const doc = new SimpleRichDoc()
  doc.insert('o', 0, 0, 'helloworld')     // seqs 0..9
  doc.splitBlock('o', 10, 5, 'paragraph') // seq 10
  doc.deleteBlock('o', 10)                // merge that boundary
  const ora = doc.materialize()

  assert.deepEqual(ora.blocks, eng.blocks)
  assert.equal(ora.text, eng.text.join(''))
})
