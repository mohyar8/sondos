#!/usr/bin/env node
/**
 * Generates the site icons from the official logo: the «سندس» calligraphy
 * with its aperture dot, without the "SONDOS YAR PHOTOGRAPHY" line, centred
 * on a Paper square. The source is public/images/brand/logo-ink-672.webp
 * (written by make-brand-assets.mjs), so this runs without the master logo.
 *
 * Writes, replacing the aperture-only icons make-brand-assets.mjs made:
 *   - public/images/brand/favicon-32.png
 *   - public/images/brand/icon-512.png
 *   - public/images/brand/apple-touch-icon.png   (180, opaque square for iOS)
 *   - public/favicon.ico                         (16 + 32 + 48, PNG-in-ICO)
 *
 * Usage: `node scripts/make-favicon.mjs` (run from app/).
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(ROOT_DIR, 'public')
const BRAND_DIR = path.join(PUBLIC_DIR, 'images', 'brand')
const SOURCE = path.join(BRAND_DIR, 'logo-ink-672.webp')

const COLOR_PAPER = '#FAF6EF'

// The calligraphy occupies rows 0-527 of the 888x672 source; the English
// wordmark starts below. 530 keeps the whole calligraphy and none of it.
const CALLIGRAPHY_HEIGHT = 530

// Calligraphy width as a fraction of the icon side. iOS rounds the corners of
// the apple-touch icon itself, so that one is a plain square.
const ICONS = [
  { file: path.join(BRAND_DIR, 'favicon-32.png'), size: 32, fill: 0.94, radius: 0.18 },
  { file: path.join(BRAND_DIR, 'icon-512.png'), size: 512, fill: 0.94, radius: 0.18 },
  { file: path.join(BRAND_DIR, 'apple-touch-icon.png'), size: 180, fill: 0.86, radius: 0 },
]
const ICO_SIZES = [16, 32, 48]

async function calligraphy() {
  const { width } = await sharp(SOURCE).metadata()

  return sharp(SOURCE)
    .extract({ left: 0, top: 0, width, height: CALLIGRAPHY_HEIGHT })
    .trim()
    .png()
    .toBuffer()
}

async function renderIcon(glyph, size, fill, radius) {
  const inner = Math.round(size * fill)
  const mark = await sharp(glyph)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${size * radius}" fill="${COLOR_PAPER}"/></svg>`,
  )

  // sharp drops all metadata unless asked to keep it.
  return sharp(background)
    .composite([{ input: mark, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
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

const glyph = await calligraphy()

for (const { file, size, fill, radius } of ICONS) {
  await writeFile(file, await renderIcon(glyph, size, fill, radius))
  console.log(`wrote ${path.relative(ROOT_DIR, file)}`)
}

const icoImages = await Promise.all(
  ICO_SIZES.map(async (size) => ({ size, png: await renderIcon(glyph, size, 0.94, 0.18) })),
)
await writeFile(path.join(PUBLIC_DIR, 'favicon.ico'), toIco(icoImages))
console.log('wrote public/favicon.ico')
