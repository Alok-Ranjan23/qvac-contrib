import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import pack from 'bare-pack'
import { listPrefix, readModule, resolveModule } from 'bare-pack/fs'
import resolveBare from 'bare-module-traverse/resolve/bare'
import type BareURL from 'bare-url'
import { FIT_RUNNER_BUNDLE } from '@/worker/fit-runner-bundle'

const OFFLOAD_DIR = 'index.bundle.d'
const SCOPE = '@qvac/'

export interface PackFitRunnerOptions {
  sdkPath: string
  qvacDir: string
  outputDir: string
  hosts: string[]
  imports: NonNullable<pack.PackOptions['imports']>
  defer: string[]
  packages: Iterable<string>
  base: string
}

interface Fitter {
  engine: string
  url: string
}

export function generateFitRunnerEntry(serveUrl: string, fitters: Fitter[]): string {
  const table = fitters
    .map(
      (fitter) =>
        `  ${JSON.stringify(fitter.engine)}: async (request) =>\n` +
        `    (await import(${JSON.stringify(fitter.url)})).assessFit(request)`
    )
    .join(',\n')
  return [
    `import { serveFitRequests } from ${JSON.stringify(serveUrl)}`,
    '',
    `serveFitRequests({\n${table}\n})`,
    ''
  ].join('\n')
}

function bundledFitters(sdkPath: string, packages: Iterable<string>): Fitter[] {
  const sdkRequire = createRequire(path.join(sdkPath, 'package.json'))
  const fitters: Fitter[] = []
  for (const name of packages) {
    if (!name.startsWith(SCOPE)) continue
    const engine = name.slice(SCOPE.length)
    try {
      const file = sdkRequire.resolve(`@qvac/inference/fit-runner/${engine}`)
      fitters.push({ engine, url: pathToFileURL(file).href })
    } catch {}
  }
  return fitters
}

function offloadedPath(url: { pathname: string }): string {
  const nm = url.pathname.indexOf('/node_modules/')
  return nm >= 0 ? url.pathname.slice(nm + 1) : url.pathname.replace(/^\//, '')
}

export async function packFitRunner(options: PackFitRunnerOptions): Promise<string | null> {
  const { sdkPath, qvacDir, outputDir, hosts, imports, defer, packages, base } = options
  const fitters = bundledFitters(sdkPath, packages)
  if (fitters.length === 0) return null

  const sdkRequire = createRequire(path.join(sdkPath, 'package.json'))
  const serveUrl = pathToFileURL(sdkRequire.resolve('@qvac/inference/fit-runner')).href
  const entryPath = path.join(qvacDir, 'fit-runner.entry.mjs')
  const offloadDir = path.join(outputDir, OFFLOAD_DIR)

  await fsp.writeFile(entryPath, generateFitRunnerEntry(serveUrl, fitters), 'utf8')
  try {
    const bundle = await pack(
      pathToFileURL(entryPath) as unknown as BareURL,
      {
        resolve: resolveBare,
        hosts,
        imports,
        defer,
        linked: false,
        offload: true,
        base: pathToFileURL(path.join(base, path.sep)) as unknown as BareURL
      },
      readModule,
      listPrefix,
      resolveModule,
      async (url, source) => {
        const relative = offloadedPath(url)
        const file = path.join(offloadDir, ...relative.split('/'))
        if (!fs.existsSync(file)) {
          await fsp.mkdir(path.dirname(file), { recursive: true })
          await fsp.writeFile(file, source)
        }
        return `/../${OFFLOAD_DIR}/${relative}`
      }
    )
    const runnerPath = path.join(outputDir, FIT_RUNNER_BUNDLE)
    await fsp.writeFile(runnerPath, bundle.toBuffer())
    return runnerPath
  } finally {
    await fsp.rm(entryPath, { force: true })
  }
}
