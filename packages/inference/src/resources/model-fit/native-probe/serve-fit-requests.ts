import processModule from 'bare-process'

import {
  callChildEngineFit,
  type EngineFitters
} from '@/resources/model-fit/native-probe/child-engine-fit'
import {
  FIT_PROCESS_MAX_REQUEST_BYTES,
  parseFitProcessRequest
} from '@/resources/model-fit/native-probe/fit-process'

export type { EngineFitters }

const process = processModule as unknown as {
  stdin: {
    setEncoding(encoding: 'utf8'): void
    pause(): void
    on(event: 'data', listener: (chunk: string) => void): void
    on(event: 'end' | 'error', listener: (error?: Error) => void): void
  }
  stdout: { write(data: string, callback?: (error: Error | null) => void): void }
  stderr: { write(data: string, callback?: () => void): void }
  exit(code: number): never
}

export function serveFitRequests(fitters: EngineFitters): void {
  let finished = false

  function respond(line: string): void {
    if (finished) return
    finished = true
    process.stdin.pause()
    process.stdout.write(line, (error) => {
      if (error !== null && error !== undefined) {
        process.stderr.write(`fit runner failed to write its response: ${error.message}\n`, () => {
          process.exit(2)
        })
        return
      }
      process.exit(0)
    })
  }

  function fail(error: unknown): void {
    const name = error instanceof Error ? error.name : 'Error'
    const message = error instanceof Error ? error.message : String(error)
    respond(`${JSON.stringify({ status: 'invocation-error', error: { name, message } })}\n`)
  }

  async function answer(input: string): Promise<void> {
    const { probe } = parseFitProcessRequest(JSON.parse(input))
    const result = await callChildEngineFit(probe, fitters)
    respond(`${JSON.stringify({ status: 'completed', probe: result })}\n`)
  }

  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    if (finished) return
    input += chunk
    if (Buffer.byteLength(input) > FIT_PROCESS_MAX_REQUEST_BYTES) {
      fail(new RangeError(`Fit request exceeds ${FIT_PROCESS_MAX_REQUEST_BYTES} bytes`))
    }
  })
  process.stdin.on('error', (error?: Error) => {
    fail(error ?? new Error('fit runner stdin failed'))
  })
  process.stdin.on('end', () => {
    if (finished) return
    answer(input).catch(fail)
  })
}
