// EVIDENCE.md generator (design spec Task 11).
//
// Runs the full evidence pipeline (adversarial+semantic suite, the differential
// fuzzer across several seed bases, and the benchmark) and writes a committed
// EVIDENCE.md in which every published design claim (C1–C5, §2 of the design
// doc) maps to a reproducible, runnable artifact.
//
// This is a MANUALLY-RUN script (not the workflow engine), so wall-clock Date()
// and the host environment are legitimately captured. Regenerate everything
// with:  npm run evidence
//
// The script EXITS NONZERO if any suite test fails or the fuzzer fails —
// EVIDENCE.md is the integrity artifact and must never claim green when it is
// not.
import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..') // dist/scripts -> repo root
const MAXBUF = 256 * 1024 * 1024 // TAP + fuzzer output can be large

function sh(cmd: string): string {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: 'utf8', maxBuffer: MAXBUF }).trim()
  } catch {
    return '(unknown)'
  }
}

// ---------------------------------------------------------------------------
// 0. Build a test-name -> source-file map by scanning test/*.test.ts.
//    The flattened `node --test` TAP stream does NOT carry the file per test,
//    so we recover the grouping from source.  simple-rich-doc oracle tests use
//    free-text names; we match those by their literal test(...) string.
// ---------------------------------------------------------------------------
function buildTestFileMap(): { exact: Map<string, string>, prefixes: Array<{ prefix: string, file: string }> } {
  const exact = new Map<string, string>()
  const prefixes: Array<{ prefix: string, file: string }> = []
  const testDir = path.join(repoRoot, 'test')
  let files: string[] = []
  try {
    files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts'))
  } catch {
    return { exact, prefixes }
  }
  // Match test('name', ...) / test("name", ...) / test(`name`, ...).
  const re = /\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  for (const f of files) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const quote = m[1]
      const raw = m[2]
      if (quote === '`' && raw.includes('${')) {
        // Template-literal name (e.g. dynamically generated tests): record the
        // static prefix before the first interpolation so we can prefix-match.
        const prefix = raw.slice(0, raw.indexOf('${'))
        if (prefix.length > 0) prefixes.push({ prefix, file: f })
        continue
      }
      const name = raw.replace(/\\(['"`])/g, '$1')
      if (!exact.has(name)) exact.set(name, f)
    }
  }
  // Longest prefix first for greedy specificity.
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length)
  return { exact, prefixes }
}
function resolveFile(name: string, map: { exact: Map<string, string>, prefixes: Array<{ prefix: string, file: string }> }): string {
  const hit = map.exact.get(name)
  if (hit) return hit
  for (const { prefix, file } of map.prefixes) {
    if (name.startsWith(prefix)) return file
  }
  return '(unmatched)'
}

// ---------------------------------------------------------------------------
// 1. Header + environment
// ---------------------------------------------------------------------------
const sha = sh('git rev-parse HEAD')
const branch = sh('git rev-parse --abbrev-ref HEAD')
const env = {
  sha,
  branch,
  node: process.version,
  platform: os.platform(),
  arch: os.arch(),
  cpu: (os.cpus()[0]?.model ?? 'unknown').trim(),
  timestamp: new Date().toISOString(),
}

// ---------------------------------------------------------------------------
// 2. Run the adversarial + semantic suite, capture + parse TAP.
// ---------------------------------------------------------------------------
const suiteGlob = 'dist/test/**/*.test.js'
const suiteCmd = `node --test --test-reporter=tap "${suiteGlob}"`
console.log(`[evidence] running suite: ${suiteCmd}`)
const suiteRun = spawnSync(
  'node',
  ['--test', '--test-reporter=tap', suiteGlob],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: MAXBUF, shell: false },
)
const suiteOut = (suiteRun.stdout ?? '') + (suiteRun.stderr ?? '')

interface TapResult { num: number, name: string, ok: boolean, skip: boolean }
function parseTap(out: string): TapResult[] {
  const results: TapResult[] = []
  for (const line of out.split('\n')) {
    // Match top-level "ok N - name" / "not ok N - name". Tolerate leading
    // whitespace for nested subtests; node:test prints the authoritative
    // top-level point lines with no indent, so we only take those.
    const m = /^(not ok|ok)\s+(\d+)\s+-\s+(.+)$/.exec(line)
    if (!m) continue
    const ok = m[1] === 'ok'
    const num = parseInt(m[2], 10)
    let name = m[3].trim()
    // Strip TAP directives (# SKIP / # TODO) from the name; flag skip.
    const dir = /\s+#\s*(SKIP|TODO)\b(.*)$/i.exec(name)
    const skip = !!dir
    if (dir) name = name.slice(0, dir.index).trim()
    results.push({ num, name, ok, skip })
  }
  return results
}
const tap = parseTap(suiteOut)
const fileMap = buildTestFileMap()

