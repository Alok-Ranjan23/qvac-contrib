import assert from 'node:assert/strict'
import test from 'node:test'

import { groupCompanionSets } from '../models/update-models/companions.ts'
import { deduplicateModels } from '../models/update-models/registry.ts'
import type { ProcessedModel } from '../models/update-models/types.ts'
import * as constants from '../src/models/constants.ts'

const BUNDLE_DIR =
  'qvac_models_compiled/ggml/parakeet/2026-09-28/parakeet-tdt-0.6b-v3-encoder.mlmodelc'

function parakeetModel(registryPath: string, sha256Checksum: string): ProcessedModel {
  return {
    registryPath,
    registrySource: 's3',
    modelId: registryPath.split('/').pop()!,
    addon: 'parakeet',
    engine: 'parakeet-transcription',
    modelName: '',
    quantization: '',
    params: '',
    tags: [],
    expectedSize: 243,
    sha256Checksum,
    blobCoreKey: 'core',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0
  }
}

test('every file inside a Core ML bundle is companion-only; the GGUF beside it is not', () => {
  const grouped = groupCompanionSets([
    parakeetModel('qvac_models_compiled/ggml/parakeet/parakeet-tdt-0.6b-v3.f16.gguf', 'a'),
    parakeetModel(`${BUNDLE_DIR}/coremldata.bin`, 'b'),
    parakeetModel(`${BUNDLE_DIR}/analytics/coremldata.bin`, 'c'),
    parakeetModel(`${BUNDLE_DIR}/weights/weight.bin`, 'd')
  ])

  const companionOnly = grouped.filter((m) => m.isCompanionOnly).map((m) => m.registryPath)
  assert.deepEqual(companionOnly, [
    `${BUNDLE_DIR}/coremldata.bin`,
    `${BUNDLE_DIR}/analytics/coremldata.bin`,
    `${BUNDLE_DIR}/weights/weight.bin`
  ])
})

test('dedup keeps Core ML components whose checksum matches another bundle', () => {
  const otherBundle = `${BUNDLE_DIR.replace('tdt-0.6b-v3', 'ctc-0.6b')}/analytics/coremldata.bin`
  const deduped = deduplicateModels(
    groupCompanionSets([
      parakeetModel(`${BUNDLE_DIR}/analytics/coremldata.bin`, 'same'),
      parakeetModel(otherBundle, 'same')
    ]),
    false
  )

  assert.deepEqual(
    deduped.map((m) => m.registryPath),
    [`${BUNDLE_DIR}/analytics/coremldata.bin`, otherBundle]
  )
})

test('the generated catalog exports no Core ML bundle component', () => {
  const exported = Object.entries(constants).filter(
    ([name, value]) => name !== 'allModels' && typeof value === 'object' && value !== null
  )
  assert.ok(exported.length > 0)

  const bundleComponents = exported
    .filter(([, value]) => /\.mlmodelc\//.test((value as { registryPath: string }).registryPath))
    .map(([name]) => name)
  assert.deepEqual(bundleComponents, [])
})
