# @qvac/fabric

Shared bare addon that hosts the **qvac-fabric** runtime (Tether's fork of
`llama.cpp` + `ggml`) as a single prebuilt shared library. Consumer addons
(`@qvac/llm-llamacpp`, `@qvac/embed-llamacpp`, …) declare `@qvac/fabric` as an
npm dependency and dynamically link against it, so the multi-hundred-megabyte
llama/ggml runtime is **built once** and **loaded once per process** instead of
being statically embedded into every addon.

`binding.js` is one line, `module.exports = require('#host-addon')`. The
`#host-addon` import resolves to the platform package for the current host,
with literal specifiers only, so `bare-pack` and `bare-link` see the whole
graph. See [INTEGRATION.md](./INTEGRATION.md) for the consumer guide.

## What it ships

- **Prebuilt `.bare` shared library** — `qvac__fabric-<host>.bare` (SONAME
  `qvac__fabric-<host>@0.bare`), in the `@qvac/fabric-<host>` platform package.
  It contains `libllama`, `libcommon`, `libmtmd`, and `libggml-base`, and
  exports the full `llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_*` C API, the
  `common_*` and `json_schema_to_grammar` C++ symbols, and the
  `qvac_fabric_*` backend-discovery API declared in `qvac-fabric.h`.
- **C++ headers** (`prebuilds/include/`) — `qvac-fabric.h`, `ggml*.h`, `gguf.h`
  at the root and `llama.h`, `llama-cpp.h`, `common/*.h`, `mtmd/*.h` under
  `include/llama/`.
- **CMake config** (`prebuilds/share/qvac-fabric/`) — `find_package(qvac-fabric)`
  exposes `qvac-fabric::headers` and the host helpers
  `qvac_fabric_platform_package()` / `qvac_fabric_module_name()`.
- **ggml compute backends** — on **Linux, Android, and Windows**, separate shared
  libraries ship under `prebuilds/<host>/qvac__fabric-<host>/` of the platform
  package and are loaded at runtime by `qvac_fabric_load_backends()`. On
  **macOS and iOS** the backends are linked statically inside the `.bare` and
  self-register on load. On **linux-x64** this includes the ROCm/HIP backend
  (`libqvac-ggml-hip.so`, gfx1151) alongside Vulkan; the DL loader skips it on
  non-AMD hosts. Linux packages also include an RPC backend with RDMA
  auto-negotiation and TCP fallback.

## Platform packages

`@qvac/fabric` is a meta package that ships the one-line `binding.js`, headers
and CMake config. Each host's runtime and backends live in a version-locked
platform package, an ordinary addon whose `index.js` is
`module.exports = require.addon()`:

| Host | Package | Module |
| --- | --- | --- |
| linux-x64 (glibc) | `@qvac/fabric-linux-x64` | `qvac__fabric-linux-x64` |
| linux-arm64 (glibc) | `@qvac/fabric-linux-arm64` | `qvac__fabric-linux-arm64` |
| darwin-arm64 | `@qvac/fabric-darwin-arm64` | `qvac__fabric-darwin-arm64` |
| darwin-x64 | `@qvac/fabric-darwin-x64` | `qvac__fabric-darwin-x64` |
| win32-x64 | `@qvac/fabric-win32-x64` | `qvac__fabric-win32-x64` |
| android-arm64 | `@qvac/fabric-android-arm64` | `qvac__fabric-android-arm64` |
| ios (device + simulators) | `@qvac/fabric-ios` | `qvac__fabric-ios` |

Desktop packages are `os`/`cpu`-filtered `optionalDependencies`, so installers
pick the right one; do not depend on them directly. Supported installers are
npm 7+, pnpm, bun, and Yarn Berry. Yarn v1 and `--omit=optional` installs skip
the platform package, and `require('@qvac/fabric')` (or `bare-pack`) then fails
naming `#host-addon`. A host without a platform package resolves to
`addon-unavailable.js`, which throws.

Mobile targets are cross-built, so no install host ever matches their `os`.
Mobile applications must declare `@qvac/fabric` and the target's platform
package as direct dependencies at the same exact version, one that satisfies
the `@qvac/fabric` range their addons declare. The meta package lists them as
optional peers.

Source builds (`npm run build`) finish with `npm run link:platform`, which
creates `node_modules/@qvac/fabric-<host>` inside this package with its
`prebuilds/<host>` linked to the fresh build, so `#host-addon` and the CMake
template resolve the local runtime without a publish.

