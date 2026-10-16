import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import fs from 'bare-fs'
import path from 'bare-path'
import { fileURLToPath, pathToFileURL } from 'bare-url'

import type { FitProbeRequest } from '@/resources/model-fit/native-probe/engine-fit'
import { runFit } from '@/resources/model-fit/native-probe/run-fit'

const PROBE: FitProbeRequest = {
  engine: 'llm-llamacpp',
  request: { modelPath: '/models/model.gguf', config: { 'ctx-size': '4096' } }
}

// Neither strategy reaches a fitter here, so the outcome is `unknown` either
// way: the subprocess supervisor refuses an unsupported platform, and the
// in-process path has no model to read.
test('a host that can spawn a child gets the process boundary', async (t) => {
  const result = await runFit(PROBE, {
    mobile: false,
    timeoutMs: 50
  })

  t.is(result.status, 'unknown')
})

test('the caller timeout and signal reach the chosen strategy', async (t) => {
  const controller = new AbortController()
  controller.abort(undefined)

  const result = await runFit(PROBE, { mobile: true, signal: controller.signal })

  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'cancelled')
})

test('an aborted caller is cancelled on the process path too', async (t) => {
  const controller = new AbortController()
  controller.abort(undefined)

  const result = await runFit(PROBE, { mobile: false, signal: controller.signal })

  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'cancelled')
})

// A host that packs the SDK into one bundle (bare-pack, as the QVAC desktop app
// does) carries run-isolated-fit but not fit-runner.js, which is reached only
// through `new URL('./fit-runner.js', import.meta.url)` and so is never packed.
test('a host that packs the SDK without its fit runner still reaches the fitter', async (t) => {
  const bundled = await import(packedWithoutRunner(t))

  const inProcess = await runFit(PROBE, { mobile: true })
  const result = await bundled.runFit(PROBE, { mobile: false, timeoutMs: 10_000 })

  t.is(result.status, 'unknown')
  if (result.status !== 'unknown' || inProcess.status !== 'unknown') return
  t.alike(
    { reason: result.reason, stderr: result.stderrTail?.includes('fit-runner') ?? false },
    { reason: inProcess.reason, stderr: false },
    'the fitter runs in process, instead of a child spawned on a runner that is not there'
  )
})

// The compiled source tree, copied with the runner left out, as a bundle lays it out
function packedWithoutRunner(t: { teardown: (fn: () => void) => void }): string {
  const dist = path.dirname(fileURLToPath(import.meta.url))
  const source = path.join(dist, '..', 'src')
  const copy = path.join(dist, '..', `packed-host-${Date.now()}`)
  fs.cpSync(source, path.join(copy, 'src'), { recursive: true })
  fs.rmSync(path.join(copy, 'src/resources/model-fit/native-probe/fit-runner.js'))
  t.teardown(() => fs.rmSync(copy, { recursive: true, force: true }))

  return pathToFileURL(path.join(copy, 'src/resources/model-fit/native-probe/run-fit.js')).href
}
