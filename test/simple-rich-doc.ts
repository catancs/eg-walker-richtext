// SimpleRichDoc — the independent differential-testing ORACLE (Task 7).
//
// PURPOSE
// -------
// A deliberately naive reference model for the eg-walker-richtext engine,
// INDEPENDENT BY CONSTRUCTION so that differential fuzzing (Task 8) is real
// evidence and not a tautology:
//   - Different text CRDT: the vendored ListFugueSimple (Fugue), NOT the
//     engine's eg-walker item list.
//   - Different mark mechanism: a Peritext-style SIDE TABLE whose spans/blocks
//     anchor to CHARACTER IDENTITIES, NOT zero-width anchors integrated as
//     list items (which is how the engine does it).
//   - Different causal machinery: a hand-rolled grow-only parents map with
//     naive O(n) happened-before walks, NOT the engine's CausalGraph.
// The RESOLVED SEMANTICS are identical and pinned by the engine's 20 green
// tests; materialize() output format matches RichSnapshot exactly.
//
// FOLD ORDER (oracle design point 1)
// ----------------------------------
// The engine's per-position LWW winner-fold is order-dependent in principle:
// wins() mixes causal dominance with an (agent,seq) tie-break, which is not
// transitive across mixed dominance/concurrency triples, so with 3+ concurrent
// same-position valued spans the fold's winner can depend on iteration order.
// The engine folds in `raw` order = document order of markEnd anchors (Pass-1
// walk in resolve.ts). We MIRROR that: each span's fold key is the resolved
// document position of its END anchor's gap (walking our fugue, tombstones
// included), tie-broken by (agent,seq). This reproduces the engine's fold order
// for every case where the end-anchor positions differ. RESIDUAL RISK: when two
// concurrent spans of one type close at the EXACTLY same resolved gap, the
// engine's order is the fugue integration order of the two markEnd ANCHOR items
// — which we cannot reproduce bit-for-bit without integrating anchors into the
// fugue (forbidden by the "side table, not anchors-as-items" mandate). We fall
// back to (agent,seq) there. This only bites intransitive 3+-concurrent triples
// that also share an exact end gap — vanishingly rare; documented for Task 8.
//
// PARAGRAPH-START EQUIVALENCE (oracle design point 6)
// ---------------------------------------------------
// A span START anchored ('before', charB) covers [charB, ...). A char X typed
// at the block-start position lands BEFORE charB in fugue order, so naive
// Peritext leaves X OUTSIDE the span — CONFLICT with the engine, which (at
// insert time) skips text past the whole anchor cluster at a paragraph start so
// X lands INSIDE spans opening at the block start. We reproduce the engine's
// OBSERVABLE result at MATERIALIZE time: after resolving a span's start gap, we
// extend it BACKWARD over any run of visible chars that (a) sit immediately
// before the span's first covered char, (b) lie at the very start of a block
// (i.e. a block boundary resolves to the span's original start position), and
// (c) were inserted strictly AFTER the span op (causally — they are not in the
// span op's parents). This is exactly the set the engine captures via its
// paragraph-start skip, and nothing else. Only expanding (endSide 'before')
// marks expand; non-expanding marks (link/comment) never do. See the
// block_paragraph_start_exception validation test.

import { ListFugueSimple, type ID } from './upstream/list-fugue-simple.js'

// ----- causal tracking (independent of the engine's CausalGraph) -----

type OpId = string // `${agent}:${seq}`
const oid = (agent: string, seq: number): OpId => `${agent}:${seq}`

// ----- side-table op shapes -----

type Anchor =
  | { kind: 'docStart' }
  | { kind: 'docEnd' }
  | { kind: 'before'; id: ID }   // gap immediately before char `id`
  | { kind: 'after'; id: ID }    // gap immediately after char `id`

interface MarkOp {
  agent: string
  seq: number
  markType: string
  value: any
  start: Anchor
  end: Anchor
  expandEnd: boolean
  // original creation-time positions (used by the paragraph-start rule)
  startPos: number
}

interface BlockOp {
  agent: string
  seq: number
  blockType: string
  at: Anchor
}

// char payload stored in the fugue
interface Ch { ch: string }

