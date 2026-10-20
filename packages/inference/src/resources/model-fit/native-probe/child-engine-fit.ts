import type {
  FitProbeEngine,
  FitProbeRequest,
  FitProbeResult,
  FitRequestOf
} from '@/resources/model-fit/native-probe/engine-fit'

export type EngineFitters = {
  [E in FitProbeEngine]?: (request: FitRequestOf<E>) => unknown
}

export async function callChildEngineFit(
  probe: FitProbeRequest,
  fitters: EngineFitters
): Promise<FitProbeResult> {
  const fitter = fitters[probe.engine] as
    ((request: FitProbeRequest['request']) => unknown) | undefined
  if (fitter === undefined) {
    throw new Error(`This fit runner has no fitter for engine '${probe.engine}'`)
  }
  return { engine: probe.engine, result: await fitter(probe.request) } as FitProbeResult
}
