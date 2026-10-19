#!/usr/bin/env node
'use strict'
// One-command local benchmark: @qvac/llm-llamacpp addon vs llama-server on the same
// local GGUF(s), same engine parameters. Runs on any desktop host with the repo
// checked out (macOS / Linux / Windows; CPU / Metal / Vulkan / CUDA). Not used by
// CI. Full guide: LOCAL.md.
//
//   node benchmarks/vlm-benchmark/run-local.cjs --llm /m/model.gguf --mmproj /m/mmproj.gguf
//
// Per backend: the vlm suite runs the image fixture through the addon (bare) and
// llama-server; the text suite runs single-stream, concurrency and speculative jobs
// (text-workload.cjs) through both. llama-server is built once per backend from the
// qvac-fabric tag the addon is built on (cached). Outputs report.md (vlm),
// text-report.md / text-report.html (text) and results.json.

const fs = require('fs')
const path = require('path')
const os = require('os')
const cp = require('child_process')
const config = require('./config.cjs')
const { parseArgs } = require('./utils')
const { selectItems } = require('./items.cjs')
const { addonDefaultImageMaxTokens } = require('./gguf.cjs')
const W = require('./text-workload.cjs')
const { SPEC_TYPES } = W

const BENCH_DIR = __dirname
const PKG_DIR = path.resolve(BENCH_DIR, '..', '..')
const REPO_DIR = path.resolve(PKG_DIR, '..', '..')
const FIXTURE_S3 = 's3://tether-ai-dev/vlm-benchmark/'
const IS_WIN = os.platform() === 'win32'
const GPU_APIS = ['metal', 'vulkan', 'cuda']
const DEFAULT_GPU_API = os.platform() === 'darwin' ? 'metal' : 'vulkan'

const HELP = `Usage: node benchmarks/vlm-benchmark/run-local.cjs --llm <gguf> [--mmproj <gguf>] [options]

Models:
  --llm <path>            main model GGUF (required)
  --mmproj <path>         vision projector GGUF (required for the vlm suite)
  --text-llm <path>       model for the text suite (default: --llm)
  --draft <path>          draft model for speculative decoding (same vocabulary)

Suites:
  --suite <name>          all | vlm | text (default: all with --mmproj, else text)

Run shape:
  --backend <list>        cpu, gpu or cpu,gpu (default: gpu)
  --gpu-api <api>         metal | vulkan | cuda for the gpu backend (default: ${DEFAULT_GPU_API});
                          the addon is pinned to it and llama-server is built with it
  --preset <name>         ${Object.keys(config.presets).join(' | ')} (default: smoke)
  --samples <n>           samples per task (default: preset)
  --repeats <n>           measured repeats per item (default: preset)
  --tasks <a,b>           restrict to these fixture tasks
  --fixture-dir <dir>     fixture images (default: benchmarks/vlm-benchmark/fixture)
  --sync-fixture          aws s3 sync the fixture images first (needs AWS access)
  --timeout-min <n>       addon leg time limit in minutes (default: 240)

Text suite (single stream, concurrency, speculative decoding):
  --text-preset <name>    ${Object.keys(W.TEXT_PRESETS).join(' | ')} (default: quick with --preset smoke, else standard)
  --text-suites <a,b>     any of ${W.SUITES.join(',')} (default: all)
  --text-prompts <a,b>    single-stream prompt lengths in tokens (e.g. 512,2048)
  --text-gen <n>          generated tokens per request, single + concurrency
  --text-repeats <n>      measured repeats / rounds per configuration
  --concurrency <a,b>     concurrent request levels (e.g. 1,2,4,8,16)
  --spec-types <a,b>      llama-server speculative modes besides none: ${SPEC_TYPES.join(', ')}
                          (default: ngram-simple, plus draft-simple with --draft)
  --spec-gen <n>          max generated tokens for speculative prompts
  --spec-concurrency <a,b>  concurrency levels for the speculative runs (default: 1)

Engine parameters (applied to both engines):
  --ctx <n>               VLM context size (default: 4096; text jobs size their own)
  --threads <n>           CPU threads (default: engine default)
  --batch <n>             logical batch size (default: engine default)
  --ubatch <n>            physical batch size (default: engine default)
  --flash-attn <on|off|auto>   (default: on)
  --cache-type <type>     KV cache type for K and V (default: f16)
  --gpu-layers <n>        layers on GPU for the gpu backend (default: 99)
  --mmproj-cpu            keep the vision projector on CPU for the gpu backend
  --image-max-tokens <n>  image-token cap (default: the addon's cap for the
                          projector, e.g. 2048 Qwen-VL / 280 Gemma 4)
  --fit <on|off>          auto-fit params to device memory (default: off)

Sources:
  --fabric-ref <tag>      qvac-fabric tag/commit to build llama-server from
                          (default: v<qvac-fabric version> from packages/fabric/vcpkg.json)
  --addon-version <ver>   npm version (or dist-tag) whose prebuild to install when
                          prebuilds/ has none for this platform (default: the
                          checkout's package.json version)
  --skip-addon | --skip-server   run one leg only

Output:
  --out-dir <dir>         default: benchmarks/vlm-benchmark/results/<timestamp>-<host>
  --host-label <name>     host column label (default: hostname, [a-z0-9] only)
  --port <n>              llama-server port (default: 8089)
`

