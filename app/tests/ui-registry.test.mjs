// W1-05: the UI registry slots and the two shared panel stylesheets.
//
// Static checks over the source (no module is imported, so no bundler or
// resolve hook is involved):
//   - every slot is wired exactly once, in its fixed order (UX-05); a tab
//     slot also carries its fixed phone group (UX-05);
//   - the registries' static import graph never reaches a component (.tsx)
//     or a stylesheet: descriptors import their components lazily only;
//   - slot files carry no inline styles, storage, links or HTML sinks (SB-12);
//   - the panel stylesheets use existing tokens only, stay inside their own
//     block, keep accent text on the right backgrounds (UX-12), size every
//     control to 44 x 44 CSS px with 8 px gaps (UX-13) and never let focus
//     land under a bar pinned to the bottom (WCAG 2.4.11).

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STAGE_VIEWS = 'src/features/journey/stage-views.ts'
const SECTIONS = 'src/features/admin-portal/sections.ts'
const STAGE_PANELS_CSS = 'src/features/journey/stage-panels.css'
const ADMIN_PANELS_CSS = 'src/features/admin-portal/admin-panels.css'
const TOKENS_CSS = 'src/styles/tokens.css'

const STAGE_VIEW_SLOTS = {
  complete: ['src/features/confirmation/registration.ts', 'confirmationStageView'],
  details: ['src/features/event-profile/registration.ts', 'eventProfileStageView'],
  gallery: ['src/features/gallery/registration.ts', 'galleryStageView'],
  handover: ['src/features/handover/registration.ts', 'handoverStageView'],
  feedback: ['src/features/feedback/registration.ts', 'feedbackStageView'],
}

const ADMIN_SECTION_ORDER = {
  summary: 0,
  actions: 10,
  contact: 20,
  deposit: 30,
  receipts: 35,
  handover: 40,
  production: 50,
  gallery: 55,
  eventProfile: 60,
  timeline: 70,
  feedback: 80,
}

/** [slot file, export name, position], listed in their fixed order. */
const ADMIN_SECTION_SLOTS = [
  ['src/features/admin-contact/registration.ts', 'adminContactSection', 'contact'],
  ['src/features/admin-deposit/registration.ts', 'adminDepositSection', 'deposit'],
  ['src/features/admin-receipt/registration.ts', 'adminReceiptSection', 'receipts'],
  ['src/features/admin-handover/registration.ts', 'adminHandoverSection', 'handover'],
  ['src/features/admin-production/registration.ts', 'adminProductionSection', 'production'],
  ['src/features/admin-gallery/registration.ts', 'adminGallerySection', 'gallery'],
  ['src/features/admin-event-profile/registration.ts', 'adminEventProfileSection', 'eventProfile'],
  ['src/features/admin-timeline/registration.ts', 'adminTimelineSection', 'timeline'],
  ['src/features/admin-feedback/registration.ts', 'adminFeedbackSection', 'feedback'],
]

/** Workspace tabs: the primary destinations first, then «المزيد». */
const ADMIN_TAB_ORDER = {
  queue: 10,
  calendar: 20,
  customers: 30,
  handoverSlots: 40,
  settings: 50,
  audit: 60,
  security: 70,
}

/** Only «اليوم» and «التقويم» are primary on phones. */
const ADMIN_TAB_GROUP = {
  queue: 'primary',
  calendar: 'primary',
  customers: 'more',
  handoverSlots: 'more',
  settings: 'more',
  audit: 'more',
  security: 'more',
}

/** [slot file, export name, position], listed in their fixed order. */
const ADMIN_TAB_SLOTS = [
  ['src/features/admin-queue/registration.ts', 'adminQueueTab', 'queue'],
  ['src/features/admin-calendar/registration.ts', 'adminCalendarTab', 'calendar'],
  ['src/features/admin-customers/registration.ts', 'adminCustomersTab', 'customers'],
  ['src/features/admin-handover/registration.ts', 'adminHandoverSlotsTab', 'handoverSlots'],
  ['src/features/admin-settings/registration.ts', 'adminSettingsTab', 'settings'],
  ['src/features/admin-audit/registration.ts', 'adminAuditTab', 'audit'],
  ['src/features/admin-security/registration.ts', 'adminSecurityTab', 'security'],
]