### Backend discovery

The runtime finds its own backends; consumers pass no path. The lookup order
of `qvac_fabric_backends_dir()` is:

1. `$QVAC_FABRIC_BACKENDS_DIR`, when set;
2. `<runtime dir>/qvac__fabric-<host>/`, when it exists (installed and
   `bare-pack`ed layouts);
3. `<runtime dir>` itself (`bare-link`ed layouts, where backends sit next to
   the runtime, including inside an APK).

`qvac_fabric_load_backends()` loads that directory once per process.
`require('@qvac/fabric')` exposes the same two calls as `backendsDir()` and
`loadBackends()`.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Consumer addons (.bare)                                   │
│  @qvac/llm-llamacpp   @qvac/embed-llamacpp   …             │
│  link qvac-fabric::headers + DT_NEEDED qvac__fabric-<host> │
└───────────────────────────┬────────────────────────────────┘
                            │ (ELF SONAME dedup → one load)
┌───────────────────────────▼────────────────────────────────┐
│  qvac__fabric-<host>@0.bare  (@qvac/fabric-<host>)          │
│  libllama · libcommon · libmtmd · libggml-base              │
│  + ggml backend modules (.so/.dll; static on Apple)         │
│  exports llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_* /     │
│          common_* / json_schema_to_grammar                  │
└───────────────────────────┬────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────┐
│  qvac-fabric vcpkg port (forked llama.cpp + ggml)           │
└──────────────────────────────────────────────────────────┘
```

**Key design points:**

- **Single runtime load** — Every consumer addon's `.bare` has
  `DT_NEEDED: qvac__fabric-<host>@0.bare`. The dynamic linker deduplicates by SONAME,
  so the llama/ggml runtime is loaded exactly once per process, no matter how
  many fabric-based addons are present.
- **Minimal JS API** — `@qvac/fabric` is a carrier module. Consumers `require()`
  it to register the `.bare` with the bare runtime before resolving their own
  addon (see INTEGRATION.md Step 5). Besides `backendsDir()` and
  `loadBackends()`, all inference happens through the consumer's own C++ code
  against the shipped headers.
- **One C++ runtime (Linux)** — the module embeds libc++ and exports the Itanium
  C++ ABI under the ELF version node `QVAC_FABRIC_ABI_1`. Consumer addons link
  with `-nostdlib++` and record a `DT_VERNEED` on that node, which is what keeps
  their `__cxa_*` / typeinfo references from binding to the GNU `libstdc++.so.6`
  that the `bare` executable brings into the process' global lookup scope. The
  node name is part of the ABI: renaming it requires rebuilding every consumer.
  See `symbols.map` and `arch/qips/linux-fabric-libcxx-ownership.md`.
- **Backends** — ggml compute backends are self-contained: each links its own
  ggml statically and imports no `ggml_*` from the module that `dlopen`s it.

## Build

```bash
npm install
npm run build   # bare-make generate/build/install, then npm run link:platform
```

Linux builds require the libibverbs development package (`libibverbs-dev` on
Debian/Ubuntu). On **linux-x64** a ROCm/TheRock SDK is also required, discovered
via `ROCM_PATH` or `/opt/rocm`. The `hip` port is deterministic — it hard-fails
rather than installing empty, so that the vcpkg binary cache cannot conflate a
no-HIP build with a real one under the same ABI hash. The `hip` dependency is
gated on `linux & x64`.

Linux hosts that use the RPC backend must provide `libibverbs.so.1`
(`libibverbs1` on Debian/Ubuntu). RDMA use also requires the provider package
for the host's hardware. The library is required even when the connection
falls back to TCP because the dynamic loader resolves it before loading the RPC
backend. Other Fabric backends remain available when the RPC backend cannot be
loaded.

### Opt-in Hexagon development build

Hexagon is disabled by default. An Android arm64 source build can opt in with
`-D QVAC_HEXAGON=ON`. This requests the registry port's `hexagon-backend`
feature and requires Hexagon SDK 6.6.0.0 with Hexagon Tools 19.0.07. Set
`HEXAGON_SDK_ROOT` and, when the tools are installed separately,
`HEXAGON_TOOLS_ROOT` before configuring; the Android triplet tracks both
values in the vcpkg cache identity. Missing or mismatched tools fail the build.

Fabric's Android arm64 prebuild configuration enables `QVAC_HEXAGON=ON`.
The reusable prebuild workflow downloads and caches the pinned Linux Hexagon
SDK archive, verifies its SHA-256, and exports the SDK and tools paths before
configuration. Other platform entries keep their existing settings. PR
workflows using `pull_request_target` load workflow definitions from the base
branch, so workflow changes must be available there before those runs can
exercise the new configuration.

The registered development overlay pins engine revision
`d312abcad4b15944e4eaa65e042185e7ed58c12b` from engine PR
[#402](https://github.com/tetherto/qvac-fabric-llm.cpp/pull/402). It includes
the standard/quick Hexagon GELU dispatch and F32 QUICK GELU CPU precision
fixes, plus the BF16 projection acceleration. Explicit CPU reference mode
evaluates QUICK GELU directly. The optimized unary F32 path retains
lookup-based execution with F32 table outputs; the existing FP16 and
gated-operation tables are unchanged. The extra F32 table uses 256 KiB.
Hexagon caches eligible BF16 matrix weights as F16 while preserving BF16
readback and refreshing the cache after uploads. The EmbeddingGemma 2
projection cache adds 12 MiB and uses F16 range and precision.

The engine REF and archive SHA-512 live in
`vcpkg-overlays/ports/qvac-fabric/portfile.cmake`. No local engine patch is
applied. This temporary validation overlay does not change a released
package version. It changes the engine source for every Fabric platform,
including Hexagon-disabled builds, so run normal Fabric and consumer
checks. Replace it with a matched engine release and registry pin when
those are available, following
[INTEGRATION.md](./INTEGRATION.md#fabric-stack-prs-parallel-qvac-fabric-development).

```bash
export HEXAGON_SDK_ROOT=/path/to/Hexagon_SDK/6.6.0.0
export HEXAGON_TOOLS_ROOT="$HEXAGON_SDK_ROOT/tools/HEXAGON_Tools/19.0.07"
bare-make generate --platform android --arch arm64 -D QVAC_HEXAGON=ON
bare-make build
bare-make install
npm run link:platform
```

The platform package stages `libqvac-ggml-hexagon.so` with the other host
backends and preserves `libggml-htp-v73.so`, `v75`, `v79` and `v81` as raw DSP
sidecars directly beside those backends in the runtime companion directory.
Bare-link copies these direct `.so` companions without rewriting their contents.
The sidecars contain Hexagon ELF code. For an extracted runtime directory,
`qvac_fabric_load_backends()` adds that directory to `DSP_LIBRARY_PATH`,
preserving existing semicolon-separated entries without adding a duplicate.
If `DSP_LIBRARY_PATH` is unset, existing `ADSP_LIBRARY_PATH` entries are carried
into the new preferred variable; `ADSP_LIBRARY_PATH` itself stays unchanged.
A caller that supplies its own backend loader/path must configure the DSP
search path before loading Hexagon.

The consuming Android application must extract its native libraries to a real
directory before FastRPC loads the sidecars. Enable
`android.packaging.jniLibs.useLegacyPackaging = true` in the application's
Gradle configuration and verify that the final merged manifest has
`android:extractNativeLibs="true"`. An APK-internal path cannot serve as the
DSP search directory. Declare optional access to the device's FastRPC library
inside the manifest's `<application>` element:

```xml
<uses-native-library android:name="libcdsprpc.so" android:required="false" />
```

Keep any SDK stub `libcdsprpc.so` out of the APK, for example with
`android.packaging.jniLibs.excludes += "**/libcdsprpc.so"`. These are consumer
application settings; the Fabric build does not change Expo or Kotlin app
configuration. Verify all four sidecars in the final APK and extracted
installation, device vendor-library access, HTP session creation and real
embedding execution in the installed app. A source build or shell benchmark
does not establish mobile SDK support.

## Supported platforms

| Platform | Triplet | Backends |
|----------|---------|----------|
| Linux | `x64-linux`, `arm64-linux` | shared `.so` under `prebuilds/<host>/qvac__fabric-<host>/` (RPC with RDMA auto-negotiation; x64 also ships ROCm/HIP) |
| macOS | `arm64-osx` | static (CPU, Metal) inside `.bare` |
| Windows | (default MSVC) | dynamic `.dll` under `prebuilds/<host>/qvac__fabric-<host>/` |
| Android | `arm64-android` | shared `.so` under `prebuilds/<host>/qvac__fabric-<host>/` |
| iOS | `arm64-ios` | static inside `.bare` |
