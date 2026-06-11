# Boundary Deletion (Block Merge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the engine merge paragraphs by tombstoning a `blockBoundary`, via a new identity-targeted `delBlockBoundary` op plus `localMergeBlock` / `localDeleteRange` helpers, closing README §6's boundary-deletion limitation.

**Architecture:** A boundary is deleted by an op that references it by raw `(agent, seq)` identity (mirroring `markEnd.startId`), never by position — sidestepping the replica-dependent positional hazard the project deliberately removed (README §3). Replay routes the op through the existing `del` retreat/advance state machine (it *is* a delete, minus the positional walk and minus any snapshot splice). Resolution needs no change: `resolve.ts` already skips tombstoned anchors before partitioning, so a dropped boundary folds its text into the preceding block and inherits the preceding type ("preceding wins" is automatic).

**Tech Stack:** TypeScript (ES2022 / NodeNext), `node:test` + `node:assert/strict`, the vendored eg-walker engine (`src/index.ts`), `seed-random` fuzzer, `npm run build` (tsc) → `dist/`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/index.ts` | Op vocabulary, replay, local edit API | Add op type; `apply1` + `advance1`/`retreat1` handling; `localDeleteBoundary`, `boundaryIdsByPos`, `localMergeBlock`, `localDeleteRange` |
| `src/resolve.ts` | Pure resolution | **No functional change** (verified: tombstoned boundary already skipped) |
| `test/block-merge.test.ts` | New semantic + concurrency suite | Create |
| `test/blocks.test.ts` | Existing block tests | Fix one stale comment |
| `test/simple-rich-doc.ts` | Differential oracle | Add boundary tombstone support |
| `test/rich-fuzzer.ts` | Differential fuzzer | Add a boundary-merge move |
| `EVIDENCE.md` | Generated evidence | Regenerate |
| `README.md`, `docs/2026-06-06-eg-walker-richtext-design.md` | Docs | Remove/Update the limitation |

All tests run from `dist/` after `npm run build`. Throughout, the boundary op id is `[agent, seq]` (a `causalGraph.RawVersion`).

---

## Task 1: `delBlockBoundary` op + replay + `localDeleteBoundary` primitive

**Files:**
- Modify: `src/index.ts` (op union ~`:54-70`, `advance1` `:242-259`, `retreat1` `:261-276`, `apply1` `:388-491`; add `localDeleteBoundary` near `:121`)
- Test: `test/block-merge.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/block-merge.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — tsc errors that `localDeleteBoundary` is not exported and `'delBlockBoundary'` is not a valid op type.

- [ ] **Step 3: Add the op type**

In `src/index.ts`, extend the `ListOp` union (after the `blockBoundary` member, before the closing of the union ~`:70`):

```ts
} | {
  // Flat block separator (¶). Right-sticky by definition (design spec §4.3).
  type: 'blockBoundary', pos: number, blockType: string
} | {
  // Tombstones the blockBoundary identified by startId (raw agent,seq) — i.e.
  // merges the two adjacent paragraphs. Targets by IDENTITY, never position
  // (mirrors markEnd.startId). Consumes one seq, like a single `del`.
  type: 'delBlockBoundary', startId: [agent: string, seq: number]
}
```

- [ ] **Step 4: Route the op through the delete state machine in `advance1` and `retreat1`**

In `advance1` (`src/index.ts:242`), replace the body up to the branch with an `isDel` flag:

```ts
function advance1<T>(ctx: EditContext, oplog: ListOpLog<T>, opId: number) {
  const op = oplog.ops[opId]

  // delBlockBoundary is a delete (of a boundary item) — same state machine as `del`.
  const isDel = op.type === 'del' || op.type === 'delBlockBoundary'
  const targetLV = isDel ? ctx.delTargets[opId] : opId
  const item = ctx.itemsByLV[targetLV]

  if (isDel) {
    assert(item.curState >= ItemState.Inserted, 'Invalid state - adv Del but item is ' + item.curState)
    assert(item.endState >= ItemState.Deleted, 'Advance delete with item not deleted in endState')
    item.curState++
  } else {
    assertEq(item.curState, ItemState.NotYetInserted, 'Advance insert for already inserted item ' + opId)
    item.curState = ItemState.Inserted
  }
}
```

