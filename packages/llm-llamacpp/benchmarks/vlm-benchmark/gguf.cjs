'use strict'
// Minimal GGUF metadata reader (Node): scalar values for the requested keys.
// Walks the key/value header only; tensor data is never read.

const fs = require('fs')

const GGUF_TYPE_STRING = 8
const GGUF_TYPE_ARRAY = 9
const FIXED_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

function readGgufValues (ggufPath, keys) {
  const want = new Set(keys)
  const found = {}
  const fd = fs.openSync(ggufPath, 'r')
  let offset = 0
  const read = (len) => {
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, offset)
    offset += len
    return buf
  }
  const readU32 = () => read(4).readUInt32LE(0)
  const readU64 = () => Number(read(8).readBigUInt64LE(0))
  const readStr = () => read(readU64()).toString('utf8')
  const readScalar = (type) => {
    const b = read(FIXED_SIZE[type])
    switch (type) {
      case 0: return b.readUInt8(0)
      case 1: return b.readInt8(0)
      case 2: return b.readUInt16LE(0)
      case 3: return b.readInt16LE(0)
      case 4: return b.readUInt32LE(0)
      case 5: return b.readInt32LE(0)
      case 6: return b.readFloatLE(0)
      case 7: return b.readUInt8(0) !== 0
      case 10: return Number(b.readBigUInt64LE(0))
      case 11: return Number(b.readBigInt64LE(0))
      default: return b.readDoubleLE(0)
    }
  }
  const skip = (type) => {
    if (type === GGUF_TYPE_STRING) { const n = readU64(); offset += n; return }
    if (type === GGUF_TYPE_ARRAY) {
      const t = readU32()
      const n = readU64()
      if (FIXED_SIZE[t]) { offset += FIXED_SIZE[t] * n; return }
      for (let i = 0; i < n; i++) skip(t)
      return
    }
    if (!FIXED_SIZE[type]) throw new Error(`unknown GGUF value type ${type}`)
    offset += FIXED_SIZE[type]
  }
  try {
    if (read(4).toString('ascii') !== 'GGUF') return found
    if (readU32() < 2) return found
    readU64() // tensor count
    const kvCount = readU64()
    for (let i = 0; i < kvCount && Object.keys(found).length < want.size; i++) {
      const key = readStr()
      const type = readU32()
      if (want.has(key) && type === GGUF_TYPE_STRING) found[key] = readStr()
      else if (want.has(key) && FIXED_SIZE[type]) found[key] = readScalar(type)
      else skip(type)
    }
  } finally {
    fs.closeSync(fd)
  }
  return found
}

// The image-token cap the addon applies when image_max_tokens is unset
// (addon/src/model-interface/ImageTokenBudget.hpp); null = the encoder's own budget.
function addonDefaultImageMaxTokens (mmprojPath) {
  const kv = readGgufValues(mmprojPath, ['clip.projector_type', 'clip.vision.projector_type'])
  const proj = kv['clip.projector_type'] || kv['clip.vision.projector_type'] || ''
  if ((proj.startsWith('qwen') && proj.includes('vl')) || proj === 'qwen2.5o') return { projector: proj, tokens: 2048 }
  if (proj === 'gemma4v' || proj === 'gemma4uv') return { projector: proj, tokens: 280 }
  return { projector: proj || null, tokens: null }
}

function architecture (ggufPath) {
  return readGgufValues(ggufPath, ['general.architecture'])['general.architecture'] || null
}

// MTP layers (<arch>.nextn_predict_layers > 0) are what --spec-type draft-mtp needs;
// quants that strip the MTP tensors drop the key or set it to 0.
function hasMtpLayers (ggufPath) {
  const arch = architecture(ggufPath)
  if (!arch) return false
  const key = `${arch}.nextn_predict_layers`
  const n = readGgufValues(ggufPath, [key])[key]
  return typeof n === 'number' && n > 0
}

module.exports = { readGgufValues, addonDefaultImageMaxTokens, architecture, hasMtpLayers }