// ----- mark policy (mirrors src/mark-config.ts; kept local for independence) -----

const MULTI_TYPES = new Set(['comment'])
const isMulti = (t: string) => MULTI_TYPES.has(t)

export class SimpleRichDoc {
  private fugue = new ListFugueSimple<Ch>('_oracle_')
  private marks: MarkOp[] = []
  private blocks: BlockOp[] = []

  // grow-only causal store: opId -> set of ancestor opIds (its parents, then
  // transitively closed lazily). We record the FRONTIER each op observed.
  private parents = new Map<OpId, OpId[]>()
  private frontier: OpId[] = []        // current set of heads (this replica)
  private known = new Set<OpId>()      // every op id this replica has seen

  // ---- helpers ----

  private record(id: OpId) {
    if (this.known.has(id)) return
    this.parents.set(id, this.frontier.slice())
    this.known.add(id)
    this.frontier = [id]   // a local linear op dominates the prior frontier
  }

  // transitive happened-before: is `a` an ancestor of (or equal to) `b`?
  private hb(a: OpId, b: OpId): boolean {
    if (a === b) return true
    const seen = new Set<OpId>()
    const stack = [...(this.parents.get(b) ?? [])]
    while (stack.length) {
      const x = stack.pop()!
      if (x === a) return true
      if (seen.has(x)) continue
      seen.add(x)
      for (const p of this.parents.get(x) ?? []) stack.push(p)
    }
    return false
  }

  private concurrent(a: OpId, b: OpId): boolean {
    return a !== b && !this.hb(a, b) && !this.hb(b, a)
  }

  // wins(): true iff op b wins over op a. Causal dominance first; (agent,seq)
  // tie-break for concurrent (lexicographically GREATER wins — matches the
  // engine: 'b' > 'a'). Mirrors resolve.ts wins().
  private wins(a: OpId, b: OpId): boolean {
    if (a === b) return false
    if (this.hb(a, b)) return true    // a is ancestor of b -> b newer
    if (this.hb(b, a)) return false
    // concurrent: raw (agent,seq) order, greater wins
    return this.cmpRaw(a, b) < 0
  }

  private cmpRaw(a: OpId, b: OpId): number {
    const [aa, as] = a.split(':'); const [ba, bs] = b.split(':')
    if (aa !== ba) return aa < ba ? -1 : 1
    return Number(as) - Number(bs)
  }

  // Walk fugue items (linked list) in document order INCLUDING tombstones.
  // Returns array of { id, ch, deleted } in order.
  private items(): { id: ID; ch: string; deleted: boolean }[] {
    const out: { id: ID; ch: string; deleted: boolean }[] = []
    // The fugue exposes start/end + linked list via .right; walk it.
    let elt: any = (this.fugue as any).start.right
    const end: any = (this.fugue as any).end
    while (elt && elt !== end) {
      out.push({ id: elt.id, ch: elt.value ? elt.value.ch : '', deleted: elt.isDeleted })
      elt = elt.right
    }
    return out
  }

  private idEq(a: ID, b: ID): boolean {
    return a.sender === b.sender && a.counter === b.counter
  }

  // ---- public API ----

  insert(agent: string, seq: number, pos: number, content: string): void {
    for (let i = 0; i < content.length; i++) {
      const id = oid(agent, seq + i)
      this.fugue.insertOneWithReplica(agent, seq + i, pos + i, { ch: content[i] })
      this.record(id)
    }
  }

  delete(pos: number): void {
    // single char; no op id (deletes do not participate in LWW resolution here,
    // matching the engine: deletion only tombstones text, never marks/blocks).
    this.fugue.delete(pos, 1)
  }

  mark(agent: string, seq: number, start: number, end: number,
       markType: string, value: any, expandEnd: boolean): void {
    const id = oid(agent, seq)
    // resolve start/end anchors against the CURRENT visible text.
    const vis = this.items().filter(it => !it.deleted)
    const len = vis.length

    // START: 'before' the char at index `start` (docEnd if start==length).
    const start_: Anchor = start >= len
      ? { kind: 'docEnd' }
      : { kind: 'before', id: vis[start].id }

    // END: expanding -> 'before' char at index `end` (docEnd if end==length).
    //      non-expanding -> 'after' char at index `end-1` (docStart if end==0).
    let end_: Anchor
    if (expandEnd) {
      end_ = end >= len ? { kind: 'docEnd' } : { kind: 'before', id: vis[end].id }
    } else {
      end_ = end <= 0 ? { kind: 'docStart' } : { kind: 'after', id: vis[end - 1].id }
    }

    this.marks.push({ agent, seq, markType, value, start: start_, end: end_, expandEnd, startPos: start })
    this.record(id)
  }

