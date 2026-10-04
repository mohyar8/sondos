#!/usr/bin/env node
// Image optimisation pipeline for the Sundus Yar site.
//
// Reads runs/redo-v2/photo-catalogue.json (the orchestrator-verified source of
// truth for the 32 site photos + product images) and:
//   1. Writes AVIF + WebP variants of every site photo into
//      app/public/images/site/.
//   2. Writes AVIF + WebP variants of every publishable product photo into
//      app/public/images/products/, then moves the raw product originals to
//      assets-originals/products/ (backup, outside the repo).
//   3. Backs up the legacy portfolio JPEGs + brand logo into assets-originals/
//      (copy only — the live files are left in place for the current pages).
//   4. Regenerates app/src/data/site-images.ts from the catalogue and the
//      real, measured output dimensions.
//
// Runs fully sequentially (one sharp operation at a time) to stay within this
// machine's 8 GB RAM budget. Safe to re-run: existing outputs whose measured
// dimensions already match the expected width are left untouched.

import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..')

const cataloguePath = path.join(repoRoot, 'runs', 'redo-v2', 'photo-catalogue.json')

const siteOutDir = path.join(appRoot, 'public', 'images', 'site')
const productsDir = path.join(appRoot, 'public', 'images', 'products')
const portfolioDir = path.join(appRoot, 'public', 'images', 'portfolio')
const brandLogoPath = path.join(appRoot, 'public', 'images', 'brand-logo.jpeg')

const assetsOriginalsRoot = path.join(repoRoot, 'assets-originals')
const productsBackupDir = path.join(assetsOriginalsRoot, 'products')
const portfolioLegacyBackupDir = path.join(assetsOriginalsRoot, 'portfolio-legacy')

const siteImagesDataPath = path.join(appRoot, 'src', 'data', 'site-images.ts')

const SITE_WIDTH_TIERS = [480, 800, 1200]
const PRODUCT_WIDTH_TIERS = [480, 800]
const PRODUCT_MAX_WIDTH = 1080

const AVIF_OPTIONS = { quality: 50, effort: 4 }
const WEBP_OPTIONS = { quality: 78 }
// Full-size variants are re-encoded at high quality instead of byte-copied: a byte
// copy kept the camera's EXIF/XMP (body and lens serials, capture date, owner
// name). sharp writes no metadata unless .withMetadata() is called.
const AVIF_FULL_OPTIONS = { quality: 64, effort: 4 }
const WEBP_FULL_OPTIONS = { quality: 86 }

const stats = {
  written: 0,
  skipped: 0,
  copied: 0,
  backedUp: 0,
}

async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/** Sorted, de-duplicated widths that never exceed nativeWidth (no upscaling). */
function widthsWithinNative(candidates, nativeWidth) {
  const unique = new Set(candidates.filter((width) => width <= nativeWidth))
  return [...unique].sort((a, b) => a - b)
}

/**
 * If outPath already exists and its measured width matches expectedWidth,
 * return its {width, height}. Otherwise return null (needs (re)generating).
 */
