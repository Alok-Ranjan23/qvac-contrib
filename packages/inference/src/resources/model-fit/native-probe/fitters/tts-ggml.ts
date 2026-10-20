import TTSGgml from '@qvac/tts-ggml'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'tts-ggml'>) {
  return TTSGgml.assessFit(request)
}
