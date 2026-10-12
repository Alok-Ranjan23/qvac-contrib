import { z } from 'zod'

/** NMT inference is ungated on its own model, so the batch size bounds native work. */
export const MAX_BATCH_INPUTS = 100

/** Mirrors the SDK's NMT `translate()` arguments. */
// The batch cap is checked after the union: from Zod 4.6.6 an over-cap array
// inside it surfaces only as `invalid_union`, losing the `too_big` the error
// code keys off.
export const translateBody = z
  .strictObject({
    model: z.string().min(1),
    text: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    stream: z.boolean().optional()
  })
  .superRefine((body, ctx) => {
    if (Array.isArray(body.text) && body.text.length > MAX_BATCH_INPUTS) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'array',
        maximum: MAX_BATCH_INPUTS,
        inclusive: true,
        input: body.text,
        path: ['text'],
        message: `Too big: expected array to have <=${MAX_BATCH_INPUTS} items`
      })
    }
  })

/** The `translate()` model types that map to the `translation` category. */
export type NmtModelType = 'nmt' | 'nmtcpp-translation'

// Loose, so a stat the SDK adds later still reaches the client through the
// response serializer.
const translationStats = z.looseObject({
  totalTime: z.number().optional(),
  totalTokens: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  timeToFirstToken: z.number().optional(),
  decodeTime: z.number().optional(),
  encodeTime: z.number().optional(),
  cacheTokens: z.number().optional()
})

export const translationResult = z.object({
  object: z.literal('translation'),
  model: z.string(),
  translations: z.array(z.string()),
  stats: translationStats.optional()
})

export const TRANSLATE_FIELD_CODES: Record<string, string> = {
  text: 'missing_text',
  'text:too_big': 'too_many_inputs'
}