const BUILT_IN_ADMIN_TABS = ['bookings', 'blocked-dates', 'security']

const SLOT_FILES = [
  ...new Set([
    ...Object.values(STAGE_VIEW_SLOTS).map(([file]) => file),
    ...ADMIN_SECTION_SLOTS.map(([file]) => file),
    ...ADMIN_TAB_SLOTS.map(([file]) => file),
  ]),
]

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// TypeScript import graph
// ---------------------------------------------------------------------------

/** Specifiers of the imports that load a module at runtime (not `import type`). */
function runtimeImportSpecifiers(source) {
  const code = stripComments(source)
  const specifiers = []
  const fromPattern =
    /(?:^|\n)\s*(?:import|export)\s+(?!type[\s{])([^'"`;]*?)\bfrom\s*['"]([^'"]+)['"]/g
  const bareImportPattern = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

  for (const match of code.matchAll(fromPattern)) {
    specifiers.push(match[2])
  }

  for (const match of code.matchAll(bareImportPattern)) {
    specifiers.push(match[1])
  }

  return specifiers
}

function resolveRelative(fromFile, specifier) {
  const base = join(dirname(join(ROOT, fromFile)), specifier)
  const candidates = /\.(ts|tsx|css)$/.test(specifier)
    ? [base]
    : specifier.endsWith('.js')
      ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
      : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  const found = candidates.find((candidate) => existsSync(candidate))

  assert.ok(found, `${fromFile}: cannot resolve '${specifier}'`)
  return relative(ROOT, found).split('\\').join('/')
}

/**
 * Everything a module loads at runtime through static imports: the relative
 * files it reaches and the packages those files import.
 */
function staticImportClosure(entryFile) {
  const seen = new Set([entryFile])
  const packages = new Set()
  const pending = [entryFile]

  while (pending.length > 0) {
    const file = pending.pop()

    if (!file.endsWith('.ts')) {
      continue
    }

    for (const specifier of runtimeImportSpecifiers(read(file))) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier)
        continue
      }

      const target = resolveRelative(file, specifier)

      if (!seen.has(target)) {
        seen.add(target)
        pending.push(target)
      }
    }
  }

  return { files: seen, packages }
}

/** Named value imports of a module: export name → resolved file. */
function namedImports(file) {
  const code = stripComments(read(file))
  const imports = new Map()
  const pattern = /(?:^|\n)\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g

  for (const match of code.matchAll(pattern)) {
    const target = resolveRelative(file, match[2])

    for (const name of match[1].split(',').map((part) => part.trim())) {
      if (name !== '' && !name.startsWith('type ')) {
        imports.set(name, target)
      }
    }
  }

  return imports
}

/** `export const name: Type = …` declarations: name → collapsed type text. */
function exportedConstTypes(source) {
  const types = new Map()
  const pattern = /export\s+const\s+(\w+)\s*:\s*([^=]+?)\s*=/g

  for (const match of stripComments(source).matchAll(pattern)) {
    types.set(match[1], collapse(match[2]))
  }

  return types
}

/**
 * The initializer of `export const name … = …`: up to the next top-level
 * export, so a file holding two slots (admin-handover) is read per slot.
 */
