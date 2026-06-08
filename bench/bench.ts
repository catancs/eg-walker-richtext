// Benchmark harness: our reference eg-walker-richtext engine vs production CRDTs
// (Yjs and Automerge).
//
// ============================================================================
// HONESTY FRAMING (read this before reading any number) ----------------------
// ============================================================================
// Our engine is a DELIBERATELY UNOPTIMIZED TypeScript REFERENCE implementation
// (see the header of src/index.ts: no run-length encoding of ops, every op is
// processed in full on every checkout, the causal graph is traversed naively,
// and there is NO BINARY CODEC — the durable artifact is JSON.stringify(oplog)).
//
// Therefore:
//   * The TIME column WILL show us slower than Yjs/Automerge. That is EXPECTED
//     and is NOT the claim. It measures the gap between a readable reference and
//     years of production engineering (Rust/WASM cores, RLE, lazy traversal),
//     NOT a property of the model.
//   * The ENCODED-SIZE column for "ours" is JSON text with no compaction; Yjs
//     and Automerge ship purpose-built binary codecs. Again: engineering, not
//     model. We label ours "reference (unoptimized TS); no binary codec".
//
// The HEADLINE metric is MEMORY SHAPE (claim C3): our persistent READ form is an
// O(document) resolved snapshot ({text, spans, blocks}) carrying ZERO
// per-character CRDT metadata, while the durable WRITE form is an append-only
// oplog — like every op-based CRDT. We surface both and frame the numbers
// around that shape, not around raw bytes/ms.
//
// We do NOT cherry-pick: every library x scenario row is printed, including
// error rows for any library whose API fights us at this version.
// ============================================================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

import { createOpLog, localInsert, localDelete, localMark } from '../src/index.js'
import { checkoutRich } from '../src/resolve.js'

import * as Y from 'yjs'
import { next as Automerge } from '@automerge/automerge'

// --- config -----------------------------------------------------------------

// Op cap for the sequential/rich scenarios = min(all-ops, 20_000). We cap so the
// whole 3-library run finishes in a reasonable time (<~60s total); our reference
// engine re-runs checkout (O(ops) per checkout, no lazy skip) and dominates the
// wall clock. NOTE: the bundled testdata/ff-raw.json yields ~5.2k flat ops
// (~21k-char doc), so in this repo the cap is never actually hit and we replay
// the WHOLE trace — the cap exists to bound time if a larger trace is dropped in.
const OP_CAP = 20_000

// Inject a formatting mark roughly every this-many ops, over a recent range,
// for the rich-text scenario.
const MARK_EVERY = 50

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dist/bench/bench.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TRACE_PATH = path.join(REPO_ROOT, 'testdata', 'ff-raw.json')
const RESULTS_PATH = path.join(REPO_ROOT, 'bench', 'results.json')

// --- trace loading ----------------------------------------------------------

// ff-raw.json shape (verified by inspection):
//   { "txns": [ { "span":[..], "parents":[..], "agent":"0", "seqStart":N,
//                 "ops": [ [pos, delCount, insContent], ... ] }, ... ] }
// Each op is a tuple [pos, delCount, insContent]:
//   - delCount > 0  => delete `delCount` chars at `pos`
//   - insContent != '' => insert the string at `pos`
// (A single op may both delete and insert; we apply the delete first, then the
// insert, both at `pos` — matching the trace's intent.)
//
// IMPORTANT: the trace is a CONCURRENT multi-agent edit graph (each txn carries
// its own `parents`/`agent`, and a txn's `pos` is relative to ITS parent
// version, not to a single linear replay). This benchmark is a SEQUENTIAL
// single-writer replay — we are measuring model/engine overhead on a realistic
// edit STREAM, not reconstructing the original concurrent merge. So at load
// time we NORMALIZE every op against a tracked linear document length: positions
// and delete counts are clamped into range exactly once, and the SAME clamped
// stream is fed to all three libraries. This keeps the comparison apples-to-
// apples and avoids out-of-range deletes that would otherwise crash a strict
// engine (ours) while the libs silently clamp.
type RawOp = [pos: number, delCount: number, insContent: string]

interface FlatOp {
  pos: number
  delCount: number
  ins: string
}

