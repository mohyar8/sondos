// W2-20 / MOT-04: the cinematic motion layer's stylesheets (12-motion-spec.md
// §2, §3, §8.2). Each case fails if a control is removed or weakened: every
// selector is scoped to :root[data-design="cinematic"] (classic stays inert
// even if a file leaked in), no hex and no url() (the palette is aliased, no
// network and no data: URI), only compositor properties animate, every
// animation and transition sits behind prefers-reduced-motion: no-preference,
// the entry guard keeps veils and rises off after an intro or inside a view
// transition (UX-09), veils exist only on armed tiles (UX-10, no mount veils),
// the corners use gold + ink (UX-12), and the cinematic boot imports exactly
// these files.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const cinematicRoot = join(appRoot, 'src', 'design', 'cinematic')
const STYLESHEETS = ['tokens.css', 'hero.css', 'scroll.css']
const SCOPE = ':root[data-design="cinematic"]'
const MOTION_QUERY = '@media (prefers-reduced-motion: no-preference)'
/** §2 token rule 1: the only properties page content may animate. */
const COMPOSITOR_PROPERTIES = new Set(['opacity', 'transform', 'translate', 'scale'])
/** Classes later motion units add (§8.3); selectors may mention them today. */
const CONTRACT_CLASSES = new Set(['cine-words', 'cine-w'])

function read(relativePath) {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * A small block parser for our own stylesheets (no strings with braces, no
 * url(), no data: — the cases below forbid them). Returns a tree whose nodes
 * are { prelude, declarations: [{ property, value }], children }.
 */
function parseStylesheet(css) {
  const root = { prelude: '', declarations: [], children: [] }
  const stack = [root]
  let buffer = ''

  function flush(node, text) {
    const trimmed = text.trim()
    if (trimmed === '') return
    const colon = trimmed.indexOf(':')
    assert.notEqual(colon, -1, `declaration without a colon: ${trimmed}`)
    node.declarations.push({
      property: trimmed.slice(0, colon).trim(),
      value: trimmed.slice(colon + 1).trim(),
    })
  }

  for (const char of stripComments(css)) {
    if (char === '{') {
      const node = { prelude: buffer.trim(), declarations: [], children: [] }
      stack.at(-1).children.push(node)
      stack.push(node)
      buffer = ''
    } else if (char === '}') {
      flush(stack.pop(), buffer)
      buffer = ''
    } else if (char === ';') {
      flush(stack.at(-1), buffer)
      buffer = ''
    } else {
      buffer += char
    }
  }

  assert.equal(stack.length, 1, 'unbalanced braces')
  assert.equal(buffer.trim(), '', `text outside any block: ${buffer.trim()}`)
  return root
}

/** Splits a selector list or a value list on the commas outside parentheses. */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current.trim())
  return parts
}

/** Every style rule with the at-rules it sits inside, keyframes separated. */
function collectRules(tree) {
  const rules = []
  const keyframes = []

  function walk(node, ancestors) {
    for (const child of node.children) {
      if (child.prelude.startsWith('@keyframes')) {
        keyframes.push(child)
      } else if (child.prelude.startsWith('@')) {
        walk(child, [...ancestors, child.prelude])
      } else {
        rules.push({
          selectors: splitTopLevel(child.prelude),
          declarations: child.declarations,
          ancestors,
        })
      }
    }
  }

  walk(tree, [])
  return { rules, keyframes }
}

const sources = new Map(
  STYLESHEETS.map((name) => [name, read(`src/design/cinematic/${name}`)]),
)
const parsed = new Map(
  [...sources].map(([name, css]) => [name, collectRules(parseStylesheet(css))]),
)
const allRules = [...parsed.values()].flatMap(({ rules }) => rules)
const allKeyframes = [...parsed.values()].flatMap(({ keyframes }) => keyframes)