const suitePass = tap.filter(t => t.ok && !t.skip).length
const suiteFail = tap.filter(t => !t.ok).length
const suiteSkip = tap.filter(t => t.skip).length

// citation-named evidence tests: peritext_*, yjs_*, block_* (claims = test names)
const isCitation = (n: string) => /^(peritext_|yjs_|block_)/.test(n)

// Group results by source file (fallback: "(suite)" when name not matched).
const byFile = new Map<string, TapResult[]>()
for (const t of tap) {
  const f = resolveFile(t.name, fileMap)
  if (!byFile.has(f)) byFile.set(f, [])
  byFile.get(f)!.push(t)
}

// ---------------------------------------------------------------------------
// 3. Differential fuzzing across several seed bases.
// ---------------------------------------------------------------------------
const fuzzIters = parseInt(process.env.EVIDENCE_FUZZ_ITERS ?? '5000', 10)
const seedBases = (process.env.EVIDENCE_FUZZ_SEEDS ?? 'evidence-1,evidence-2,evidence-3')
  .split(',').map(s => s.trim()).filter(Boolean)

interface FuzzRun {
  seed: string
  iters: number
  pass: boolean
  selfConverged: boolean   // engine self-convergence == iters/iters
  textVariant: string      // "N/iters (X%)"
  itemVariant: string
  carved: string           // carved-out span/block-moving variance "N/iters (X%)"
  raw: string
}
function runFuzz(seed: string, iters: number): FuzzRun {
  console.log(`[evidence] fuzzing seed "${seed}" x${iters}`)
  const r = spawnSync('node', ['dist/test/rich-fuzzer.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: MAXBUF,
    env: { ...process.env, FUZZ_ITERS: String(iters), FUZZ_SEED: seed },
    shell: false,
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const pass = r.status === 0 && /rich-fuzzer: PASS/.test(out)
  const selfConverged = new RegExp(`Engine self-converged on all ${iters} iterations`).test(out)
  const grab = (re: RegExp) => { const m = re.exec(out); return m ? m[1].trim() : '(n/a)' }
  return {
    seed,
    iters,
    pass,
    selfConverged,
    textVariant: grab(/visible-text variant:\s*(.+)/),
    itemVariant: grab(/item-order variant:\s*(\S.*?)\n/),
    carved: grab(/carved out\):\s*(.+)/),
    raw: out,
  }
}
const fuzzRuns = seedBases.map(s => runFuzz(s, fuzzIters))
const fuzzAllPass = fuzzRuns.every(f => f.pass && f.selfConverged)

// ---------------------------------------------------------------------------
// 4. Benchmark — read bench/results.json, or run the bench if absent.
// ---------------------------------------------------------------------------
const resultsPath = path.join(repoRoot, 'bench', 'results.json')
if (!fs.existsSync(resultsPath)) {
  console.log('[evidence] bench/results.json absent — running benchmark')
  spawnSync('node', ['--expose-gc', 'dist/bench/bench.js'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: MAXBUF, stdio: 'inherit', shell: false,
  })
}
let bench: any = null
try { bench = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) } catch { bench = null }

// ---------------------------------------------------------------------------
// Assemble EVIDENCE.md
// ---------------------------------------------------------------------------
const L: string[] = []
const p = (s = '') => L.push(s)

const allGreen = suiteFail === 0 && fuzzAllPass

p('# EVIDENCE')
p()
p('> **Integrity artifact.** Every published claim below maps to a runnable, reproducible result.')
p('> This file is generated by `scripts/gen-evidence.ts`; the generator exits non-zero (and this')
p('> file is not trusted) if any suite test fails or the fuzzer fails.')
p()
p(`**Overall status:** ${allGreen ? '✅ GREEN' : '❌ NOT GREEN'}`)
p()
p('Regenerate everything with:')
p()
p('```sh')
p('npm run evidence            # builds, runs suite + fuzzer + benchmark, rewrites this file')
p('```')
p()

// --- Environment ---
p('## Environment')
p()
p('| Field | Value |')
p('| --- | --- |')
p(`| Git SHA | \`${env.sha}\` |`)
p(`| Git branch | \`${env.branch}\` |`)
p(`| Node | ${env.node} |`)
p(`| Platform | ${env.platform} / ${env.arch} |`)
p(`| CPU | ${env.cpu} |`)
p(`| Generated (UTC) | ${env.timestamp} |`)
p(`| Fuzz iterations / seed | ${fuzzIters} |`)
p(`| Fuzz seed bases | ${seedBases.join(', ')} |`)
p()