In `retreat1` (`src/index.ts:261`):

```ts
function retreat1<T>(ctx: EditContext, oplog: ListOpLog<T>, opId: number) {
  const op = oplog.ops[opId]
  const isDel = op.type === 'del' || op.type === 'delBlockBoundary'
  const targetLV = isDel ? ctx.delTargets[opId] : opId
  const item = ctx.itemsByLV[targetLV]

  if (isDel) {
    assert(item.curState >= ItemState.Deleted, 'Retreat delete but item not currently deleted')
    assert(item.endState >= ItemState.Deleted, 'Retreat delete but item not deleted')
  } else {
    assertEq(item.curState, ItemState.Inserted, 'Retreat insert for item not in inserted state')
  }

  item.curState--
}
```

- [ ] **Step 5: Handle the op in `apply1`**

In `src/index.ts`, change the top-level branch in `apply1` (`:388`) from `if (op.type === 'del') { ... } else { ... }` to insert a new `else if` BEFORE the final `else`:

```ts
  if (op.type === 'del') {
    // ... existing positional text-delete body, UNCHANGED ...
  } else if (op.type === 'delBlockBoundary') {
    // Identity-targeted delete of a zero-width boundary. No findByCurPos walk,
    // no snapshot splice (anchors contribute no width).
    const targetLV = causalGraph.rawToLV(oplog.cg, op.startId[0], op.startId[1])
    const item = ctx.itemsByLV[targetLV]
    assert(item != null && item.kind === 'blockBoundary',
      'delBlockBoundary target is not a live boundary item')
    // Concurrent double-merge is fine: retreat/advance restore curState to
    // Inserted before each apply, exactly as for text `del` (index.ts:411-413).
    assert(item.curState === ItemState.Inserted,
      'delBlockBoundary target not currently Inserted')
    item.curState = item.endState = ItemState.Deleted
    ctx.delTargets[opId] = targetLV
  } else {
    // ... existing ins | markStart | markEnd | blockBoundary integration, UNCHANGED ...
  }
```

- [ ] **Step 6: Add the `localDeleteBoundary` primitive**

In `src/index.ts`, after `localSplitBlock` (`:126`):

```ts
/** Merge the two paragraphs around a boundary by tombstoning it. Targets the
 *  boundary by its raw (agent,seq) identity. Low-level primitive; prefer
 *  localMergeBlock / localDeleteRange for position-based editing. */
export function localDeleteBoundary<T>(oplog: ListOpLog<T>, agent: string,
    startId: [agent: string, seq: number]) {
  const seq = causalGraph.nextSeqForAgent(oplog.cg, agent)
  causalGraph.add(oplog.cg, agent, seq, seq + 1, oplog.cg.heads)
  oplog.ops.push({ type: 'delBlockBoundary', startId })
}
```

- [ ] **Step 7: Build and run the test**

Run: `npm run build && node --test "dist/test/block-merge.test.js"`
Expected: PASS (`block_merge_basic`).

- [ ] **Step 8: Run the full suite to confirm no regressions**

Run: `npm run build && node --test "dist/test/**/*.test.js"`
Expected: all existing tests still PASS (`localDelete` is unchanged; the new op only adds behavior).

- [ ] **Step 9: Commit**

```bash
git add src/index.ts test/block-merge.test.ts
git commit -m "feat(blocks): delBlockBoundary op + replay + localDeleteBoundary primitive"
```

---

## Task 2: `boundaryIdsByPos` read helper

**Files:**
- Modify: `src/index.ts` (add helper after `checkoutWithItems` ~`:640`)
- Test: `test/block-merge.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/block-merge.test.ts` (add `boundaryIdsByPos` to the import from `../src/index.js`):