const log = (...a) => console.log('[run-local]', ...a)
function fail (msg) { console.error(`[run-local] ERROR: ${msg}`); process.exit(1) }

// Windows runs npm / bare / aws through their .cmd shims, which need cmd.exe;
// quote every argument so paths with spaces or cmd metacharacters stay intact.
const SHIMS = new Set(['npm', 'bare', 'aws'])
function winQuote (s) {
  s = String(s)
  return /^[\w\-.:\\/=@,+]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`
}
function spawnSpec (cmd, args) {
  if (IS_WIN && SHIMS.has(cmd)) return { cmd: [cmd, ...args].map(winQuote).join(' '), args: [], shell: true }
  return { cmd, args, shell: false }
}

function which (cmd) {
  try {
    const r = cp.execFileSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return r.trim().split(/\r?\n/)[0] || null
  } catch (_) { return null }
}

function tryExec (cmd, args) {
  const s = spawnSpec(cmd, args)
  try {
    return cp.execFileSync(s.cmd, s.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: s.shell, timeout: 30000 }).trim()
  } catch (_) { return null }
}

function readJson (p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return null } }

// Run a command, streaming its stdout+stderr to the console and appending to logFile.
function runTee (cmd, args, { cwd, env, logFile }) {
  const s = spawnSpec(cmd, args)
  return new Promise((resolve) => {
    const out = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null
    const child = cp.spawn(s.cmd, s.args, { cwd, env, shell: s.shell, stdio: ['ignore', 'pipe', 'pipe'] })
    const pipe = (stream, sink) => stream.on('data', d => { sink.write(d); if (out) out.write(d) })
    pipe(child.stdout, process.stdout)
    pipe(child.stderr, process.stderr)
    child.on('close', code => { if (out) out.end(); resolve(code) })
    child.on('error', e => { console.error(`[run-local] failed to start ${cmd}: ${e.message}`); if (out) out.end(); resolve(1) })
  })
}

function runInherit (cmd, args, opts = {}) {
  const s = spawnSpec(cmd, args)
  return cp.spawnSync(s.cmd, s.args, { stdio: 'inherit', shell: s.shell, ...opts }).status
}

function intOpt (a, name, def, min = 1) {
  if (a[name] === undefined) return def
  const v = Number(a[name])
  if (!Number.isInteger(v) || v < min) fail(`--${name} must be an integer >= ${min} (got '${a[name]}')`)
  return v
}

function strOpt (a, name, def, allowed) {
  if (a[name] === undefined) return def
  if (a[name] === true) fail(`--${name} needs a value`)
  const v = String(a[name])
  if (allowed && !allowed.includes(v)) fail(`--${name} must be one of ${allowed.join(', ')} (got '${v}')`)
  return v
}

// ── setup ────────────────────────────────────────────────────────────────────

function checkPrereqs (a) {
  const major = parseInt(process.versions.node.split('.')[0], 10)
  if (major < 18) fail(`Node >= 18 required (found ${process.versions.node})`)
  const missing = []
  if (!a['skip-addon'] && !which('bare')) missing.push('bare  (npm install -g bare)')
  if (!a['skip-server']) {
    if (!which('git')) missing.push('git')
    if (!which('cmake')) missing.push('cmake >= 3.14')
    if (!IS_WIN && !(which('cc') || which('clang') || which('gcc'))) missing.push('a C/C++ compiler (clang or gcc)')
  }
  if (a['sync-fixture'] && !which('aws')) missing.push('aws CLI (for --sync-fixture)')
  if (missing.length) fail(`missing prerequisites:\n  - ${missing.join('\n  - ')}`)
}

function prebuildDir () { return path.join(PKG_DIR, 'prebuilds', `${os.platform()}-${os.arch()}`) }

// Install JS deps and the addon prebuild when absent, the same way CI stages them.
function ensureAddon (a) {
  if (!fs.existsSync(path.join(PKG_DIR, 'node_modules'))) {
    log('installing package dependencies (npm install)…')
    if (runInherit('npm', ['install', '--no-audit', '--no-fund'], { cwd: PKG_DIR }) !== 0) fail('npm install failed')
  }
  if (fs.existsSync(prebuildDir())) return 'local prebuilds/'
  const pkgVer = readJson(path.join(PKG_DIR, 'package.json')).version
  const wanted = strOpt(a, 'addon-version', pkgVer)
  if (!/^[0-9A-Za-z.+-]+$/.test(wanted)) fail(`--addon-version must be a version or dist-tag (got '${wanted}')`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-addon-'))
  log(`no prebuild for ${os.platform()}-${os.arch()}; fetching @qvac/llm-llamacpp@${wanted} from npm…`)
  if (runInherit('npm', ['pack', `@qvac/llm-llamacpp@${wanted}`, '--pack-destination', tmp], { cwd: tmp }) !== 0) {
    fail(`npm pack @qvac/llm-llamacpp@${wanted} failed. Build the addon locally (npm run build), ` +
      'or pick a published version with --addon-version <ver|latest>.')
  }
  const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'))
  if (!tgz || runInherit('tar', ['-xzf', tgz], { cwd: tmp }) !== 0) fail('could not unpack the addon tarball')
  const src = path.join(tmp, 'package', 'prebuilds')
  if (!fs.existsSync(path.join(src, `${os.platform()}-${os.arch()}`))) fail(`the npm package has no prebuild for ${os.platform()}-${os.arch()}; build it with: npm run build`)
  fs.cpSync(src, path.join(PKG_DIR, 'prebuilds'), { recursive: true })
  const ver = (readJson(path.join(tmp, 'package', 'package.json')) || {}).version || wanted
  fs.rmSync(tmp, { recursive: true, force: true })
  if (ver !== pkgVer) log(`WARNING: addon prebuild is ${ver} but the checkout's JS is ${pkgVer}; build locally (npm run build) for an exact match`)
  return `npm @qvac/llm-llamacpp@${ver}`
}

