import { assessFit as assessOcrFit } from '@qvac/ocr-ggml'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'ocr-ggml'>) {
  return assessOcrFit(request)
}
