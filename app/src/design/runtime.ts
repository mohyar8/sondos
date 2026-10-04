/**
 * Runtime checks for the design switch. The cinematic boot
 * (src/design/cinematic/boot.ts) marks <html data-design="cinematic"> before
 * the first render, so components can read it synchronously; the classic
 * build never sets it and renders exactly the classic markup.
 */
export function isCinematicDesign(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-design') === 'cinematic'
  )
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** View transitions: cinematic design, supported engine, motion allowed. */
export function canUseViewTransition(): boolean {
  return (
    isCinematicDesign() &&
    typeof document.startViewTransition === 'function' &&
    !prefersReducedMotion()
  )
}

/** A transition skipped by a quick second action rejects with AbortError. */
export function ignoreSkippedTransition(error: unknown): void {
  if (!(error instanceof DOMException)) {
    throw error
  }
}
