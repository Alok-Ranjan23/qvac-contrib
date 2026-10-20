import ASRGgml from '@qvac/asr-ggml'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'asr-ggml'>) {
  return ASRGgml.assessFit(request)
}
