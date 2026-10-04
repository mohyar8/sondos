# Styles — the design system in `src/styles/`

Plain CSS on one token set (decision D1: no Tailwind, no animation library).
`src/index.css` is the only entry point; it imports the layers in this order:

| File | What it holds |
|---|---|
| `fonts.css` | El Messiri 600 + Cairo 400/700 (`@fontsource`, D9) and the metric-matched `Cairo Fallback` / `El Messiri Fallback` faces |
| `tokens.css` | every custom property (`:root`), the `.on-dark` context, and the legacy aliases |
| `base.css` | reset, RTL document defaults, typography, focus ring, skip link, the reduced-motion safety net |
| `components.css` | the shared component classes below — one implementation each |
| `motion.css` | the `.reveal` contract and the `hero-zoom` keyframes |

Page and layout stylesheets (`src/pages/**`, `src/layout/**`) and component
stylesheets (`src/components/*.css`) sit on top and read the same tokens.

## Token groups (`tokens.css`)

| Group | Names | Notes |
|---|---|---|
| Colour, core | `--color-paper`, `--color-surface`, `--color-ink`, `--color-accent`, `--color-line` | the 60/30/10 palette |
| Colour, derived | `--color-ink-muted`, `--color-ink-on-dark-muted`, `--color-accent-deep`, `--color-accent-soft`, `--color-paper-sunk`, `--color-hairline` | tints/shades of the core five |
| Colour, semantic | `--color-success` / `--color-warning` / `--color-danger` / `--color-info`, each with a `-tint` | badges, notices, field errors |
| Shadow | `--shadow-ink` (an RGB triplet), `--shadow-sm/md/lg` | use as `rgb(var(--shadow-ink) / 0.6)` |
| Typography | `--font-display`, `--font-text`, `--text-*` sizes, `--leading-*` | sizes are `clamp()` ramps |
| Spacing | `--space-3xs` … `--space-4xl` (4px base), `--page-gutter`, `--section-space` | |
| Shape | `--radius-sm/md/lg` (information), `--radius-full` (interactive pills) | never mix the two meanings |
| Layering | `--z-header` … `--z-toast` | |
| Layout | `--container-narrow`, `--container`, `--container-wide` | breakpoints are the literal 36/48/64/80rem values (see the comment in `tokens.css`) |
| Motion | `--duration-*`, `--ease-*` | |
| Controls | `--control-height` (44px touch target), `--control-height-lg`, `--focus-ring-*` | |

`.on-dark` re-points the text, link and focus tokens for ink backgrounds
(footer, contact band, lightbox). The **legacy aliases** block at the end of
`tokens.css` keeps old names used by the component stylesheets in
`src/components/` working; do not add new uses of them.

## Rules

- **No hex outside `tokens.css`.** Every colour is a `var(--color-…)` or
  `rgb(var(--shadow-ink) / α)`. A new colour starts as a token.
- **Logical properties** (`inline-size`, `margin-inline-start`, `inset-block`…)
  so the layout is right in RTL without overrides.
- **Never colour alone** for state: pair colour with text, an icon or a shape
  (badges, the current-page underline).
- Hover effects live inside `@media (hover: hover)`.
- Motion must degrade to static under `prefers-reduced-motion` (`base.css`
  enforces this globally).

## Component classes (`components.css`)

| Class | Variants / parts |
|---|---|
| `.container`, `.container--wide`, `.section`, `.section-heading` | layout primitives |
| `.eyebrow` | small label above a heading |
| `.btn` | `--primary`, `--secondary`, `--ghost`, `--whatsapp`; size `--lg` |
| `.text-link` | prominent text call to action |
| `.card` | `--interactive` |
| `.badge` | `--success`, `--warning`, `--danger`, `--info`, `--neutral`; `__icon` |
| `.field` | `__label`, `__required`, `__hint`, `__error`, `--error`; with `.input`, `.select`, `.textarea` |
| `.notice` | `--success`, `--warning`, `--danger`, `--info`; `__icon` |
| `.dialog`, `.dialog__backdrop` | positioning only; the owning component adds open/close behaviour |

Example (Arabic copy, feminine singular):

```tsx
<section className="section" aria-labelledby="offer-title">
  <div className="container">
    <header className="section-heading reveal">
      <p className="eyebrow">التغطية</p>
      <h2 id="offer-title">اختاري التغطية المناسبة ليومكِ</h2>
    </header>
    <span className="badge badge--info">بانتظار المراجعة</span>
    <a className="btn btn--primary btn--lg" href="/packages#packages">
      ابدئي طلب الحجز
    </a>
  </div>
</section>
```

## The reveal contract (`motion.css` + `src/layout/useReveal.ts`)

| Classes | Meaning | Who sets it |
|---|---|---|
| `.reveal` | the final, fully visible state | you, in the markup |
| `.reveal.reveal--armed` | the "from" state (faded, 12px lower) | `useReveal`, only when motion is allowed and the element starts below the fold |
| `.reveal--armed.is-revealed` | the "to" state | `useReveal`, once, when the element scrolls into view |

