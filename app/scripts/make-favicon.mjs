#!/usr/bin/env node
/**
 * The site icon is public/images/brand/icon-512.svg (the owner's logo: the
 * «سندس» calligraphy on a Paper rounded square), linked as-is from
 * index.html. This writes the two raster copies that clients without SVG
 * favicon support need, rendered from that same SVG:
 *   - public/images/brand/apple-touch-icon.png   (180, iOS home screen)
 *   - public/favicon.ico                         (16 + 32 + 48, PNG-in-ICO;
 *                                                 Safari, and /favicon.ico
 *                                                 requests made unasked)
 *
 * Usage: `node scripts/make-favicon.mjs` (run from app/) after changing the SVG.
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(ROOT_DIR, 'public')
const BRAND_DIR = path.join(PUBLIC_DIR, 'images', 'brand')
const SOURCE = path.join(BRAND_DIR, 'icon-512.svg')
const SOURCE_SIZE = 512

const COLOR_PAPER = '#FAF6EF'
const APPLE_TOUCH_SIZE = 180
const ICO_SIZES = [16, 32, 48]

/** The SVG rasterised straight at `size` px (no upscaled bitmap). */
function render(size) {
  return sharp(SOURCE, { density: (72 * size) / SOURCE_SIZE })
    .resize(size, size)
}

/** An ICO file holding one PNG image per size (supported by every browser). */
function toIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size, 0)
    entry.writeUInt8(size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })

  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)])
}

// iOS ignores transparency (the SVG's rounded corners), so fill them with Paper;
// iOS rounds the corners itself. sharp drops all metadata unless asked to keep it.
const appleTouch = await render(APPLE_TOUCH_SIZE)
  .flatten({ background: COLOR_PAPER })
  .png({ compressionLevel: 9 })
  .toBuffer()
await writeFile(path.join(BRAND_DIR, 'apple-touch-icon.png'), appleTouch)
console.log('wrote public/images/brand/apple-touch-icon.png')

const icoImages = await Promise.all(
  ICO_SIZES.map(async (size) => ({
    size,
    png: await render(size).png({ compressionLevel: 9 }).toBuffer(),
  })),
)
await writeFile(path.join(PUBLIC_DIR, 'favicon.ico'), toIco(icoImages))
console.log('wrote public/favicon.ico')