  splitBlock(agent: string, seq: number, pos: number, blockType: string): void {
    // The engine's blockBoundary is right-sticky, BUT text typed at the
    // boundary position skips PAST it (the paragraph-start rule applies to the
    // boundary itself), so a char inserted at the boundary position always
    // lands AFTER the boundary (in the following block). The equivalent
    // side-table anchor is therefore 'after' the PRECEDING char (docStart at
    // pos 0): insertions at the boundary gap land after the preceding char and
    // thus after the boundary, never before it. This reproduces both
    // block_text_insert_at_boundary_lands_in_following_block and the
    // paragraph-start exception. (See oracle design point 5.)
    const id = oid(agent, seq)
    const vis = this.items().filter(it => !it.deleted)
    const at: Anchor = pos <= 0
      ? { kind: 'docStart' }
      : { kind: 'after', id: vis[pos - 1].id }
    this.blocks.push({ agent, seq, blockType, at })
    this.record(id)
  }

  merge(other: SimpleRichDoc): void {
    // union fugue states
    this.fugue.mergeFrom(other.fugue)
    // union mark/block op sets (dedupe by (agent,seq))
    const mk = new Set(this.marks.map(m => oid(m.agent, m.seq)))
    for (const m of other.marks) if (!mk.has(oid(m.agent, m.seq))) this.marks.push(m)
    const bk = new Set(this.blocks.map(b => oid(b.agent, b.seq)))
    for (const b of other.blocks) if (!bk.has(oid(b.agent, b.seq))) this.blocks.push(b)
    // union causal store
    for (const [k, v] of other.parents) if (!this.parents.has(k)) this.parents.set(k, v.slice())
    for (const k of other.known) this.known.add(k)
    // frontier union, then strip dominated heads
    const union = [...new Set([...this.frontier, ...other.frontier])]
    this.frontier = union.filter(h => !union.some(o => o !== h && this.hb(h, o)))
  }

  // ---- materialization ----

