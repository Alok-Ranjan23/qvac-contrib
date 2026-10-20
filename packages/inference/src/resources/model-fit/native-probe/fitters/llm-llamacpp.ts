import LlmLlamacpp from '@qvac/llm-llamacpp'
import type { FitRequestOf } from '@/resources/model-fit/native-probe/engine-fit'

export function assessFit(request: FitRequestOf<'llm-llamacpp'>) {
  return LlmLlamacpp.assessFit(request)
}
