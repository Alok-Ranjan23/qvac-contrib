import { assessFit as assessDiffusionFit } from '@qvac/diffusion-cpp'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'diffusion-cpp'>) {
  return assessDiffusionFit(request)
}
