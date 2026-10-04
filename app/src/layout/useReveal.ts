import { useLayoutEffect, type RefObject } from 'react'

/*
 * Scroll-entry reveal — the JS half of the `.reveal` contract in
 * styles/motion.css (design-system §3.2):
 *
 *   .reveal                    final, visible state (what CSS alone shows)
 *   .reveal.reveal--armed      "from" state, added here only
 *   .reveal--armed.is-revealed "to" state, added here when the element enters
 *
 * An element is armed only when motion is allowed AND it starts below the
 * fold, so nothing the visitor can already see ever disappears, and a
 * JavaScript failure or reduced motion leaves everything visible.
 */

const REVEAL_SELECTOR = '.reveal'
const ARMED_CLASS = 'reveal--armed'
const REVEALED_CLASS = 'is-revealed'
const STAGGER_PROPERTY = '--reveal-index'
/** §3.2: stagger 60–80 ms per sibling, capped at about five steps (0–4). */
const MAX_STAGGER_INDEX = 4
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const OBSERVER_OPTIONS: IntersectionObserverInit = {
  threshold: 0.15,
  rootMargin: '0px 0px -10% 0px',
}

/**
 * Arms every `.reveal` element inside `rootRef` and reveals each one once, the
 * first time it scrolls into view. Siblings that enter together are staggered.
 * Follows live changes to prefers-reduced-motion, and removes every class,
 * inline property, observer and listener it added when the root unmounts.
 */
export function useReveal(rootRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = rootRef.current

    if (
      root === null ||
      typeof window.IntersectionObserver !== 'function' ||
      typeof window.matchMedia !== 'function'
    ) {
      return undefined
    }

    const elements = Array.from(
      root.querySelectorAll<HTMLElement>(REVEAL_SELECTOR),
    )

    if (elements.length === 0) {
      return undefined
    }

    const motionQuery = window.matchMedia(REDUCED_MOTION_QUERY)
    const revealedElements = new WeakSet<HTMLElement>()
    let observer: IntersectionObserver | null = null

    function handleIntersections(
      entries: IntersectionObserverEntry[],
      activeObserver: IntersectionObserver,
    ) {
      // Stagger only the siblings that arrive in the same batch, so a card
      // that scrolls in on its own never waits for siblings it cannot see.
      const batchIndexByParent = new Map<Element | null, number>()

      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue
        }

        const element = entry.target
        activeObserver.unobserve(element)

        if (!(element instanceof HTMLElement)) {
          continue
        }

        const parent = element.parentElement
        const index = batchIndexByParent.get(parent) ?? 0
        batchIndexByParent.set(parent, index + 1)

        if (index > 0) {
          element.style.setProperty(
            STAGGER_PROPERTY,
            String(Math.min(index, MAX_STAGGER_INDEX)),
          )
        }

        revealedElements.add(element)
        element.classList.add(REVEALED_CLASS)
      }
    }

    function disarm() {
      observer?.disconnect()
      observer = null

      for (const element of elements) {
        element.classList.remove(ARMED_CLASS, REVEALED_CLASS)
        element.style.removeProperty(STAGGER_PROPERTY)
      }
    }

    function arm() {
      if (motionQuery.matches) {
        return
      }

      const foldEdge = window.innerHeight
      const belowFold = elements.filter(
        (element) =>
          !revealedElements.has(element) &&
          element.getBoundingClientRect().top >= foldEdge,
      )

      if (belowFold.length === 0) {
        return
      }

      const nextObserver = new IntersectionObserver(
        handleIntersections,
        OBSERVER_OPTIONS,
      )

      for (const element of belowFold) {
        element.classList.add(ARMED_CLASS)
        nextObserver.observe(element)
      }

      observer = nextObserver
    }

    function handleMotionPreferenceChange() {
      // Reduced motion switched on: show everything, statically, right away.
      // Switched off: arm again whatever is still waiting below the fold.
      disarm()
      arm()
    }

    arm()
    motionQuery.addEventListener('change', handleMotionPreferenceChange)

    return () => {
      motionQuery.removeEventListener('change', handleMotionPreferenceChange)
      disarm()
    }
  }, [rootRef])
}
