// Differential-fuzzer convergence finding (Task 8), pinned deterministically.
//
// STATUS: KNOWN-FAILING (test.todo). This reproduces a REAL pre-existing engine
// convergence bug surfaced by test/rich-fuzzer.ts on its very first seed. It is
// recorded here as an executable, deterministic repro so the finding is not
// lost and so a fix can be validated against it. It is `test.todo` so the green
// suite stays green while the bug is open — flip it to `test(...)` once fixed.
//
// ROOT CAUSE (see the long analysis in the Task-8 report):
// The paragraph-start text-skip in apply1() (src/index.ts) decides whether a
// text insert lands INSIDE the spans/block that open at a block start by
// scanning the item list at REPLAY time using each item's transient `curState`.
// That makes the resolved `originLeft`/`rightParent` of a text insert depend on
// the replica-local LV order in which CONCURRENT, not-yet-inserted block
// boundaries happen to be materialised in the list — which is NOT a function of
// the op's parent version. Two replicas that observed the concurrent ops in
// different orders therefore compute different metadata for the SAME op and the
// engine's `{text}` DIVERGES across replicas (violating eg-walker's core
// convergence guarantee, design doc §3/§4.2/§4.3). The divergence is purely in
// the engine; the SimpleRichDoc oracle is not involved (this is replica-vs-
// replica text disagreement, caught before the oracle comparison).
//
// Confirmed (Task 8) that disabling ONLY the paragraph-start branch of the skip
// makes all engine replicas reconverge — isolating that branch as the cause.
//
// Minimal deterministic driver: replay fuzzer seed "egwrt-1-0" (60 ops over 3
// replicas with mid-run pairwise merges), then full-mesh merge and check that
// all engine replicas agree on text. See test/rich-fuzzer.ts for the generator.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import seedRandom from 'seed-random'
import { createOpLog, localInsert, localDelete, localMark, localSplitBlock,
  mergeOplogInto, type ListOpLog } from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'
import { markPolicy } from '../src/mark-config.js'

const MARK_TYPES = ['bold', 'italic', 'link', 'comment', 'color']
const AGENTS = ['a', 'b', 'c']
interface Rep { oplog: ListOpLog<string>, agent: string, seq: number }

function drive(seed: string, opsPerRun = 60): string[] {
  const rng = seedRandom(seed)
  const ri = (n: number) => Math.floor(rng() * n)
  const reps: Rep[] = AGENTS.map(agent => ({ oplog: createOpLog<string>(), agent, seq: 0 }))
  for (let i = 0; i < opsPerRun; i++) {
    const p = reps[ri(3)]
    const len = checkoutRich(p.oplog).text.length
    const roll = rng()
    if (roll < 0.45 || len === 0) {
      const pos = ri(len + 1), ch = String.fromCharCode(97 + ri(26))
      localInsert(p.oplog, p.agent, pos, ch); p.seq += 1
    } else if (roll < 0.6) {
      localDelete(p.oplog, p.agent, ri(len), 1); p.seq += 1
    } else if (roll < 0.85) {
      const s = ri(len), e = s + 1 + ri(len - s)
      const t = MARK_TYPES[ri(MARK_TYPES.length)]
      const value = rng() < 0.25 ? null
        : t === 'color' ? ['red', 'blue'][ri(2)]
        : t === 'link' ? 'https://x' : t === 'comment' ? `c${i}` : true
      localMark(p.oplog, p.agent, s, e, t, value); p.seq += 2
      void markPolicy
    } else if (roll < 0.95) {
      localSplitBlock(p.oplog, p.agent, ri(len + 1)); p.seq += 1
    } else {
      const q = reps[ri(3)]; if (q !== p) mergeOplogInto(p.oplog, q.oplog)
    }
  }
  for (const p of reps) for (const q of reps) if (p !== q) mergeOplogInto(p.oplog, q.oplog)
  return reps.map(r => checkoutRich(r.oplog).text.join(''))
}

// FIXED (paragraph-start moved placement->resolution + blockBoundary made
// left-sticky): engine replicas previously diverged at the doc start (a/c
// resolved 'colhygenpzpnovtjlt', b resolved 'oclhygenpzpnovtjlt') because the
// paragraph-start text-skip read the replica-local order of concurrent,
// not-yet-inserted block boundaries. With placement now a pure function of the
// prepare version, all replicas converge.
test('block_paragraph_start_concurrent_convergence (fuzzer seed egwrt-1-0)', () => {
  const texts = drive('egwrt-1-0')
  for (const t of texts) {
    assert.equal(t, texts[0],
      `engine replicas must converge on text; got ${JSON.stringify(texts)}`)
  }
})