```ts
import { /* ...existing... */ boundaryIdsByPos } from '../src/index.js'

// boundaryIdsByPos returns each live boundary's resolved gap position + raw id.
// 'helloworld' = seqs 0..9; split@5 = seq 10; split@8 = seq 11.
test('boundaryIdsByPos reports live boundaries with pos + id', () => {
  const o = createOpLog<string>()
  localInsert(o, 'o', 0, ...'helloworld')
  localSplitBlock(o, 'o', 5)
  localSplitBlock(o, 'o', 8)
  assert.deepEqual(
    boundaryIdsByPos(o).sort((a, b) => a.pos - b.pos),
    [{ pos: 5, id: ['o', 10] }, { pos: 8, id: ['o', 11] }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `boundaryIdsByPos` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/index.ts`, after `checkoutWithItems` (`:640`):

```ts
/** Live block boundaries with their resolved gap position and raw (agent,seq)
 *  identity. LOCAL convenience for position-based merge helpers — NOT part of
 *  the persistent RichSnapshot. Parallels the boundary resolution in
 *  resolve.ts: a boundary resolves to the gap immediately right of its
 *  originLeft char (0 at doc start). */
export function boundaryIdsByPos<T>(oplog: ListOpLog<T>):
    { pos: number, id: [string, number] }[] {
  const { items } = checkoutWithItems(oplog)
  const visAfter = new Map<number, number>()
  const live: { originLeft: number, id: [string, number] }[] = []
  let pos = 0
  for (const it of items) {
    if (it.opId >= oplog.ops.length) continue           // merge placeholder
    if (it.kind === 'text') {
      if (it.endState === ItemState.Inserted) pos++
      visAfter.set(it.opId, pos)
      continue
    }
    visAfter.set(it.opId, pos)
    if (it.endState !== ItemState.Inserted) continue     // tombstoned anchor
    if (it.kind === 'blockBoundary') {
      live.push({ originLeft: it.originLeft, id: causalGraph.lvToRaw(oplog.cg, it.opId) })
    }
  }
  return live.map(b => ({
    pos: b.originLeft === -1 ? 0 : (visAfter.get(b.originLeft) ?? 0),
    id: b.id,
  }))
}
```

- [ ] **Step 4: Build and run the test**

Run: `npm run build && node --test "dist/test/block-merge.test.js"`
Expected: PASS (`boundaryIdsByPos ...`).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/block-merge.test.ts
git commit -m "feat(blocks): boundaryIdsByPos read helper (position -> boundary identity)"
```

---

## Task 3: `localMergeBlock` + `localDeleteRange`

**Files:**
- Modify: `src/index.ts` (add after `localDeleteBoundary`)
- Test: `test/block-merge.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/block-merge.test.ts` (add `localMergeBlock, localDeleteRange, localDelete` to the import):

```ts
import { /* ...existing... */ localMergeBlock, localDeleteRange, localDelete } from '../src/index.js'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build`
Expected: FAIL — `localMergeBlock` / `localDeleteRange` not exported.

- [ ] **Step 3: Implement both helpers**

In `src/index.ts`, after `localDeleteBoundary`:

```ts
/** Backspace-style merge: delete the boundary at gap `pos` (merge this block
 *  into the previous one). No-op at doc start or when no boundary sits at pos. */
export function localMergeBlock<T>(oplog: ListOpLog<T>, agent: string, pos: number) {
  if (pos <= 0) return
  const b = boundaryIdsByPos(oplog).find(x => x.pos === pos)
  if (b === undefined) return
  localDeleteBoundary(oplog, agent, b.id)
}

/** Delete the visible text range [pos, pos+len) AND merge every boundary whose
 *  resolved gap is STRICTLY inside (pos, pos+len). Plain text deletes skip
 *  anchors, so boundaries are merged explicitly via their identity. */
export function localDeleteRange<T>(oplog: ListOpLog<T>, agent: string, pos: number, len: number) {
  if (len <= 0) throw Error('Invalid delete length')
  // Capture inside-boundary ids BEFORE the text deletes (ids are position-
  // independent, but the position filter must read the pre-delete layout).
  const inside = boundaryIdsByPos(oplog)
    .filter(b => b.pos > pos && b.pos < pos + len)
    .map(b => b.id)
  localDelete(oplog, agent, pos, len)
  for (const id of inside) localDeleteBoundary(oplog, agent, id)
}
```

- [ ] **Step 4: Build and run the tests**

Run: `npm run build && node --test "dist/test/block-merge.test.js"`
Expected: PASS (all four new tests).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/block-merge.test.ts
git commit -m "feat(blocks): localMergeBlock + localDeleteRange position-based merge helpers"
```