async function existingVariantDims(outPath, expectedWidth) {
  if (!(await pathExists(outPath))) return null
  try {
    const meta = await sharp(outPath).metadata()
    if (meta.width === expectedWidth && typeof meta.height === 'number') {
      return { width: meta.width, height: meta.height }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Produce one output file (byte-copy or sharp-encode), skipping if an
 * up-to-date copy already exists. Returns the file's real {width, height}.
 */
async function produceVariant({ outPath, width, sourcePath, format, isByteCopy, isFullSize = false }) {
  const existing = await existingVariantDims(outPath, width)
  if (existing) {
    stats.skipped += 1
    return existing
  }

  await ensureDir(path.dirname(outPath))

  if (isByteCopy) {
    await copyFile(sourcePath, outPath)
  } else if (format === 'avif') {
    await sharp(sourcePath)
      .resize({ width, withoutEnlargement: true })
      .avif(isFullSize ? AVIF_FULL_OPTIONS : AVIF_OPTIONS)
      .toFile(outPath)
  } else if (format === 'webp') {
    await sharp(sourcePath)
      .resize({ width, withoutEnlargement: true })
      .webp(isFullSize ? WEBP_FULL_OPTIONS : WEBP_OPTIONS)
      .toFile(outPath)
  } else {
    throw new Error(`unknown format: ${format}`)
  }

  stats.written += 1

  const meta = await sharp(outPath).metadata()
  if (typeof meta.width !== 'number' || typeof meta.height !== 'number') {
    throw new Error(`could not read dimensions of freshly written ${outPath}`)
  }
  return { width: meta.width, height: meta.height }
}

async function processSitePhoto(photo, sourceRoot) {
  const sourcePath = path.join(sourceRoot, photo.file)

  const srcMeta = await sharp(sourcePath).metadata()
  const nativeWidth = srcMeta.width
  const nativeHeight = srcMeta.height
  if (typeof nativeWidth !== 'number' || typeof nativeHeight !== 'number') {
    throw new Error(`cannot read source dimensions for ${photo.file}`)
  }

  const widths = widthsWithinNative([...SITE_WIDTH_TIERS, nativeWidth], nativeWidth)
  const variants = []

  for (const width of widths) {
    const isNativeWidth = width === nativeWidth
    const avifPath = path.join(siteOutDir, `${photo.slug}-${width}.avif`)
    const webpPath = path.join(siteOutDir, `${photo.slug}-${width}.webp`)

    const avifDims = await produceVariant({
      outPath: avifPath,
      width,
      sourcePath,
      format: 'avif',
      isByteCopy: false,
      isFullSize: isNativeWidth,
    })
    const webpDims = await produceVariant({
      outPath: webpPath,
      width,
      sourcePath,
      format: 'webp',
      isByteCopy: false,
      isFullSize: isNativeWidth,
    })

    if (avifDims.height !== webpDims.height) {
      throw new Error(
        `height mismatch for ${photo.slug} @ ${width}w: avif=${avifDims.height} webp=${webpDims.height}`,
      )
    }

    variants.push({
      width,
      height: avifDims.height,
      avif: `/images/site/${photo.slug}-${width}.avif`,
      webp: `/images/site/${photo.slug}-${width}.webp`,
    })
  }

  const placeholder = await dominantHex(path.join(siteOutDir, `${photo.slug}-${variants[0].width}.webp`))

  return {
    id: photo.slug,
    ratio: photo.ratio,
    category: photo.category,
    placeholder,
    width: nativeWidth,
    height: nativeHeight,
    alt: photo.alt,
    variants,
  }
}

/** Source for a product file: the still-present original, or its backup copy on a re-run. */
async function resolveProductSource(fileName) {
  const primary = path.join(productsDir, fileName)
  if (await pathExists(primary)) return primary
  const backup = path.join(productsBackupDir, fileName)
  if (await pathExists(backup)) return backup
  throw new Error(`product source not found (checked ${primary} and ${backup})`)
}

async function processProduct(product) {
  const sourcePath = await resolveProductSource(product.file)

  const srcMeta = await sharp(sourcePath).metadata()
  const nativeWidth = srcMeta.width
  const nativeHeight = srcMeta.height
  if (typeof nativeWidth !== 'number' || typeof nativeHeight !== 'number') {
    throw new Error(`cannot read source dimensions for ${product.file}`)
  }

  const candidateWidths = [...PRODUCT_WIDTH_TIERS, Math.min(PRODUCT_MAX_WIDTH, nativeWidth)]
  const widths = widthsWithinNative(candidateWidths, nativeWidth)
  const variants = []

  for (const width of widths) {
    const avifPath = path.join(productsDir, `${product.slug}-${width}.avif`)
    const webpPath = path.join(productsDir, `${product.slug}-${width}.webp`)

    const avifDims = await produceVariant({
      outPath: avifPath,
      width,
      sourcePath,
      format: 'avif',
      isByteCopy: false,
    })
    const webpDims = await produceVariant({
      outPath: webpPath,
      width,
      sourcePath,
      format: 'webp',
      isByteCopy: false,
    })

    if (avifDims.height !== webpDims.height) {
      throw new Error(
        `height mismatch for product ${product.slug} @ ${width}w: avif=${avifDims.height} webp=${webpDims.height}`,
      )
    }

    variants.push({
      width,
      height: avifDims.height,
      avif: `/images/products/${product.slug}-${width}.avif`,
      webp: `/images/products/${product.slug}-${width}.webp`,
    })
  }

  const placeholder = await dominantHex(path.join(productsDir, `${product.slug}-${variants[0].width}.webp`))

  return {
    id: product.slug,
    placeholder,
    width: nativeWidth,
    height: nativeHeight,
    alt: product.alt,
    variants,
  }
}

/** Backs up every listed product original, then deletes it from public/images/products. */
async function backupAndCleanProducts(products) {
  await ensureDir(productsBackupDir)

  for (const product of products) {
    const originalPath = path.join(productsDir, product.file)
    const backupPath = path.join(productsBackupDir, product.file)

    if (await pathExists(originalPath)) {
      if (!(await pathExists(backupPath))) {
        await copyFile(originalPath, backupPath)
        stats.backedUp += 1
      }
      await rm(originalPath)
    } else if (!(await pathExists(backupPath))) {
      console.warn(`WARNING: product original missing in both locations: ${product.file}`)
    }
  }
}

/** Copy-only backup of files that must remain live in place. */
async function copyIfNeeded(sourcePath, destPath) {
  await ensureDir(path.dirname(destPath))

  if (await pathExists(destPath)) {
    const [srcStat, destStat] = await Promise.all([stat(sourcePath), stat(destPath)])
    if (srcStat.size === destStat.size) {
      stats.skipped += 1
      return
    }
  }

  await copyFile(sourcePath, destPath)
  stats.copied += 1
}

async function backupPortfolioLegacyAndBrandLogo() {
  await ensureDir(portfolioLegacyBackupDir)

  // The live legacy files are deleted once no page references them; their backups stay.
  if (await pathExists(portfolioDir)) {
    const portfolioFiles = (await readdir(portfolioDir)).filter((name) => name.toLowerCase().endsWith('.jpeg'))
    for (const fileName of portfolioFiles) {
      await copyIfNeeded(path.join(portfolioDir, fileName), path.join(portfolioLegacyBackupDir, fileName))
    }
  }

  if (await pathExists(brandLogoPath)) {
    await copyIfNeeded(brandLogoPath, path.join(assetsOriginalsRoot, path.basename(brandLogoPath)))
  }
}

/** Dominant colour of an image as #rrggbb: the solid placeholder painted while the photo loads (decision D12). */
async function dominantHex(imagePath) {
  const { dominant } = await sharp(imagePath).stats()
  return '#' + [dominant.r, dominant.g, dominant.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')
}

function quote(value) {
  return JSON.stringify(value)
}

function renderVariant(variant, indent) {
  return (
    `${indent}{ width: ${variant.width}, height: ${variant.height}, ` +
    `avif: ${quote(variant.avif)}, webp: ${quote(variant.webp)} },`
  )
}

function renderSiteImageEntry(image) {
  const lines = []
  lines.push(`  ${quote(image.id)}: {`)
  lines.push(`    id: ${quote(image.id)},`)
  lines.push(`    ratio: ${quote(image.ratio)},`)
  lines.push(`    category: ${quote(image.category)},`)
  lines.push(`    placeholder: ${quote(image.placeholder)},`)
  lines.push(`    width: ${image.width},`)
  lines.push(`    height: ${image.height},`)
  lines.push(`    alt: ${quote(image.alt)},`)
  lines.push('    variants: [')
  for (const variant of image.variants) {
    lines.push(renderVariant(variant, '      '))
  }
  lines.push('    ],')
  lines.push('  },')
  return lines.join('\n')
}

function renderProductImageEntry(image) {
  const lines = []
  lines.push(`  ${quote(image.id)}: {`)
  lines.push(`    id: ${quote(image.id)},`)
  lines.push(`    placeholder: ${quote(image.placeholder)},`)
  lines.push(`    width: ${image.width},`)
  lines.push(`    height: ${image.height},`)
  lines.push(`    alt: ${quote(image.alt)},`)
  lines.push('    variants: [')
  for (const variant of image.variants) {
    lines.push(renderVariant(variant, '      '))
  }
  lines.push('    ],')
  lines.push('  },')
  return lines.join('\n')
}

function renderSiteImagesFile({ siteImageEntries, productImageEntries, portfolioOrder, heroImageId, homeFeatured, packagesBannerId, categories }) {
  const categoryUnion = categories.map((category) => quote(category.id)).join(' | ')
  const categoryList = categories
    .map((category) => `  { id: ${quote(category.id)}, label: ${quote(category.label)} },`)
    .join('\n')

  const header = `// AUTO-GENERATED FILE — do not hand-edit.
// Generated by app/scripts/optimize-images.mjs from
// runs/redo-v2/photo-catalogue.json. Re-run that script to regenerate.

export type SiteImageRatio = '16:9' | '3:2' | '4:5'

export type SiteImageCategory = ${categoryUnion}

export interface PortfolioCategory {
  readonly id: SiteImageCategory
  readonly label: string
}

/** Portfolio filter categories, in display order (the UI adds «الكل»). */
export const portfolioCategories: readonly PortfolioCategory[] = [
${categoryList}
]

export interface SiteImageVariant {
  readonly width: number
  readonly height: number
  readonly avif: string
  readonly webp: string
}

export interface SiteImage {
  readonly id: string
  readonly ratio: SiteImageRatio
  readonly category: SiteImageCategory
  /** Solid dominant colour (#rrggbb) painted behind the photo until it loads. */
  readonly placeholder: string
  readonly width: number
  readonly height: number
  readonly alt: string
  readonly variants: readonly SiteImageVariant[]
}

export interface ProductImage {
  readonly id: string
  readonly placeholder: string
  readonly width: number
  readonly height: number
  readonly alt: string
  readonly variants: readonly SiteImageVariant[]
}
`

  const siteImagesBlock = `export const siteImages = {
${siteImageEntries.map(renderSiteImageEntry).join('\n')}
} as const satisfies Record<string, SiteImage>

export type SiteImageId = keyof typeof siteImages

export const portfolioOrder: readonly SiteImageId[] = [
${portfolioOrder.map((id) => `  ${quote(id)},`).join('\n')}
]

export const heroImageId: SiteImageId = ${quote(heroImageId)}

export const homeFeatured: readonly SiteImageId[] = [
${homeFeatured.map((id) => `  ${quote(id)},`).join('\n')}
]

export const packagesBannerId: SiteImageId = ${quote(packagesBannerId)}
`

  const productImagesBlock = `export const productImages = {
${productImageEntries.map(renderProductImageEntry).join('\n')}
} as const satisfies Record<string, ProductImage>

export type ProductImageId = keyof typeof productImages
`

  return `${header}\n${siteImagesBlock}\n${productImagesBlock}`
}

async function writeIfChanged(filePath, content) {
  if (await pathExists(filePath)) {
    const existing = await readFile(filePath, 'utf8')
    if (existing === content) {
      return false
    }
  }
  await writeFile(filePath, content, 'utf8')
  return true
}

async function summarizeDir(dir) {
  if (!(await pathExists(dir))) return { files: 0, bytes: 0 }
  const entries = await readdir(dir)
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    const entryPath = path.join(dir, entry)
    const entryStat = await stat(entryPath)
    if (entryStat.isFile()) {
      files += 1
      bytes += entryStat.size
    }
  }
  return { files, bytes }
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes (${(bytes / 1024 / 1024).toFixed(2)} MB)`
}

async function main() {
  const catalogue = JSON.parse(await readFile(cataloguePath, 'utf8'))
  const sourceRoot = catalogue.source_root

  await ensureDir(siteOutDir)
  await ensureDir(productsDir)

  console.log(`Processing ${catalogue.photos.length} site photos...`)
  const siteImageEntries = []
  for (const photo of catalogue.photos) {
    const entry = await processSitePhoto(photo, sourceRoot)
    siteImageEntries.push(entry)
  }

  const publishableProducts = catalogue.products.filter((product) => product.publish === true)
  console.log(`Processing ${publishableProducts.length} publishable product photos...`)
  const productImageEntries = []
  for (const product of publishableProducts) {
    const entry = await processProduct(product)
    productImageEntries.push(entry)
  }

  console.log('Backing up and cleaning product originals...')
  await backupAndCleanProducts(catalogue.products)

  console.log('Backing up legacy portfolio JPEGs and brand logo...')
  await backupPortfolioLegacyAndBrandLogo()

  const portfolioOrder = catalogue.photos.map((photo) => photo.slug)
  const heroImageId = catalogue.slots.hero
  const homeFeatured = catalogue.slots.homeFeatured
  const packagesBannerId = catalogue.slots.packagesBanner

  const fileContent = renderSiteImagesFile({
    siteImageEntries,
    productImageEntries,
    portfolioOrder,
    heroImageId,
    homeFeatured,
    packagesBannerId,
    categories: catalogue.categories,
  })
  const dataFileChanged = await writeIfChanged(siteImagesDataPath, fileContent)

  const siteSummary = await summarizeDir(siteOutDir)
  const productsSummary = await summarizeDir(productsDir)

  console.log('')
  console.log('=== Optimize Images Report ===')
  console.log(`Site images   (public/images/site):     ${siteSummary.files} files, ${formatBytes(siteSummary.bytes)}`)
  console.log(`Product images (public/images/products): ${productsSummary.files} files, ${formatBytes(productsSummary.bytes)}`)
  console.log(`This run: wrote ${stats.written} new variant(s), skipped ${stats.skipped} already-up-to-date file(s), copied ${stats.copied} backup file(s), backed up ${stats.backedUp} product original(s).`)
  console.log(`src/data/site-images.ts: ${dataFileChanged ? 'written (changed)' : 'unchanged'}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
