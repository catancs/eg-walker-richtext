# eg-walker-richtext — Design Document

**Date:** 2026-06-06
**Status:** Approved design, pre-implementation
**Language:** TypeScript (reference-quality, correctness-first)
**Repo:** `catancs/eg-walker-richtext` · local `/Users/cata/Apps/eg-walker-richtext`
**License:** MIT (upstream-compatible; vendored code attributed)

---

## 1. Problem & Gap

The Eg-walker algorithm (Gentle & Kleppmann, *Collaborative Text Editing with
Eg-walker: Better, Faster, Smaller*, EuroSys 2025, arXiv:2409.14252) is the
state of the art for collaborative **plain text**: it stores an immutable event
graph of original operations, keeps no per-character CRDT metadata in steady
state, and rebuilds a transient CRDT structure only while merging concurrent
edits. It beats both OT (160,000× on a pathological merge) and CRDTs
(1–2 orders of magnitude on steady-state memory).

**It does not support rich text.** The paper names rich text as future work.
No implementation (diamond-types, eg-walker-reference, Loro's event-graph
layer) ships it as of June 2026 (verified by frontier scan).

Worse, the one team that got close published an **infeasibility claim**: Loro's
materials state that Peritext (the reference rich-text CRDT semantics, Litt et
al., Ink & Switch / CSCW 2022) *"cannot be modeled on Eg-walker"* because
Eg-walker's replay relies on operations producing the same effect regardless of
state, while Peritext's span resolution is order-dependent. Loro therefore
routed rich text onto a separate Fugue positional layer, paying permanent
per-element CRDT metadata for formatted text.

**This project refutes that infeasibility claim by decomposition** and ships
the first rich-text layer that inherits Eg-walker's memory/load profile.

## 2. Core Claims (each maps to published evidence — §7)

1. **C1 — Feasibility:** Peritext-semantics inline formatting *can* run on an
   event-graph replay engine, by splitting marks into (a) state-independent
   anchor insertions handled inside replay and (b) a pure, order-aware
   resolution function that runs outside replay at materialization time.