// bare refuses to load a module whose engines.bare floor it is below, so check the
// installed dependencies up front instead of failing mid-run.
function checkBareVersion () {
  const parse = s => (String(s).match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number)
  const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  const have = parse(tryExec('bare', ['--version']) || '')
  if (have.length !== 3) return
  const nm = path.join(PKG_DIR, 'node_modules')
  const dirs = []
  for (const d of fs.readdirSync(nm)) {
    if (d.startsWith('@')) for (const s of fs.readdirSync(path.join(nm, d))) dirs.push(path.join(d, s))
    else if (!d.startsWith('.')) dirs.push(d)
  }
  let need = null
  let by = null
  for (const d of dirs) {
    const range = ((readJson(path.join(nm, d, 'package.json')) || {}).engines || {}).bare
    const m = typeof range === 'string' && range.match(/>=\s*v?(\d+\.\d+\.\d+)/)
    if (m && (!need || cmp(parse(m[1]), need) > 0)) { need = parse(m[1]); by = d }
  }
  if (need && cmp(have, need) < 0) {
    fail(`bare ${have.join('.')} is too old: ${by} requires bare >= ${need.join('.')}.\n` +
      '  Update it with: npm install -g bare@latest')
  }
}

// The fabric tag the addon is built on: the qvac-fabric pin of the shared runtime
// (packages/fabric/vcpkg.json). Warns when the installed runtime is not this
// checkout's, since the tag would then be a guess.
function resolveFabricRef (a) {
  if (a['fabric-ref'] !== undefined) return { ref: strOpt(a, 'fabric-ref'), note: 'from --fabric-ref' }
  const vcpkg = readJson(path.join(REPO_DIR, 'packages', 'fabric', 'vcpkg.json')) || {}
  const dep = (vcpkg.dependencies || []).find(d => d && typeof d === 'object' && d.name === 'qvac-fabric')
  const raw = dep && (dep['version>='] || dep.version)
  if (!raw) fail('could not read the qvac-fabric version from packages/fabric/vcpkg.json; pass --fabric-ref')
  const ref = `v${String(raw).split('#')[0]}`
  const repoFabric = (readJson(path.join(REPO_DIR, 'packages', 'fabric', 'package.json')) || {}).version
  const installed = (readJson(path.join(PKG_DIR, 'node_modules', '@qvac', 'fabric', 'package.json')) || {}).version
  if (installed && repoFabric && installed !== repoFabric) {
    log(`WARNING: installed @qvac/fabric is ${installed} but packages/fabric is ${repoFabric}; ${ref} may not be the engine the addon runs. Pass --fabric-ref to pin the matching tag.`)
  }
  return { ref, note: `packages/fabric/vcpkg.json (installed @qvac/fabric ${installed || '?'})` }
}

