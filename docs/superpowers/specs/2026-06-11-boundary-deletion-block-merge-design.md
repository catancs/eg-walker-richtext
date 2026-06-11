# Boundary Deletion (Block Merge) — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming), pending implementation plan
**Scope:** Close the #1 documented v1 limitation in README §6 — *"Boundary-deletion is not supported (deleting across a block boundary)."*

---

## 1. Problem

A document is a sequence of items; paragraph breaks are zero-width `blockBoundary`
anchor items. Deletion today cannot remove a boundary:

- `localDelete` (`src/index.ts`) pushes `del` ops by position.
- The replay delete loop (`apply1`, `src/index.ts:394`) advances the cursor past
  **every** non-text item (`it.kind !== 'text'`) and only ever tombstones a visible
  character.

Consequently a delete range that crosses a `blockBoundary` deletes the text on both
sides but leaves the boundary alive: the paragraphs stay split. There is **no op in
the vocabulary that can tombstone a boundary**, so "merge two paragraphs" is
inexpressible. This spec adds that capability.

## 2. Goals / Non-goals

**Goals**
- Express block merge: a delete range crossing one or more boundaries removes those
  boundaries (paragraphs merge), and a standalone backspace-at-paragraph-start merge.
- Merged block keeps the **preceding** block's type.
- Converge under concurrency (the project's load-bearing property).
- Evidence-grade: adversarial/semantic tests, oracle parity, differential-fuzzer
  coverage, regenerated `EVIDENCE.md`, updated README/design docs.

**Non-goals (YAGNI)**
- Nested-block merge rules (v1 is flat; nesting is deferred, design §9).
- Cursor/selection/presence APIs.
- Any new mark-policy behavior beyond the existing union/LWW/multi rules.

## 3. Decisions (from brainstorming)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Merge scope | Range-delete crossing boundaries **and** backspace-merge | Matches real editor UX |
| Mechanism | New op `delBlockBoundary`, targeting the boundary by identity `(agent, seq)` | Convergence-robust; mirrors `markEnd → startId`; leaves `del` untouched; avoids the replica-dependent positional hazard the project deliberately removed (README §3 "sticky-skip" removal) |
| Merged block type | **Preceding** block wins | Standard editor behavior; and it falls out for free (see §6) |
| Depth | Full, evidence-grade | Matches the C1–C5 bar |

## 4. Op vocabulary (`src/index.ts`)

Add a sixth op kind:

```ts
{ type: 'delBlockBoundary', startId: RawVersion }   // RawVersion = [agent, seq]
```

`startId` references the target `blockBoundary` op by its raw identity, exactly as
`markEnd.startId` references its `markStart`. There is **no `pos`** — targeting is by
identity only, so it never consults transient positional arrangement.

The op consumes one causal-graph seq (like a single `del`).

## 5. Replay (`apply1` + retreat/advance, `src/index.ts`)

Handle `delBlockBoundary` as an **identity-targeted delete**:

1. Resolve `startId → LV` via `causalGraph.rawToLV`.
2. Find the boundary **item** for that LV. Replay does not currently maintain an
   `opId → item` index (markEnd linking happens at resolution, not replay), so add
   one (a `Map<number, number>` opId→item-index, populated as items integrate). The
   plan will confirm whether an equivalent already exists before adding.
3. Tombstone that item: set `curState = endState = ItemState.Deleted`, and record
   `delTargets[opId] = boundaryItemLv`.
4. Route through the same `do1`/`undo1` retreat/advance machinery the diff-based
   causal traversal uses for `del`, so forward/backward replay over a branching
   graph stays correct.

**Double-merge** (two replicas delete the same boundary): the second application is an
idempotent re-delete. The engine "doesn't care about double deletes" for text
(`src/index.ts:411–413`); the same tolerance must hold here (assert/relax exactly as
`del` does — the plan verifies the assertion at line ~404 does not over-fire for an
already-`Deleted` boundary, mirroring the text-delete carve-out).

## 6. Resolution (`src/resolve.ts`) — no change for the happy path

Verified during design:

- `resolve.ts:107–108` (`if (it.endState !== ItemState.Inserted) continue`) skips a
  tombstoned anchor **before** the `blockBoundary` branch at `:126`, so a tombstoned
  boundary is never pushed to `bounds` and produces no cut.
- Block assembly (`resolve.ts:316–321`) carries each cut's type forward as `prevType`;
  a boundary's `blockType` describes the block that **starts** at it. Removing a
  boundary folds its following text into the preceding block, which keeps the
  preceding cut's type — i.e. **"preceding wins" is automatic**.

**Audit (one test, no code change expected):** confirm a tombstoned boundary's stale
`originLeft`/`visAfter` cannot perturb paragraph-start mark inheritance
(`resolve.ts:206–243`). It is skipped before `bounds.push`, so its position is never
in `boundaryPositions` — a regression test pins this.

## 7. Local API (`src/index.ts`)

```ts
// Backspace at a paragraph start: merge this block into the previous one.
// No-op at doc start (the implicit doc-start boundary cannot be deleted).
function localMergeBlock<T>(oplog, agent, pos): void

// Delete a range; emits text `del`s for visible chars AND one
// `delBlockBoundary` per boundary whose resolved gap is STRICTLY inside (start, end).
function localDeleteRange<T>(oplog, agent, pos, len): void
```

`localDelete` is **unchanged** (preserves every existing delete test).

Both helpers need position → boundary-identity at edit time. Local edits are
single-replica, so the mapping is unambiguous. Add a read-only helper:

```ts
// Live boundaries with their resolved gap position and raw identity.
// Local convenience ONLY — not part of the persistent RichSnapshot.
function boundaryIdsByPos<T>(oplog): { pos: number, id: RawVersion }[]
```

It reuses the same `originLeft → visAfter` resolution the snapshot uses, then attaches
each live boundary's raw `(agent, seq)`.

**Range/boundary half-open convention:** a boundary at resolved gap `g` is merged by
`localDeleteRange(pos, len)` iff `pos < g < pos + len` (strictly inside). A selection
that merely starts or ends exactly on a boundary does not merge it. Pinned by tests.

## 8. Concurrency semantics (specified + tested)

| Scenario | Specified result |
| --- | --- |
| Merge + concurrent edit in either adjacent block | Edit survives; one merged block contains both blocks' text |
| Concurrent double-merge of the same boundary | Idempotent; single merged block |
| Merge + concurrent split elsewhere | Independent; both apply |
| Merge + concurrent text insert *at* the merged boundary | Inserted text survives, lands per existing boundary-insert semantics, folded into the merged block |
| Merge + concurrent `blockType` change on the disappearing block | Type change is moot (block is gone); preceding type stands |
| Backspace-merge at doc start | No-op |

All must converge: engine self-convergence on `{text, spans, blocks}` and
engine↔oracle agreement wherever item orders agree (the existing fuzzer contract).

## 9. Evidence plan (C1–C5 bar)

- **Tests** (`test/blocks.test.ts` or a new `test/block-merge.test.ts`): citation-style
  `block_merge_*` names covering every row of §8, plus the §6 resolution audit.
- **Oracle** (`test/simple-rich-doc.ts`): teach `SimpleRichDoc` to apply
  `delBlockBoundary` (remove the boundary from its side table). Oracle and engine must
  agree.
- **Differential fuzzer** (`test/rich-fuzzer.ts`): add merge and range-delete moves to
  the random op generator; existing convergence/agreement assertions cover them.
- **EVIDENCE.md**: regenerate via `npm run evidence`; the new tests appear in the suite
  totals and the fuzzer rows.
- **Docs**: remove the boundary-deletion bullet from README §6; update design doc §4.3
  (merge is now expressible) and §9.

## 10. File-by-file change list

| File | Change |
| --- | --- |
| `src/index.ts` | New op kind; `apply1` + retreat/advance handling; opId→item index; `localMergeBlock`, `localDeleteRange`, `boundaryIdsByPos` |
| `src/resolve.ts` | No functional change (audit + possibly a clarifying comment) |
| `test/simple-rich-doc.ts` | Oracle learns `delBlockBoundary` |
| `test/block-merge.test.ts` (new) | `block_merge_*` adversarial/semantic suite |
| `test/rich-fuzzer.ts` | Generate merge/range-delete moves |
| `EVIDENCE.md` | Regenerated |
| `README.md` | §6 limitation removed |
| `docs/2026-06-06-eg-walker-richtext-design.md` | §4.3 / §9 updated |

## 11. Risks

- **Retreat/advance correctness for an identity-targeted delete.** The diff-based
  traversal must undo/redo a boundary tombstone exactly like a text delete. Mitigation:
  reuse the existing `del` retreat/advance path verbatim, differing only in how the
  target item is located; fuzz heavily.
- **opId→item index.** If replay has no such index, adding one touches the integration
  hot path. Mitigation: populate incrementally as items integrate; it is O(1) per item.
- **Oracle drift.** The oracle must mirror merge semantics precisely or the fuzzer
  carve-out widens. Mitigation: the oracle's boundary removal is trivial (delete from
  its side table); covered by direct oracle-vs-engine unit assertions.

## 12. References

- Design doc `docs/2026-06-06-eg-walker-richtext-design.md` §4.3 (blocks), §5
  (resolution), §9 (deferred).
- `src/index.ts:99` (`localDelete`), `:121` (`localSplitBlock`), `:384` (`apply1`),
  `:394` (delete skip loop).
- `src/resolve.ts:107` (tombstone skip), `:126` (boundary push), `:304–321` (block
  partition).
- README §3 (sticky-skip removal — the convergence lesson motivating identity
  targeting), §6 (the limitation being closed).
