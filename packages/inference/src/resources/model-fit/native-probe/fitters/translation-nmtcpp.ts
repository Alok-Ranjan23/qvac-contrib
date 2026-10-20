import TranslationNmtcpp from '@qvac/translation-nmtcpp'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'translation-nmtcpp'>) {
  return TranslationNmtcpp.assessFit(request)
}
