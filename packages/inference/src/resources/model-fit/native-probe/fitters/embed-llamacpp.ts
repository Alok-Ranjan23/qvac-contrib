import { assessFit as assessEmbedFit } from '@qvac/embed-llamacpp'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'embed-llamacpp'>) {
  return assessEmbedFit(request)
}
