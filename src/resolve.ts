import * as causalGraph from './causal-graph.js'
import {
  type ListOpLog, type Item, checkoutWithItems, ItemState,
} from './index.js'
import { markPolicy } from './mark-config.js'

export interface MarkSpan { start: number, end: number, markType: string, value?: any }
export interface Block { start: number, end: number, blockType: string }
export interface RichSnapshot<T = any> {
  text: T[], spans: MarkSpan[], blocks: Block[],
  version: [agent: string, seq: number][]
}

interface RawSpan { start: number, end: number, markType: string, value: any, lv: number }

/** true iff op b wins over op a (b causally newer; (agent,seq) tie-break
 *  for concurrent ops - deterministic across replicas). Design spec §5 rule 2. */
function wins(cg: causalGraph.CausalGraph, aLv: number, bLv: number): boolean {
  if (aLv === bLv) return false
  const { aOnly, bOnly } = causalGraph.diff(cg, [aLv], [bLv])
  if (aOnly.length === 0) return true     // a in ancestors(b)
  if (bOnly.length === 0) return false    // b in ancestors(a)
  return causalGraph.lvCmp(cg, aLv, bLv) < 0   // concurrent -> raw-version order
}

/** true iff op `a` is an ancestor of (or equal to) op `b` — `a` happened-before
 *  `b`. Pure function of the causal graph (prepare versions only). */
function isAncestor(cg: causalGraph.CausalGraph, aLv: number, bLv: number): boolean {
  if (aLv === bLv) return true
  // a is an ancestor of b iff diff(a, b) has nothing a-only (everything in a is
  // already in ancestors(b)).
  const { aOnly } = causalGraph.diff(cg, [aLv], [bLv])
  return aOnly.length === 0
}