function loadFlatOps(cap: number): FlatOp[] {
  const raw = JSON.parse(fs.readFileSync(TRACE_PATH, 'utf8')) as { txns: { ops: RawOp[] }[] }
  const out: FlatOp[] = []
  let len = 0 // tracked linear document length, for clamping into range.
  outer: for (const txn of raw.txns) {
    for (const [rawPos, rawDel, rawIns] of txn.ops) {
      const ins = rawIns ?? ''
      const pos = Math.max(0, Math.min(rawPos, len))
      const delCount = Math.max(0, Math.min(rawDel, len - pos))
      out.push({ pos, delCount, ins })
      len += ins.length - delCount
      if (out.length >= cap) break outer
    }
  }
  return out
}

// --- mark plan (shared across all three libraries) --------------------------

// Alternate bold / italic / link over a recent range, every MARK_EVERY ops.
// Produced once and replayed identically into every library so the rich-text
// comparison is apples-to-apples.
type MarkType = 'bold' | 'italic' | 'link'
interface MarkOp {
  start: number
  end: number
  type: MarkType
  value: any
}

function buildMarkPlan(docLen: number): MarkOp[] {
  const plan: MarkOp[] = []
  const cycle: MarkType[] = ['bold', 'italic', 'link']
  let i = 0
  // Operate over the most recent ~40% of the document (a "recent range").
  const rangeStart = Math.floor(docLen * 0.6)
  for (let start = rangeStart; start + 6 < docLen; start += MARK_EVERY) {
    const type = cycle[i % cycle.length]
    const end = Math.min(start + 5, docLen)
    const value = type === 'link' ? 'https://example.com' : true
    plan.push({ start, end, type, value })
    i++
  }
  return plan
}

// --- measurement helpers ----------------------------------------------------

interface Row {
  library: string
  scenario: string
  ms: number | null
  heapBytes: number | null
  encodedBytes: number | null
  note?: string
  error?: string
}

function heapAfterGc(): number {
  global.gc?.()
  global.gc?.() // twice — the first pass can leave finalizable garbage.
  return process.memoryUsage().heapUsed
}

