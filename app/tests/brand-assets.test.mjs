// W1-17 / MOT-03: the intro logo rasters written by
// scripts/make-brand-assets.mjs. Each case fails if its control is removed:
// the byte budgets (25 KB / 40 KB), the exact 2x / 3x box the intro draws them
// in, and pixel-data-only files (the master carries EXIF and XMP; no brand
// output may). The chunk walk is independent of the script's own check.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { brandIntroLogo, brandLogo } from '../src/data/brand-images.ts'

const publicRoot = fileURLToPath(new URL('../public', import.meta.url))
const brandDir = join(publicRoot, 'images', 'brand')

const INTRO_RASTERS = [
  { key: 'webp448', scale: 2, maxBytes: 25_000 },
  { key: 'webp672', scale: 3, maxBytes: 40_000 },
]
const WEBP_CHUNKS = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH'])
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'pHYs', 'IDAT', 'IEND'])
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const VP8X_ALPHA_FLAG = 0x10

/** Chunks of a RIFF/WEBP file as { type, start } (start = first data byte). */
function webpChunks(bytes) {
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF')
  assert.equal(bytes.toString('latin1', 8, 12), 'WEBP')
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8, 'RIFF size')
  const chunks = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4)
    chunks.push({ type: bytes.toString('latin1', offset, offset + 4), start: offset + 8 })
    offset += 8 + size + (size & 1)
  }
  assert.equal(offset, bytes.length, 'chunks end exactly at the end of the file')
  return chunks
}

function pngChunkTypes(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature')
  const types = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    types.push(bytes.toString('latin1', offset + 4, offset + 8))
    offset += 12 + bytes.readUInt32BE(offset)
  }
  assert.equal(offset, bytes.length, 'chunks end exactly at the end of the file')
  assert.equal(types.at(-1), 'IEND')
  return types
}

function publicFile(url) {
  assert.match(url, /^\/images\/brand\/[a-z0-9-]+\.webp$/)
  return join(publicRoot, ...url.split('/').filter(Boolean))
}

describe('brandIntroLogo', () => {
  test('shares the header logo alt text and box', () => {
    assert.equal(brandIntroLogo.alt, brandLogo.alt)
    assert.equal(brandIntroLogo.width, brandLogo.height224.width)
    assert.equal(brandIntroLogo.height, brandLogo.height224.height)
  })

  for (const { key, scale, maxBytes } of INTRO_RASTERS) {
    describe(key, () => {
      const file = publicFile(brandIntroLogo[key])

      test('exists under public/images/brand/', () => {
        assert.ok(existsSync(file), file)
      })

      test(`is at most ${maxBytes} bytes`, () => {
        const size = readFileSync(file).length
        assert.ok(size <= maxBytes, `${size} B > ${maxBytes} B`)
      })

      test(`is exactly ${scale}x the logo box, with alpha and nothing else announced`, () => {
        const bytes = readFileSync(file)
        const vp8x = webpChunks(bytes).find((chunk) => chunk.type === 'VP8X')
        assert.ok(vp8x, 'VP8X header present')
        assert.equal(bytes[vp8x.start], VP8X_ALPHA_FLAG)
        assert.equal(bytes.readUIntLE(vp8x.start + 4, 3) + 1, brandIntroLogo.width * scale)
        assert.equal(bytes.readUIntLE(vp8x.start + 7, 3) + 1, brandIntroLogo.height * scale)
      })
    })
  }
})

describe('brand outputs carry no metadata', () => {
  const files = readdirSync(brandDir).filter((name) => /\.(webp|png)$/.test(name))

  test('the directory holds the intro rasters and the existing outputs', () => {
    assert.ok(files.includes('logo-ink-448.webp'))
    assert.ok(files.includes('logo-ink-672.webp'))
    assert.ok(files.includes('logo-ink-224.png'))
  })

  for (const name of files) {
    test(name, () => {
      const bytes = readFileSync(join(brandDir, name))
      if (name.endsWith('.webp')) {
        const chunks = webpChunks(bytes)
        assert.deepEqual(chunks.filter((chunk) => !WEBP_CHUNKS.has(chunk.type)), [])
        for (const chunk of chunks.filter((c) => c.type === 'VP8X')) {
          assert.equal(bytes[chunk.start] & ~VP8X_ALPHA_FLAG, 0, 'no ICC/EXIF/XMP/animation flag')
        }
      } else {
        assert.deepEqual(pngChunkTypes(bytes).filter((type) => !PNG_CHUNKS.has(type)), [])
      }
    })
  }
})