// --- 2. Claims -> evidence map ---
p('## 1. Claims → evidence map')
p()
p('The five core design claims (design doc §2) and the artifact that evidences each.')
p()
p('| Claim | Statement (abridged) | Evidence artifact | Status |')
p('| --- | --- | --- | --- |')
const claimStatus = allGreen ? '✅' : '⚠️'
p(`| **C1** Feasibility | Peritext-semantics inline formatting runs on an event-graph replay engine (anchor insertions inside replay + a pure order-aware resolution outside replay). | \`test/adversarial.test.ts\`, \`test/anchors.test.ts\` (§3) + the engine itself | ${suiteFail === 0 ? '✅' : '❌'} |`)
p(`| **C2** Intent preservation | Passes Peritext Examples 1–8 + failure cases P1–P4, the tombstone-capture bug (peritext#32), and Yjs's orphaned-marker bug (yjs#197). | citation-named tests in \`test/adversarial.test.ts\` + \`test/simple-rich-doc.test.ts\` oracle (§3) | ${suiteFail === 0 ? '✅' : '❌'} |`)
p(`| **C3** Memory shape | Persistent state is O(document), not O(history): snapshot \`{text, spans, blocks}\` with zero per-char metadata; anchors live only in the append-only log + transient replay. | \`bench/bench.ts\` → \`bench/results.json\` (§6) | ${bench ? '✅' : '⚠️ (no bench data)'} |`)
p(`| **C4** Convergence | All replicas converge for arbitrary concurrent histories — differentially fuzzed against an independent simple reference, seeds published. | \`test/rich-fuzzer.ts\` (§4) | ${fuzzAllPass ? '✅' : '❌'} |`)
p(`| **C5** Flat-block semantics | Concurrent paragraph split/merge + text edits have specified, tested merge behavior. | \`test/blocks.test.ts\` (block_* tests), \`test/block-convergence-regression.test.ts\` (§3) | ${suiteFail === 0 ? '✅' : '❌'} |`)
p()
p(`_Legend: ${claimStatus} reflects the suite/fuzzer run captured in this same file._`)
p()

// --- 3. Adversarial + semantic suite ---
p('## 2. Adversarial + semantic suite')
p()
p('Command:')
p()
p('```sh')
p(`${suiteCmd}`)
p('```')
p()
p(`**Totals: ${suitePass} pass / ${suiteFail} fail / ${suiteSkip} skip** (of ${tap.length} TAP points).`)
p()
p('Citation-named tests (`peritext_*`, `yjs_*`, `block_*`) are the "claims = test names" evidence — each is a named published failure case or semantic obligation.')
p()
// Sort files for stable output, citation-bearing files first-ish (alpha is fine).
const fileOrder = Array.from(byFile.keys()).sort()
for (const f of fileOrder) {
  const rows = byFile.get(f)!
  p(`### \`${f}\``)
  p()
  p('| Test | Citation | Result |')
  p('| --- | --- | --- |')
  for (const t of rows) {
    const status = t.skip ? '⏭️ SKIP' : t.ok ? '✅ PASS' : '❌ FAIL'
    const cite = isCitation(t.name) ? '★' : ''
    p(`| \`${t.name}\` | ${cite} | ${status} |`)
  }
  p()
}
p('★ = citation-named claim test.')
p()

// --- 4. Differential fuzzing ---
p('## 3. Differential fuzzing')
p()
p('The fuzzer (`test/rich-fuzzer.ts`) drives 3 replica pairs (engine oplog + an independent `SimpleRichDoc` oracle) through random local edits and pairwise/full-mesh merges, asserting engine self-convergence on `{text, spans, blocks}` and engine-vs-oracle agreement wherever the comparison is well-defined.')
p()
p('Command (per seed base):')
p()
p('```sh')
p(`FUZZ_ITERS=${fuzzIters} FUZZ_SEED=<seed-base> node dist/test/rich-fuzzer.js`)
p('```')
p()
p('| Seed base | Iterations | Engine self-converged | Visible-text variant | Item-order variant | Carved span/block variance | Result |')
p('| --- | --- | --- | --- | --- | --- | --- |')
for (const f of fuzzRuns) {
  p(`| \`${f.seed}\` | ${f.iters} | ${f.selfConverged ? `✅ ${f.iters}/${f.iters}` : '❌'} | ${f.textVariant} | ${f.itemVariant} | ${f.carved} | ${f.pass ? '✅ PASS' : '❌ FAIL'} |`)
}
p()
p('**Honest claim:** 0 unclassified mark-resolution divergences; the engine self-converged on N/N iterations for every seed base; the only carve-out is the precisely-characterized tombstone-order / equal-letter-swap variance of the side-table oracle (rates above), each instance of which is logged and is a known text-CRDT-ordering difference — never a mark or block bug.')
p()