function now(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

// --- scenario runners (each wrapped in try/catch by the caller) -------------

const OURS_LABEL = 'ours (reference, unoptimized TS; no binary codec)'
const YJS_LABEL = 'Yjs (production)'
const AM_LABEL = 'Automerge (production)'

// ===== OURS =================================================================

function runOurs(ops: FlatOp[], markPlan: MarkOp[]): Row[] {
  const rows: Row[] = []
  const AGENT = 'bench'

  // --- Scenario 1: sequential plain-text replay ---
  const t0 = now()
  const oplog = createOpLog<string>()
  for (const op of ops) {
    if (op.delCount > 0) localDelete(oplog, AGENT, op.pos, op.delCount)
    if (op.ins.length > 0) localInsert(oplog, AGENT, op.pos, ...op.ins.split(''))
  }
  // Force a materialization so the work is real and comparable.
  checkoutRich(oplog)
  const t1 = now()
  rows.push({
    library: OURS_LABEL,
    scenario: '1-seq-plaintext',
    ms: t1 - t0,
    heapBytes: heapAfterGc(),
    encodedBytes: JSON.stringify(oplog.ops).length, // oplog JSON (no binary codec in v1)
    note: 'ours: oplog JSON (no binary codec in v1)',
  })

  // --- Scenario 2: rich-text (same trace + injected marks) ---
  const t2 = now()
  for (const m of markPlan) {
    // localMark(oplog, agent, start, end, markType, value)
    localMark(oplog, AGENT, m.start, m.end, m.type, m.value)
  }
  const richSnap = checkoutRich(oplog)
  const t3 = now()
  // Snapshot retained-size proxy: the persistent READ form is {text, spans,
  // blocks}. JSON length of that snapshot is an O(document) size proxy carrying
  // ZERO per-character metadata (claim C3) — contrast with per-char CRDT
  // metadata in the libs' internal models.
  const snapshotProxyBytes = JSON.stringify({
    text: richSnap.text.join(''),
    spans: richSnap.spans,
    blocks: richSnap.blocks,
  }).length
  rows.push({
    library: OURS_LABEL,
    scenario: '2-richtext',
    ms: t3 - t2,
    heapBytes: heapAfterGc(),
    encodedBytes: JSON.stringify(oplog.ops).length,
    note: 'ours: oplog JSON (no binary codec in v1)',
  })

  // --- Scenario 3: steady-state memory + encoded size ---
  // Durable artifact = the append-only oplog (JSON). Persistent read form = the
  // O(document) resolved snapshot. Report BOTH, clearly labelled.
  const heap = heapAfterGc()
  rows.push({
    library: OURS_LABEL,
    scenario: '3-steady-snapshot-proxy',
    ms: null,
    heapBytes: heap,
    encodedBytes: snapshotProxyBytes,
    note: 'O(document) resolved snapshot {text,spans,blocks}, ZERO per-char metadata (claim C3)',
  })
  rows.push({
    library: OURS_LABEL,
    scenario: '3-steady-oplog-json',
    ms: null,
    heapBytes: heap,
    encodedBytes: JSON.stringify(oplog.ops).length,
    note: 'durable append-only oplog as JSON (no binary codec in v1)',
  })

  return rows
}

// ===== YJS ==================================================================

function runYjs(ops: FlatOp[], markPlan: MarkOp[]): Row[] {
  const rows: Row[] = []

  // --- Scenario 1: sequential plain-text replay ---
  const t0 = now()
  const doc = new Y.Doc()
  const ytext = doc.getText('t')
  for (const op of ops) {
    if (op.delCount > 0) {
      // Clamp to current length defensively (the trace is internally consistent,
      // but a cap can land mid-txn).
      const len = Math.min(op.delCount, Math.max(0, ytext.length - op.pos))
      if (len > 0) ytext.delete(op.pos, len)
    }
    if (op.ins.length > 0) ytext.insert(Math.min(op.pos, ytext.length), op.ins)
  }
  const t1 = now()
  rows.push({
    library: YJS_LABEL,
    scenario: '1-seq-plaintext',
    ms: t1 - t0,
    heapBytes: heapAfterGc(),
    encodedBytes: Y.encodeStateAsUpdate(doc).byteLength,
  })

  // --- Scenario 2: rich-text ---
  const t2 = now()
  for (const m of markPlan) {
    const len = Math.max(0, Math.min(m.end, ytext.length) - m.start)
    if (len > 0) {
      const attrs = m.type === 'link' ? { link: m.value } : { [m.type]: true }
      ytext.format(m.start, len, attrs)
    }
  }
  const t3 = now()
  rows.push({
    library: YJS_LABEL,
    scenario: '2-richtext',
    ms: t3 - t2,
    heapBytes: heapAfterGc(),
    encodedBytes: Y.encodeStateAsUpdate(doc).byteLength,
  })

  // --- Scenario 3: steady-state memory + encoded size ---
  const heap = heapAfterGc()
  rows.push({
    library: YJS_LABEL,
    scenario: '3-steady-encoded',
    ms: null,
    heapBytes: heap,
    encodedBytes: Y.encodeStateAsUpdate(doc).byteLength,
    note: 'Y.encodeStateAsUpdate (binary)',
  })

  return rows
}

// ===== AUTOMERGE ============================================================

function runAutomerge(ops: FlatOp[], markPlan: MarkOp[]): Row[] {
  const rows: Row[] = []

  // --- Scenario 1: sequential plain-text replay ---
  const t0 = now()
  let doc: any = Automerge.from({ text: '' })
  // Batch into a single change for speed (one change per op is pathologically
  // slow in Automerge and would distort the comparison toward "Automerge is
  // unusable", which is false). We still apply the EXACT same op sequence.
  doc = Automerge.change(doc, (d: any) => {
    let len = 0
    for (const op of ops) {
      let delLen = 0
      if (op.delCount > 0) delLen = Math.min(op.delCount, Math.max(0, len - op.pos))
      const pos = Math.min(op.pos, len)
      Automerge.splice(d, ['text'], pos, delLen, op.ins)
      len += op.ins.length - delLen
    }
  })
  const t1 = now()
  rows.push({
    library: AM_LABEL,
    scenario: '1-seq-plaintext',
    ms: t1 - t0,
    heapBytes: heapAfterGc(),
    encodedBytes: Automerge.save(doc).byteLength,
  })

  // --- Scenario 2: rich-text ---
  const t2 = now()
  doc = Automerge.change(doc, (d: any) => {
    const textLen = (d.text as string).length
    for (const m of markPlan) {
      const end = Math.min(m.end, textLen)
      if (end > m.start) {
        // mark(doc, path, {start, end, expand}, name, value)
        // expand 'none' for link (non-expanding), 'after' for bold/italic.
        const expand = m.type === 'link' ? 'none' : 'after'
        Automerge.mark(d, ['text'], { start: m.start, end, expand }, m.type, m.value)
      }
    }
  })
  const t3 = now()
  rows.push({
    library: AM_LABEL,
    scenario: '2-richtext',
    ms: t3 - t2,
    heapBytes: heapAfterGc(),
    encodedBytes: Automerge.save(doc).byteLength,
  })

  // --- Scenario 3: steady-state memory + encoded size ---
  const heap = heapAfterGc()
  rows.push({
    library: AM_LABEL,
    scenario: '3-steady-encoded',
    ms: null,
    heapBytes: heap,
    encodedBytes: Automerge.save(doc).byteLength,
    note: 'Automerge.save (binary)',
  })

  return rows
}

// --- driver -----------------------------------------------------------------

function tryRun(name: string, fn: () => Row[]): Row[] {
  try {
    return fn()
  } catch (err: any) {
    console.error(`[bench] ${name} FAILED:`, err?.stack ?? err)
    return [
      {
        library: name,
        scenario: 'ALL',
        ms: null,
        heapBytes: null,
        encodedBytes: null,
        error: String(err?.message ?? err),
      },
    ]
  }
}

function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function fmtMs(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(0)}`
}

function printTable(rows: Row[]) {
  console.log('')
  console.log('| library | scenario | ms | heap | encoded | note |')
  console.log('|---|---|---:|---:|---:|---|')
  for (const r of rows) {
    const note = r.error ? `ERROR: ${r.error}` : (r.note ?? '')
    console.log(
      `| ${r.library} | ${r.scenario} | ${fmtMs(r.ms)} | ${fmtBytes(r.heapBytes)} | ${fmtBytes(
        r.encodedBytes,
      )} | ${note} |`,
    )
  }
  console.log('')
}

function main() {
  if (!global.gc) {
    console.warn(
      '[bench] WARNING: global.gc is unavailable. Run with `node --expose-gc` ' +
        '(the `npm run bench` script already does). Heap numbers will be noisy.',
    )
  }

  const ops = loadFlatOps(OP_CAP)
  // Estimate doc length from the op stream for the mark plan range.
  let docLen = 0
  for (const op of ops) {
    docLen += op.ins.length - Math.min(op.delCount, docLen)
    if (docLen < 0) docLen = 0
  }
  const markPlan = buildMarkPlan(docLen)

  console.log(`[bench] op cap: ${OP_CAP} (loaded ${ops.length} flat ops)`)
  console.log(`[bench] estimated doc length: ~${docLen} chars`)
  console.log(`[bench] mark plan: ${markPlan.length} marks (every ${MARK_EVERY} ops, recent range)`)
  console.log(
    '[bench] NOTE: "ours" is a reference (unoptimized TS) engine with NO binary ' +
      'codec. The time/encoded-size columns are EXPECTED to trail the production ' +
      'libs — that is engineering overhead, not model overhead. The headline is ' +
      'the O(document) snapshot MEMORY SHAPE (claim C3).',
  )

  const rows: Row[] = []
  rows.push(...tryRun(OURS_LABEL, () => runOurs(ops, markPlan)))
  rows.push(...tryRun(YJS_LABEL, () => runYjs(ops, markPlan)))
  rows.push(...tryRun(AM_LABEL, () => runAutomerge(ops, markPlan)))

  printTable(rows)

  const env = {
    node: process.version,
    date: new Date().toISOString(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    opCap: OP_CAP,
    flatOps: ops.length,
    estDocLen: docLen,
    markCount: markPlan.length,
  }
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ env, rows }, null, 2))
  console.log(`[bench] wrote ${RESULTS_PATH}`)

  // Report which libraries produced real numbers.
  const ok = new Set(rows.filter((r) => r.error == null && r.ms !== undefined).map((r) => r.library))
  const errored = rows.filter((r) => r.error != null).map((r) => r.library)
  console.log(`[bench] libraries with results: ${[...ok].join(', ')}`)
  if (errored.length) console.log(`[bench] libraries that errored: ${errored.join(', ')}`)
}

main()
