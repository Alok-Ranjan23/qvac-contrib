import { assessFit as assessAudiogenFit } from '@qvac/audiogen-ggml'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'audiogen-ggml'>) {
  return assessAudiogenFit(request)
}