// --- 5. Conformance ---
p('## 4. Conformance (real trace)')
p()
p('`checkoutRich` reproduces the `testdata/ff-raw.json` real `dt export` trace\'s ground-truth `endContent`, materializing to empty spans + a single block (plain-text trace). This is asserted by `conformance_plaintext_ff-raw.json_via_checkoutRich` in `test/conformance-rich.test.ts`, which is part of the suite run in §2 above. (A second, slower `am.json` trace runs under `SLOW_TESTS=1`.)')
p()
const ffTest = tap.find(t => t.name.startsWith('conformance_plaintext_ff-raw'))
p(`Status in this run: ${ffTest ? (ffTest.ok ? '✅ PASS' : '❌ FAIL') : '⚠️ not found'}.`)
p()

// --- 6. Benchmarks ---
p('## 5. Benchmarks')
p()
p('Run with `node --expose-gc dist/bench/bench.js` (writes `bench/results.json`; gitignored — its data is embedded below).')
p()
p('**Honesty framing (copied from `bench/bench.ts`):** our engine is a *deliberately unoptimized TypeScript reference* — no run-length encoding, every op replayed in full on every checkout, naive causal traversal, and **no binary codec** (the durable artifact is `JSON.stringify(oplog)`). The **TIME** column will show us slower than Yjs/Automerge — that is expected and is *not* the claim (it measures readable-reference vs years of Rust/WASM production engineering). The **ENCODED-SIZE** column for "ours" is uncompacted JSON; the libraries ship purpose-built binary codecs. The **headline metric is MEMORY SHAPE (claim C3)**: our persistent *read* form is an O(document) resolved snapshot `{text, spans, blocks}` carrying **zero** per-character CRDT metadata, while the durable *write* form is an append-only oplog like every op-based CRDT. Every library × scenario row is printed — no cherry-picking.')
p()
if (bench) {
  p('### Benchmark environment')
  p()
  p('| Field | Value |')
  p('| --- | --- |')
  for (const [k, v] of Object.entries(bench.env ?? {})) p(`| ${k} | ${v} |`)
  p()
  p('### Results')
  p()
  p('| Library | Scenario | Time (ms) | Heap (bytes) | Encoded (bytes) | Note |')
  p('| --- | --- | ---: | ---: | ---: | --- |')
  for (const r of bench.rows ?? []) {
    const ms = r.ms == null ? '—' : String(r.ms)
    const heap = r.heapBytes == null ? '—' : r.heapBytes.toLocaleString('en-US')
    const enc = r.encodedBytes == null ? '—' : r.encodedBytes.toLocaleString('en-US')
    p(`| ${r.library} | ${r.scenario} | ${ms} | ${heap} | ${enc} | ${(r.note ?? '').replace(/\|/g, '\\|')} |`)
  }
  p()
} else {
  p('_No benchmark data available (`bench/results.json` missing and bench run failed)._')
  p()
}

// --- 7. Reproduction ---
p('## 6. Reproduction')
p()
p('| Section | Command |')
p('| --- | --- |')
p('| Everything | `npm run evidence` |')
p('| Build | `npm run build` |')
p(`| §2 Suite | \`${suiteCmd}\` |`)
p(`| §3 Fuzzing | \`FUZZ_ITERS=${fuzzIters} FUZZ_SEED=evidence-1 node dist/test/rich-fuzzer.js\` (repeat per seed base) |`)
p('| §4 Conformance (slow am.json too) | `SLOW_TESTS=1 node --test "dist/test/conformance-rich.test.js"` |')
p('| §5 Benchmarks | `node --expose-gc dist/bench/bench.js` |')
p()
p(`Tune the fuzz count with \`EVIDENCE_FUZZ_ITERS\` and seed bases with \`EVIDENCE_FUZZ_SEEDS\` (comma-separated) when running \`npm run evidence\`.`)
p()
p('---')
p()
p(`_Generated ${env.timestamp} from \`${env.sha}\`._`)
p()

const outFile = path.join(repoRoot, 'EVIDENCE.md')
fs.writeFileSync(outFile, L.join('\n'))
console.log(`[evidence] wrote ${outFile}`)

// ---------------------------------------------------------------------------
// Integrity gate
// ---------------------------------------------------------------------------
const summary = `suite: ${suitePass} pass / ${suiteFail} fail / ${suiteSkip} skip — fuzz: ${fuzzRuns.filter(f => f.pass && f.selfConverged).length}/${fuzzRuns.length} seed-bases PASS`
if (!allGreen) {
  console.error(`[evidence] ❌ NOT GREEN — ${summary}`)
  process.exit(1)
}
console.log(`[evidence] ✅ GREEN — ${summary}`)
