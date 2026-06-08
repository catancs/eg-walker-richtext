// Rich conformance over upstream plain-text traces (Task 9).
//
// Goal: prove the rich-text extension is INERT on real plain-text editing
// traces. checkoutRich must reproduce the exact text the plain (upstream)
// checkout produces, while emitting ZERO mark spans and a single trivial
// paragraph block. Pure-text traces contain no mark/block ops, so:
//   - spans  === []
//   - blocks === [{ start: 0, end: textLen, blockType: 'paragraph' }]
//
// Loader note: this is a local copy of the DTExport loader logic from
// test/upstream/test.ts (importDTOpLog). We copy rather than import so the
// upstream test file stays pristine. The upstream test already proves this
// loader reproduces endContent for the plain checkout, so our job is just to
// confirm checkoutRich agrees AND adds the empty-spans / single-block shape.
//
// Trace selection (see report):
//   - ff-raw.json  PRIMARY. A real `dt export` DTExport ({endContent, txns}
//     with per-txn seqStart). 21k chars, checkoutRich ~1s. Has a ground-truth
//     `endContent` we assert against directly.
//   - am.json      SECONDARY. The historic AsciiMath/LaTeX trace. NOTE: its
//     on-disk shape is a *bare array* of DTExport items (no `endContent`
//     wrapper, no per-txn `seqStart` — single author, parents:[]). Because it
//     carries no ground-truth endContent, we assert checkoutRich's text equals
//     the upstream-proven plain `checkoutSimpleString`. It is ~105k chars and
//     a single checkout is ~50s; running both checkouts is ~100s. It is the
//     slow one, but it's the only other genuine real-world trace, so we keep
//     it (rather than dropping it) and bump the per-test timeout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as causalGraph from '../src/causal-graph.js'
import type { LV, LVRange } from '../src/causal-graph.js'
import { type ListOp, type ListOpLog, checkoutSimpleString } from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'

// --- DTExport loader (local copy of importDTOpLog from test/upstream/test.ts) ---
// Format output by the `dt export` command. Each txn carries its own LV span,
// agent, parents and shattered insert/delete ops.
interface DTExportItem {
  agent: string,
  seqStart?: number, // present in the wrapped {endContent, txns} form; absent in the bare-array am.json
  span: LVRange,
  parents: LV[],
  ops: [pos: number, del: number, insContent: string][],
}

function oplogFromDTExport(txns: DTExportItem[]): ListOpLog {
  const ops: ListOp[] = []
  const cg = causalGraph.createCG()

  for (const txn of txns) {
    const len = txn.span[1] - txn.span[0]
    // Wrapped DTExport carries an explicit seqStart; the bare-array form
    // (am.json) does not — fall back to the LV span start, which is correct
    // for the single-author linear traces that ship in that shape.
    const seqStart = txn.seqStart ?? txn.span[0]
    causalGraph.add(cg, txn.agent, seqStart, seqStart + len, txn.parents)

    // Shatter ops: every insert char / delete becomes one op (no RLE).
    for (let [pos, delHere, insContent] of txn.ops) {
      if ((delHere > 0) === (insContent !== '')) throw Error('Operation must be an insert or delete')

      if (delHere > 0) {
        for (let i = 0; i < delHere; i++) {
          ops.push({ type: 'del', pos })
        }
      } else {
        for (const c of insContent) {
          ops.push({ type: 'ins', pos, content: c })
          pos++
        }
      }
    }
  }

  return { ops, cg }
}

const trivialBlocks = (textLen: number) => [{ start: 0, end: textLen, blockType: 'paragraph' }]

// PRIMARY: a real DTExport with ground-truth endContent. Fast (~1s).
test('conformance_plaintext_ff-raw.json_via_checkoutRich', () => {
  const data: { endContent: string, txns: DTExportItem[] } =
    JSON.parse(fs.readFileSync('testdata/ff-raw.json', 'utf8'))
  const oplog = oplogFromDTExport(data.txns)
  const snap = checkoutRich(oplog)

  // (a) text reproduces the trace's own expected endContent exactly.
  assert.equal(snap.text.join(''), data.endContent)
  // (b) no mark ops in a plain-text trace => no spans.
  assert.deepEqual(snap.spans, [])
  // (c) no block ops => one trivial paragraph spanning the whole document.
  assert.deepEqual(snap.blocks, trivialBlocks(snap.text.length))
})

// SECONDARY: am.json is a bare array of DTExport items with NO endContent
// ground truth, so we oracle against the upstream-proven plain checkout.
// ~100s (two full ~50s checkouts on a 105k-char trace) -> generous timeout.
test('conformance_plaintext_am.json_via_checkoutRich', { timeout: 240_000 }, () => {
  const data: DTExportItem[] = JSON.parse(fs.readFileSync('testdata/am.json', 'utf8'))
  const oplog = oplogFromDTExport(data)
  const snap = checkoutRich(oplog)

  // (a) text matches the upstream plain checkout (am.json has no endContent).
  assert.equal(snap.text.join(''), checkoutSimpleString(oplog))
  // (b) no spans, (c) single trivial paragraph block.
  assert.deepEqual(snap.spans, [])
  assert.deepEqual(snap.blocks, trivialBlocks(snap.text.length))
})