  // Resolve an anchor to a GAP position (index among VISIBLE chars). Walk the
  // fugue items including tombstones; tombstones resolve to the position they
  // occupied (= index of the next visible char after them).
  private resolveAnchor(a: Anchor, items: { id: ID; ch: string; deleted: boolean }[]): number {
    if (a.kind === 'docStart') return 0
    if (a.kind === 'docEnd') return items.filter(it => !it.deleted).length
    // find the target char's index in the item list
    let visPos = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (a.kind === 'before' && this.idEq(it.id, a.id)) {
        // gap before this char = current visible position
        return visPos
      }
      if (a.kind === 'after' && this.idEq(it.id, a.id)) {
        // gap after this char: if alive, visPos+1; if dead, the position it
        // would occupy = visPos (next visible char's index)
        return it.deleted ? visPos : visPos + 1
      }
      if (!it.deleted) visPos++
    }
    // target not found (shouldn't happen) -> end
    return visPos
  }

  materialize(): {
    text: string
    spans: { start: number; end: number; markType: string; value: any }[]
    blocks: { start: number; end: number; blockType: string }[]
  } {
    const items = this.items()
    const vis = items.filter(it => !it.deleted)
    const text = vis.map(it => it.ch).join('')
    const textLen = vis.length

    // ----- raw spans -----
    interface RawSpan {
      start: number; end: number; markType: string; value: any
      id: OpId; foldKey: number
    }
    const raw: RawSpan[] = []
    for (const m of this.marks) {
      let s = this.resolveAnchor(m.start, items)
      const e = this.resolveAnchor(m.end, items)
      // paragraph-start backward extension (expanding marks only)
      if (m.expandEnd) s = this.extendStartForParagraph(m, s, items, vis)
      if (e > s) {
        raw.push({
          start: s, end: e, markType: m.markType, value: m.value,
          id: oid(m.agent, m.seq), foldKey: e,
        })
      }
    }

    // ----- per-type resolution -----
    const spans: { start: number; end: number; markType: string; value: any }[] = []
    const types = [...new Set(raw.map(s => s.markType))]
    for (const t of types) {
      const ofType = raw.filter(s => s.markType === t)
      if (isMulti(t)) {
        for (const s of ofType) if (s.value != null)
          spans.push({ start: s.start, end: s.end, markType: t, value: s.value })
        continue
      }
      // LWW per-position winner, folded in document order of the END anchor
      // (foldKey), tie-broken by (agent,seq). See FOLD ORDER note at top.
      const sorted = ofType.slice().sort((x, y) =>
        x.foldKey - y.foldKey || this.cmpRaw(x.id, y.id))
      const winner: (RawSpan | null)[] = new Array(textLen).fill(null)
      for (const s of sorted)
        for (let p = s.start; p < s.end; p++)
          if (winner[p] === null || this.wins(winner[p]!.id, s.id)) winner[p] = s
      // coalesce equal-value runs; null value = mark absent
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
    spans.sort((x, y) =>
      x.start - y.start || x.end - y.end || (x.markType < y.markType ? -1 : 1))

    // ----- blocks -----
    const byPos = new Map<number, { id: OpId; blockType: string }>()
    for (const b of this.blocks) {
      const pos = this.resolveAnchor(b.at, items)
      const id = oid(b.agent, b.seq)
      const cur = byPos.get(pos)
      if (!cur || this.wins(cur.id, id)) byPos.set(pos, { id, blockType: b.blockType })
    }
    const cuts = [...byPos.entries()].sort((a, b) => a[0] - b[0])
    const blocks: { start: number; end: number; blockType: string }[] = []
    let prev = 0, prevType = 'paragraph'
    for (const [cut, info] of cuts) {
      if (cut > prev) blocks.push({ start: prev, end: cut, blockType: prevType })
      prev = cut; prevType = info.blockType
    }
    blocks.push({ start: prev, end: textLen, blockType: prevType })

    return { text, spans, blocks }
  }

  // Paragraph-start backward extension. Given an expanding span `m` whose start
  // gap resolved to `s`, extend `s` left over any run of visible chars that:
  //   (a) were inserted AFTER the span op (concurrent or descendant — i.e. the
  //       span op did NOT happen-before... actually: char op is NOT an ancestor
  //       of the span op, so the char is "new" relative to the span), and
  //   (b) sit at the very start of a block — there is a block boundary that
  //       resolves to a position <= the char's position and there is no visible
  //       char between the boundary and the span's original first char that is
  //       OLDER than the span.
  // Concretely: we walk left from gap `s` while the char just left of the gap
  // is (i) newer than the span and (ii) the immediately-preceding boundary sits
  // right there. This captures exactly the engine's paragraph-start skip.
  private extendStartForParagraph(
    m: MarkOp,
    s: number,
    items: { id: ID; ch: string; deleted: boolean }[],
    vis: { id: ID; ch: string; deleted: boolean }[],
  ): number {
    if (s <= 0) return s
    const spanId = oid(m.agent, m.seq)
    // boundary positions present in the doc
    const boundaryPositions = new Set<number>()
    for (const b of this.blocks) boundaryPositions.add(this.resolveAnchor(b.at, items))

    let cur = s
    while (cur > 0) {
      const leftChar = vis[cur - 1]
      const charId = oid(leftChar.id.sender, leftChar.id.counter)
      // char must be NEWER than the span (span did not exist when char created):
      // the char op must NOT be an ancestor of the span op.
      const charIsNew = !this.hb(charId, spanId)
      if (!charIsNew) break
      // there must be a block boundary at position `cur-1` (the char sits at a
      // block start) OR a boundary somewhere strictly left that we keep crossing
      // only over new chars until we hit the boundary.
      cur -= 1
      if (boundaryPositions.has(cur)) return cur
    }
    // no boundary reached -> no extension (revert)
    return s
  }
}