Siblings revealed together get `--reveal-index` (0–4) for a 70ms stagger.
Without JavaScript, or under reduced motion, a `.reveal` element is simply
visible: never write CSS that hides `.reveal` on its own. Call
`useReveal(rootRef)` once per page root; it cleans up its observer, listener
and classes on unmount.

## The design switch (`src/design/`)

Two designs share the code base (`runs/redo-v2/12-motion-spec.md` §7):
**classic** (today's look, everything above) and **cinematic** (classic plus
the motion layer). The choice is made **at build time**, never at runtime:

- `VITE_SITE_DESIGN=classic|cinematic` is read only in `vite.config.ts`
  (through `loadEnv`, so `.env*` files and the process environment both
  work, the process environment winning). **Unset or empty means classic**;
  any other value fails the build with a message. Application code never
  reads `import.meta.env.VITE_SITE_DESIGN`, so the value is not even in the
  bundle.
- Every `@site-design/<Name>` import resolves to
  `src/design/<design>/<Name>`; TypeScript checks consumers against the
  cinematic twin (`tsconfig.app.json` `paths`), and each classic twin types
  its exports against the cinematic one. Classic twins import no CSS and
  render no DOM of their own, so the classic bundle contains no cinematic
  code at all. `boot` is imported by `src/main.tsx` right after `./index.css`:
  cinematic `boot.ts` sets `data-design="cinematic"` on `<html>` and imports
  the cinematic stylesheets; classic `boot.ts` is `export {}`.
- Which design a page runs: `document.documentElement.dataset.design` is
  `"cinematic"` or `undefined`.

### Build and dev commands

| Command | Design | Notes |
|---|---|---|
| `npm run dev`, `npm run build` | classic (the unset default) | unchanged |
| `npm run dev:classic`, `npm run dev:cinematic` | as named | `vite` with the flag set |
| `npm run build:classic`, `npm run build:cinematic` | as named | `tsc -b`, `vite build`, then the checks below |

All four call `scripts/build-design.mjs`, which only builds and serves (there
is no `--deploy` and no `--allow-dirty`; deploys go through the release script
of wave 3, `scripts/release.mjs`):

```
node scripts/build-design.mjs <classic|cinematic> [--env=production|preview]
node scripts/build-design.mjs <classic|cinematic> --dev [--env=production|preview] [--port=<1024-65535>]
```

- The arguments are a strict allowlist: one design, each option at most once,
  exact spellings. Anything else (a typo such as `clasic`, an unknown flag,
  `--deploy`) prints the usage and exits 2 before anything runs.
- `tsc` and `vite` run as `node node_modules/<package>/<bin>` through
  `spawnSync` with argument arrays and `shell: false`. The child environment
  is the inherited one with `VITE_SITE_DESIGN` set to the design;
  `--env=preview` sets `CLOUDFLARE_ENV=preview` (and the Vite mode `preview`),
  `--env=production` (the default) removes an inherited `CLOUDFLARE_ENV`.
- After a build the script reads `dist/client` and refuses (exit 1) a classic
  build that contains `cine-`, `data-design`, `startViewTransition` or
  `view-transition`, or a cinematic build without `data-design`. It then
  checks that the generated deploy config targets the Worker `wrangler.jsonc`
  declares for `--env` and prints the design and the Worker name
  (`sundus-yar-website`, or `sundus-yar-preview` with `--env=preview`), never
  an environment value.
- `--dev` serves on localhost; `--port` pins the port with `--strictPort`.

A consequence for stylesheets: the four marker strings above may appear only
in `src/design/cinematic/` (and in comments, which the minifier drops). A
stylesheet, class name or attribute of the classic layer must never use the
`cine-` prefix or `data-design`.

### Cinematic stylesheets and the `--cine-*` tokens

The cinematic layer lives in `src/design/cinematic/` (`tokens.css`,
`hero.css`, `scroll.css`, later more), each imported by a cinematic module so
it is emitted only in cinematic builds. Every cinematic selector is prefixed
`:root[data-design="cinematic"]`; the files contain no hex (colours alias the
`--color-*` tokens above) and no `url()`. The classic `--duration-*` /
`--ease-*` tokens stay untouched for component micro-interactions.

`tokens.css` is the only place cinematic timing lives. The table below is the
contract of `12-motion-spec.md` §2; `tokens.css` is authoritative for the
values.