---

## Task 4: Concurrency + preceding-type semantics (engine-only)

**Files:**
- Test: `test/block-merge.test.ts` (no `src/` change — exercises the §8 semantics table)

- [ ] **Step 1: Write the failing tests**

Append to `test/block-merge.test.ts` (add `localMark, mergeOplogInto` to the import):

```ts
import { /* ...existing... */ localMark, mergeOplogInto } from '../src/index.js'

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

// Concurrent double-merge of the SAME boundary is idempotent and converges.
test('block_merge_concurrent_double_merge', () => {
  const a = createOpLog<string>(), b = createOpLog<string>()
  localInsert(a, 'a', 0, ...'helloworld')
  localSplitBlock(a, 'a', 5)              // boundary id ['a', 10]
  mergeOplogInto(b, a)
  localDeleteBoundary(a, 'a', ['a', 10])  // both replicas delete the same boundary
  localDeleteBoundary(b, 'b', ['a', 10])
  mergeOplogInto(a, b); mergeOplogInto(b, a)
  const sa = checkoutRich(a), sb = checkoutRich(b)
  assert.deepEqual(sa.blocks, sb.blocks)
  assert.deepEqual(sa.blocks, [{ start: 0, end: 10, blockType: 'paragraph' }])
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
```

- [ ] **Step 2: Run tests to verify behavior**

Run: `npm run build && node --test "dist/test/block-merge.test.js"`
Expected: PASS for all four. (If `block_merge_preceding_type_wins` fails, the boundary id is wrong — recount seqs. If a convergence test fails, the retreat/advance routing in Task 1 Step 4 is incomplete.)

- [ ] **Step 3: Commit**

```bash
git add test/block-merge.test.ts
git commit -m "test(blocks): merge concurrency + preceding-type-wins semantics"
```

---

## Task 5: Teach the differential oracle `delBlockBoundary`

**Files:**
- Modify: `test/simple-rich-doc.ts` (field `:105`, `merge` `:248-262`, `materialize` byPos `:377-383`, `extendStartForParagraph` `:415-417`; add `deleteBlock` + `liveBlocks`)
- Test: `test/block-merge.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/block-merge.test.ts` (add the oracle import at top):

```ts
import { SimpleRichDoc } from './simple-rich-doc.js'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `doc.deleteBlock` is not a function.

- [ ] **Step 3: Add the tombstone set + `deleteBlock` + `liveBlocks`**

In `test/simple-rich-doc.ts`, add the field beside `blocks` (`:105`):

```ts
  private blocks: BlockOp[] = []
  private deletedBlocks = new Set<OpId>()   // tombstoned boundary op ids
```

Add two methods in the public API section (e.g. after `splitBlock`, `:246`):

```ts
  // Mirrors the engine's delBlockBoundary: tombstone the boundary op (agent,seq)
  // so it drops out of the partition. Like delete(), it does not participate in
  // LWW and records no new op id; deletedBlocks unions monotonically on merge.
  deleteBlock(agent: string, seq: number): void {
    this.deletedBlocks.add(oid(agent, seq))
  }

  // Boundary ops still live (not tombstoned). Used wherever block boundaries are
  // read, so a deleted boundary contributes neither a cut NOR a paragraph-start.
  private liveBlocks(): BlockOp[] {
    return this.blocks.filter(b => !this.deletedBlocks.has(oid(b.agent, b.seq)))
  }
