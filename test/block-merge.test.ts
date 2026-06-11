import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOpLog, localInsert, localSplitBlock, localDeleteBoundary,
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