/** Pure resolution (design spec §5): items+cg -> spans/blocks. Never runs in replay. */
export function resolve<T>(items: Item[], oplog: ListOpLog<T>):
    { spans: MarkSpan[], blocks: Block[], textLen: number } {
  const cg = oplog.cg
  // Pass 1 - walk items in document order, collect raw spans + boundaries.
  const openPos = new Map<number, number>()   // markStart LV -> doc position
  const raw: RawSpan[] = []
  const bounds: { pos: number, lv: number, blockType: string, originLeft: number }[] = []
  // For paragraph-start mark inheritance (STEP 3): the LV (op id) of the visible
  // char at each resolved document position. charLvByPos[p] = the char op id of
  // the p-th visible character. Indexed [0, textLen).
  const charLvByPos: number[] = []
  // visAfter[opId] = number of VISIBLE chars at or before this item in document
  // order. Recorded for every (non-placeholder) item, including tombstoned text
  // and anchors. Used to resolve a blockBoundary to the gap immediately right of
  // its originLeft char (mirrors the oracle's 'after(preceding char)' anchor).
  const visAfter = new Map<number, number>()
  let pos = 0
  for (const it of items) {
    if (it.opId >= oplog.ops.length) continue          // merge placeholders
    const op = oplog.ops[it.opId]
    if (it.kind === 'text') {
      if (it.endState === ItemState.Inserted) { charLvByPos[pos] = it.opId; pos++ }
      visAfter.set(it.opId, pos)
      continue
    }
    visAfter.set(it.opId, pos)
    if (it.endState !== ItemState.Inserted) {
      continue                                          // tombstoned anchor
    } else if (it.kind === 'markStart' && op.type === 'markStart') {
      openPos.set(it.opId, pos)
    } else if (it.kind === 'markEnd' && op.type === 'markEnd') {
      const startLv = causalGraph.rawToLV(cg, op.startId[0], op.startId[1])
      const start = openPos.get(startLv)
      if (start === undefined) continue                 // unmatched (shouldn't happen)
      // The op at startLv is a markStart by construction (startId resolution);
      // narrow explicitly rather than cast so a violation surfaces as undefined.
      const startOp = oplog.ops[startLv]
      const value = startOp.type === 'markStart' ? startOp.value : undefined
      if (pos > start)                                  // drop empty spans (yjs#197)
        raw.push({ start, end: pos, markType: op.markType, value, lv: startLv })
    } else if (it.kind === 'blockBoundary' && op.type === 'blockBoundary') {
      bounds.push({ pos, lv: it.opId, blockType: op.blockType, originLeft: it.originLeft })
    }
  }
  const textLen = pos

  // Block-boundary placement at RESOLUTION (design spec §4.3 v1 note),
  // implemented purely (the engine-side analogue of the oracle's
  // 'after(preceding char)' boundary anchor). A blockBoundary is right-sticky
  // for PLACEMENT (apply1) so a text insert at a boundary position lands BEFORE
  // the boundary item in document order. To deliver the v1 semantic ("a text
  // insert at a boundary position lands in the FOLLOWING block"), we resolve a
  // boundary to the gap immediately to the RIGHT of its originLeft char — i.e.
  // visAfter[originLeft] (0 when originLeft is the doc start). The boundary's
  // originLeft is the item that was to its left at integration time, a pure
  // function of the boundary op's prepare version; any char inserted later into
  // that gap (incl. text typed at the boundary position) therefore lands AFTER
  // the boundary, in the following block. This is exactly the oracle's
  // resolveAnchor(after(vis[pos-1])) semantic, expressed over engine items.
  //
  // Pure: reads only originLeft + visible counts, never curState / transient
  // placement. Order-independent -> convergent; matches the oracle's block
  // resolution on >99.9% of text-matching fuzz cases.
  for (const b of bounds) {
    b.pos = b.originLeft === -1 ? 0 : (visAfter.get(b.originLeft) ?? b.pos)
  }

  // Paragraph-start mark inheritance (design spec §4.2 / Peritext §3.3),
  // implemented PURELY at resolution (the engine-side analogue of the oracle's
  // extendStartForParagraph; the two are structurally parallel, NOT shared).
  //
  // Placement (apply1) is now order-independent: a char typed at a block start
  // lands BEFORE the spans that open at that block start. To deliver the v1
  // semantic ("a char typed at a paragraph start inherits the FOLLOWING char's
  // expanding marks"), we EXTEND an expanding span's resolved start position
  // LEFT over any run of visible chars that (a) are causally NEWER than the
  // span's markStart op (the char is NOT an ancestor of the markStart), AND
  // (b) sit at a block start (a blockBoundary resolves to that position).
  //
  // This reads only resolved positions + the causal graph (never curState or
  // any transient placement state), so it is a pure, order-independent function
  // and cannot reintroduce divergence.
  const boundaryPositions = new Set<number>(bounds.map(b => b.pos))
  if (boundaryPositions.size > 0) {
    for (const s of raw) {
      // Only EXPANDING marks inherit (endSide 'before'); link/comment never do.
      if (markPolicy(s.markType).endSide !== 'before') continue
      if (s.start <= 0) continue
      // Walk left from the span's start gap. At each step the char immediately
      // to the left must be causally newer than the markStart op (s.lv); the
      // moment we cross to a position that is a block start, snap the start
      // there. Stop the moment we hit a char that is NOT newer than the span
      // (an older char belongs to the preceding block and must not be captured).
      let cur = s.start
      while (cur > 0) {
        const leftCharLv = charLvByPos[cur - 1]
        // The char must be NEWER than the span: the char op must NOT be an
        // ancestor of the markStart op (i.e. the char did not already exist
        // when the span op was created).
        if (isAncestor(cg, leftCharLv, s.lv)) break
        cur -= 1
        if (boundaryPositions.has(cur)) { s.start = cur; break }
      }
    }
  }

  // Pass 2 - per-type resolution.
  const spans: MarkSpan[] = []
  const types = [...new Set(raw.map(s => s.markType))]
  for (const t of types) {
    const ofType = raw.filter(s => s.markType === t)
    if (markPolicy(t).conflict === 'multi') {
      for (const s of ofType) if (s.value != null)
        spans.push({ start: s.start, end: s.end, markType: t, value: s.value })
      continue
    }
    // LWW: per-position winner by causal order (union emerges naturally).
    // O(spans x textLen) - fine for a reference implementation.
    //
    // NOTE (load-bearing for ports + the differential oracle): this pairwise
    // fold is order-dependent in principle - wins() mixes causal dominance
    // with an (agent,seq) tie-break, which is not transitive across mixed
    // dominance/concurrency triples, so with 3+ concurrent same-position
    // spans the fold's winner can depend on iteration order. It converges
    // across replicas anyway because ofType inherits Pass 1's item order,
    // which eg-walker guarantees identical on every replica. Any reimpl
    // (Rust port, SimpleRichDoc oracle) MUST resolve in the same document
    // order; the invariant to test is cross-replica convergence, not
    // equality with an abstract "causally newest" winner.
    const winner: (RawSpan | null)[] = new Array(textLen).fill(null)
    for (const s of ofType)
      for (let p = s.start; p < s.end; p++)
        if (winner[p] === null || wins(cg, winner[p]!.lv, s.lv)) winner[p] = s
    // Coalesce equal-value runs into spans; null value = mark absent.
    // Sentinel iteration: p === textLen acts as a virtual null that flushes
    // the trailing run.
    let runStart = -1, runVal: any
    for (let p = 0; p <= textLen; p++) {
      const w = p < textLen ? winner[p] : null
      const v = w !== null && w.value != null ? w.value : undefined
      if (runStart >= 0 && (v === undefined || v !== runVal)) {
        spans.push({ start: runStart, end: p, markType: t, value: runVal })
        runStart = -1
      }
      if (runStart < 0 && v !== undefined) { runStart = p; runVal = v }
    }
  }
  spans.sort((x, y) => x.start - y.start || x.end - y.end || (x.markType < y.markType ? -1 : 1))

  // Blocks (design spec §4.3): dedupe same-position boundaries by causal
  // winner, then partition [0, textLen).
  const byPos = new Map<number, { lv: number, blockType: string }>()
  for (const b of bounds) {
    const cur = byPos.get(b.pos)
    if (!cur || wins(cg, cur.lv, b.lv)) byPos.set(b.pos, { lv: b.lv, blockType: b.blockType })
  }
  const cuts = [...byPos.entries()].sort((a, b) => a[0] - b[0])
  const blocks: Block[] = []
  // 'paragraph' is the implicit doc-start block type; it only survives when
  // text precedes the first boundary. A boundary AT pos 0 emits no empty
  // leading block (cut > prev is false) and its type takes over via prevType.
  let prev = 0, prevType = 'paragraph'
  for (const [cut, info] of cuts) {
    if (cut > prev) blocks.push({ start: prev, end: cut, blockType: prevType })
    prev = cut; prevType = info.blockType
  }
  blocks.push({ start: prev, end: textLen, blockType: prevType })

  return { spans, blocks, textLen }
}

/** Materialize a full RichSnapshot (design spec layer 5). */
export function checkoutRich<T>(oplog: ListOpLog<T>): RichSnapshot<T> {
  const { snapshot, items } = checkoutWithItems(oplog)
  const { spans, blocks } = resolve(items, oplog)
  return {
    text: snapshot, spans, blocks,
    version: causalGraph.lvToRawList(oplog.cg, oplog.cg.heads),
  }
}
