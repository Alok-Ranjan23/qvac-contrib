import { assessFit as assessBciFit } from '@qvac/bci-whispercpp'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'bci-whispercpp'>) {
  return assessBciFit(request)
}
