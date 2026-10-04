#!/usr/bin/env node
/**
 * Generates the brand-mark assets for the Sundus Yar site from the single
 * source file `../assets-originals/brand-logo.jpeg` (5000x3245, black Arabic
 * calligraphy on flat opaque white; the dot of the س is a camera-aperture /
 * lens-diaphragm glyph made of concentric arc segments).
 *
 * Produces, into public/images/brand/:
 *   - logo-ink-{112,224}.{webp,png}  full logo, ink-coloured, transparent bg
 *   - logo-ink-{448,672}.webp        the same logo for the cinematic intro,
 *                                    exactly 2x / 3x the 224 logo's box
 *   - favicon-32.png                 aperture glyph on a Paper roundel
 *   - apple-touch-icon.png           aperture glyph on an opaque Paper square
 *   - icon-512.png                   aperture glyph on a Paper roundel
 *
 * Idempotent: re-running produces byte-identical output (no timestamps, no
 * randomness, deterministic libvips encode settings).
 *
 * Reads only the master (and its own outputs, to check them); writes only
 * inside public/images/brand/. The master carries EXIF and XMP: sharp strips
 * metadata by default, and every output is checked to hold pixel-data chunks
 * only, so a changed default fails the run.
 *
 * Usage: `node scripts/make-brand-assets.mjs` (run from app/).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
// The master logo lives outside the served folder (it is 5000x3245 and never shipped).
const SOURCE_LOGO = path.join(ROOT_DIR, '..', 'assets-originals', 'brand-logo.jpeg')
const OUT_DIR = path.resolve(ROOT_DIR, 'public/images/brand')

const COLOR_INK = '#241E1A'
const COLOR_PAPER = '#FAF6EF'

// Full-logo output heights (px); width is derived from the trimmed logo's
// aspect ratio.
const LOGO_HEIGHTS = [112, 224]

// Intro-logo output heights (px) and byte budgets (motion spec §4.2). WebP
// only: every browser that runs the intro decodes WebP. Each raster is an
// exact multiple of the 224 logo's box (296x224, the intro's viewBox), not of
// the master's aspect ratio, which would give 593x448 / 889x672.
const INTRO_LOGO_BASE_HEIGHT = 224
const INTRO_LOGO_HEIGHTS = [448, 672]
const INTRO_LOGO_MAX_BYTES = { 448: 25_000, 672: 40_000 }

// The master is a JPEG, so its "flat white" paper carries compression noise,
// and the lanczos3 downscale adds faint ringing beside every stroke. Both
// reach the intro rasters as alpha 1-8 speckle (a grey haze on Paper) and
// 247-254 wobble inside solid ink; snapping them to 0 / 255 removes the haze
// and cuts the lossless alpha plane by about a third. With RGB flattened to
// exact ink this takes 448 from ~50 KB to ~22 KB and 672 from ~83 KB to
// ~37 KB at the same quality 90, while the edge anti-aliasing (alpha 9-246)
// stays untouched. The 112/224 logos keep their original, unsnapped pipeline.
const INTRO_ALPHA_FLOOR = 8
const INTRO_ALPHA_CEIL = 247

// Chunk types an output may contain: pixel data and its framing only, so no
// EXIF, XMP, ICC or text chunk can ride along from the master. pHYs (pixel
// density) is what libvips writes into every PNG.
const WEBP_CHUNKS = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH'])
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'pHYs', 'IDAT', 'IEND'])
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// The only VP8X feature flag allowed: "has alpha". The others announce ICC,
// EXIF, XMP or animation chunks.
const VP8X_ALPHA_FLAG = 0x10

// Aperture-glyph crop box, in source-image (5000x3245) pixel coordinates.
// Located by rendering coarse preview crops to a temp dir and viewing them,
// then refining twice: the box is a square centred on the aperture glyph's
// visual centre (~2599, 889 in source pixels), sized to hold the full
// concentric-arc ring with a small margin.
const APERTURE_CROP = { left: 2329, top: 619, width: 540, height: 540 }

// Radius (px, measured from the crop's centre) of the circular mask applied
// after cropping. The aperture ring's own radius is ~241-248px; the source
// logo's calligraphy stroke (the س body) pokes into the crop's bottom-left
// and bottom-right corners starting at ~282px from the crop centre, so a
// 252px mask keeps the full ring and discards those corner artifacts,
// guaranteeing the icon shows ONLY the aperture glyph.
const APERTURE_MASK_RADIUS = 252

// Aperture glyph fills this fraction of each icon's diameter/side.
const GLYPH_FILL_RATIO = 0.66

const ICON_SPECS = [
  { name: 'favicon-32.png', size: 32, shape: 'roundel' },
  { name: 'apple-touch-icon.png', size: 180, shape: 'square' },
  { name: 'icon-512.png', size: 512, shape: 'roundel' },
]

function hexToRgb(hex) {
  const n = hex.replace('#', '')
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  }
}

/** Resolves an output file name inside OUT_DIR; anything that would land
 * elsewhere (a separator, `..`, an absolute path) is refused. */
