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
