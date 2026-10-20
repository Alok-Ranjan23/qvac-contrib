import { serveFitRequests } from '@/resources/model-fit/native-probe/serve-fit-requests'

serveFitRequests({
  'llm-llamacpp': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/llm-llamacpp')).assessFit(request),
  'embed-llamacpp': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/embed-llamacpp')).assessFit(request),
  'asr-ggml': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/asr-ggml')).assessFit(request),
  'bci-whispercpp': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/bci-whispercpp')).assessFit(request),
  'tts-ggml': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/tts-ggml')).assessFit(request),
  'audiogen-ggml': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/audiogen-ggml')).assessFit(request),
  'diffusion-cpp': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/diffusion-cpp')).assessFit(request),
  'ocr-ggml': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/ocr-ggml')).assessFit(request),
  'translation-nmtcpp': async (request) =>
    (await import('@/resources/model-fit/native-probe/fitters/translation-nmtcpp')).assessFit(
      request
    )
})