function checkFixture (dir, items, a) {
  const missing = () => items.filter(it => !fs.existsSync(path.join(dir, it.image)))
  if (missing().length && a['sync-fixture']) {
    log(`syncing fixture images from ${FIXTURE_S3} into ${dir}…`)
    fs.mkdirSync(dir, { recursive: true })
    if (runInherit('aws', ['s3', 'sync', FIXTURE_S3, dir]) !== 0) fail('aws s3 sync failed (check your AWS credentials)')
  }
  const m = missing()
  if (m.length) {
    fail(`${m.length}/${items.length} fixture images missing from ${dir} (e.g. ${m[0].image}).\n` +
      '  Copy the fixture images there, pass --fixture-dir, or use --sync-fixture with AWS access. See LOCAL.md.')
  }
}

function hostInfo (backend, gpuApi) {
  const cpus = os.cpus()
  let osName = `${os.type()} ${os.release()}`
  let gpu = null
  if (os.platform() === 'darwin') {
    const pv = tryExec('sw_vers', ['-productVersion'])
    if (pv) osName = `macOS ${pv}`
    const sp = tryExec('system_profiler', ['SPDisplaysDataType'])
    const m = sp && sp.match(/Chipset Model:\s*(.+)/)
    if (m) gpu = m[1].trim()
  } else if (os.platform() === 'linux') {
    const rel = (() => { try { return fs.readFileSync('/etc/os-release', 'utf8') } catch (_) { return '' } })()
    const m = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m)
    if (m) osName = m[1]
    const vk = tryExec('vulkaninfo', ['--summary'])
    const g = vk && vk.match(/deviceName\s*=\s*(.+)/)
    if (g) gpu = g[1].trim()
  } else if (IS_WIN) {
    const g = tryExec('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name'])
    if (g) gpu = g
  }
  return {
    hostname: os.hostname(),
    os: osName,
    arch: os.arch(),
    cpu: cpus.length ? cpus[0].model.trim() : '?',
    cpu_count: cpus.length,
    ram_gb: Math.round(os.totalmem() / 1073741824),
    gpu: gpu || '?',
    backend,
    gpu_api: backend === 'gpu' ? gpuApi : null,
    node: process.versions.node,
    bare: tryExec('bare', ['--version']) || 'n/a'
  }
}

// ── results.json ─────────────────────────────────────────────────────────────

function summarize (logFiles) {
  const { parseLog, score, ocrScore, OCR_METRICS } = require('./aggregate.js')
  const { rows } = parseLog(logFiles.map(f => ({ label: f.host, file: f.file })))
  const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
  const num = (rs, k) => rs.map(r => r[k]).filter(v => v != null)
  const groups = {}
  for (const r of rows) {
    if (r.block === 0) continue
    const k = `${r.__host}|${r.cell}|${r.device}`
    ;(groups[k] = groups[k] || []).push(r)
  }
  return Object.entries(groups).map(([k, rs]) => {
    const [host, engine, backend] = k.split('|')
    const ok = rs.filter(r => !r.error)
    const vqaTasks = [...new Set(ok.filter(r => !OCR_METRICS.has(r.metric)).map(r => r.task))]
    const perTask = Object.fromEntries(vqaTasks.map(t => [t, mean(ok.filter(r => r.task === t).map(r => score(r.metric, r.pred, r.gold)))]))
    const ocr = ok.filter(r => OCR_METRICS.has(r.metric)).map(r => ocrScore(r.pred, r.gold)).filter(o => o.cer != null)
    const rss = num(ok, 'rss_mb')
    return {
      host,
      engine,
      backend,
      runs: rs.length,
      errors: rs.length - ok.length,
      ttft_ms: mean(num(ok, 'ttft_ms')),
      prefill_tps: mean(num(ok, 'pp_tps')),
      decode_tps: mean(num(ok, 'decode_tps')),
      wall_ms: mean(num(ok, 'ms')),
      vision_enc_ms: mean(num(ok, 'vision_enc_ms')),
      peak_rss_mb: rss.length ? Math.max(...rss) : null,
      quality_pct: (() => { const v = Object.values(perTask).filter(x => x != null); return v.length ? 100 * mean(v) : null })(),
      quality_by_task_pct: Object.fromEntries(Object.entries(perTask).map(([t, v]) => [t, v == null ? null : 100 * v])),
      ocr: ocr.length ? { cer: mean(ocr.map(o => o.cer)), wer: mean(ocr.map(o => o.wer)), bleu: mean(ocr.map(o => o.bleu)), n: ocr.length } : null
    }
  })
}

// ── text suite ───────────────────────────────────────────────────────────────

