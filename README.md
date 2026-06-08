# eg-walker-richtext

**Peritext-semantics rich text on the Eg-walker collaborative-editing algorithm — a reference implementation in TypeScript.** June 2026.

This is, as far as we are aware, the first implementation of inline rich-text marks (bold / italic / underline / link / comment / color / font) plus flat paragraph blocks on the **Eg-walker** event-graph replay algorithm. It exists to refute a specific published claim — that Peritext semantics *cannot* be modeled on Eg-walker — by building the thing and shipping the evidence. It is a research/reference artifact, not a production library (see [Status](#6-status--whats-deferred)).

---

## 1. Why this exists — the gap and the refuted claim

**Eg-walker** (Gentle & Kleppmann, *Collaborative Text Editing with Eg-walker: Better, Faster, Smaller*, EuroSys 2025, [arXiv:2409.14252](https://arxiv.org/abs/2409.14252)) is the state of the art for collaborative **plain text**. It stores an immutable event graph of the original operations, keeps **no per-character CRDT metadata in steady state**, and rebuilds a transient CRDT structure only while merging concurrent edits. The paper lists rich text as **future work**, and no shipping implementation had it as of June 2026.

The team that got closest published an **infeasibility claim**. Loro's documentation/blog states (paraphrasing) that **Peritext cannot be modeled on Eg-walker**: Eg-walker's replay depends on every operation producing the *same effect regardless of document state* (state-independent replay), whereas Peritext's span resolution is fundamentally **order-dependent**. Loro therefore routed rich text onto a *separate* Fugue positional layer — paying permanent per-element CRDT metadata for all formatted text.

**The thesis of this project, in one sentence:** the claim is refuted by **decomposition** — keep replay pure and state-independent (it only ever integrates zero-width *anchor* operations, never resolves anything), and push **all** of Peritext's order-dependent semantics into a **pure resolution function** computed at materialization. Replay never needs to be order-dependent because it never decides span membership; resolution is allowed to be order-dependent because it is a deterministic pure function of the final causal graph, computed identically on every replica.

> The Loro position is attributed honestly: it is a reasonable reading of Eg-walker's replay contract, and the contribution here is showing the contract can be *satisfied* by moving the order-dependent work out of replay rather than concluding it's impossible. This repo contrasts with — it does not disparage — Loro's engineering.

---

## 2. What it is

A document is edited through an append-only **op log** carrying six op kinds: `ins`, `del`, `markStart`, `markEnd`, and `blockBoundary` (marks are an open `markStart` + a matching `markEnd` referencing it by raw `(agent, seq)`). Materializing the log yields a **resolved snapshot**:

```ts
interface RichSnapshot {
  text:    string[]          // the visible characters
  spans:   { start, end, markType, value }[]   // resolved inline marks
  blocks:  { start, end, blockType }[]          // flat paragraph partition
  version: [agent, seq][]
}
```

The snapshot carries **zero per-character metadata** — it is O(document), not O(history). The CRDT machinery exists only in the append-only log and in a transient structure built during a checkout.

---

## 3. How it works

This describes the **final** architecture as implemented in `src/`. (The original design placed mark stickiness in replay via a "sticky-skip" during anchor placement; **that was removed** — the differential fuzzer proved it broke convergence, because a side-based cursor move reads the replica-dependent transient arrangement of concurrent not-yet-inserted anchors. Placement is now 100% pure base FugueMax, and *every* Peritext semantic lives in resolution. See `src/index.ts` `apply1` — there is no sticky-skip — and `src/resolve.ts`.)

Five layers:

```
  1. Causal graph        immutable event graph: (agent,seq) ids + parents
        │                (vendored from eg-walker-reference, unchanged)
        ▼
  2. Op log              ins | del | markStart | markEnd | blockBoundary
        │                marks/blocks are zero-width anchor ops in the log
        ▼
  3. Pure replay         base Eg-walker / FugueMax integration.
        │                anchors integrate as ZERO-WIDTH items exactly like
        │                text inserts — NO stickiness, NO order-dependence.
        │                (proven 0 engine self-divergence over >1e5 iters)
        ▼
  4. Pure resolution     a deterministic function (items + causal graph) ->
        │                spans + blocks. Computes EVERYTHING order-dependent:
        │                 · span start/end from each anchor's originLeft
        │                 · expand vs contract by per-mark policy
        │                 · paragraph-start mark inheritance
        │                 · per-position causal LWW (and multi for comments)
        │                 · flat block partition
        ▼
  5. Resolved snapshot   { text, spans, blocks } — O(document),
                         zero per-character metadata
```

The key move: **replay places anchors but never interprets them.** A `markStart`/`markEnd` is just a zero-width FugueMax item; its *resolved* position is recomputed at resolution from its immutable `originLeft` (the char to its left at integration time — a pure function of its prepare version) plus the causal graph, **not** from where FugueMax happened to drop the anchor item among concurrent boundary text. That is what makes resolution order-independent across replicas while remaining order-*aware* of the marks themselves. Expand/contract, paragraph-start inheritance, LWW conflict resolution, and the flat-block partition are all computed there as pure functions.

### Usage

```ts
// Reference artifact: import from the source modules (no npm package / exports map).
import {
  createOpLog, localInsert, localMark, localSplitBlock, mergeOplogInto,
} from './src/index.js'
import { checkoutRich } from './src/resolve.js'

// Replica A types a sentence, bolds a word, and starts a new paragraph.
const a = createOpLog<string>()
localInsert(a, 'alice', 0, ...'Hello brave world')
localMark(a, 'alice', 6, 11, 'bold')      // bold "brave"
localSplitBlock(a, 'alice', 17)           // paragraph break

// Replica B concurrently writes its own text and links part of it.
const b = createOpLog<string>()
localInsert(b, 'bob', 0, ...'see docs')
localMark(b, 'bob', 4, 8, 'link', 'https://example.com')

// Merge both ways — both replicas converge.
mergeOplogInto(a, b)
mergeOplogInto(b, a)

const snap = checkoutRich(a)
console.log(snap.text.join(''))   // "Hello brave worldsee docs"
console.log(snap.spans)
//  [ { start: 6,  end: 11, markType: 'bold', value: true },
//    { start: 21, end: 25, markType: 'link', value: 'https://example.com' } ]
console.log(snap.blocks)
//  [ { start: 0,  end: 17, blockType: 'paragraph' },
//    { start: 17, end: 25, blockType: 'paragraph' } ]
```

(This exact example is run and verified during development; the output above is its real output.)

---

## 4. The evidence

Full, reproducible evidence — every claim mapped to a runnable result — lives in **[EVIDENCE.md](EVIDENCE.md)** (generated by `scripts/gen-evidence.ts`, which exits non-zero if any test or the fuzzer fails). Summary:

### (a) Claims → evidence

| Claim | Statement (abridged) | Evidence |
| --- | --- | --- |
| **C1 Feasibility** | Peritext-semantics inline formatting runs on an event-graph replay engine (anchors inside replay + pure resolution outside). | the engine + `test/adversarial.test.ts`, `test/anchors.test.ts` |
| **C2 Intent preservation** | Passes Peritext Examples 1–8 and failure cases P1–P4, the tombstone-capture bug (peritext#32), and Yjs's orphaned-marker bug (yjs#197). | citation-named tests + the independent oracle |
| **C3 Memory shape** | Persistent state is O(document): snapshot with zero per-char metadata; anchors live only in the log + transient replay. | `bench/bench.ts` → `bench/results.json` |
| **C4 Convergence** | All replicas converge for arbitrary concurrent histories. | differential fuzzer vs an independent oracle |
| **C5 Flat-block semantics** | Concurrent paragraph split/merge + text edits have specified, tested merge behavior. | `test/blocks.test.ts`, block-convergence regression |

### (b) "Claims = test names" — the citation-named adversarial suite

Each published Peritext/Yjs failure case the design must guard against is an **executable, citation-named test** — `peritext_P1_concurrent_overlap_bold`, `peritext_P2_toggle_counting_dog`, `peritext_P4_unbounded_bleed`, `peritext_example1_concurrent_insert_inside_span`, `peritext_example4_color_lww`, `peritext_table1_overlapping_comments`, `peritext_issue32_tombstone_capture`, `yjs_197_orphaned_markers`. Each is asserted twice: once against the engine, once against the independent oracle.

### (c) Differential fuzzing vs an independent oracle

`test/rich-fuzzer.ts` drives replica pairs through random local edits and pairwise/full-mesh merges, comparing the engine against a **completely independent** reference — `SimpleRichDoc`, a different text CRDT with a Peritext-style side table of marks (it shares no code with the engine). Latest run:

- **Engine self-converged on 100% of iterations** (text + spans + blocks) across 28+ seed bases and >1e5 total iterations.
- **0 unclassified mark-resolution divergences.** Wherever the engine and oracle agreed on the full item order, mark/block resolution matched **exactly**.
- The only carve-out is a precisely-characterized **text-CRDT ordering variance** of the side-table oracle (concurrent-tombstone order / equal-letter swap) — each instance is logged, and **0** of them ever moved a resolved span or block. This is an honest limitation of the *oracle comparison*, not a mark bug.

Reproduce:

```sh
npm run evidence                          # build + suite + fuzz + bench, regenerates EVIDENCE.md
npm test                                  # 45 TAP points (44 pass, 1 expected slow-skip)
FUZZ_ITERS=10000 npm run fuzz:rich        # 10k-iteration differential fuzz
```

---

## 5. Benchmarks (honest framing)

Numbers in `bench/results.json`; the honesty framing is verbatim from `bench/bench.ts`. **Read this before reading any number:**

- Our engine is a **deliberately unoptimized TypeScript reference** — no run-length encoding, every op replayed in full on every checkout, naive causal traversal, and **no binary codec** (the durable artifact is `JSON.stringify(oplog)`).
- **We are SLOWER than Yjs and Automerge**, and our oplog-as-JSON is **LARGER** than their purpose-built binary codecs. This is expected and is **not** the claim — it measures a readable reference against years of Rust/WASM production engineering, not a property of the model. **We do not claim to beat them on speed or encoded size — we don't.**
- **The architectural point is memory *shape* (claim C3):** the persistent *read* form is an O(document) resolved snapshot `{text, spans, blocks}` carrying **zero** per-character CRDT metadata. On the bundled ~21k-char / 171-mark trace, that resolved snapshot is ~33 KB vs the ~1 MB full-history oplog — a point-in-time read form, not comparable to the libraries' full-history binary encodings.

This is what the model *costs*, measured honestly. Production optimization (RLE, a B-tree document index, a binary codec, lazy traversal) is future work.

---

## 6. Status & what's deferred

**This is a v1 reference implementation / research artifact. It is not production-ready.** Honesty about limits is a feature here.

**Documented v1 limitations:**
- **Boundary-deletion is not supported** (deleting across a block boundary in the specified way).
- The differential oracle has a carved-out **tombstone-order / equal-letter-swap variance** (above) — characterized, logged, never a mark/block move.
- The LWW per-position fold is **order-dependent in principle** for 3+ concurrent same-position spans; it is made replica-independent by folding in a canonical, replica-independent order (resolved `start`,`end`, then raw `(agent,seq)`). This is documented in `src/resolve.ts` as load-bearing for any port or oracle.

**Deferred to future work (design §9):**
- Nested blocks (only flat paragraph blocks in v1).
- Formal verification of the resolution function.
- An optimized / Rust port (RLE, B-tree index, binary codec, lazy traversal).
- A network sync protocol.
- Cursor / presence.
- History pruning / compaction.

---

## 7. Relation to prior work & attribution

- **eg-walker-reference** — the base plain-text engine (`src/causal-graph.ts`, the base of `src/index.ts`, `test/upstream/*`, `testdata/*`) is **vendored from [josephg/eg-walker-reference](https://github.com/josephg/eg-walker-reference)** by Joseph Gentle, **BSD-2-Clause**. `src/index.ts` is extended here; all other vendored files are unchanged except import paths. See [ATTRIBUTION.md](ATTRIBUTION.md) and [LICENSE.upstream](LICENSE.upstream).
- **Eg-walker** — Gentle & Kleppmann, EuroSys 2025, [arXiv:2409.14252](https://arxiv.org/abs/2409.14252).
- **Peritext** — Litt, Lim, Kleppmann & van Hardenberg, *Peritext: A CRDT for Collaborative Rich Text Editing*, Ink & Switch / CSCW 2022. The rich-text semantics here follow Peritext.
- **Fugue / FugueMax** — Weidner & Kleppmann, [arXiv:2305.00583](https://arxiv.org/abs/2305.00583); the maximal-non-interleaving sequence CRDT used for placement (equivalent here to YjsMod / Sync9).
- **Loro `crdt-richtext`** — the contrast case and the source of the refuted "Peritext cannot be modeled on Eg-walker" claim.
- **Yjs** — `yjs#197` (orphaned markers) is one of the guarded-against failure cases.

Our own code is **MIT** (see [LICENSE](LICENSE)) — upstream-compatible; vendored BSD-2-Clause code is attributed as above.
