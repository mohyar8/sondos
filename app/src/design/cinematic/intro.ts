/**
 * Cinematic logo intro (12-motion-spec.md §4).
 *
 * Storyboard (≤ 1.85 s): a thin gold ring and an eight-point khatam star
 * draw themselves and turn into place (0–1.1 s), the calligraphic logo is
 * inked in from right to left over them (0.42–1.2 s), then the whole screen
 * lifts away along a diagonal while the star grows and fades, uncovering the
 * home page whose entrance resumes underneath (hero.css "hero hold").
 *
 * Rules:
 * - home page (`/`) only, never on a deep link, at most once every 60 days
 *   (remembered in localStorage as `sy:intro:v1`; blocked storage = no intro);
 * - never under prefers-reduced-motion;
 * - any pointer, key, wheel or touch input ends it at once;
 * - the page renders underneath, so the hero image loads in parallel;
 * - the overlay is aria-hidden and takes no focus; it only sets classes and
 *   data attributes (no inline styles), so the CSP stays strict.
 */

const STORAGE_KEY = 'sy:intro:v1'
const REPEAT_AFTER_MS = 60 * 24 * 60 * 60 * 1000
const HOLD_MS = 1250
const LEAVE_MS = 600
const SKIP_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
const SVG_NS = 'http://www.w3.org/2000/svg'

function readLastShown(): number | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    const parsed = value === null ? 0 : Number(value)

    return Number.isFinite(parsed) ? parsed : 0
  } catch (error: unknown) {
    if (error instanceof DOMException) {
      return null
    }

    throw error
  }
}

function rememberShown(now: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(now))
  } catch (error: unknown) {
    if (!(error instanceof DOMException)) {
      throw error
    }
  }
}

function shouldPlay(now: number): boolean {
  if (window.location.pathname !== '/' || window.location.hash !== '') {
    return false
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return false
  }

  const lastShown = readLastShown()

  return lastShown !== null && now - lastShown > REPEAT_AFTER_MS
}

function svgElement(
  name: string,
  className: string,
  attributes: Record<string, string>,
): SVGElement {
  const element = document.createElementNS(SVG_NS, name)

  element.setAttribute('class', className)

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value)
  }

  return element
}

/** The gold ring and the two squares of the khatam star. */
function createFrame(): SVGElement {
  const frame = svgElement('svg', 'cine-intro__frame', {
    viewBox: '0 0 200 200',
    'aria-hidden': 'true',
    focusable: 'false',
  })

  frame.append(
    svgElement('circle', 'cine-intro__ring', {
      cx: '100',
      cy: '100',
      r: '92',
      pathLength: '1',
    }),
    svgElement('rect', 'cine-intro__square', {
      x: '38',
      y: '38',
      width: '124',
      height: '124',
      pathLength: '1',
    }),
    svgElement('rect', 'cine-intro__square cine-intro__square--turned', {
      x: '38',
      y: '38',
      width: '124',
      height: '124',
      pathLength: '1',
    }),
  )

  return frame
}

export function playIntroOnce(logoSrc: string): void {
  const now = Date.now()

  if (!shouldPlay(now)) {
    return
  }

  rememberShown(now)

  const root = document.documentElement
  const overlay = document.createElement('div')
  const logo = document.createElement('img')

  overlay.className = 'cine-intro'
  overlay.setAttribute('aria-hidden', 'true')
  logo.className = 'cine-intro__logo'
  logo.src = logoSrc
  logo.alt = ''
  logo.decoding = 'async'
  overlay.append(createFrame(), logo)

  root.setAttribute('data-cine-intro', 'playing')
  root.setAttribute('data-cine-entry', 'intro')
  document.body.append(overlay)

  let leaving = false
  let holdTimer = 0

  function finish() {
    overlay.remove()
    root.removeAttribute('data-cine-intro')
  }

  function leave() {
    if (leaving) {
      return
    }

    leaving = true
    window.clearTimeout(holdTimer)

    for (const type of SKIP_EVENTS) {
      window.removeEventListener(type, leave)
    }

    root.setAttribute('data-cine-intro', 'leaving')
    window.setTimeout(finish, LEAVE_MS)
  }

  for (const type of SKIP_EVENTS) {
    window.addEventListener(type, leave, { passive: true })
  }

  holdTimer = window.setTimeout(leave, HOLD_MS)
}
