import type { SiteImageVariant } from '../data/site-images'

interface ResponsiveImageSource {
  readonly width: number
  readonly height: number
  readonly alt: string
  readonly variants: readonly SiteImageVariant[]
}

interface ResponsiveImageProps {
  image: ResponsiveImageSource
  sizes: string
  className?: string
  loading?: 'lazy' | 'eager'
  fetchPriority?: 'high' | 'low' | 'auto'
}

export default function ResponsiveImage({
  image,
  sizes,
  className,
  loading = 'lazy',
  fetchPriority,
}: ResponsiveImageProps) {
  const avifSrcSet = image.variants
    .map((variant) => `${variant.avif} ${variant.width}w`)
    .join(', ')
  const webpSrcSet = image.variants
    .map((variant) => `${variant.webp} ${variant.width}w`)
    .join(', ')
  const largestVariant = image.variants[image.variants.length - 1]

  return (
    <picture>
      <source type="image/avif" srcSet={avifSrcSet} sizes={sizes} />
      <source type="image/webp" srcSet={webpSrcSet} sizes={sizes} />
      <img
        src={largestVariant?.webp}
        width={image.width}
        height={image.height}
        alt={image.alt}
        className={className}
        loading={loading}
        decoding="async"
        fetchPriority={fetchPriority}
      />
    </picture>
  )
}
