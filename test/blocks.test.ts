import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpLog, localInsert, localDelete, localMark, localSplitBlock, mergeOplogInto } from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'

test('block_basic_split', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'helloworld')
  localSplitBlock(o, 'o', 5)
  assert.deepEqual(checkoutRich(o).blocks,
    [{ start: 0, end: 5, blockType: 'paragraph' },
     { start: 5, end: 10, blockType: 'paragraph' }])
})

// Design spec §4.3 / claim C5: concurrent split + text edit merge as plain
// sequence ops - the edit lands in the block its position implies.
test('block_concurrent_split_edit', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'helloworld')
  mergeOplogInto(b, a)
  localSplitBlock(a, 'a', 5)              // Alice splits hello|world
  localInsert(b, 'b', 7, 'X')             // Bob edits "world" -> "woXrld"
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const sa = checkoutRich(a), sb = checkoutRich(b)
  assert.equal(sa.text.join(''), 'hellowoXrld')
  assert.deepEqual(sa.blocks, sb.blocks)
  assert.deepEqual(sa.blocks.map(bl => [bl.start, bl.end]), [[0, 5], [5, 11]])
})

// Design spec §4.3: two users split at the SAME position -> ONE boundary
// survives in the partition (empty block collapsed), replicas agree.
test('block_same_position_split', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'helloworld')
  mergeOplogInto(b, a)
  localSplitBlock(a, 'a', 5)
  localSplitBlock(b, 'b', 5)
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const sa = checkoutRich(a)
  assert.deepEqual(sa.blocks.map(bl => [bl.start, bl.end]), [[0, 5], [5, 10]])
  assert.deepEqual(sa.blocks, checkoutRich(b).blocks)
})

// Design spec §4.3: v1 has no boundary-deletion op (del skips anchors). This
// test documents honest v1 semantics: delete ALL text around a boundary ->
// boundary persists, blocks collapse to a single empty block.
test('block_merge_vs_edit_v1_semantics', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'ab')
  localSplitBlock(o, 'o', 1)
  localDelete(o, 'o', 0, 2)               // delete ALL text
  const s = checkoutRich(o)
  assert.equal(s.text.join(''), '')
  // boundary at pos 0 of empty doc -> single empty block
  assert.deepEqual(s.blocks, [{ start: 0, end: 0, blockType: 'paragraph' }])
})

// Design spec §4.2 paragraph-start exception (Peritext §3.3): a char typed
// right after a block boundary inherits the FOLLOWING char's expanding marks.
test('block_paragraph_start_exception', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'ab')
  localSplitBlock(o, 'o', 1)              // a | b
  localMark(o, 'o', 1, 2, 'bold', true)   // bold "b" (second block)
  localInsert(o, 'o', 1, 'X')             // type at start of second block
  const s = checkoutRich(o)
  assert.equal(s.text.join(''), 'aXb')
  assert.deepEqual(
    s.spans.filter(x => x.markType === 'bold').map(x => [x.start, x.end]),
    [[1, 3]], 'X inherits bold from following char at paragraph start')
})
