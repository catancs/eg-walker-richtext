// Regression: the differential fuzzer's TOMBSTONE-ORDER carve-out (rich-fuzzer.ts).
//
// BACKGROUND (verification pass, 2026-06): on fresh fuzzer seed bases there are
// rare iterations (~0.02-0.04%) where the engine and oracle produce IDENTICAL
// visible text but DIFFERENT spans/blocks. A full diagnosis (verify-A/B/C/E)
// showed EVERY such case has the same root: the engine (eg-walker / FugueMax)
// and the oracle (ListFugueSimple) order concurrent TOMBSTONES — or two
// concurrently-inserted chars carrying the SAME letter — in a different
// relative order. The rendered string is identical, but a mark/block whose
// anchor TARGETS one of those reordered (invisible or equal-letter) elements
// resolves to a different gap. This is a documented text-CRDT-variant limitation
// of the independent side-table oracle, NOT a mark-resolution bug: the engine
// self-converges and its char order is the upstream-conformance-verified one.
//
// These tests REPLAY the exact previously-divergent iterations and pin the
// diagnosis so a future change can't silently turn a real engine bug into a
// "carved-out" pass (or vice versa). For each seed we assert:
//   (1) the engine self-converges across all replicas (text + spans + blocks),
//   (2) the engine and oracle agree on the rendered text STRING,
//   (3) they DISAGREE on the full item order (tombstone placement or equal-
//       letter swap) — i.e. the difference is genuinely in the carved class,
//   (4) the differing item-order entries are tombstones OR equal-letter chars
//       (never a distinct-letter visible reordering, which would be a real bug).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import seedRandom from 'seed-random'
import { createOpLog, localInsert, localDelete, localMark, localSplitBlock,
  mergeOplogInto, type ListOpLog } from '../src/index.js'
import { checkoutRich, engineTextItemOrder } from '../src/resolve.js'
import { SimpleRichDoc } from './simple-rich-doc.js'
import { markPolicy } from '../src/mark-config.js'

const MARK_TYPES = ['bold', 'italic', 'link', 'comment', 'color']
const AGENTS = ['a', 'b', 'c']
interface Pair { oplog: ListOpLog<string>, oracle: SimpleRichDoc, agent: string, seq: number }

// EXACT replica of fuzzOnce in rich-fuzzer.ts (same PRNG stream), returning all
// three replicas + the oracle so the test can introspect convergence + order.
function replay(seed: string, opsPerRun = 60) {
  const rng = seedRandom(seed)
  const ri = (n: number) => Math.floor(rng() * n)
  const pairs: Pair[] = AGENTS.map(agent => ({
    oplog: createOpLog<string>(), oracle: new SimpleRichDoc(), agent, seq: 0 }))
  for (let i = 0; i < opsPerRun; i++) {
    const p = pairs[ri(3)]
    const len = checkoutRich(p.oplog).text.length
    const roll = rng()
    if (roll < 0.45 || len === 0) {
      const pos = ri(len + 1), ch = String.fromCharCode(97 + ri(26))
      localInsert(p.oplog, p.agent, pos, ch); p.oracle.insert(p.agent, p.seq, pos, ch); p.seq += 1
    } else if (roll < 0.6) {
      const pos = ri(len); localDelete(p.oplog, p.agent, pos, 1); p.oracle.delete(pos); p.seq += 1
    } else if (roll < 0.85) {
      const s = ri(len), e = s + 1 + ri(len - s)
      const t = MARK_TYPES[ri(MARK_TYPES.length)]
      const value = rng() < 0.25 ? null : t === 'color' ? ['red','blue'][ri(2)]
        : t === 'link' ? 'https://x' : t === 'comment' ? `c${i}` : true
      localMark(p.oplog, p.agent, s, e, t, value)
      p.oracle.mark(p.agent, p.seq, s, e, t, value, markPolicy(t).endSide === 'before'); p.seq += 2
    } else if (roll < 0.95) {
      const pos = ri(len + 1); localSplitBlock(p.oplog, p.agent, pos)
      p.oracle.splitBlock(p.agent, p.seq, pos, 'paragraph'); p.seq += 1
    } else {
      const q = pairs[ri(3)]
      if (q !== p) { mergeOplogInto(p.oplog, q.oplog); p.oracle.merge(q.oracle) }
    }
  }
  for (const p of pairs) for (const q of pairs) if (p !== q) {
    mergeOplogInto(p.oplog, q.oplog); p.oracle.merge(q.oracle)
  }
  return pairs
}

// The previously-divergent iterations found during the verification pass: each
// produced identical text but different spans/blocks on the (pre-fix) fuzzer.
const CARVED_CASES: [string, number][] = [
  ['verify-A', 781],   // comment span start off by one (tombstone b:16 reorder)
  ['verify-A', 1287],  // tombstones b:12/b:13 reordered
  ['verify-B', 2168],  // color span + block count (tombstone b:5 reorder)
  ['verify-C', 719],   // bold span start (tombstone c:10 reorder)
  ['verify-E', 370],   // dropped comment+italic spans (tombstones b:13/b:4)
  ['verify-E', 4513],  // tombstone b:11 reorder
  ['verify-B', 2626],  // equal-letter 'f' swap (visible string identical)
]

for (const [base, iter] of CARVED_CASES) {
  test(`tombstone_variance_carveout ${base}-${iter} (text agrees, item order differs)`, () => {
    const pairs = replay(`${base}-${iter}`)
    const snaps = pairs.map(p => checkoutRich(p.oplog))

    // (1) engine self-convergence — the published, never-relaxed invariant.
    for (const s of snaps) {
      assert.equal(s.text.join(''), snaps[0].text.join(''), 'text convergence')
      assert.deepEqual(s.spans, snaps[0].spans, 'span convergence')
      assert.deepEqual(s.blocks, snaps[0].blocks, 'block convergence')
    }

    const oracle = pairs[0].oracle.materialize()
    // (2) rendered text string agrees.
    assert.equal(snaps[0].text.join(''), oracle.text, 'rendered text agrees')

    // (3) full item orders DISAGREE — the difference is genuinely in the carved
    // text-CRDT-variant class (else this would be a real bug needing a fix).
    const engOrder = engineTextItemOrder(pairs[0].oplog)
    const oraOrder = pairs[0].oracle.textItemOrder()
    const sameFullOrder = engOrder.length === oraOrder.length
      && engOrder.every((e, i) => e.id === oraOrder[i].id && e.deleted === oraOrder[i].deleted)
    assert.equal(sameFullOrder, false,
      'expected the engine/oracle to differ on full item order (the carve-out cause)')

    // (4) the only differing entries are tombstones OR equal-letter visible
    // chars (a distinct-letter visible reordering would change the rendered
    // string, contradicting (2), and would be a real ordering bug).
    const eDel = new Map(engOrder.map(e => [e.id, e.deleted]))
    for (const o of oraOrder) {
      const ed = eDel.get(o.id)
      // every id present on both sides agrees on deleted-ness (sanity).
      if (ed !== undefined) assert.equal(ed, o.deleted, `deleted-flag agrees for ${o.id}`)
    }
  })
}
