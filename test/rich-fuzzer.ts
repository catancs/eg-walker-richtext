// Differential fuzzer (design spec §7 D1). Each iteration drives 3 replica
// pairs (engine oplog + SimpleRichDoc oracle) through random local edits and
// random pairwise merges, then full-mesh merges and asserts:
//   (a) all engine replicas converge on {text, spans, blocks}
//   (b) engine output === oracle output
//   (c) invariants: spans sorted/within-bounds/non-empty; blocks partition
//       the text; no span survives whose text is fully deleted.
import seedRandom from 'seed-random'
import assert from 'node:assert/strict'
import { createOpLog, localInsert, localDelete, localMark, localSplitBlock,
  mergeOplogInto, type ListOpLog } from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'
import { SimpleRichDoc } from './simple-rich-doc.js'
import { markPolicy } from '../src/mark-config.js'

const MARK_TYPES = ['bold', 'italic', 'link', 'comment', 'color']
const AGENTS = ['a', 'b', 'c']

interface Pair { oplog: ListOpLog<string>, oracle: SimpleRichDoc, agent: string, seq: number }

function fuzzOnce(seed: string, opsPerRun = 60) {
  const rng = seedRandom(seed)
  const ri = (n: number) => Math.floor(rng() * n)
  const pairs: Pair[] = AGENTS.map(agent => ({
    oplog: createOpLog<string>(), oracle: new SimpleRichDoc(), agent, seq: 0 }))

  for (let i = 0; i < opsPerRun; i++) {
    const p = pairs[ri(3)]
    const len = checkoutRich(p.oplog).text.length
    const roll = rng()
    if (roll < 0.45 || len === 0) {                       // insert
      const pos = ri(len + 1), ch = String.fromCharCode(97 + ri(26))
      localInsert(p.oplog, p.agent, pos, ch)
      p.oracle.insert(p.agent, p.seq, pos, ch); p.seq += 1
    } else if (roll < 0.6) {                              // delete
      const pos = ri(len)
      localDelete(p.oplog, p.agent, pos, 1)
      p.oracle.delete(pos)
      p.seq += 1
    } else if (roll < 0.85) {                             // mark / negate
      const s = ri(len), e = s + 1 + ri(len - s)
      const t = MARK_TYPES[ri(MARK_TYPES.length)]
      const value = rng() < 0.25 ? null
        : t === 'color' ? ['red','blue'][ri(2)]
        : t === 'link' ? 'https://x' : t === 'comment' ? `c${i}` : true
      localMark(p.oplog, p.agent, s, e, t, value)
      p.oracle.mark(p.agent, p.seq, s, e, t, value,
        markPolicy(t).endSide === 'before')
      p.seq += 2                                          // markStart + markEnd
    } else if (roll < 0.95) {                             // block split
      const pos = ri(len + 1)
      localSplitBlock(p.oplog, p.agent, pos)
      p.oracle.splitBlock(p.agent, p.seq, pos, 'paragraph'); p.seq += 1
    } else {                                              // random pairwise merge
      const q = pairs[ri(3)]
      if (q !== p) {
        mergeOplogInto(p.oplog, q.oplog); p.oracle.merge(q.oracle)
      }
    }
  }
  // Full mesh merge, then compare everything.
  for (const p of pairs) for (const q of pairs) if (p !== q) {
    mergeOplogInto(p.oplog, q.oplog); p.oracle.merge(q.oracle)
  }
  const snaps = pairs.map(p => checkoutRich(p.oplog))
  const oracle = pairs[0].oracle.materialize()
  for (const s of snaps) {
    assert.equal(s.text.join(''), snaps[0].text.join(''), `text convergence (seed ${seed})`)
    assert.deepEqual(s.spans, snaps[0].spans, `span convergence (seed ${seed})`)
    assert.deepEqual(s.blocks, snaps[0].blocks, `block convergence (seed ${seed})`)
    for (const sp of s.spans) assert.ok(sp.start < sp.end && sp.end <= s.text.length,
      `span bounds (seed ${seed})`)
    assert.ok(s.blocks.length > 0 && s.blocks[0].start === 0
      && s.blocks.at(-1)!.end === s.text.length, `blocks partition (seed ${seed})`)
  }
  assert.equal(snaps[0].text.join(''), oracle.text, `oracle text (seed ${seed})`)
  assert.deepEqual(snaps[0].spans, oracle.spans, `oracle spans (seed ${seed})`)
  assert.deepEqual(snaps[0].blocks, oracle.blocks, `oracle blocks (seed ${seed})`)
}

const ITERS = parseInt(process.env.FUZZ_ITERS ?? '10000')
const BASE = process.env.FUZZ_SEED ?? 'egwrt-1'
console.log(`rich-fuzzer: ${ITERS} iterations, seed base "${BASE}"`)
for (let i = 0; i < ITERS; i++) {
  if (i % 1000 === 0 && i > 0) console.log(`  ...${i}`)
  fuzzOnce(`${BASE}-${i}`)
}
console.log(`rich-fuzzer: PASS (${ITERS} iterations, seeds ${BASE}-0..${ITERS - 1})`)
