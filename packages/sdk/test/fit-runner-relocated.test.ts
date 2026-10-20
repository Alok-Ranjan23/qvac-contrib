import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { bundleSdk } from '@/commands/bundle/index'

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = `${process.platform}-${process.arch}`
const require = createRequire(import.meta.url)
const BARE = path.join(
  path.dirname(require.resolve('bare-sidecar/package')),
  'prebuilds',
  HOST,
  process.platform === 'win32' ? 'bare.exe' : 'bare'
)

function hasLlmAddon(): boolean {
  return fs.existsSync(path.join(SDK_DIR, 'node_modules', '@qvac', `fabric-${HOST}`))
}

test(
  'a relocated worker folder runs a fit check from its own files',
  { skip: !hasLlmAddon() },
  async function (t) {
    t.timeout(120_000)

    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-fit-project-')))
    const moved = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-fit-moved-')))
    t.teardown(() => {
      fs.rmSync(projectRoot, { recursive: true, force: true })
      fs.rmSync(moved, { recursive: true, force: true })
    })

    fs.symlinkSync(
      path.join(SDK_DIR, 'node_modules'),
      path.join(projectRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const configPath = path.join(projectRoot, 'qvac.config.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin'] })
    )

    const result = await bundleSdk({ projectRoot, sdkPath: SDK_DIR, configPath, quiet: true })
    const workerDir = path.dirname(result.bundlePath)
    t.ok(fs.existsSync(path.join(workerDir, 'fit-runner.bundle')), 'the bundle ships a fit runner')

    const relocated = path.join(moved, 'worker')
    fs.cpSync(workerDir, relocated, { recursive: true })
    fs.rmSync(projectRoot, { recursive: true, force: true })

    const runner = spawn(BARE, [path.join(relocated, 'fit-runner.bundle')], {
      cwd: moved,
      stdio: ['pipe', 'pipe', 'inherit', 'pipe']
    })
    let output = ''
    runner.stdout!.setEncoding('utf8')
    runner.stdout!.on('data', (chunk: string) => {
      output += chunk
    })
    runner.stdin!.end(
      `${JSON.stringify({
        version: 1,
        probe: {
          engine: 'llm-llamacpp',
          request: { modelPath: path.join(moved, 'missing.gguf') }
        }
      })}\n`
    )
    await once(runner, 'close')

    const response = JSON.parse(output.trim()) as {
      status: string
      probe?: { engine: string; result: { reason: string } }
    }
    t.is(response.status, 'completed', `runner answered ${output.trim()}`)
    t.is(response.probe?.engine, 'llm-llamacpp')
    t.is(response.probe?.result.reason, 'model-unreadable')
  }
)