function outPath(name) {
  const resolved = path.resolve(OUT_DIR, name)
  if (path.dirname(resolved) !== OUT_DIR) {
    throw new Error(`refusing to write outside ${OUT_DIR}: ${name}`)
  }
  return resolved
}

/**
 * Throws unless `bytes` is a well-formed WebP or PNG made only of the
 * pixel-data chunks allowed above (no EXIF, XMP, ICC or text chunk).
 */
function assertNoMetadata(bytes, label) {
  const types = []
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) !== bytes.length - 8) throw new Error(`${label}: bad RIFF size`)
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('latin1', offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4)
      if (type === 'VP8X' && (bytes[offset + 8] & ~VP8X_ALPHA_FLAG) !== 0) {
        throw new Error(`${label}: VP8X announces metadata or animation`)
      }
      types.push(type)
      // RIFF pads odd-sized chunks to an even length.
      offset += 8 + size + (size & 1)
    }
    if (offset !== bytes.length) throw new Error(`${label}: truncated WebP chunk`)
    const extra = types.filter((type) => !WEBP_CHUNKS.has(type))
    if (extra.length > 0) throw new Error(`${label}: unexpected WebP chunks ${extra.join(', ')}`)
    return
  }
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset)
      types.push(bytes.toString('latin1', offset + 4, offset + 8))
      // length + type + data + CRC
      offset += 12 + size
    }
    if (offset !== bytes.length || types.at(-1) !== 'IEND') {
      throw new Error(`${label}: truncated PNG chunk`)
    }
    const extra = types.filter((type) => !PNG_CHUNKS.has(type))
    if (extra.length > 0) throw new Error(`${label}: unexpected PNG chunks ${extra.join(', ')}`)
    return
  }
  throw new Error(`${label}: neither WebP nor PNG`)
}

/**
 * Recolours a source region (black/gray ink on white/transparent) to a flat
 * `color`, deriving the alpha channel from the inverted luminance of the
 * pixels so anti-aliased edges stay smooth instead of a hard cutout.
 * Returns a sharp() pipeline wrapping raw RGBA pixel data at the input's
 * native resolution.
 */
async function inkFromLuminance(inputBuffer, hexColor) {
  const { data: alpha, info } = await sharp(inputBuffer)
    .greyscale()
    .negate({ alpha: false })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height } = info
  const { r, g, b } = hexToRgb(hexColor)
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, p = 0; i < alpha.length; i += 1, p += 4) {
    rgba[p] = r
    rgba[p + 1] = g
    rgba[p + 2] = b
    rgba[p + 3] = alpha[i]
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
}

/** Renders an opaque circle of `color` on a transparent square, as PNG bytes. */
function circleSvg(size, radius, color) {
  const c = size / 2
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${c}" cy="${c}" r="${radius}" fill="${color}"/>` +
      `</svg>`,
  )
}

/** Trims the master and recolours it to ink on transparent, at source
 * resolution, as PNG bytes. Shared by the header and intro logos. */
async function buildInkLogo() {
  const trimmed = await sharp(SOURCE_LOGO).trim().toBuffer()
  const inkLogo = await inkFromLuminance(trimmed, COLOR_INK)
  return inkLogo.png().toBuffer()
}

async function buildLogo(inkLogoBuffer) {
  const results = []
  for (const height of LOGO_HEIGHTS) {
    const webpPath = outPath(`logo-ink-${height}.webp`)
    const pngPath = outPath(`logo-ink-${height}.png`)

    const resized = sharp(inkLogoBuffer).resize({ height })
    const webpInfo = await resized.clone().webp({ quality: 90 }).toFile(webpPath)
    const pngInfo = await resized.clone().png({ compressionLevel: 9 }).toFile(pngPath)

    results.push({ height, webpPath, pngPath, webpInfo, pngInfo })
  }
  return results
}

/**
 * Renders the intro rasters from the same ink logo, `baseWidth` being the
 * 224 logo's width. Each one is encoded in memory and written only once it
 * is under its budget and free of metadata.
 */
