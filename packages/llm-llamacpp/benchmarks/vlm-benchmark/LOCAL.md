# Local benchmark: addon vs llama-server (vision + text)

`run-local.cjs` compares the `@qvac/llm-llamacpp` addon with **llama-server** on any desktop
host where this repo is checked out: macOS, Linux or Windows, on CPU, Metal, Vulkan or CUDA.
It does not run in CI.

It has two suites, and runs both by default:

- **vlm:** a model GGUF plus its mmproj, over the same images, scored for quality and speed.
- **text:** text-only workloads on the same model: single-stream prefill and decode,
  concurrent requests, and speculative decoding (see §6).

```bash
cd packages/llm-llamacpp
# both suites
npm run benchmarks:vlm -- --llm /models/Qwen3.5-0.8B-Q8_0.gguf --mmproj /models/mmproj-Q8_0.gguf
# text only (any text GGUF; no mmproj or fixture needed)
npm run benchmarks:vlm -- --llm /models/Qwen3-8B-Q4_K_M.gguf --suite text
```

**Contents**
1. [What one run does](#1--what-one-run-does)
2. [One-time host setup](#2--one-time-host-setup)
3. [Running](#3--running)
4. [Options](#4--options)
5. [What is held equal between the engines](#5--what-is-held-equal-between-the-engines)
6. [Text suite](#6--text-suite)
7. [Output](#7--output)
8. [Comparing machines](#8--comparing-machines)
9. [Troubleshooting](#9--troubleshooting)
10. [Limitations](#10--limitations)

---

## 1 · What one run does

For each backend you ask for (`--backend cpu,gpu`), `run-local.cjs` does these steps. The
image steps (3, 5) are skipped with `--suite text`, the text step (6) with `--suite vlm`:

1. **Checks the host.** It looks for Node ≥ 18, `bare`, `git`, `cmake` and a C/C++
   compiler, and for the vlm suite checks that the fixture images are present. If
   something is missing, it names it and stops.
2. **Prepares the addon.**
   - If `node_modules/` is missing, it runs `npm install`.
   - If `prebuilds/` has no addon build for this platform, it installs the prebuild of this
     checkout's version from npm.
   - A prebuild you already have, for example from `npm run build`, is used as it is.
3. **Runs the addon leg.** The existing harness (`vlm-matrix.test.js`) runs under `bare`
   with your model files: one warmup pass, then the measured passes.
4. **Builds llama-server** from the **qvac-fabric tag the addon is built on**.
   - The tag is `v<version>`, using the `qvac-fabric` version in
     `packages/fabric/vcpkg.json`.
   - The build is cached in `cli-builds/` per OS, arch, backend, GPU API and commit, so
     later runs reuse it. Both suites use the same build.
5. **Runs the llama-server leg.** It starts one server on `127.0.0.1` with a per-run API
   key, sends one warmup request, then posts every fixture item to
   `/v1/chat/completions`.
6. **Runs the text suite.** Each text configuration is one job: the addon in a fresh `bare`
   process, then llama-server freshly started with the same settings (§6).
7. **Writes the reports.** `report.md` (vlm) uses the same renderer as the CI report;
   `text-report.md` and `text-report.html` hold the text suite; `results.json` holds both
   in machine-readable form.

## 2 · One-time host setup

Every host needs:

- **Node.js ≥ 18**
- **A current bare**: `npm install -g bare@latest`. Some installed dependencies need a
  newer bare than the package's own `engines` floor (for example `bare-dns` needs ≥ 1.33);
  the runner checks this before the addon leg and names the package that needs it.
- **git** and **cmake ≥ 3.14**
- **A C/C++ compiler** to build llama-server. The addon itself comes prebuilt.

Extra setup per platform:

- **macOS (Apple silicon):** install the Xcode command-line tools with
  `xcode-select --install`. Metal needs nothing else.
- **Linux:** install `build-essential` (or clang).
  - For `--backend gpu` with Vulkan, the default, also install the Vulkan SDK or
    `libvulkan-dev`, and put `glslc` (or `glslangValidator`) on PATH.
  - With `--gpu-api cuda`, install the CUDA toolkit instead.
  - Either way, the host needs a working GPU driver.
- **Windows:** install one of these toolchains:
  - Visual Studio Build Tools with the C++ workload;
  - clang + Ninja, with `CMAKE_GENERATOR=Ninja`, `CC=clang` and `CXX=clang++` set.

  For the GPU backend, add the Vulkan SDK, or the CUDA toolkit with `--gpu-api cuda`.

**NVIDIA and AMD hosts.** The addon prefers CUDA when it is available. The benchmark
always pins the addon to the API that llama-server is built with:

- By default that is Vulkan, so both engines run Vulkan.
- To compare on CUDA, pass `--gpu-api cuda` (needs the CUDA toolkit).

### Fixture images

The images are **not in git**. They live in a private bucket, `s3://tether-ai-dev/vlm-benchmark/`.
There are two ways to get them:

- **With AWS access to the bucket:** add `--sync-fixture` to the first run. It runs
  `aws s3 sync` into `benchmarks/vlm-benchmark/fixture/`.
- **Without AWS access:** copy the images once from a teammate or another machine. Put them
  in `benchmarks/vlm-benchmark/fixture/`, or keep them elsewhere and pass
  `--fixture-dir <dir>`.

Only the images for the preset you run need to be present. If any are missing, the runner
lists them before it starts.

The text suite needs no fixture.

### Models

Any GGUF + mmproj pair that llama.cpp supports will work for the vlm suite; any GGUF for
the text suite. Put the files anywhere and pass absolute or relative paths. The files are
used where they are; nothing is copied or downloaded.

## 3 · Running

Run from `packages/llm-llamacpp`. These two forms are equivalent:
```bash
npm run benchmarks:vlm -- --llm <model.gguf> --mmproj <mmproj.gguf> [options]
node benchmarks/vlm-benchmark/run-local.cjs --llm <model.gguf> --mmproj <mmproj.gguf> [options]
```

Typical runs:

```bash
# Wiring check: one image on the GPU (the default preset and backend)
npm run benchmarks:vlm -- --llm ~/models/qwen.gguf --mmproj ~/models/qwen-mmproj.gguf

# The real comparison: the 5 VQA tasks × 5 samples, 3 repeats, CPU and GPU
npm run benchmarks:vlm -- --llm ~/models/qwen.gguf --mmproj ~/models/qwen-mmproj.gguf \
  --preset cognitive --repeats 3 --backend cpu,gpu

# Everything (VQA + OCR), fixed thread count, fixture kept outside the repo
npm run benchmarks:vlm -- --llm ~/models/qwen.gguf --mmproj ~/models/qwen-mmproj.gguf \
  --preset full --threads 8 --fixture-dir ~/vlm-fixture

# NVIDIA host, comparing on CUDA instead of Vulkan
npm run benchmarks:vlm -- --llm … --mmproj … --gpu-api cuda

# First run on a host with AWS access: also fetch the fixture
npm run benchmarks:vlm -- --llm … --mmproj … --sync-fixture

# Text suite only, the standard matrix: p512/p2048 × n128, concurrency 1–16, speculation
npm run benchmarks:vlm -- --llm ~/models/qwen3-8b-q4_k_m.gguf --suite text --text-preset standard

# Speculative decoding on both engines (addon from #4849's CI prebuild, see §6):
# an MTP model gets draft-mtp automatically; a DFlash --draft adds draft-dflash
npm run benchmarks:vlm -- --llm ~/models/Qwen3.8-27B-UD-Q4_K_XL.gguf --suite text --text-suites spec \
  --draft ~/models/Qwen3.8-27B-DFlash2-Q8_0.gguf --spec-draft-n-max 7 \
  --addon-prebuild ~/Downloads/prebuild-llm-llamacpp-darwin-arm64

# Classic draft model (llama-server only; same vocabulary as --llm)
npm run benchmarks:vlm -- --llm ~/models/qwen3-8b-q4_k_m.gguf --suite text --text-suites spec \
  --draft ~/models/qwen3-0.6b-q8_0.gguf

# Concurrency sweep only, higher levels
npm run benchmarks:vlm -- --llm … --suite text --text-suites conc --concurrency 1,4,8,16,32
```

The first GPU run spends a few minutes building llama-server. Later runs reuse that build.

Presets (`config.cjs`) set how many images run:

- `smoke`: 1 image; a wiring check. This is the default.
- `cognitive`: the 5 VQA tasks × 5 samples.
- `ocr1page`: 1 document page (OCR).
- `ocr5pages`: 5 document pages (OCR); heavy.
- `full`: `cognitive`, plus `ocr-small` × 5 and 1 document page.

## 4 · Options

`--help` prints the full list.

- **Model files:** `--llm` (required); `--mmproj` (required for the vlm suite);
  `--text-llm` (a different model for the text suite); `--draft` (draft model for
  speculative decoding: a DFlash draft, or a small same-vocabulary model).
- **Suites:** `--suite all|vlm|text` (default `all` when `--mmproj` is given, else `text`).
- **Text suite** (§6):
  - `--text-preset quick|standard|full` (default `quick` with `--preset smoke`, else
    `standard`)
  - `--text-suites single,conc,spec` (default: all three)
  - `--text-prompts 512,2048`, `--text-gen 128`, `--text-repeats 3`
  - `--concurrency 1,2,4,8,16`
  - `--spec-types ngram-simple,draft-mtp,draft-dflash,…` (default: see §6),
    `--spec-draft-n-max 7`, `--spec-gen 512`, `--spec-concurrency 1,4,8`
- **Backend:**
  - `--backend cpu|gpu|cpu,gpu` (default `gpu`).
  - `--gpu-api metal|vulkan|cuda` (default `metal` on macOS, `vulkan` elsewhere).
- **Run size:**
  - `--preset`, `--samples`, `--repeats`, `--tasks`. Defaults come from the preset;
    `--tasks` is a comma-separated list such as `textvqa,docvqa`.
  - `--timeout-min` (default 240) caps the addon leg's run time.
- **Fixture:** `--fixture-dir <dir>` points at the images; `--sync-fixture` fetches them
  from S3 first.
- **Engine parameters**, applied to both engines (see §5):
  - `--ctx` (default 4096)
  - `--threads`, `--batch`, `--ubatch` (default: the engine default, which is the same for
    both)
  - `--flash-attn` (default `on`)
  - `--cache-type` (default `f16`)
  - `--gpu-layers` (default 99)
  - `--mmproj-cpu`
  - `--image-max-tokens` (default: the addon's cap for the projector)
  - `--fit` (default `off`)
- **Engine source:** `--fabric-ref <tag|sha>` builds llama-server from a different
  qvac-fabric tag or commit. Use it when §9 says so, or to test another engine version.
- **Addon prebuild:**
  - `--addon-version <ver|latest>` picks the npm version to install when `prebuilds/` has
    none. There is no automatic fallback to another version.
  - `--addon-prebuild <dir>` runs against another addon build, such as a PR's CI prebuild
    artifact (a directory holding `<platform>-<arch>/qvac__llm-llamacpp.bare`). The
    checkout's `prebuilds/` is moved aside for the run and restored when it exits.
- **One leg only:** `--skip-addon`, `--skip-server`.
- **Output and port:**
  - `--out-dir` (where results go)
  - `--host-label` (the host's name in the report)
  - `--port` (llama-server; default 8089, and the run stops if the port is busy)

## 5 · What is held equal between the engines

Both engines use the same model files, the same fixture items and the same scoring. The
following are also held equal:

- **Engine version:** llama-server is built from the qvac-fabric tag the addon links,
  found in `packages/fabric/vcpkg.json`.
- **Prompt shape:** a system message ("You are a helpful assistant."), then one user turn
  holding the image followed by the question. The addon folds its media message into the
  next user message, so llama-server gets the same single turn; `prompt_tokens` should
  match between the engines.
- **Sampling:** greedy, at temperature 0 with seed 42.
- **Output cap:** set per item from the task: 128 tokens for VQA, 96 for `ocr-small`, 768
  for `ocr-page`.
- **Reasoning:** off. The addon gets `reasoning-budget 0`, which also renders the chat
  template with thinking disabled. The server gets `--reasoning off --reasoning-budget 0`,
  because on llama-server the budget alone does not change the template.
- **Image-token cap:** pinned on both engines.
  - Unless you set `--image-max-tokens`, the cap is the one the addon applies for the
    mmproj's projector: 2048 for Qwen-VL, 280 for Gemma 4, and the model's own budget for
    other projectors.
  - llama-server would otherwise use the model's own budget for every projector.
- **Context, threads and batch:**
  - `--ctx` is applied to both engines.
  - `--threads`, `--batch` and `--ubatch` are applied to both when given. Otherwise both
    keep llama.cpp's common default.
- **Flash attention and KV cache:** set explicitly on both (`on`, `f16`). The addon's own
  defaults differ from llama-server's: it turns flash attention on, and on GPU switches
  the KV cache to q8_0.
- **GPU placement:**
  - Both use the same GPU API: the addon's `backend` is pinned to `--gpu-api`.
  - Both put `--gpu-layers` layers on the GPU.
  - Both use a single device: llama-server gets `--split-mode none`, which is the addon's
    default.
  - The vision projector runs on the GPU unless `--mmproj-cpu` is given.
- **CPU backend:** nothing is offloaded on either engine. llama-server also gets
  `--device none`.
- **Memory auto-fit:** off on both, so neither engine quietly shrinks ctx or layers.
- **Prompt cache:** disabled on the server (`cache_prompt: false`, `--cache-ram 0`, one
  slot), so every request prefills in full, as the addon does.
- **Warmup and repeats:** one warmup request per engine, dropped from the stats. Then both
  run the same number of measured repeats.

## 6 · Text suite

Three workloads on the same text model, each run on both engines and on every backend:

- **Single stream** (`single`): one request at a time at fixed prompt lengths (default
  512 and 2048 tokens) and a fixed generation length (128), like `llama-bench -p 512,2048
  -n 128`. Reports prefill tok/s, decode tok/s and TTFT from each engine's own counters.
- **Concurrent requests** (`conc`): N requests in flight at once (default 1, 2, 4, 8, 16),
  512-token prompts, 128 generated tokens each. Reports aggregate tok/s (all generated
  tokens ÷ batch wall time), per-request decode tok/s, median TTFT (client-measured, so
  queueing counts) and peak RSS.
- **Speculative decoding** (`spec`): four prompts (code, rewrite, story, explain), up to
  512 generated tokens, stopping at EOS. Both engines run their baseline and every
  `--spec-types` mode they support (below). Reports decode tok/s per prompt, the speedup
  against the same engine without speculation, addon vs llama-server on the same mode,
  and draft acceptance (accepted ÷ drafted tokens). With `--spec-concurrency 1,4,8` it
  also runs speculation under concurrency.

Presets set the run size:

- `quick`: p512 × n64 once, concurrency 1 and 4, two speculative prompts at 256 tokens.
  The default with `--preset smoke`; a wiring check.
- `standard`: p512 and p2048 × n128 × 3 repeats, concurrency 1–16 × 2 rounds, all four
  speculative prompts × 2.
- `full`: p128–p4096, concurrency 1–32 × 3 rounds, speculation also at 4 and 8 concurrent.

**Speculative modes.** `--spec-types` takes llama-server's `--spec-type` values. Which
engine runs which:

- **Both engines:** `draft-mtp` and `draft-dflash`. The addon's speculative decoding comes
  from [tetherto/qvac#4849](https://github.com/tetherto/qvac/pull/4849) (`spec-type`,
  `spec-draft-model`, `spec-draft-n-max` load keys; `draftTokens` / `draftAcceptedTokens`
  stats), which the benchmark passes the same values as llama-server's flags.
  - `draft-mtp` uses the model's own multi-token-prediction layers. Not every GGUF keeps
    them (unsloth's Qwen3.5 quants strip them; ggml-org's keep them).
  - `draft-dflash` needs a DFlash block-diffusion draft model, passed with `--draft`.
- **llama-server only:** `ngram-*` (draft from text already in the context; helps most on
  copy-heavy output such as rewrites and code), `draft-simple` (a small `--draft` model
  with the **same vocabulary** as `--llm`, e.g. Qwen3-0.6B for Qwen3-8B) and
  `draft-dspark`.

Without `--spec-types` the run picks: `ngram-simple`; `draft-mtp` when the GGUF has MTP
layers (`<arch>.nextn_predict_layers > 0`); and, with `--draft`, `draft-dflash` for a
DFlash draft (`general.architecture = dflash`) or `draft-simple` otherwise.
`--spec-draft-n-max` pins the draft length on both engines; without it each keeps its
default (the addon lowers it to fit a batch, with a warning).

**Addon builds without #4849.** Until #4849 is released, the addon's speculative modes need
a build from that PR. Download the PR's `prebuild-llm-llamacpp-<platform>-<arch>` artifact
from its CI run (the PR's *Checks* tab, or `gh run download <run-id> --repo tetherto/qvac
--name prebuild-llm-llamacpp-darwin-arm64 --dir <dir>`) and pass `--addon-prebuild <dir>`,
or build the addon from the PR branch. With a build that lacks it, the addon's speculative
rows fail with `invalid argument: --spec-type` and are listed under *Failed
configurations*; everything else still runs.

**Held equal**, beyond §5:

- **Prompts:** the same chat messages on both engines (one user turn), rendered by each
  engine's chat template with thinking off. Prompt lengths are calibrated once, on the
  first engine run, by adjusting filler text until the rendered prompt is the target
  token count. Every request gets a unique fixed-width document number, so no prompt
  cache can hit, without changing the token count. The tables show the prompt tokens each
  engine actually processed.
- **Generation length:** EOS is ignored for `single` and `conc` (addon `ignore-eos`,
  server `ignore_eos`), so every request generates exactly the target length.
- **Slots and KV:** the addon gets `parallel = N`; llama-server gets `-np N
  --no-kv-unified`. Both split the context evenly, and each job sizes its context to N ×
  (prompt + generation + headroom).
- **Fresh state:** every configuration is a new model load: a new `bare` process for the
  addon, a new server for llama-server. Peak RSS is therefore per configuration.
- **Warmup:** the first request (or first round of N) in every job is dropped.

**Outputs:** `text-report.md`, `text-report.html` (charts plus tables, self-contained),
`text-<host>-<backend>.log` (raw `[TEXTROW]` / `[TEXTBATCH]` markers),
`text-calibration.json`, `plans/` (the exact job each engine ran) and
`llama-server-text-<backend>.log`. Re-render or merge hosts with
`node benchmarks/vlm-benchmark/text-report.cjs --dir <dir>[,<dir>…] --out <dir>`.

## 7 · Output

Each run writes to `benchmarks/vlm-benchmark/results/<timestamp>-<host>/`, which git
ignores:

- `report.md`: the consolidated report, with one column per engine (`addon`,
  `llama-server`). It covers:
  - quality, overall and per task
  - speed
  - peak RSS
  - OCR CER/WER/BLEU
  - resolved versions
- `results.json`: for each engine and backend:
  - run and error counts
  - `ttft_ms`, `prefill_tps`, `decode_tps`, `wall_ms`, `vision_enc_ms`, `peak_rss_mb`
  - `quality_pct`, `quality_by_task_pct` and `ocr`

  It also records the host info, the parameters, the addon version and the fabric ref.
  The `text` block holds the text-suite summary (`single`, `conc`, `spec` arrays).
- `text-report.md` / `text-report.html` and the other text-suite files: see §6.
- `vlm-matrix-<host>-<backend>.log`: the raw markers for both legs. `combine.cjs` can
  render them again later.
- `llama-server-<backend>.log`: the server's own log.
- `prov-<host>-<backend>.md`: the host and software provenance shown in the report.

These files contain the hostname, absolute model paths and hardware details. Check them
before you share a report outside the team.

How each metric is measured:

- **TTFT, prefill tok/s and decode tok/s** come from each engine's own counters, and
  prefill includes the image.
  - The addon reports `TTFT`, `ppTPS` and `TPS`.
  - llama-server reports `timings.prompt_ms`, `prompt_per_second` and
    `predicted_per_second`.
  - The server's client-side first-token time is kept per row as `client_ttft_ms`.
- **Wall time** (`ms`) is the full request: in-process for the addon, and over HTTP for
  llama-server. It is useful for context, not as an engine comparison.
- **mmproj encode:**
  - for the addon, `visionEncodeMs`
  - for llama-server, the time from the `encoding mtmd batch` log line to the first
    `decoding image batch` line, read from the log timestamps (the server runs at
    `--verbosity 4 --log-timestamps`). Both cover the encoder pass only.
- **Peak RSS** is the whole-process high-water mark.
  - For the addon, this is the `bare` process, so it includes the Bare runtime (tens of MB).
  - For llama-server, it is the kernel high-water mark on Linux (`VmHWM`) and
    `PeakWorkingSet64` on Windows.
  - On macOS, the server's RSS is sampled every 100 ms, so its true peak can be slightly
    higher.

## 8 · Comparing machines

1. Run the same command on each machine, with a different `--host-label` on each.
2. Copy every machine's `vlm-matrix-<host>-<backend>.log` and `prov-*.md` files into one
   directory.
3. Render one combined report:

```bash
node benchmarks/vlm-benchmark/combine.cjs --dir <that-dir> --out <that-dir>/report.md \
  --mode several-sources --engine "addon vs llama-server" --preset <preset>
```

Each machine gets its own row, with an `addon` column and a `llama-server` column.

For the text suite, point `text-report.cjs` at each machine's results directory; each host
gets its own tables and charts:

```bash
node benchmarks/vlm-benchmark/text-report.cjs --dir <host-a-dir>,<host-b-dir> --out <out-dir>
```

`results.json` files can be merged by any script; each one carries its own host block.

For results you can compare across machines:

- Keep the preset, `--repeats`, the parameters and the model files identical.
- Keep the checkout identical on every machine, so they use the same addon version and
  fabric tag. Both appear in the report's *Sources* table.
- On laptops, plug in power and close heavy apps.

## 9 · Troubleshooting

- **`fixture images missing`:** copy the images into `fixture/`, or pass `--fixture-dir`.
  See §2.
- **`installed @qvac/fabric is X but packages/fabric is Y`:** the addon's shared runtime
  came from npm at a different version than this checkout's `packages/fabric`. The
  default llama-server tag may then not match the addon's engine. Either:
  - pass `--fabric-ref v<qvac-fabric version of X>`, taken from that release's
    `packages/fabric/vcpkg.json`; or
  - update the checkout so the versions match.
- **`npm pack @qvac/llm-llamacpp@<ver> failed`:** this checkout's version is not on npm.
  - Build the addon locally with `npm run build` (see `packages/llm-llamacpp/build.md`), or
  - pick a published version with `--addon-version`.
- **`addon prebuild is X but the checkout's JS is Y`:** the prebuild came from a different
  version than the checkout's JS. Build locally for an exact match.
- **The llama-server build fails with `--backend gpu`:** the GPU SDK is missing. Check with
  `glslc --version` for Vulkan, or `nvcc --version` for CUDA.
- **The model fails to load or runs out of memory:** lower `--ctx` or `--gpu-layers`, or
  pass `--fit on`. With `--fit on`, each engine may choose a different placement, so check
  the logs.
- **`port … is already in use`:** pass `--port <free port>`.
- **A leg had errors:** the *Test Results* section of `report.md` counts the failures, and
  each failing row in the `.log` carries its error.
- **`llama-server exited … before becoming healthy` in a text job:** the lines after it are
  the server's own errors. The usual causes are a `--spec-types` mode the model cannot
  use (`draft-mtp` on a model without MTP layers, `draft-simple` with a draft of another
  vocabulary) or a context too large for memory at a high `--concurrency`.
- **`invalid argument: --spec-type` from the addon:** the addon build has no speculative
  decoding; see *Addon builds without #4849* in §6.
- **`prompt calibration failed`:** the model could not be loaded for the calibration pass;
  the error above it says why. The rest of the text suite is skipped on that backend.
- **A speculative row shows no acceptance:** the mode drafted nothing. `ngram-*` modes only
  draft once the output repeats text already in the context; short generations may never
  get there. Raise `--spec-gen`.

## 10 · Limitations

- **Desktop only.** Phones run the addon through the CI workflow (`README.md` §1); there is
  no llama-server on phones.
- **CPU builds differ slightly.** llama-server is compiled for the host CPU
  (`GGML_NATIVE=ON`), while the addon's fabric runtime picks the best prebuilt CPU variant
  when it loads. Both should use the same instruction set, but BLAS and OpenMP settings may
  differ between the two builds.
- **Multi-GPU hosts.** Both engines use a single GPU, but they may not choose the same one.
  To make them use the same GPU, expose only that one before running, with
  `GGML_VK_VISIBLE_DEVICES=<n>` (Vulkan) or `CUDA_VISIBLE_DEVICES=<n>` (CUDA). Both legs
  inherit the variable.
- **The quality fixture is required for the vlm suite.** Speed-only runs on arbitrary
  images are not supported.
- **Only the parameters in §5 and §6 are shared.** Engine flags that `run-local.cjs` does
  not expose (tensor split and so on) stay at each engine's default.
- **Speculative decoding on the addon needs #4849.** It covers `draft-mtp` and
  `draft-dflash`; the other modes compare llama-server's speculation against both engines'
  baselines.
- **Prompt rendering.** The addon accepts chat messages only, so the text suite measures
  chat-templated prompts on both engines rather than raw token sequences.
- **Text quality is not scored.** The text suite measures speed and memory; greedy outputs
  may diverge between engines after some tokens.