function intListOpt (a, name) {
  const xs = strOpt(a, name).split(',').map(s => s.trim()).filter(Boolean).map(Number)
  if (!xs.length || xs.some(x => !Number.isInteger(x) || x < 1)) fail(`--${name} must be a comma-separated list of positive integers`)
  return xs
}

// Text run shape: a preset (quick for the smoke VLM preset, else standard) plus
// command-line overrides, expanded into the job list both engines run.
function textPlan (a, presetName, draft) {
  const name = strOpt(a, 'text-preset', presetName === 'smoke' ? 'quick' : 'standard', Object.keys(W.TEXT_PRESETS))
  const shape = JSON.parse(JSON.stringify(W.TEXT_PRESETS[name]))
  if (a['text-prompts'] !== undefined) shape.single.prompts = intListOpt(a, 'text-prompts')
  if (a['text-gen'] !== undefined) shape.single.gen = shape.conc.gen = intOpt(a, 'text-gen', null)
  if (a['text-repeats'] !== undefined) shape.single.repeats = shape.conc.rounds = shape.spec.runs = intOpt(a, 'text-repeats', null)
  if (a.concurrency !== undefined) shape.conc.levels = intListOpt(a, 'concurrency')
  if (a['spec-gen'] !== undefined) shape.spec.gen = intOpt(a, 'spec-gen', null)
  if (a['spec-concurrency'] !== undefined) shape.spec.levels = intListOpt(a, 'spec-concurrency')
  const suites = strOpt(a, 'text-suites', W.SUITES.join(',')).split(',').map(s => s.trim()).filter(Boolean)
  for (const s of suites) if (!W.SUITES.includes(s)) fail(`--text-suites must be from ${W.SUITES.join(', ')} (got '${s}')`)
  const spec = a['spec-types'] !== undefined
    ? strOpt(a, 'spec-types').split(',').map(s => s.trim()).filter(Boolean)
    : (draft ? ['ngram-simple', 'draft-simple'] : ['ngram-simple'])
  for (const s of spec) if (s !== 'none' && !SPEC_TYPES.includes(s)) fail(`--spec-types must be from ${SPEC_TYPES.join(', ')} (got '${s}')`)
  if (spec.includes('draft-simple') && !draft) fail('--spec-types draft-simple needs --draft <gguf> (a small model with the same vocabulary)')
  const specTypes = ['none', ...new Set(spec.filter(s => s !== 'none'))]
  return { presetName: name, shape, suites, specTypes, jobs: W.buildJobs(shape, suites, specTypes) }
}

// Run every text job on this backend: the addon in a fresh bare process and
// llama-server freshly started, per job. Calibration runs once, on the first engine.
async function runTextJobs ({ a, backend, outDir, host, text, textLlm, textLabel, draft, textParams, port, addonRef, build, serverRef }) {
  const useAddon = !a['skip-addon']
  const useServer = !!build
  if (!useAddon && !useServer) return 0
  const logFile = path.join(outDir, `text-${host}-${backend}.log`)
  const planDir = path.join(outDir, 'plans')
  fs.mkdirSync(planDir, { recursive: true })
  const calibrationFile = path.join(outDir, 'text-calibration.json')
  let failures = 0
  for (const job of text.jobs) {
    let engines = []
    if (useAddon && !job.serverOnly) engines.push('addon')
    if (useServer) engines.push('llama-server')
    if (job.suite === 'calibrate') {
      if (fs.existsSync(calibrationFile)) continue
      engines = engines.slice(0, 1)
    }
    for (const engine of engines) {
      const plan = {
        llm: textLlm,
        draft,
        backend,
        params: textParams,
        label: textLabel,
        port,
        calibrationFile,
        job,
        sourceRef: engine === 'addon' ? addonRef : serverRef,
        serverLog: path.join(outDir, `llama-server-text-${backend}.log`)
      }
      const planFile = path.join(planDir, `${backend}-${job.id}-${engine}.json`)
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 2))
      log(`── text · ${backend} · ${job.id} · ${engine} ──`)
      const rc = engine === 'addon'
        ? await runTee('bare', [path.join(BENCH_DIR, 'text-addon.js')], { cwd: PKG_DIR, env: { ...process.env, QVAC_TEXT_PLAN: planFile }, logFile })
        : await runTee(process.execPath, [path.join(BENCH_DIR, 'text-server.cjs'), '--binary', build.binaryPath, '--plan', planFile], { cwd: BENCH_DIR, logFile })
      if (rc !== 0) {
        failures++
        log(`text ${job.id} (${engine}) exited with code ${rc}`)
        if (job.suite === 'calibrate') {
          log('prompt calibration failed; skipping the text suite on this backend')
          return failures
        }
      }
    }
  }
  return failures
}