async function buildIntroLogo(inkLogoBuffer, baseWidth) {
  const { r, g, b } = hexToRgb(COLOR_INK)
  const results = []
  for (const height of INTRO_LOGO_HEIGHTS) {
    const scale = height / INTRO_LOGO_BASE_HEIGHT
    const maxBytes = INTRO_LOGO_MAX_BYTES[height]
    if (!Number.isInteger(scale) || maxBytes === undefined) {
      throw new Error(`intro logo ${height}: needs a budget and a multiple of ${INTRO_LOGO_BASE_HEIGHT}`)
    }

    const { data, info } = await sharp(inkLogoBuffer)
      .resize({ width: baseWidth * scale, height, fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.channels !== 4) throw new Error(`intro logo ${height}: expected RGBA, got ${info.channels} channels`)

    for (let p = 0; p < data.length; p += 4) {
      // Un-premultiplying after the resize leaves black or rounded RGB under
      // faint alpha; pure ink everywhere means no fringe on any background.
      data[p] = r
      data[p + 1] = g
      data[p + 2] = b
      if (data[p + 3] <= INTRO_ALPHA_FLOOR) data[p + 3] = 0
      else if (data[p + 3] >= INTRO_ALPHA_CEIL) data[p + 3] = 255
    }

    const name = `logo-ink-${height}.webp`
    const webp = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .webp({ quality: 90 })
      .toBuffer()
    if (webp.length > maxBytes) {
      throw new Error(`${name} is ${webp.length}B, over its ${maxBytes}B budget`)
    }
    assertNoMetadata(webp, name)

    const webpPath = outPath(name)
    await writeFile(webpPath, webp)
    results.push({ height, webpPath, width: info.width, size: webp.length })
  }
  return results
}

/** Crops, recolours and circle-masks the aperture glyph. Returns PNG bytes
 * tightly trimmed to the glyph's (square) bounding box. */
async function buildApertureGlyph() {
  const cropped = await sharp(SOURCE_LOGO).extract(APERTURE_CROP).toBuffer()
  const inkGlyph = await inkFromLuminance(cropped, COLOR_INK)

  const mask = circleSvg(APERTURE_CROP.width, APERTURE_MASK_RADIUS, '#FFFFFF')
  const maskedBuffer = await inkGlyph
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()

  // Trimming in the same pipeline as the composite above trips a sharp
  // dimension-check bug ("Image to composite must have same dimensions or
  // smaller"); trimming a fresh pipeline from the materialised buffer avoids it.
  return sharp(maskedBuffer).trim().toBuffer()
}

async function buildIcon(glyphBuffer, spec) {
  const glyphSize = Math.round(spec.size * GLYPH_FILL_RATIO)
  const glyph = await sharp(glyphBuffer)
    .resize({
      width: glyphSize,
      height: glyphSize,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer()

  const offset = Math.round((spec.size - glyphSize) / 2)
  const iconPath = outPath(spec.name)
  const glyphLayer = { input: glyph, left: offset, top: offset }

  // NOTE: sharp's .composite() REPLACES any previously queued composite
  // layers rather than appending to them, so the roundel's Paper disc and
  // the ink glyph must be passed together in one array, in paint order.
  let base
  let layers
  if (spec.shape === 'roundel') {
    base = sharp({
      create: {
        width: spec.size,
        height: spec.size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
    layers = [{ input: circleSvg(spec.size, spec.size / 2, COLOR_PAPER) }, glyphLayer]
  } else {
    // apple-touch-icon: iOS ignores transparency and applies its own mask,
    // so fill the whole square opaquely instead of a circle.
    const { r, g, b } = hexToRgb(COLOR_PAPER)
    base = sharp({
      create: {
        width: spec.size,
        height: spec.size,
        channels: 4,
        background: { r, g, b, alpha: 1 },
      },
    })
    layers = [glyphLayer]
  }

  const info = await base
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toFile(iconPath)

  return { iconPath, info }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  const inkLogoBuffer = await buildInkLogo()
  const logoResults = await buildLogo(inkLogoBuffer)
  const baseLogo = logoResults.find((r) => r.height === INTRO_LOGO_BASE_HEIGHT)
  if (!baseLogo) throw new Error(`no ${INTRO_LOGO_BASE_HEIGHT}px logo to size the intro logos from`)
  const introResults = await buildIntroLogo(inkLogoBuffer, baseLogo.webpInfo.width)
  const glyphBuffer = await buildApertureGlyph()

  const iconResults = []
  for (const spec of ICON_SPECS) {
    iconResults.push(await buildIcon(glyphBuffer, spec))
  }

  const written = [
    ...logoResults.flatMap((r) => [r.webpPath, r.pngPath]),
    ...introResults.map((r) => r.webpPath),
    ...iconResults.map((r) => r.iconPath),
  ]
  for (const file of written) {
    assertNoMetadata(await readFile(file), path.basename(file))
  }

  for (const r of logoResults) {
    console.log(
      `logo-ink-${r.height}: webp ${r.webpInfo.width}x${r.webpInfo.height} (${r.webpInfo.size}B), ` +
        `png ${r.pngInfo.width}x${r.pngInfo.height} (${r.pngInfo.size}B)`,
    )
  }
  for (const r of introResults) {
    console.log(`logo-ink-${r.height}: webp ${r.width}x${r.height} (${r.size}B)`)
  }
  for (const r of iconResults) {
    console.log(`${path.basename(r.iconPath)}: ${r.info.width}x${r.info.height} (${r.info.size}B)`)
  }
  console.log(`${written.length} files checked: pixel-data chunks only`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
