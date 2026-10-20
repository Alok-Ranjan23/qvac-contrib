import RPC from 'bare-rpc'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import type { Duplex } from 'bare-stream'
import { close as closeEngine } from '@qvac/inference/engine'
import { useFitRunner } from '@qvac/inference/fit-runner-location'
import { registerPlugins } from '@qvac/inference/plugins'
import { registerRpcServerProvider } from '@qvac/inference/rpc-server-provider'
import type { QvacPlugin, RpcServerProvider } from '@qvac/inference/surface'
import { handleRequest } from '@/worker/handle-request'
import { FIT_RUNNER_BUNDLE } from '@/worker/fit-runner-bundle'
import { getServerLogger } from '@/logging'

const logger = getServerLogger()

export interface WorkerOptions {
  plugins: readonly QvacPlugin[]
  rpcServerProvider?: RpcServerProvider | undefined
}

export type StopWorker = () => Promise<void>

function registerBundledFitRunner(): void {
  const bundle = Bare.argv[1]
  if (bundle === undefined) return
  const runnerPath = path.join(path.dirname(bundle), FIT_RUNNER_BUNDLE)
  if (fs.existsSync(runnerPath)) useFitRunner({ executable: os.execPath(), runnerPath })
}

export function startWorker(ipc: Duplex, ready: () => void, options: WorkerOptions): StopWorker {
  registerPlugins(options.plugins)
  if (options.rpcServerProvider) registerRpcServerProvider(options.rpcServerProvider)
  registerBundledFitRunner()

  new RPC(ipc, handleRequest)
  logger.info(`Worker ready with ${options.plugins.length} plugins`)
  ready()

  return closeEngine
}