function writeTextMeta (outDir, meta) {
  fs.writeFileSync(path.join(outDir, 'text-meta.json'), JSON.stringify(meta, null, 2) + '\n')
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (a.help || a.h) { process.stdout.write(HELP); return }
  const suite = strOpt(a, 'suite', typeof a.mmproj === 'string' ? 'all' : 'text', ['all', 'vlm', 'text'])
  const runVlm = suite !== 'text'
  const runText = suite !== 'vlm'
  if (typeof a.llm !== 'string') { process.stdout.write(HELP); fail('--llm is required') }
  if (runVlm && typeof a.mmproj !== 'string') { process.stdout.write(HELP); fail('--mmproj is required for the vlm suite (or pass --suite text)') }
  const llm = path.resolve(a.llm)
  const mmproj = runVlm ? path.resolve(a.mmproj) : null
  const textLlm = runText ? path.resolve(strOpt(a, 'text-llm', llm)) : null
  const draft = a.draft !== undefined ? path.resolve(strOpt(a, 'draft')) : null
  for (const p of [llm, mmproj, textLlm, draft]) if (p && !fs.existsSync(p)) fail(`model file not found: ${p}`)
  if (runVlm && /[,|]/.test(llm + mmproj)) fail('model paths must not contain "," or "|"')

  const backends = strOpt(a, 'backend', 'gpu').split(',').map(s => s.trim()).filter(Boolean)
  for (const b of backends) if (b !== 'cpu' && b !== 'gpu') fail(`--backend must be cpu, gpu or cpu,gpu (got '${b}')`)
  const gpuApi = strOpt(a, 'gpu-api', DEFAULT_GPU_API, GPU_APIS)
  const presetName = strOpt(a, 'preset', 'smoke', Object.keys(config.presets))
  const preset = config.presets[presetName]
  const samples = intOpt(a, 'samples', null)
  const repeats = intOpt(a, 'repeats', preset.repeats || 1)
  const tasks = a.tasks !== undefined ? strOpt(a, 'tasks').split(',').map(s => s.trim()).filter(Boolean) : null
  const fixtureDir = path.resolve(strOpt(a, 'fixture-dir', path.join(BENCH_DIR, 'fixture')))
  const items = runVlm ? selectItems(preset, { samples, tasks }) : []
  if (runVlm && !items.length) fail('the preset/tasks selection matched no fixture items')

  const text = runText ? textPlan(a, presetName, draft) : null

  const cacheType = strOpt(a, 'cache-type', 'f16')
  const params = {
    ctxSize: intOpt(a, 'ctx', 4096),
    flashAttn: strOpt(a, 'flash-attn', 'on', ['on', 'off', 'auto']),
    cacheTypeK: cacheType,
    cacheTypeV: cacheType,
    fit: strOpt(a, 'fit', 'off', ['on', 'off']),
    gpuLayers: intOpt(a, 'gpu-layers', 99, 0),
    gpuApi,
    mmprojGpu: !a['mmproj-cpu'],
    perItemPredict: true
  }
  const threads = intOpt(a, 'threads', null)
  const batch = intOpt(a, 'batch', null)
  const ubatch = intOpt(a, 'ubatch', null)
  if (threads) params.threads = threads
  if (batch) params.batchSize = batch
  if (ubatch) params.ubatchSize = ubatch
  // Pin the image-token cap on both engines; unset, the addon applies its own
  // per-projector cap while llama-server uses the model's budget.
  const imgCap = runVlm ? addonDefaultImageMaxTokens(mmproj) : { projector: null, tokens: null }
  const imageMaxTokens = intOpt(a, 'image-max-tokens', imgCap.tokens)
  if (runVlm && imageMaxTokens != null) params.imageMaxTokens = imageMaxTokens
  // Text jobs size ctx per job; the vision-only keys don't apply.
  const textParams = { ...params }
  for (const k of ['ctxSize', 'imageMaxTokens', 'mmprojGpu', 'perItemPredict']) delete textParams[k]
  const port = intOpt(a, 'port', 8089)
  const timeoutMin = intOpt(a, 'timeout-min', 240)

  const host = strOpt(a, 'host-label', os.hostname()).toLowerCase().replace(/[^a-z0-9]/g, '') || 'local'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = path.resolve(strOpt(a, 'out-dir', path.join(BENCH_DIR, 'results', `${stamp}-${host}`)))
  fs.mkdirSync(outDir, { recursive: true })

  checkPrereqs(a)
  if (runVlm) checkFixture(fixtureDir, items, a)
  const addonOrigin = a['skip-addon'] ? null : ensureAddon(a)
  if (!a['skip-addon']) checkBareVersion()
  const fabric = a['skip-server'] ? null : resolveFabricRef(a)
  const addonVer = readJson(path.join(PKG_DIR, 'package.json')).version
  const benchSha = tryExec('git', ['-C', REPO_DIR, 'rev-parse', '--short=12', 'HEAD']) || '?'
  const labelOf = p => path.basename(p).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || 'model'
  const label = labelOf(llm)
  const addonRef = `@qvac/llm-llamacpp@${addonVer} (${addonOrigin})`

  log(`suite: ${suite} · backends: ${backends.join(', ')}${backends.includes('gpu') ? ` (gpu = ${gpuApi})` : ''}`)
  log(`model: ${llm}`)
  if (runVlm) {
    log(`mmproj: ${mmproj} (projector ${imgCap.projector || '?'})`)
    log(`vlm: preset ${presetName} · ${items.length} items × ${repeats} repeats (+1 warmup)`)
  }
  if (runText) {
    log(`text: model ${textLlm} · shape ${text.presetName} · suites ${text.suites.join(', ')} · ${text.jobs.length} jobs` +
      (text.suites.includes('spec') ? ` · spec ${text.specTypes.join(', ')}${draft ? ` (draft ${path.basename(draft)})` : ''}` : ''))
  }
  log(`params: ${JSON.stringify(params)}`)
  log(`output: ${outDir}`)

  const logFiles = []
  const hosts = []
  let failures = 0
  for (const backend of backends) {
    const logFile = path.join(outDir, `vlm-matrix-${host}-${backend}.log`)
    let serverRef = null
    // llama-server for this backend, built (or taken from the cache) on first use.
    let build
    const serverBuild = () => {
      if (build !== undefined) return build
      log(`── build llama-server (${fabric.ref}, ${backend}${backend === 'gpu' ? `/${gpuApi}` : ''}) ──`)
      const code = runInherit(process.execPath, [path.join(BENCH_DIR, 'build-cli-sources.js'),
        '--sources=fabric', `--fabric-ref=${fabric.ref}`, `--backend=${backend}`, `--gpu-api=${gpuApi}`,
        '--target=llama-server'], { cwd: BENCH_DIR })
      build = (code === 0 && (readJson(path.join(BENCH_DIR, 'server-sources-resolved.json')) || {}).fabric) || null
      if (!build) {
        failures++
        log('llama-server build failed; skipping the server legs for this backend')
        return build
      }
      // provenance.commitSha is the checked-out commit; the top-level commitSha
      // of a cache hit is the ls-remote (annotated tag object) SHA.
      const sha = String((build.provenance && build.provenance.commitSha) || build.commitSha).slice(0, 12)
      serverRef = `qvac-fabric ${fabric.ref} @ ${sha}`
      return build
    }
    if (runVlm) {
      fs.writeFileSync(logFile, '')
      logFiles.push({ host, file: logFile })
    }

    if (runVlm && !a['skip-addon']) {
      log(`── addon · ${backend} ──`)
      // Only this run's settings reach the harness: inherited QVAC_VLM_* / QVAC_PERF_RUNS
      // would change the addon leg but not the server leg.
      const env = {}
      for (const [k, v] of Object.entries(process.env)) if (!/^QVAC_(VLM_|PERF_RUNS$)/.test(k)) env[k] = v
      Object.assign(env, {
        QVAC_VLM_MATRIX: '1',
        QVAC_VLM_ALLOW_LOCAL: '1',
        QVAC_VLM_MODE: 'several-sources',
        QVAC_VLM_ENGINE: 'addon',
        QVAC_VLM_SOURCE_ID: 'addon',
        QVAC_VLM_SOURCE_REF: addonRef,
        QVAC_VLM_SOURCES_MODEL: `${label}=${llm}|${mmproj}@ctx=${params.ctxSize}`,
        QVAC_VLM_PRESET: presetName,
        QVAC_VLM_DEVICES: backend,
        QVAC_VLM_REPEATS: String(repeats),
        QVAC_VLM_WARMUP_REPEATS: '1',
        QVAC_VLM_FIXTURE_DIR: fixtureDir,
        QVAC_VLM_PARAMS: JSON.stringify(params),
        QVAC_VLM_TEST_TIMEOUT_MIN: String(timeoutMin)
      })
      if (samples) env.QVAC_VLM_SAMPLES = String(samples)
      if (tasks) env.QVAC_VLM_TASKS = tasks.join(',')
      const code = await runTee('bare', [path.join(BENCH_DIR, 'vlm-matrix.test.js')], { cwd: PKG_DIR, env, logFile })
      if (code !== 0) { failures++; log(`addon leg exited with code ${code}`) }
    }

    if (runVlm && !a['skip-server']) {
      if (serverBuild()) {
        log(`── llama-server · ${backend} ──`)
        const args = [path.join(BENCH_DIR, 'server-runner.cjs'),
          '--binary', build.binaryPath, '--llm', llm, '--mmproj', mmproj,
          '--backend', backend, '--preset', presetName, '--repeats', String(repeats),
          '--fixture-dir', fixtureDir, '--port', String(port), '--label', label,
          `--source-ref=${serverRef}`,
          '--server-log', path.join(outDir, `llama-server-${backend}.log`)]
        if (samples) args.push('--samples', String(samples))
        if (tasks) args.push('--tasks', tasks.join(','))
        const rc = await runTee(process.execPath, args, { cwd: BENCH_DIR, env: { ...process.env, QVAC_VLM_PARAMS: JSON.stringify(params) }, logFile })
        if (rc !== 0) { failures++; log(`llama-server leg exited with code ${rc}`) }
      }
    }

    if (runText) {
      const textBuild = a['skip-server'] ? null : serverBuild()
      failures += await runTextJobs({ a, backend, outDir, host, text, textLlm, textLabel: labelOf(textLlm), draft, textParams, port, addonRef, build: textBuild, serverRef })
    }

    const info = hostInfo(backend, gpuApi)
    hosts.push(info)
    const prov = [
      `**${host} · ${backend}${backend === 'gpu' ? ` (${gpuApi})` : ''}** — ${info.hostname}`,
      `- os: ${info.os} ${info.arch} · cpu: ${info.cpu} (${info.cpu_count} threads) · ram: ${info.ram_gb} GB · gpu: ${info.gpu}`,
      `- node: ${info.node} · bare: ${info.bare}`,
      `- params: ${JSON.stringify(params)}`
    ]
    if (addonOrigin) prov.push(`- addon: \`@qvac/llm-llamacpp@${addonVer}\` (${addonOrigin})`)
    if (fabric) prov.push(`- engine: llama-server from qvac-fabric \`${fabric.ref}\` (${fabric.note})${serverRef ? '' : ' — not built'}`)
    prov.push(`- benchmark code: \`${benchSha}\``)
    if (runVlm) fs.writeFileSync(path.join(outDir, `prov-${host}-${backend}.md`), prov.join('\n') + '\n')
    if (runText) {
      writeTextMeta(outDir, {
        host,
        label: labelOf(textLlm),
        llm: textLlm,
        draft,
        text_preset: text.presetName,
        shape: text.shape,
        suites: text.suites,
        spec_types: text.specTypes,
        params: textParams,
        gpu_api: backends.includes('gpu') ? gpuApi : null,
        addon: addonOrigin ? addonRef : null,
        server: serverRef,
        benchmark_sha: benchSha,
        hosts
      })
    }
  }

  log('── report ──')
  if (runVlm) {
    const reportRc = runInherit(process.execPath, [path.join(BENCH_DIR, 'combine.cjs'), '--dir', outDir, '--out', path.join(outDir, 'report.md'),
      '--title', `VLM benchmark — addon vs llama-server (${host})`, '--mode', 'several-sources',
      '--engine', 'addon vs llama-server', '--preset', presetName], { cwd: BENCH_DIR, stdio: ['ignore', 'ignore', 'inherit'] })
    if (reportRc !== 0) { failures++; log(`report rendering failed (combine.cjs exited ${reportRc})`) }
  }
  let textSummary = null
  if (runText) {
    try {
      textSummary = require('./text-report.cjs').render([outDir], outDir, `Text benchmark — addon vs llama-server (${host})`)
    } catch (e) {
      failures++
      log(`text report rendering failed: ${e.message}`)
    }
  }

  const results = {
    generated_at: new Date().toISOString(),
    model: { llm, mmproj, label, projector: imgCap.projector },
    preset: presetName,
    items: items.length,
    repeats,
    params,
    addon: addonOrigin ? { version: addonVer, origin: addonOrigin } : null,
    llama_server: fabric ? { fabric_ref: fabric.ref, note: fabric.note } : null,
    benchmark_sha: benchSha,
    hosts,
    summary: runVlm ? summarize(logFiles) : [],
    text: runText ? { model: textLlm, draft, preset: text.presetName, shape: text.shape, spec_types: text.specTypes, summary: textSummary } : null
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  if (runVlm) log(`report:  ${path.join(outDir, 'report.md')}`)
  if (runText) {
    log(`text:    ${path.join(outDir, 'text-report.md')}`)
    log(`         ${path.join(outDir, 'text-report.html')}`)
  }
  log(`results: ${path.join(outDir, 'results.json')}`)
  if (failures) { log(`${failures} step(s) failed — see the log above`); process.exitCode = 1 }
}

main().catch(e => { console.error(`[run-local] ${e.stack || e}`); process.exit(1) })