```

- [ ] **Step 4: Use `liveBlocks()` in resolution and union the set on merge**

In `materialize`, the blocks loop (`:377-378`) — change the iteration source:

```ts
    const byPos = new Map<number, { id: OpId; blockType: string }>()
    for (const b of this.liveBlocks()) {
```

In `extendStartForParagraph`, the boundary-positions loop (`:417`):

```ts
    for (const b of this.liveBlocks()) boundaryPositions.add(this.resolveAnchor(b.at, items))
```

In `merge` (`:256-258`), union the tombstone set (add after the block-op union):

```ts
    for (const k of other.deletedBlocks) this.deletedBlocks.add(k)
```

- [ ] **Step 5: Build and run the test**

Run: `npm run build && node --test "dist/test/block-merge.test.js"`
Expected: PASS (`oracle matches engine on block merge`).

- [ ] **Step 6: Commit**

```bash
git add test/simple-rich-doc.ts test/block-merge.test.ts
git commit -m "test(oracle): SimpleRichDoc learns delBlockBoundary (tombstone + merge)"
```

---

## Task 6: Add a boundary-merge move to the differential fuzzer

**Files:**
- Modify: `test/rich-fuzzer.ts` (imports `:10-11`, op-roll ladder `:47-75`)

- [ ] **Step 1: Extend the fuzzer imports**

In `test/rich-fuzzer.ts`, add `boundaryIdsByPos` and `localDeleteBoundary` to the `../src/index.js` import (`:10-11`):

```ts
import { createOpLog, localInsert, localDelete, localMark, localSplitBlock,
  mergeOplogInto, boundaryIdsByPos, localDeleteBoundary, type ListOpLog } from '../src/index.js'
```

- [ ] **Step 2: Rebalance the roll ladder and add the merge move**

Replace the op-selection ladder (`:47-75`) with (note the new `0.42 / 0.55 / 0.78 / 0.88 / 0.93` thresholds and the new branch):

```ts
    if (roll < 0.42 || len === 0) {                       // insert
      const pos = ri(len + 1), ch = String.fromCharCode(97 + ri(26))
      localInsert(p.oplog, p.agent, pos, ch)
      p.oracle.insert(p.agent, p.seq, pos, ch); p.seq += 1
    } else if (roll < 0.55) {                             // delete
      const pos = ri(len)
      localDelete(p.oplog, p.agent, pos, 1)
      p.oracle.delete(pos)
      p.seq += 1
    } else if (roll < 0.78) {                             // mark / negate
      const s = ri(len), e = s + 1 + ri(len - s)
      const t = MARK_TYPES[ri(MARK_TYPES.length)]
      const value = rng() < 0.25 ? null
        : t === 'color' ? ['red','blue'][ri(2)]
        : t === 'link' ? 'https://x' : t === 'comment' ? `c${i}` : true
      localMark(p.oplog, p.agent, s, e, t, value)
      p.oracle.mark(p.agent, p.seq, s, e, t, value,
        markPolicy(t).endSide === 'before')
      p.seq += 2                                          // markStart + markEnd
    } else if (roll < 0.88) {                             // block split
      const pos = ri(len + 1)
      localSplitBlock(p.oplog, p.agent, pos)
      p.oracle.splitBlock(p.agent, p.seq, pos, 'paragraph'); p.seq += 1
    } else if (roll < 0.93) {                             // merge (delete) a boundary
      const bs = boundaryIdsByPos(p.oplog)
      if (bs.length > 0) {
        const b = bs[ri(bs.length)]
        localDeleteBoundary(p.oplog, p.agent, b.id)
        p.oracle.deleteBlock(b.id[0], b.id[1])
        p.seq += 1
      }
      // bs empty -> no op on either side; seq unchanged (engine + oracle stay in sync).
    } else {                                              // random pairwise merge
      const q = pairs[ri(3)]
      if (q !== p) {
        mergeOplogInto(p.oplog, q.oplog); p.oracle.merge(q.oracle)
      }
    }
```

- [ ] **Step 3: Run a short fuzz to verify convergence + oracle agreement**

Run: `npm run build && FUZZ_ITERS=3000 FUZZ_SEED=merge-smoke node dist/test/rich-fuzzer.js`
Expected: `rich-fuzzer: PASS (3000 iterations ...)`, "Engine self-converged on all 3000 iterations", and the variant rates well under the 2% ceilings. Any `span/block convergence` assertion failure means a replay bug in Task 1.

- [ ] **Step 4: Run the per-push fuzz count**

Run: `FUZZ_ITERS=10000 npm run fuzz:rich`
Expected: PASS at 10k iterations.

- [ ] **Step 5: Commit**

```bash
git add test/rich-fuzzer.ts
git commit -m "test(fuzz): exercise delBlockBoundary (merge a random live boundary)"
```

---

## Task 7: Regenerate evidence + update docs

**Files:**
- Modify: `README.md` (§6 limitation), `docs/2026-06-06-eg-walker-richtext-design.md` (§4.3, §9), `test/blocks.test.ts` (stale comment `:44-46`)
- Regenerate: `EVIDENCE.md`

- [ ] **Step 1: Fix the stale comment in `test/blocks.test.ts`**

Replace the comment above `block_merge_vs_edit_v1_semantics` (`:44-46`) with:

```ts
// Plain `localDelete` deliberately skips anchors (it only tombstones text), so
// deleting all text around a boundary leaves the boundary in place -> a single
// empty block. Merging a boundary is a SEPARATE op (delBlockBoundary /
// localMergeBlock / localDeleteRange); see block-merge.test.ts.
```

(The test body is unchanged and still passes — `localDelete` semantics are untouched.)

- [ ] **Step 2: Remove the boundary-deletion limitation from README §6**

In `README.md`, delete this bullet under "Documented v1 limitations":

```
- **Boundary-deletion is not supported** (deleting across a block boundary in the specified way).
```

- [ ] **Step 3: Update the design doc**

In `docs/2026-06-06-eg-walker-richtext-design.md` §4.3, the "Merge paragraphs = delete a boundary" bullet (`:161-162`): append a sentence noting it is now implemented via the `delBlockBoundary` op (identity-targeted), with `localMergeBlock` / `localDeleteRange` helpers. Do NOT remove anything from §9 (nested blocks etc. remain deferred); boundary-deletion was a §6 limitation, not a §9 item.

- [ ] **Step 4: Regenerate EVIDENCE.md**

Run: `npm run evidence`
Expected: exits 0; `EVIDENCE.md` rewritten with the new `block_merge_*` tests in the suite totals and a fresh fuzz run. (`gen-evidence.ts` exits non-zero if any test or the fuzzer fails — a non-zero exit means an earlier task regressed.)

- [ ] **Step 5: Verify the whole suite + dashes hygiene**

Run: `npm test`
Expected: all TAP points pass (the count grows by the new `block_merge_*` tests; expect the prior 44-pass total plus the new tests, still 0 fail).

Run: `grep -c $'—\\|–' README.md docs/2026-06-06-eg-walker-richtext-design.md`
Expected: `0` for both files (the repo's no-em/en-dash house style).

- [ ] **Step 6: Commit**

```bash
git add README.md docs/2026-06-06-eg-walker-richtext-design.md test/blocks.test.ts EVIDENCE.md
git commit -m "docs+evidence: close the boundary-deletion limitation; regenerate EVIDENCE.md"
```

---

## Self-Review

**Spec coverage:** §A op vocabulary → Task 1. §B replay → Task 1 (steps 4-5). §C local API (`localMergeBlock`, `localDeleteRange`, `boundaryIdsByPos`) → Tasks 2-3, plus the `localDeleteBoundary` primitive introduced as a shared building block. §D resolution audit → covered by Task 4's `block_merge_preceding_type_wins` + the merge tests (a tombstoned boundary that perturbed paragraph-start inheritance would surface as a span diff). §E concurrency table → Task 4 (+ fuzz Task 6). §F evidence → Tasks 5-7. Non-goals respected (no nesting, no cursor API).

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command + expected output.

**Type consistency:** `delBlockBoundary` carries `startId: [agent, seq]` everywhere (op def, `localDeleteBoundary`, `apply1` via `causalGraph.rawToLV`). `boundaryIdsByPos` returns `{ pos, id: [string, number] }`, and every caller (`localMergeBlock`, `localDeleteRange`, the fuzzer) reads `.id` / `.pos` accordingly. `deleteBlock(agent, seq)` matches the fuzzer call `deleteBlock(b.id[0], b.id[1])`. `localDeleteRange(oplog, agent, pos, len)` signature is consistent across its test and definition.

**Note on op-id arithmetic:** every test that passes a literal boundary id (`['o', 2]`, `['o', 10]`, `['o', 11]`, `['a', 10]`) derives it from seq counting — inserts consume one seq per char, `localSplitBlock` one, `localMark` two. If an executor changes preceding ops, recount.