function exportedConstInitializer(source, name) {
  const code = stripComments(source)
  const match = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=`).exec(code)

  assert.ok(match, `export const ${name} not found`)

  const rest = code.slice(match.index + match[0].length)
  const next = rest.search(/\nexport\s/)

  return next === -1 ? rest : rest.slice(0, next)
}

/** `export const NAME = Object.freeze({ key: value, … })`: key → literal. */
function frozenRecord(source, constName) {
  const match = new RegExp(
    `export const ${constName} = Object\\.freeze\\(\\{([^}]*)\\}`,
  ).exec(source)

  assert.ok(match, `${constName} not found`)
  return Object.fromEntries(
    [...match[1].matchAll(/(\w+)\s*:\s*(\d+|'\w+')/g)].map((entry) => [
      entry[1],
      entry[2].startsWith("'") ? entry[2].slice(1, -1) : Number(entry[2]),
    ]),
  )
}

function arrayLiteralNames(source, constName) {
  const match = new RegExp(
    `export const ${constName}\\b[^=]*=\\s*\\[([^\\]]*)\\]`,
  ).exec(stripComments(source))

  assert.ok(match, `array literal ${constName} not found`)
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

test('every stage view id has exactly one slot, read from its own file', () => {
  const source = stripComments(read(STAGE_VIEWS))
  const ids = /export const stageViewIds = \[([^\]]*)\] as const/
    .exec(source)[1]
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/g, ''))
    .filter((part) => part !== '')
  const slotsBody = /const stageViewSlots\b[^=]*=\s*\{([^}]*)\}/.exec(source)[1]
  const slots = Object.fromEntries(
    [...slotsBody.matchAll(/(\w+)\s*:\s*(\w+)/g)].map((match) => [match[1], match[2]]),
  )
  const imports = namedImports(STAGE_VIEWS)

  assert.deepEqual(ids, Object.keys(STAGE_VIEW_SLOTS))
  assert.deepEqual(
    slots,
    Object.fromEntries(
      Object.entries(STAGE_VIEW_SLOTS).map(([viewId, [, name]]) => [viewId, name]),
    ),
  )

  for (const [file, name] of Object.values(STAGE_VIEW_SLOTS)) {
    assert.equal(imports.get(name), file, `${name} must come from ${file}`)
    assert.equal(
      exportedConstTypes(read(file)).get(name),
      'StageViewEntry | null',
      `${file} must export ${name}: StageViewEntry | null`,
    )
  }
})

test('booking sections carry the fixed UX-05 order of their position', () => {
  const source = stripComments(read(SECTIONS))
  const imports = namedImports(SECTIONS)

  assert.deepEqual(frozenRecord(source, 'ADMIN_SECTION_ORDER'), ADMIN_SECTION_ORDER)
  assert.deepEqual(
    arrayLiteralNames(source, 'adminBookingSections'),
    ADMIN_SECTION_SLOTS.map(([, name]) => name),
  )

  for (const [file, name, position] of ADMIN_SECTION_SLOTS) {
    const slotSource = read(file)
    const declaredOrders = [
      ...exportedConstInitializer(slotSource, name).matchAll(/\border\s*:\s*([^,}\s]+)/g),
    ]

    assert.equal(imports.get(name), file, `${name} must come from ${file}`)
    assert.equal(
      exportedConstTypes(slotSource).get(name),
      `AdminBookingSection<'${position}'> | null`,
      `${file} must export ${name}: AdminBookingSection<'${position}'> | null`,
    )

    for (const match of declaredOrders) {
      assert.equal(match[1], String(ADMIN_SECTION_ORDER[position]), `${file}: ${name} order`)
    }
  }
})

test('workspace tabs carry the fixed UX-05 order and group of their position', () => {
  const source = stripComments(read(SECTIONS))
  const imports = namedImports(SECTIONS)

  assert.deepEqual(frozenRecord(source, 'ADMIN_TAB_ORDER'), ADMIN_TAB_ORDER)
  assert.deepEqual(frozenRecord(source, 'ADMIN_TAB_GROUP'), ADMIN_TAB_GROUP)
  assert.deepEqual(
    Object.keys(ADMIN_TAB_ORDER).filter((position) => ADMIN_TAB_GROUP[position] === 'primary'),
    ['queue', 'calendar'],
    'only «اليوم» and «التقويم» are primary, and they come first',
  )
  assert.deepEqual(
    Object.values(ADMIN_TAB_ORDER),
    [...new Set(Object.values(ADMIN_TAB_ORDER))].sort((first, second) => first - second),
    'tab orders are unique and ascending',
  )
  assert.deepEqual(
    arrayLiteralNames(source, 'adminWorkspaceTabs'),
    ADMIN_TAB_SLOTS.map(([, name]) => name),
  )
  // The descriptor types a slot's order and group as its position's
  // literals, so a filled slot cannot pick its own number.
  assert.match(collapse(source), /readonly group: \(typeof ADMIN_TAB_GROUP\)\[Position\]/)
  assert.match(collapse(source), /readonly order: \(typeof ADMIN_TAB_ORDER\)\[Position\]/)

  for (const [file, name, position] of ADMIN_TAB_SLOTS) {
    const slotSource = read(file)
    const initializer = exportedConstInitializer(slotSource, name)
    const declaredOrders = [...initializer.matchAll(/\border\s*:\s*([^,}\s]+)/g)]
    const declaredGroups = [...initializer.matchAll(/\bgroup\s*:\s*([^,}\s]+)/g)]

    assert.equal(imports.get(name), file, `${name} must come from ${file}`)
    assert.equal(
      exportedConstTypes(slotSource).get(name),
      `AdminWorkspaceTab<'${position}'> | null`,
      `${file} must export ${name}: AdminWorkspaceTab<'${position}'> | null`,
    )

    for (const match of declaredOrders) {
      assert.equal(match[1], String(ADMIN_TAB_ORDER[position]), `${file}: ${name} order`)
    }

    for (const match of declaredGroups) {
      assert.equal(match[1], `'${ADMIN_TAB_GROUP[position]}'`, `${file}: ${name} group`)
    }
  }
})

test('registered admin ids are unique kebab-case and never a built-in tab', () => {
  const ids = []

  for (const [file] of [...ADMIN_SECTION_SLOTS, ...ADMIN_TAB_SLOTS]) {
    for (const match of stripComments(read(file)).matchAll(/\bid\s*:\s*'([^']*)'/g)) {
      ids.push(match[1])
    }
  }

  for (const id of ids) {
    assert.match(id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `id '${id}'`)
    assert.ok(!BUILT_IN_ADMIN_TABS.includes(id), `id '${id}' is a built-in tab`)
  }

  assert.equal(new Set(ids).size, ids.length, 'registered ids must be unique')
})

// ---------------------------------------------------------------------------
// Lazy components only; slot hygiene (SB-12)
// ---------------------------------------------------------------------------

test('the registries never statically reach a component or a stylesheet', () => {
  for (const registry of [STAGE_VIEWS, SECTIONS]) {
    const { files, packages } = staticImportClosure(registry)

    for (const file of files) {
      assert.ok(
        file.endsWith('.ts'),
        `${registry} loads ${file} eagerly; import components lazily (createRetryableLazy) and styles from the component`,
      )
    }

    for (const name of packages) {
      assert.equal(name, 'react', `${registry} loads the package '${name}' eagerly`)
    }
  }
})

test('slot files load components only through createRetryableLazy, from their own folder', () => {
  for (const file of SLOT_FILES) {
    const code = stripComments(read(file))
    const dynamicImports = [...code.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)]

    for (const specifier of runtimeImportSpecifiers(code)) {
      assert.ok(
        specifier.startsWith('.'),
        `${file}: static import of the package '${specifier}'; a descriptor needs none`,
      )
      assert.ok(
        !['../journey/stage-views', '../admin-portal/sections'].includes(specifier),
        `${file}: import the registry with \`import type\` only (it imports this slot)`,
      )
      assert.ok(
        resolveRelative(file, specifier).endsWith('.ts'),
        `${file}: static import '${specifier}' is a component or a stylesheet`,
      )
    }

    for (const match of dynamicImports) {
      assert.match(match[1], /^'\.\/[\w-]+'$/, `${file}: dynamic import ${match[1]}`)
    }

    if (dynamicImports.length > 0) {
      assert.match(code, /createRetryableLazy\(/, `${file}: wrap import() in createRetryableLazy`)
      assert.doesNotMatch(code, /\blazy\s*\(/, `${file}: use createRetryableLazy, not React.lazy`)
    }
  }
})