describe('cinematic stylesheets are scoped and self-contained (SC-0)', () => {
  test('every selector starts with :root[data-design="cinematic"]', () => {
    assert.notEqual(allRules.length, 0)
    for (const rule of allRules) {
      for (const selector of rule.selectors) {
        assert.equal(selector.startsWith(SCOPE), true, selector)
      }
    }
  })

  test('every keyframes name is prefixed cine- (the build-output marker)', () => {
    assert.notEqual(allKeyframes.length, 0)
    for (const block of allKeyframes) {
      assert.match(block.prelude, /^@keyframes cine-[a-z-]+$/)
    }
  })

  test('no hex, no url(), no @import, no data:, no !important', () => {
    for (const [name, css] of sources) {
      const code = stripComments(css)
      assert.doesNotMatch(code, /#[0-9a-f]{3,8}\b/i, `${name}: hex colour`)
      assert.doesNotMatch(code, /url\s*\(/i, `${name}: url()`)
      assert.doesNotMatch(code, /@import\b/, `${name}: @import`)
      assert.doesNotMatch(code, /data:/i, `${name}: data: URI`)
      assert.doesNotMatch(code, /!important/, `${name}: !important`)
      assert.doesNotMatch(code, /expression\s*\(/i, `${name}: expression()`)
    }
  })

  test('colours are palette aliases: every gradient stop is a var()', () => {
    for (const [name, css] of sources) {
      const code = stripComments(css)
      const gradients = (code.match(/gradient\(/g) ?? []).length
      const aliased = (code.match(/gradient\(var\(--(cine|color)-[a-z-]+\)/g) ?? []).length
      assert.equal(aliased, gradients, `${name}: a gradient stop is not a palette alias`)
    }
  })

  test('every --cine-* / --color-* reference resolves to a declared token', () => {
    const declared = new Set(
      [...stripComments(read('src/styles/tokens.css')).matchAll(/(--color-[a-z-]+)\s*:/g)].map(
        (match) => match[1],
      ),
    )
    for (const rule of allRules) {
      for (const { property } of rule.declarations) {
        if (property.startsWith('--')) declared.add(property)
      }
    }
    for (const [name, css] of sources) {
      for (const match of stripComments(css).matchAll(/var\((--[a-z-]+)/g)) {
        const token = match[1]
        if (token === '--reveal-index') continue // set inline by useReveal
        assert.equal(declared.has(token), true, `${name}: ${token} is not declared`)
      }
    }
  })

  test('selectors target classes that exist in the markup or the §8.3 contract', () => {
    const markup = [
      'src/pages/home/HeroSection.tsx',
      'src/pages/home/FeaturedWorkSection.tsx',
      'src/pages/PortfolioPage.tsx',
      'src/pages/PackagesPage.tsx',
      'src/layout/SiteHeader.tsx',
      'src/styles/motion.css',
    ]
      .map(read)
      .join('\n')
    for (const rule of allRules) {
      for (const selector of rule.selectors) {
        for (const match of selector.matchAll(/\.([a-z][a-z0-9_-]*)/g)) {
          const className = match[1]
          if (CONTRACT_CLASSES.has(className)) continue
          assert.equal(markup.includes(className), true, `${selector}: .${className}`)
        }
      }
    }
  })
})

describe('motion is compositor-only and behind prefers-reduced-motion', () => {
  test('keyframes animate only opacity, transform, translate and scale', () => {
    for (const block of allKeyframes) {
      for (const frame of block.children) {
        for (const { property } of frame.declarations) {
          assert.equal(COMPOSITOR_PROPERTIES.has(property), true, `${block.prelude}: ${property}`)
        }
      }
    }
  })

  test('transitions name only compositor properties', () => {
    for (const rule of allRules) {
      for (const { property, value } of rule.declarations) {
        if (property !== 'transition' || value === 'none') continue
        for (const part of splitTopLevel(value)) {
          const [animated] = part.split(/\s+/)
          assert.equal(COMPOSITOR_PROPERTIES.has(animated), true, `${rule.selectors[0]}: ${animated}`)
        }
      }
    }
  })

  test('every animation and transition sits inside no-preference (none is allowed anywhere)', () => {
    for (const rule of allRules) {
      const insideMotionQuery = rule.ancestors.includes(MOTION_QUERY)
      for (const { property, value } of rule.declarations) {
        if (!/^(animation|transition)/.test(property) || value === 'none') continue
        assert.equal(insideMotionQuery, true, `${rule.selectors[0]} { ${property} }`)
      }
    }
  })

  test('from-states (opacity 0, a veil at scaleX(1)) exist only inside no-preference', () => {
    for (const rule of allRules) {
      const insideMotionQuery = rule.ancestors.includes(MOTION_QUERY)
      for (const { property, value } of rule.declarations) {
        const fromState =
          (property === 'opacity' && value === '0') ||
          (property === 'transform' && value === 'scaleX(1)')
        if (!fromState) continue
        // The header logo is hidden by the intro's state attribute, not by
        // a from-state: the intro never plays under reduced motion (§4.6).
        if (rule.selectors[0].includes('data-cine-intro')) continue
        assert.equal(insideMotionQuery, true, `${rule.selectors[0]} { ${property}: ${value} }`)
      }
    }
  })

  test('scroll-driven parallax is feature-gated and only on <picture>', () => {
    for (const rule of allRules) {
      if (!rule.declarations.some(({ property }) => property === 'animation-timeline')) continue
      assert.equal(rule.ancestors.includes('@supports (animation-timeline: view())'), true)
      for (const selector of rule.selectors) {
        assert.match(selector, /> picture$/, selector)
      }
    }
  })
})

describe('tokens.css (§2)', () => {
  const { rules } = parsed.get('tokens.css')

  test('one scoped rule declaring only --cine-* tokens and --z-intro', () => {
    assert.equal(rules.length, 1)
    assert.deepEqual(rules[0].selectors, [SCOPE])
    assert.deepEqual(rules[0].ancestors, [])
    for (const { property } of rules[0].declarations) {
      assert.match(property, /^--(cine-[a-z-]+|z-intro)$/, property)
    }
  })

  test('the rev. 2 timings and the colour aliases', () => {
    const byName = new Map(rules[0].declarations.map(({ property, value }) => [property, value]))
    assert.equal(byName.get('--cine-dur-vt-in'), '450ms')
    assert.equal(byName.get('--cine-dur-vt-out'), '250ms')
    assert.equal(byName.get('--cine-dur-fade'), '400ms')
    assert.equal(byName.get('--cine-dur-glide'), '500ms')
    assert.equal(byName.get('--cine-dur-wipe'), '1100ms')
    assert.equal(byName.get('--cine-dur-settle'), '2400ms')
    assert.equal(byName.get('--cine-gold'), 'var(--color-accent)')
    assert.equal(byName.get('--cine-gold-on-dark'), 'var(--color-accent-soft)')
    assert.equal(byName.get('--cine-intro-bg'), 'var(--color-paper)')
    assert.equal(byName.get('--z-intro'), '990')
  })
})

describe('hero.css (E2–E4, §4.5, E9)', () => {
  const { rules } = parsed.get('hero.css')
  const veilRules = rules.filter((rule) =>
    rule.selectors.some((selector) => selector.endsWith('.home-hero__media::after')),
  )

  test('the hero veil exists only on a plain load (UX-01, UX-09)', () => {
    const veil = veilRules.find((rule) =>
      rule.declarations.some(({ property, value }) => property === 'content' && value === '""'),
    )
    assert.notEqual(veil, undefined)
    assert.equal(veil.ancestors.includes(MOTION_QUERY), true)
    assert.match(veil.selectors[0], /^:root\[data-design="cinematic"\]:where\(:not\(\[data-cine-entry\]\)\)/)
    assert.equal(veil.declarations.some(({ property, value }) => property === 'transform-origin' && value === 'left center'), true)
    assert.equal(veil.declarations.some(({ property, value }) => property === 'background-color' && value === 'inherit'), true)
  })

  test('the veil and the rises play only on a plain load; settles and the corner lock skip view transitions', () => {
    const plainLoadOnly = new Set(['cine-veil-out', 'cine-rise'])
    const skipsViewTransition = new Set(['cine-settle', 'cine-lock'])
    let checked = 0
    for (const rule of rules) {
      const animated = rule.declarations.find(({ property, value }) => property === 'animation' && value !== 'none')
      if (animated === undefined) continue
      const [name] = animated.value.split(/\s+/)
      const selector = rule.selectors[0]
      if (plainLoadOnly.has(name)) {
        assert.match(selector, /:where\(:not\(\[data-cine-entry\]\)\)/, selector)
      } else {
        assert.equal(skipsViewTransition.has(name), true, `${selector}: ${name}`)
        assert.match(selector, /:where\(:not\(\[data-cine-entry="vt"\]\)\)/, selector)
      }
      checked += 1
    }
    assert.equal(checked, 9, 'settle, veil, lock, four rises (eyebrow, plain title, lead, actions), banner settle and lead rise')
  })

  test('the classic hero-zoom is replaced, never stacked', () => {
    const replaced = rules.find(
      (rule) =>
        rule.selectors[0] === `${SCOPE} .home-hero__image` &&
        rule.ancestors.length === 0 &&
        rule.declarations.some(({ property, value }) => property === 'animation' && value === 'none'),
    )
    assert.notEqual(replaced, undefined)
    assert.doesNotMatch(stripComments(sources.get('hero.css')), /hero-zoom/)
  })

  test('the viewfinder corners are gold with an ink hairline, static for everyone (UX-12)', () => {
    const corners = rules.find(
      (rule) => rule.selectors[0] === `${SCOPE} .home-hero__media::before` && rule.ancestors.length === 0,
    )
    assert.notEqual(corners, undefined)
    const background = corners.declarations.find(({ property }) => property === 'background')
    assert.notEqual(background, undefined)
    const stops = [...background.value.matchAll(/gradient\((var\(--[a-z-]+\))/g)].map((match) => match[1])
    assert.equal(stops.length, 16, 'eight gold arms and eight ink hairlines')
    assert.equal(stops.slice(0, 8).every((stop) => stop === 'var(--cine-gold)'), true)
    assert.equal(stops.slice(8).every((stop) => stop === 'var(--color-ink)'), true)
    assert.doesNotMatch(background.value, /--cine-gold-on-dark/)
    assert.equal(corners.declarations.some(({ property, value }) => property === 'opacity' && value === '0.9'), true)
    assert.equal(corners.declarations.some(({ property, value }) => property === 'pointer-events' && value === 'none'), true)
  })

  test('the hero hold pauses the photo, the content and both pseudo-elements while the intro plays (§4.5)', () => {
    const hold = rules.filter((rule) =>
      rule.declarations.some(({ property, value }) => property === 'animation-play-state' && value === 'paused'),
    )
    assert.equal(hold.length, 1)
    const selectors = hold[0].selectors.join('\n')
    for (const target of ['.home-hero__image', '.home-hero__content', '.home-hero__content > *', '.home-hero__media::before', '.home-hero__media::after']) {
      assert.equal(selectors.includes(target), true, target)
    }
    for (const selector of hold[0].selectors) {
      assert.match(selector, /^:root\[data-design="cinematic"\]\[data-cine-intro="playing"\]/)
    }
  })

  test('the header logo is hidden while the intro plays or leaves (§4.4)', () => {
    const hidden = rules.find((rule) =>
      rule.selectors[0].endsWith('.site-header__logo') &&
      rule.declarations.some(({ property, value }) => property === 'opacity' && value === '0'),
    )
    assert.notEqual(hidden, undefined)
    assert.match(hidden.selectors[0], /\[data-cine-intro="playing"\]/)
    assert.match(hidden.selectors[0], /\[data-cine-intro="leaving"\]/)
    assert.deepEqual(hidden.ancestors, [])
  })
})

describe('scroll.css (E6–E8)', () => {
  const { rules } = parsed.get('scroll.css')

  test('tile veils exist only on armed tiles and never inside a view transition (UX-10, UX-09)', () => {
    const veilSelectors = rules
      .flatMap((rule) => rule.selectors)
      .filter((selector) => /(home-featured__item|portfolio-tile)(:nth-child\(\d\))?::after$/.test(selector))
    assert.notEqual(veilSelectors.length, 0)
    for (const selector of veilSelectors) {
      assert.match(selector, /\.reveal--armed/, selector)
      if (!rules.some((rule) => rule.ancestors.includes('@media print') && rule.selectors.includes(selector))) {
        assert.match(selector, /:where\(:not\(\[data-cine-entry="vt"\]\)\)/, selector)
      }
    }
  })

  test('the tile settle needs an armed, revealed item — a filter change adds no settle (UX-10)', () => {
    const settles = rules.filter((rule) =>
      rule.declarations.some(({ property, value }) => property === 'animation' && value.startsWith('cine-settle-tile')),
    )
    assert.equal(settles.length, 1)
    for (const selector of settles[0].selectors) {
      assert.match(selector, /\.portfolio-grid__item\.reveal--armed\.is-revealed \.portfolio-tile__image$/)
    }
  })

  test('the E6 tuning keeps the classic contract shape', () => {
    const armed = rules.find((rule) => rule.selectors[0] === `${SCOPE} .reveal.reveal--armed` && rule.ancestors.includes(MOTION_QUERY))
    assert.notEqual(armed, undefined)
    assert.equal(armed.declarations.some(({ property, value }) => property === 'transform' && value === 'none'), true)
    assert.equal(armed.declarations.some(({ property, value }) => property === 'translate' && value === '0 var(--cine-rise)'), true)
    const revealed = rules.find((rule) => rule.selectors[0] === `${SCOPE} .reveal--armed.is-revealed` && rule.ancestors.includes(MOTION_QUERY))
    assert.notEqual(revealed, undefined)
    assert.equal(rules.indexOf(armed) < rules.indexOf(revealed), true, 'the revealed rule follows the armed rule')
  })

  test('print shows every armed element and no veil', () => {
    const printRules = rules.filter((rule) => rule.ancestors.includes('@media print'))
    assert.equal(printRules.some((rule) => rule.selectors[0] === `${SCOPE} .reveal.reveal--armed`), true)
    assert.equal(printRules.some((rule) => rule.declarations.some(({ property, value }) => property === 'content' && value === 'none')), true)
  })
})

describe('the cinematic boot', () => {
  test('imports exactly tokens, hero and scroll, in that order, and marks <html>', () => {
    const boot = stripComments(read('src/design/cinematic/boot.ts'))
    const imports = [...boot.matchAll(/^import '([^']+)'$/gm)].map((match) => match[1])
    assert.deepEqual(imports, ['./tokens.css', './hero.css', './scroll.css'])
    assert.equal((boot.match(/\bimport\b/g) ?? []).length, imports.length)
    assert.match(boot, /document\.documentElement\.setAttribute\('data-design', 'cinematic'\)/)
  })
})
