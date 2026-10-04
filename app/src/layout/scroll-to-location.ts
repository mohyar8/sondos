import { getHashTargetId } from './navigation'

/**
 * How many animation frames to keep looking for a #hash target after the page
 * has rendered (about half a second at 60 Hz). Covers content that a page
 * mounts a frame or two after its own commit; after that the hash is treated
 * as unknown and the page starts at the top.
 */
const MAX_TARGET_LOOKUP_FRAMES = 30

export function scrollToPageTop(): void {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
}

/**
 * Scrolls to the element named by `hash` (e.g. "#packages"), or to the top of
 * the page when there is no hash or no such element. The sticky header is
 * accounted for by the scroll-margin rules in PublicSiteShell.css. Returns a
 * cleanup that cancels a lookup still in progress.
 */
export function scrollToLocationHash(hash: string): () => void {
  const targetId = getHashTargetId(hash)
  let framesLeft = MAX_TARGET_LOOKUP_FRAMES
  let frameId = 0

  function scrollToTarget() {
    const target = targetId === null ? null : document.getElementById(targetId)

    if (target !== null) {
      const reduceMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches

      target.scrollIntoView({
        behavior: reduceMotion ? 'instant' : 'smooth',
        block: 'start',
      })
      return
    }

    if (targetId !== null && framesLeft > 0) {
      framesLeft -= 1
      frameId = window.requestAnimationFrame(scrollToTarget)
      return
    }

    scrollToPageTop()
  }

  frameId = window.requestAnimationFrame(scrollToTarget)

  return () => window.cancelAnimationFrame(frameId)
}