test('slot files carry no inline styles, storage, links or HTML sinks', () => {
  const forbidden = [
    /\bstyle\b/,
    /CSSProperties/,
    /dangerouslySetInnerHTML|innerHTML|outerHTML/,
    /localStorage|sessionStorage|indexedDB|document\.cookie/,
    /wa\.me|https?:|mailto:|tel:/,
    /\beval\s*\(|new Function/,
  ]

  for (const file of SLOT_FILES) {
    const code = stripComments(read(file))

    for (const pattern of forbidden) {
      assert.doesNotMatch(code, pattern, `${file}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Panel stylesheets
// ---------------------------------------------------------------------------

/** Leaf rules of a stylesheet: { selector, context, declarations: [[prop, value]] }. */
function parseCss(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const stack = []
  let buffer = ''

  const pushDeclaration = () => {
    const text = buffer.trim()
    buffer = ''

    if (text === '' || stack.length === 0) {
      return
    }

    const colon = text.indexOf(':')
    assert.ok(colon > 0, `malformed declaration '${text}'`)
    stack.at(-1).declarations.push([
      text.slice(0, colon).trim(),
      collapse(text.slice(colon + 1)),
    ])
  }

  for (const character of source) {
    if (character === '{') {
      stack.push({ selector: collapse(buffer), declarations: [] })
      buffer = ''
    } else if (character === ';') {
      pushDeclaration()
    } else if (character === '}') {
      pushDeclaration()
      const frame = stack.pop()

      if (!frame.selector.startsWith('@')) {
        rules.push({
          selector: frame.selector,
          context: stack.map((parent) => parent.selector).join(' '),
          declarations: frame.declarations,
        })
      }
    } else {
      buffer += character
    }
  }

  assert.equal(stack.length, 0, 'unbalanced braces')
  return rules
}

/**
 * The current token set: the first `:root` block of tokens.css. The later
 * `:root` block holds the legacy aliases, which are not for new code.
 */
function readTokens() {
  const css = read(TOKENS_CSS).replace(/\/\*[\s\S]*?\*\//g, '')
  const block = /:root\s*\{([^{}]*)\}/.exec(css)

  assert.ok(block, `${TOKENS_CSS}: no :root block`)

  const values = new Map(
    [...block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      collapse(match[2]),
    ]),
  )
  const names = new Set(values.keys())
  const hex = new Map(
    [...values]
      .filter(([name, value]) => name.startsWith('--color-') && /^#[0-9a-fA-F]{6}$/.test(value))
      .map(([name, value]) => [name, value]),
  )

  for (const token of ['--color-accent', '--color-accent-deep', '--color-accent-soft', '--control-height', '--space-2xs']) {
    assert.ok(names.has(token), `${TOKENS_CSS}: ${token} not read`)
  }

  return { names, hex, values }
}

/** A token's length in CSS px (rem at the browser default of 16px). */
function tokenPx(values, name) {
  const match = /^(\d*\.?\d+)(rem|px)$/.exec(values.get(name) ?? '')

  assert.ok(match, `${TOKENS_CSS}: ${name} is not a rem or px length`)
  return Number(match[1]) * (match[2] === 'rem' ? 16 : 1)
}

/** Splits `text` at `separator` where it is outside parentheses. */
function splitTopLevel(text, separator) {
  const parts = []
  let depth = 0
  let current = ''

  for (const character of text) {
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
    }

    if (character === separator && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }

  parts.push(current.trim())
  return parts.filter((part) => part !== '')
}

/**
 * The CSS px of a length written the way these stylesheets write one: px, a
 * token, `token * n`, a calc() sum, max(), or the bottom safe area (given as
 * `safeArea`). Anything else fails, so a new form is never silently zero.
 */
function lengthPx(expression, values, safeArea) {
  const text = expression.trim()
  const call = /^(calc|max)\((.*)\)$/.exec(text)

  if (call !== null) {
    const parts = splitTopLevel(call[2], call[1] === 'calc' ? '+' : ',').map((part) =>
      lengthPx(part, values, safeArea),
    )

    return call[1] === 'calc' ? parts.reduce((sum, part) => sum + part, 0) : Math.max(...parts)
  }

  const scaled = /^(.+?)\s*\*\s*(\d+)$/.exec(text)

  if (scaled !== null) {
    return lengthPx(scaled[1], values, safeArea) * Number(scaled[2])
  }

  if (text === 'env(safe-area-inset-bottom)') {
    return safeArea
  }

  const token = singleVar(text)

  if (token !== null) {
    return tokenPx(values, token)
  }

  const px = /^(\d*\.?\d+)px$/.exec(text)

  assert.ok(px, `cannot evaluate the length '${text}'`)
  return Number(px[1])
}

function relativeLuminance(hex) {
  const [red, green, blue] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  )

  return (lighter + 0.05) / (darker + 0.05)
}

/** `pinnedBars`: the bars each sheet pins to the bottom of the viewport. */
const STYLESHEETS = [
  {
    file: STAGE_PANELS_CSS,
    block: 'stage-panel',
    accentText: '--stage-panel-accent-text',
    pinnedBars: ['.stage-panel__bar'],
  },
  {
    file: ADMIN_PANELS_CSS,
    block: 'admin-feature',
    accentText: '--admin-feature-accent-text',
    pinnedBars: [],
  },
]

/** Bottom safe areas to size a pinned bar at: none, and a phone's home indicator. */
const SAFE_AREAS_PX = [0, 34]

const ACCENT_TOKENS = ['--color-accent', '--color-accent-deep', '--color-accent-soft']

/** UX-12: the accent shade allowed on each background token. */
const ACCENT_FOR_BACKGROUND = {
  '--color-paper': ['--color-accent', '--color-accent-deep'],
  '--color-surface': ['--color-accent', '--color-accent-deep'],
  '--color-paper-sunk': ['--color-accent-deep'],
  '--color-hairline': ['--color-accent-deep'],
  '--color-success-tint': ['--color-accent-deep'],
  '--color-warning-tint': ['--color-accent-deep'],
  '--color-danger-tint': ['--color-accent-deep'],
  '--color-info-tint': ['--color-accent-deep'],
  '--color-ink': ['--color-accent-soft'],
}

const COLOUR_PROPERTY =
  /^(color|background(-color)?|border(-(block|inline))?(-(start|end))?(-color)?|outline(-color)?|accent-color|text-decoration(-color)?|box-shadow|fill|stroke|caret-color)$/

const GAP_TOKENS = /^var\(--space-(2xs|xs|sm|md|lg|xl|2xl|3xl|4xl)\)$/

const CONTROL_SIZE = /^var\(--control-height(-lg)?\)$/

function singleVar(value) {
  const match = /^var\((--[\w-]+)\)$/.exec(value)
  return match === null ? null : match[1]
}

for (const { file, block, accentText, pinnedBars } of STYLESHEETS) {
  test(`${file}: every rule stays inside .${block}`, () => {
    for (const rule of parseCss(read(file))) {
      for (const selector of rule.selector.split(',').map((part) => part.trim())) {
        assert.match(
          selector,
          new RegExp(`^\\.${block}(?![\\w-])|^\\.${block}__`),
          `selector '${selector}' can reach outside a registered panel`,
        )
      }
    }
  })

  test(`${file}: existing tokens only, no colour literals`, () => {
    const { names } = readTokens()
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')

    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'hex colour')
    assert.doesNotMatch(css, /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/, 'colour function')

    for (const rule of parseCss(read(file))) {
      for (const [property, value] of rule.declarations) {
        for (const match of value.matchAll(/var\((--[\w-]+)/g)) {
          assert.ok(
            names.has(match[1]) || match[1] === accentText,
            `${rule.selector}: unknown custom property ${match[1]}`,
          )
        }

        if (property.startsWith('--')) {
          // Only the block's own accent-text property, and the focus ring
          // where it must switch colour on ink; no other token is redefined.
          assert.ok(
            property === accentText || property === '--focus-ring-color',
            `${rule.selector}: sets ${property}; only ${accentText} and --focus-ring-color may be set`,
          )
          assert.ok(
            names.has(singleVar(value) ?? ''),
            `${rule.selector}: ${property} must alias one existing token`,
          )
        }

        if (COLOUR_PROPERTY.test(property)) {
          const rest = value
            .replace(/var\(--[\w-]+\)/g, ' ')
            .replace(/-?\d*\.?\d+(px|rem|em|%)?/g, ' ')
            .split(/\s+/)
            .filter((word) => word !== '')

          for (const word of rest) {
            assert.ok(
              ['solid', 'dashed', 'dotted', 'none', 'transparent', 'inherit', 'currentColor', 'underline'].includes(word),
              `${rule.selector}: '${property}: ${value}' is not a token`,
            )
          }
        }
      }
    }
  })

  test(`${file}: accent text sits only on the backgrounds UX-12 allows`, () => {
    const { hex } = readTokens()

    for (const rule of parseCss(read(file))) {
      const declarations = new Map(rule.declarations)
      const background = singleVar(
        declarations.get('background') ?? declarations.get('background-color') ?? '',
      )
      const accent = declarations.has(accentText) ? singleVar(declarations.get(accentText)) : null

      for (const property of ['color', 'text-decoration-color']) {
        const value = declarations.get(property) ?? ''

        for (const token of ACCENT_TOKENS) {
          assert.ok(
            !value.includes(`var(${token})`),
            `${rule.selector}: set accent text through ${accentText}, not ${token}`,
          )
        }
      }

      if (declarations.has(accentText)) {
        assert.ok(ACCENT_TOKENS.includes(accent), `${rule.selector}: ${accentText} must be an accent token`)
      }

      for (const [property, value] of rule.declarations) {
        if (value.includes('var(--color-accent-soft)')) {
          assert.equal(
            background,
            '--color-ink',
            `${rule.selector}: ${property} uses accent-soft without an ink background`,
          )
        }
      }

      if (background !== null && background.startsWith('--color-')) {
        const allowed = ACCENT_FOR_BACKGROUND[background]

        assert.ok(allowed, `${rule.selector}: background ${background} has no UX-12 accent rule`)
        assert.ok(
          allowed.includes(accent),
          `${rule.selector}: on ${background} set ${accentText} to ${allowed.join(' or ')}`,
        )
        assert.ok(
          contrastRatio(hex.get(accent), hex.get(background)) >= 4.5,
          `${rule.selector}: ${accent} on ${background} is below 4.5:1`,
        )
      }
    }
  })

  test(`${file}: text set on its own background reaches 4.5:1; state rules repaint theirs`, () => {
    const { hex } = readTokens()

    for (const rule of parseCss(read(file))) {
      const declarations = new Map(rule.declarations)
      const colour = singleVar(declarations.get('color') ?? '')
      const background = singleVar(
        declarations.get('background') ?? declarations.get('background-color') ?? '',
      )

      if (colour !== null && background !== null) {
        assert.ok(hex.has(colour) && hex.has(background), `${rule.selector}: colour pair is not two colour tokens`)
        assert.ok(
          contrastRatio(hex.get(colour), hex.get(background)) >= 4.5,
          `${rule.selector}: ${colour} on ${background} is below 4.5:1`,
        )
      }

      // A state that recolours text (checked, pressed, unavailable) paints its
      // own background too, so two states that meet (e.g. pressed and
      // unavailable) never leave muted text on the other state's ink fill.
      if (
        /:checked|:disabled|\[aria-(pressed|disabled)="true"\]/.test(rule.selector) &&
        declarations.has('color')
      ) {
        assert.ok(background !== null, `${rule.selector}: a state rule that sets color must set its background`)
      }
    }
  })

  test(`${file}: hover is never keyed to a body its invisible input covers`, () => {
    // Here `+` and `~` only ever follow a visually hidden input laid over its
    // sibling; the input takes every pointer hit, so `input + body:hover`
    // never matches. Hover goes on the label (`label:hover > input + body`).
    for (const rule of parseCss(read(file))) {
      for (const selector of rule.selector.split(',').map((part) => part.trim())) {
        assert.doesNotMatch(
          selector,
          /[+~]\s*[^\s>+~]*:hover/,
          `${selector}: hover the element under the pointer, not the covered sibling`,
        )
      }
    }
  })

  test(`${file}: controls are at least 44 x 44 CSS px with 8 px gaps (UX-13)`, () => {
    const { values } = readTokens()

    for (const token of ['--control-height', '--control-height-lg']) {
      assert.ok(tokenPx(values, token) >= 44, `${token} is below 44px`)
    }

    for (const rule of parseCss(read(file))) {
      const declarations = new Map(rule.declarations)
      const cursor = declarations.get('cursor')

      if (cursor === 'pointer' || cursor === 'zoom-in') {
        assert.match(declarations.get('min-block-size') ?? '', CONTROL_SIZE, `${rule.selector}: min-block-size`)
        assert.match(declarations.get('min-inline-size') ?? '', CONTROL_SIZE, `${rule.selector}: min-inline-size`)
      }

      for (const property of ['gap', 'row-gap', 'column-gap']) {
        if (declarations.has(property)) {
          for (const part of declarations.get(property).split(' ')) {
            const token = singleVar(part)

            assert.match(part, GAP_TOKENS, `${rule.selector}: ${property} is not a spacing token`)
            assert.ok(tokenPx(values, token) >= 8, `${rule.selector}: ${property} ${token} is below 8px`)
          }
        }
      }
    }
  })

  test(`${file}: focus never lands under a bar pinned to the bottom (WCAG 2.4.11)`, () => {
    // Focus scrolls a control into view only when it is not already fully
    // inside the viewport, so one inside a pinned bar's band would stay under
    // it. Each such bar needs a rule, wherever the bar is pinned, that gives
    // every focused control of its panel (not the bar's own) a bottom scroll
    // margin taller than the bar wrapped to two rows of its tallest controls
    // (.btn--lg, --control-height-lg) plus the focus ring.
    const { values } = readTokens()
    const rules = parseCss(read(file))
    const focusRing = tokenPx(values, '--focus-ring-width') + tokenPx(values, '--focus-ring-offset')
    const tallestRow = tokenPx(values, '--control-height-lg')
    const found = []

    for (const bar of rules) {
      const declarations = new Map(bar.declarations)
      const pinned =
        ['sticky', 'fixed'].includes(declarations.get('position') ?? '') &&
        ['inset-block-end', 'inset-block', 'inset', 'bottom'].some((property) => declarations.has(property))

      if (!pinned) {
        continue
      }

      found.push(bar.selector)
      assert.match(bar.selector, new RegExp(`^\\.${block}__[\\w-]+$`), `${bar.selector}: a pinned bar is one class`)

      const prefix = `.${block}:has(${bar.selector}) `
      const guard = rules.find(
        (rule) =>
          rule.context === bar.context &&
          rule.selector.startsWith(prefix) &&
          /:focus(-visible)?(?![\w-])/.test(rule.selector.slice(prefix.length)) &&
          rule.selector.endsWith(`:not(${bar.selector} *)`) &&
          rule.declarations.some(([property]) => property === 'scroll-margin-block-end'),
      )

      assert.ok(guard, `${bar.selector}: no scroll-margin-block-end rule keeps a focused control clear of it`)

      const margin = new Map(guard.declarations).get('scroll-margin-block-end')
      const [paddingStart, paddingEnd = paddingStart] = splitTopLevel(declarations.get('padding-block') ?? '0px', ' ')
      const [rowGap] = splitTopLevel(declarations.get('row-gap') ?? declarations.get('gap') ?? '0px', ' ')
      const [border] = splitTopLevel(declarations.get('border-block-start') ?? '0px', ' ')

      for (const safeArea of SAFE_AREAS_PX) {
        const px = (expression) => lengthPx(expression, values, safeArea)
        const twoRowBar = px(border) + px(paddingStart) + 2 * tallestRow + px(rowGap) + px(paddingEnd)

        assert.ok(
          px(margin) >= twoRowBar + focusRing,
          `${guard.selector}: scroll margin ${px(margin)}px is less than a two-row bar (${twoRowBar}px) ` +
            `plus the focus ring (${focusRing}px) at a ${safeArea}px safe area`,
        )
      }
    }

    assert.deepEqual(found, pinnedBars, `${file}: the bars pinned to the bottom`)
  })
}