2. **C2 — Intent preservation:** The design passes Peritext's published intent
   test cases (Examples 1–8) and the documented failure cases that made
   Peritext reject naive inline control characters (P1–P4), plus the
   tombstone-capture bug (peritext#32) and Yjs's orphaned-marker bug (yjs#197).
3. **C3 — Memory shape:** Persistent state stays O(document size), not
   O(history): the snapshot is `{text, spans, blocks}` with zero per-character
   metadata; anchors exist only in the (always-growing, append-only) event log
   and in the transient replay structure.
4. **C4 — Convergence:** All replicas converge for arbitrary concurrent
   histories (differentially fuzzed against an independent simple reference
   implementation, seeds published).
5. **C5 — Defined flat-block semantics:** Concurrent paragraph split/merge and
   text edits have specified, tested merge behavior — a case Peritext,
   Automerge, and Loro all explicitly defer.

## 3. Architecture

Five layers; the bottom two are reused from `josephg/eg-walker-reference`
(vendored, attributed):

```
┌─────────────────────────────────────────────────────┐
│ 5. Snapshot: { text, spans[], blocks[] }            │  persistent, O(doc size)
├─────────────────────────────────────────────────────┤
│ 4. Resolution: anchors → resolved spans             │  pure function, runs at
│    (set-coverage, overlap=union, LWW per type)      │  checkout, NOT in replay
├─────────────────────────────────────────────────────┤
│ 3. Replay: retreat/advance/apply over items         │  extended: anchor items
│    (FugueMax integration — anchors are items)       │  transient, discarded
├─────────────────────────────────────────────────────┤
│ 2. Op log: ins | del | markStart | markEnd | block  │  extended op vocabulary
├─────────────────────────────────────────────────────┤
│ 1. Causal graph: (agent,seq) IDs + parents          │  reused unchanged
└─────────────────────────────────────────────────────┘
```

**The decomposition argument (answer to Loro's infeasibility claim):**
Eg-walker replay requires state-independent operations. Peritext resolution is
order-dependent. We never put resolution into replay:

- Layer 3 treats mark anchors and block boundaries as ordinary **zero-width
  sequence insertions**. Placement under concurrency is handled by the
  already-proven FugueMax integration — state-independent, exactly what replay
  requires.
- Layer 4 holds **all** order-dependent Peritext logic as a pure derivation
  over the finished item list + causal graph. It runs at materialization and
  its output is discarded/recomputed like any view.

Approach validated against alternatives (side-table marks; Automerge-style
hybrid) via efficiency analysis and prior-art review — see §8 Decision Log.

## 4. Data Model

### 4.1 Op vocabulary (layer 2)

```typescript
type RichOp<T> =
  | { type: 'ins', pos: number, content: T }            // unchanged upstream
  | { type: 'del', pos: number }                        // unchanged upstream
  | { type: 'markStart', pos: number, side: 'before'|'after',
      markType: string, value?: any }                   // zero-width anchor
  | { type: 'markEnd',   pos: number, side: 'before'|'after',
      markType: string,
      startId: [agent: string, seq: number] }           // pairs to its start by
                                                        // RAW version - LVs are
                                                        // replica-local, never in ops
  | { type: 'blockBoundary', pos: number,
      blockType: string }                               // flat blocks (¶)
```

Operation identity and causal parents live in the causal graph (layer 1),
unchanged. A mark op's `(agent, seq)` doubles as its Lamport-comparable ID for
conflict resolution — fixing Peritext failure P3 (bare control characters
cannot say which format is newer; ours can).

### 4.2 Anchor placement rules

- **`side` encodes expand policy at insertion time.** A `markEnd` with
  `side:'before'` is right-sticky (insertion stops BEFORE the anchor, so the
  anchor stays after the new text): text typed at the boundary integrates
  *inside* the span (bold grows). `side:'after'` is left-sticky (insertion
  skips PAST the anchor): text lands *outside* (links don't grow). Labels
  match the `Side` doc comment in `src/index.ts` (the authoritative
  convention). Implemented via the insertion-time sticky-skip rule —
  zero runtime cost.
  Default policy table (Peritext Table 1 / Loro's expand modes):

  | markType            | overlap? | expand (end side) |
  |---------------------|----------|-------------------|
  | bold/italic/underline/font/color | merge-by-rule | grows (`before`) |
  | link                | no (LWW) | does not grow (`after`) |
  | comment             | yes (all kept) | does not grow (`after`) |

- **Paragraph-start exception (Peritext §3.3):** a character inserted at the
  start of a block inherits the formatting of the *following* character (not
  the preceding one, which lives in the previous block). Encoded as: at a
  position immediately after a `blockBoundary`, expand-eligible spans
  beginning at that position capture the insert.

- **Tombstone tie-break (the peritext#32 rule):** at integration time, new
  text inserts **before** tombstoned `markStart` anchors and **after**
  tombstoned `markEnd` anchors, as an explicit tier in the integration
  ordering. Prevents dead marks from capturing live inserts.

- **Adjacent-anchor ambiguity (Loro's "n+1 positions" problem):** with n
  zero-width anchors at one text offset there are n+1 insertion slots. The
  deterministic ordering is: [markEnd anchors (side:'after')] → [insertion
  point] → [markStart anchors (side:'before')] → next character; plus the
  tombstone tier above. This total order is part of the spec and enforced by
  tests.

### 4.3 Blocks (flat, v1)

A block is the text between two `blockBoundary` items (document start/end are
implicit boundaries). Consequences, all inherited from sequence semantics:

- **Split** = insert a boundary. Concurrent split + text edit merge as
  ordinary concurrent sequence ops (FugueMax decides order; text lands in the
  block its position implies).
- **Merge paragraphs** = delete a boundary. Concurrent merge + edit: the edit
  survives; the boundary's tombstone is invisible.
- **Concurrent identical split** (two users split at the same position): two
  adjacent boundaries → one empty block between them. Policy: empty blocks
  produced this way are collapsed at resolution (layer 4), with the surviving
  boundary chosen by causal/ID order. Recorded as an explicit, tested rule.
- Block *type* changes (paragraph → heading) are `blockType` values resolved
  LWW by causal order at resolution. v1 has no nesting (no lists-in-lists);
  nesting is deferred (§9).
- **v1 boundary-insert semantics (amended during implementation):** a text
  insert at a boundary position always lands at the start of the FOLLOWING
  block — with or without marks present. The boundary index is inherently
  ambiguous (end of block N == start of block N+1) and ops carry no cursor
  affinity, so v1 picks the intuitive side deterministically. This supersedes
  a naive "¶ is right-sticky for text" reading of the rule above; ¶ remains
  right-sticky for *anchor* inserts. Pinned by
  `block_text_insert_at_boundary_lands_in_following_block`.

## 5. Resolution Semantics (layer 4)

`resolve(items, causalGraph) → { spans, blocks }` — pure, deterministic,
recomputed at checkout. Rules:

1. **Set-coverage, never toggle-counting.** A character's formatting is the
   set of mark spans (live start/end anchor pairs) covering it. Defeats P1
   (concurrent overlapping bold → union → whole range bold) and P4 (no
   running toggle state → unbalanced anchors cannot bleed to EOF).
2. **Per-type conflict policy** (table in §4.2): same-type overlap for
   boolean marks = union; valued exclusive marks (color, link) = LWW by causal
   order, ties broken by (agent, seq); comments = all preserved.
3. **Deletion hygiene.** A mark is dead iff either anchor is tombstoned.
   Netted-out mark churn yields zero spans — the snapshot self-cleans without
   a Yjs-style cleanup pass. "No orphaned live anchors" is a fuzzer-checked
   invariant, not a runtime repair.
4. **Empty-block collapse** per §4.3.

**Anchors targeting tombstones (resolution-is-CRDT-order-dependent, by design).**
A span/block boundary anchors to a *character identity* (e.g. a comment whose
end is `after` char X, or a span covering a run that is later fully deleted).
When that target char is subsequently deleted, the boundary resolves to the
*gap the tombstone occupies* in document order. That gap is a property of the
underlying sequence CRDT's tombstone placement. Two different (both valid,
both convergent) sequence CRDTs may order concurrent tombstones differently
while rendering identical visible text, so they can legitimately resolve such a
tombstone-anchored boundary to different gaps. This is **not** a resolution
ambiguity in *our* engine — eg-walker/FugueMax gives one deterministic,
replica-convergent order (verified by the upstream 1000-test conformance suite),
and resolution over that order is a pure function. It only matters for the
differential oracle (§7-D1), which uses a *different* sequence CRDT and therefore
cannot reproduce the engine's tombstone order without abandoning its
independence. The fuzzer handles this soundly: it asserts engine↔oracle spans
and blocks match **exactly** whenever the two agree on the full item order
(visible chars *and* tombstones), and carves out — with a logged note — only the
rare iterations where the orders differ (always on tombstones or an equal-letter
concurrent-insertion swap; the rendered string is identical). A genuine
mark-resolution bug is a pure function of (item order, causal graph) and so
surfaces on the >99.7% of iterations with identical item order, which are
asserted exactly; it cannot hide in the carve-out. (Measured: a deliberately
injected resolution bug fails on the *first* iteration of a carve-out-free base.)

## 6. Persistent Snapshot (layer 5)

```typescript
interface RichSnapshot<T> {
  text: T[]                       // visible characters only
  spans: { start: number, end: number, markType: string, value?: any }[]
  blocks: { start: number, end: number, blockType: string }[]
  version: LV[]                   // frontier this snapshot represents
}
```

O(visible document), independent of history length. Anchors never appear in
the snapshot — only their resolved effect. This is claim C3 and is
non-negotiable: a `Branch` checkout carries `RichSnapshot`, not raw items.

## 7. Verification & Evidence Harness

Four layers, strongest first. Everything is reproducible by command and the
results are committed.

- **D1 — Differential fuzzing (keystone).** `SimpleRichDoc`: an independent,
  deliberately naive reference model (~200 lines: per-character mark sets,
  array splicing, no CRDT machinery — correct by inspection). Fuzzer generates
  random concurrent histories (ins/del/mark/unmark/split/merge across 3
  agents, random merge points, seeded PRNG) and asserts: (a) replica
  convergence on `{text, spans, blocks}` (UNCONDITIONAL, every iteration), (b)
  engine ≡ SimpleRichDoc spans/blocks **exactly** whenever the two agree on the
  full item order (visible chars *and* tombstones), (c) invariants (no orphaned
  live anchors; spans well-formed; blocks partition the text). Seeds committed;
  10⁴ traces per push, 10⁶ nightly.

  **Honest, seed-independent claim (verification pass, 2026-06).** The
  engine self-converges on 100% of iterations across every seed base tested
  (egwrt-1 at 10⁴ plus 27+ fresh bases at 3·10³–5·10³ each, >10⁵ total). The
  engine matches the oracle's spans/blocks **exactly on every iteration where
  the comparison is well-defined** — i.e. wherever the two independent sequence
  CRDTs produce the same item order. The only carved-out cases are text-CRDT
  *ordering* variants, NOT mark-resolution differences, in two precisely
  characterized classes (§5, "Anchors targeting tombstones"): (i) a
  visible-text concurrent-insertion tie-break (rendered string itself differs;
  ~0.4–0.6% per base), and (ii) an identical-rendered-string item-order variant
  where concurrent *tombstones* or two *equal-letter* concurrent inserts resolve
  in a different relative order (~0.05–0.14% per base), of which only a small
  fraction (≈0.0–0.04% per base, 0.007% aggregate) actually shifts a
  tombstone-anchored span/block. The earlier "0 divergences" wording was an
  artifact of one cherry-picked seed base and of a fuzzer that skipped the
  span/block check whenever the text differed; the comparison is now sound on
  EVERY run (a deliberately injected resolution bug fails on the first iteration
  even of a carve-out-free base). The honest headline is therefore: **0
  mark-resolution divergences across all seed bases / >10⁵ iterations**, with
  the engine↔oracle differences fully attributed to the independent oracle's
  different (but equally valid and convergent) sequence-CRDT tombstone order.
- **D2 — Adversarial suite (claims = test names).** Every documented prior-art
  failure becomes a citation-named test: `peritext_P1_concurrent_overlap_bold`,
  `peritext_P2_toggle_counting_dog`, `peritext_P4_unbounded_bleed`,
  `peritext_issue32_tombstone_capture`, `yjs_197_orphaned_markers`, Peritext
  Examples 1–8, and the new block suite (`block_concurrent_split_edit`,
  `block_same_position_split`, `block_merge_vs_edit`). This file is the
  executable spec.
- **D3 — Conformance & traces.** Upstream plain-text conformance data and the
  real editing traces (automerge-perf, git-makefile, node_nodecc) must pass
  unchanged — the rich extension must not perturb the proven text layer. New
  synthetic rich traces committed as a conformance corpus for other
  implementations.
- **D4 — Benchmarks.** Replay time, steady-state memory, encoded size on
  standard + rich traces vs Yjs and Automerge 3.x (both ship rich text), and
  Loro where comparable. Honest framing: a TS reference vs production
  libraries measures *model overhead*; the headline claim is the memory
  *shape* (C3), which survives constant factors.

**Evidence publication:** auto-generated `EVIDENCE.md` (fuzz totals + seeds +
git SHA; adversarial results table test ↔ citation ↔ status; benchmark tables
with environment; `npm run evidence` regenerates all). GitHub Actions: suite +
10⁴ fuzz per push; nightly 10⁶ + EVIDENCE.md refresh. README badges.

## 8. Decision Log (validated 2026-06-06 by parallel research agents)

- **Anchors-as-items over side-table marks:** side-table is asymptotically
  lighter on replay but re-implements concurrent anchor movement (the hard
  part FugueMax gives free) and breaks under `mergeChangesIntoBranch`
  placeholders; crossover ratio (marks ≫ chars) unreachable in real prose
  (M/N ≤ ~0.3). Loro's `crdt-richtext` is the existence proof the layout
  achieves Peritext semantics (and outperforms Yjs ~6×).
- **Efficiency verdict:** anchors add a ≤1.3× (pathological ~1.8×) constant to
  the reference engine's already-linear replay; log growth equivalent to
  Yjs/Peritext (all op-based append-only); no pathology beyond existing
  character tombstones; churn self-cleans at resolution. Future optimized port
  absorbs costs via B-tree position index + RLE anchor runs.
- **Freshness (June 2026):** rich-text-on-Eg-walker unclaimed; diamond-types
  commits are refactoring only; Kleppmann's 2025–26 output is plain-text Fugue
  theory; Loro keeps rich text on its positional layer. Mandatory related
  work to cite: Eg-walker paper; Peritext (CSCW 2022); Fugue/TPDS 2025;
  Loro crdt-richtext; Yjs #197/#606.

## 9. Deferred (documented in README roadmap, not v1)

- Nested block structure (lists-in-lists, tables) — the open research problem.
- Formal/machine-checked spec of the resolution function (Kleppmann's
  AI-assisted-verification direction) — natural phase 2.
- Rust port into diamond-types lineage for production-grade benchmarks.
- Cursor/selection (presence) APIs; network sync protocol.
- History pruning interplay (the "shallow graft" problem) — separate project.

## 10. Build Order

1. Vendor upstream engine + tests; CI green on plain-text conformance (D3).
2. Anchor items in replay (layer 2+3): markStart/markEnd integration, side
   semantics, #32 tie-break tier. Fuzz text+anchors.
3. Resolution function (layer 4) + snapshot (layer 5). Adversarial suite D2
   for marks.
4. `SimpleRichDoc` + full differential fuzzer (D1).
5. Blocks (boundary items + resolution rules + block adversarial tests).
6. Benchmarks (D4) + `EVIDENCE.md` generation + CI nightly.
7. README narrative (why / how / edge / deferred) + publish.

## 11. References

- Gentle & Kleppmann, *Collaborative Text Editing with Eg-walker*, EuroSys
  2025, arXiv:2409.14252. Reference impl: github.com/josephg/eg-walker-reference.
- Litt, Kleppmann et al., *Peritext: A CRDT for Rich-Text Collaboration*,
  CSCW 2022. inkandswitch.com/peritext (esp. §2.3 rejected designs, §3 rules,
  Table 1; issue inkandswitch/peritext#32).
- Weidner & Kleppmann, *The Art of the Fugue*, IEEE TPDS Nov 2025 (FugueMax,
  maximal non-interleaving).
- Loro: loro.dev/blog/loro-richtext; github.com/loro-dev/crdt-richtext
  (anchors-as-list-elements existence proof; the Eg-walker infeasibility
  claim this design refutes).
- Yjs: yjs#197 (orphaned markers, cleanup), yjs#606, YText
  `cleanupFormattingGap` (8-year production lessons for inline anchors).
