import host from 'bare-stow/host'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type WorkerIPC = InstanceType<typeof host.IPC>

function unbundledShim(): string {
  type ImportMetaAsset = { asset?: (spec: string) => string }
  const asset = (import.meta as ImportMetaAsset).asset
  return fileURLToPath(
    asset
      ? asset('../../worker/unbundled-shim.js')
      : new URL('../../worker/unbundled-shim.js', import.meta.url)
  )
}

export async function start(
  entry: string,
  options: { timeout?: number } = {}
): Promise<{ ipc: WorkerIPC }> {
  const { default: Sidecar } = await import('bare-sidecar')
  const sidecar = new Sidecar(unbundledShim(), [entry], { stdio: 'inherit' })
  const child = (sidecar as unknown as { _process: ChildProcess })._process
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
  const ipc = new host.IPC(sidecar, { ...options, kill: () => child.kill('SIGKILL') })
  const terminate = ipc.terminate.bind(ipc)
  ipc.terminate = async () => {
    const code = await terminate()
    await exited
    return code
  }
  await ipc.ready
  return { ipc }
}
