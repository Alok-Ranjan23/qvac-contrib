import test from 'brittle'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { waitForBareChildren, isAlive } from './fixtures/bare-children'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HARNESS = path.resolve(__dirname, '../dist/src/client/rpc/unbundled-harness.js')

test('terminating an unbundled worker that blocks resolves only once its process has exited', async function (t) {
  t.timeout(30_000)

  const { start } = (await import(
    pathToFileURL(HARNESS).href
  )) as typeof import('@/client/rpc/unbundled-harness')
  const { ipc } = await start(path.resolve(__dirname, 'fixtures/blocked-worker.mjs'))

  const pids = await waitForBareChildren(process.pid)
  t.ok(pids.length > 0, 'expected the blocked worker to be running')
  await new Promise((resolve) => setTimeout(resolve, 500))

  await ipc.terminate()

  const alive = pids.filter((pid) => isAlive(pid))
  t.is(alive.length, 0, `worker still alive after terminate: ${alive.join(',')}`)
})