| Group | Token | Value | Used for |
|---|---|---|---|
| Duration | `--cine-dur-tick` | 180ms | header-logo hand-off, small state flips |
| | `--cine-dur-exit` | 300ms | things leaving (intro decorations) |
| | `--cine-dur-vt-out` | 250ms | outgoing page dims under the incoming one |
| | `--cine-dur-fade` | 400ms | intro veil dissolve; the single hero fade after an intro |
| | `--cine-dur-glide` | 500ms | logo FLIP to the header, viewfinder lock |
| | `--cine-dur-vt-in` | 450ms | incoming page veil |
| | `--cine-dur-word` | 800ms | one word of a display heading |
| | `--cine-dur-rise` | 900ms | copy blocks, section reveals |
| | `--cine-dur-wipe` | 1100ms | photo veils |
| | `--cine-dur-settle-tile` | 1400ms | portfolio tile settle |
| | `--cine-dur-draw` | 1600ms | khatam stroke draw, whole figure |
| | `--cine-dur-settle` | 2400ms | hero and packages-banner photo settle |
| | `--cine-dur-ticker` | 60s | one full ticker cycle |
| Easing | `--cine-ease-settle` | `cubic-bezier(0.16, 1, 0.3, 1)` | fast start, long landing (= `--ease-premium`) |
| | `--cine-ease-rise` | `cubic-bezier(0.22, 1, 0.36, 1)` | quint-out, text |
| | `--cine-ease-glide` | `cubic-bezier(0.65, 0, 0.25, 1)` | in-out: wipes, FLIP, page veil |
| | `--cine-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | accelerate away (= `--ease-accelerate`) |
| | `--cine-ease-ink` | `linear` | constant brush speed inside one stroke |
| Stagger | `--cine-stagger-word` | 70ms | per word (JS caps the index at 12) |
| | `--cine-stagger-item` | 90ms | per sibling block (`--reveal-index` is capped at 4) |
| | `--cine-stagger-tile` | 120ms | per photo tile |
| Distance / scale | `--cine-rise` | 22px | reveal rise |
| | `--cine-word-rise` | 0.4em | word rise, scales with the heading |
| | `--cine-settle-from` | 1.08 | hero photo settle start |
| | `--cine-tile-settle-from` | 1.05 | portfolio tile settle start |
| | `--cine-banner-settle-from` | 1.06 | packages banner settle start |
| | `--cine-parallax-shift` | 4% | ± within the overscan |
| | `--cine-parallax-overscan` | 1.1 | 5% per side |
| | `--cine-exit-shift` | 6% | hero/banner drift while leaving the viewport |
| | `--cine-exit-overscan` | 1.12 | grows with the drift so no edge ever shows |
| | `--cine-lock-from` | 1.06 | viewfinder corners converge from here |
| | `--cine-vt-slant` | 8% | page-veil edge slant |
| Hero choreography | `--cine-hero-eyebrow-delay` | 100ms | relative to release |
| | `--cine-hero-words-delay` | 200ms | |
| | `--cine-hero-lead-delay` | 650ms | |
| | `--cine-hero-actions-delay` | 800ms | |
| | `--cine-hero-corners-delay` | 900ms | |
| Banner choreography | `--cine-banner-lead-delay` | 500ms | packages banner copy, relative to the banner reveal |
| Colour roles (aliases only) | `--cine-gold` | `var(--color-accent)` | lines on paper/surface |
| | `--cine-gold-on-dark` | `var(--color-accent-soft)` | lines on ink or on dark photos |
| | `--cine-intro-bg` | `var(--color-paper)` | |
| Layer | `--z-intro` | 990 | above header/overlay/dialog, below the skip link (1000) |

Token rules (§2): only compositor properties are animated in page content
(`opacity`, `transform`, `translate`, `scale`; bounded exceptions for
`stroke-dashoffset`, the intro's SVG mask and `clip-path` on
`::view-transition-new(root)`); settle and parallax sit on different elements;
numbers reach CSS (`--wi`) only through React's `style` prop, never
`setAttribute('style', …)`; `will-change` only while an animation runs.
Everything degrades to static under `prefers-reduced-motion`, as for classic.

### Class and attribute contract

Set by the cinematic modules (owned by their units; documented here so no
other stylesheet or component reuses the names):

| Name | Set by | Meaning |
|---|---|---|
| `html[data-design="cinematic"]` | cinematic `boot.ts` | the cinematic layer is present; every cinematic selector requires it |
| `html[data-cine-intro="playing\|leaving\|landing"]` | `LogoIntro` | hero hold (`playing`), header logo hidden (`playing`, `leaving`) |
| `html[data-cine-intro-reason]` | `LogoIntro` | diagnostic reason the intro was skipped or cut short |
| `html[data-cine-entry="intro\|vt"]` | `LogoIntro`, `page-transition` | how the current page was entered; suppresses the hero entrance, word reveal and photo wipes; kept until the next navigation |
| `html[data-cine-vt="forward\|back"]` | `page-transition` | a view transition is running |
| `html[data-cine-vt-pending]` | `page-transition` | a slow route chunk is loading (static hairline) |
| `document` event `cine:navigate` | `page-transition` | a navigation started; `LogoIntro` finishes at once |
| `.cine-words`, `.cine-w`, `--wi`, `[data-cine-trigger]` | `DisplayHeading` | word reveal |
| `.cine-khatam-frame`, `.cine-khatam--*`, `.cine-khatam__ring\|star\|square\|inner\|pupil` | `Khatam` | ornament |
| `.cine-ticker*`, `[data-paused]`, `[data-offscreen]` | `ServicesTicker` | ticker |
| `.cine-intro*`, `[data-phase="wait\|assemble\|leave"]` | `LogoIntro` | intro |
| `--z-intro` | `tokens.css` | 990 |
