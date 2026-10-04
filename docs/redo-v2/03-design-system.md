# Sundus Yar — Design System & Page Layouts (redo-v2)

«المصورة سندس يار» · bridal photographer, Madinah · role deliverable: **design system + page layouts** for run `redo-v2`.
This is design, not copy — Arabic strings in this document are short placeholders for the copywriter, always
feminine-singular address, never lorem ipsum, never invented business facts.

## 0. Scope, method, sources

Read in full before writing this: `runs/redo-v2/decisions.md`, `runs/redo-v2/00-inspection-report.md`. Read in the
code: `app/src/index.css`, `app/src/App.tsx`, `app/src/data/packages.ts`, `app/shared/admin.ts`,
`app/src/components/{MyBookings,AdminDashboard,BookingCalendar,PackageConfigurator}.tsx` (targeted sections),
`app/public/images/brand-logo.jpeg` (viewed directly), `app/public/icons.svg` + `favicon.svg` (confirmed dead
Vite-template leftovers — off-brand purple mark, unrelated bluesky/discord/github/x icons; replace, see §6.4),
the 32-file manifest at `assets-incoming/site-photos-7239/**` (all filenames read directly from disk) and one
photo opened directly (`4.5/IMG_2845 (1) copy.webp`).

**A methodology note that matters for the photo assignments in §5**: the 32 source photos are AVIF except one
WebP. My tooling can view WebP/JPEG but cannot render AVIF (it returns raw container bytes, not an image), so of
the 32 I could **visually verify only `IMG_2845 (1) copy.webp`** and the logo JPEG myself. For the other 31 I
relied on the filenames, folder (aspect ratio), and the descriptions already recorded in `decisions.md`, never
inventing content beyond what that file states. **Action item for whoever implements §5: before publishing any
crop, do one visual pass confirming no selected frame reveals the bride's identifiable face** — the brand value
is explicit («جميع الصور تُنشر بموافقة العروس», no identifiable bride faces) and I could not confirm this myself
for 31 of the 32 files.

**Correction to the inspection report's brand-evidence note**: having opened `brand-logo.jpeg` directly, the mark
dotting the س is not "a small flower" — it is a **camera-aperture/lens icon** (concentric partial-arc segments,
like a lens diaphragm). This is a nice, already-brand-owned graphic; §2.4 and §6.4 reuse it. The logo file itself
is a 5000×3245 JPEG on a **flat opaque white** square (confirmed by direct viewing) — on the ivory `--color-surface`
token below, a white JPEG square will show a faint seam. Flag for the build stage: re-export the mark as a
transparent-background SVG or alpha-matted PNG/WebP, sized ~112×112 px @2x for a 56 px display box (fixes
inspection defect: "Logo is a 5000×3245 JPEG shown at ~46 px").

**Binding constraints this document respects**: D1 (plain CSS, one token system, native motion, no Tailwind/animation
library, `prefers-reduced-motion` honoured — see §3); prices/API/auth untouched (§5.3, §5.7 flag the few places a
layout implies an *additive* API need, never a changed one); no invented testimonials/stats/addresses/bank
details (D7's testimonial card in §4.3 ships empty until the owner supplies quotes; D4's deposit amount is a
placeholder token, flagged in §9); feminine-singular Arabic throughout.

---

## Table of contents

1. Palette — 60/30/10, core + semantic, full contrast table
2. Typography — Arabic display + text face, scale, numerals policy
3. Tokens — `:root` block, motion spec
4. Component inventory — states
5. Page layouts — desktop/mobile/RTL, photo assignments
6. Header, footer, mobile menu
7. GCC market taste notes
8. Dark mode
9. Unresolved (owner decisions, with proposed defaults)

---

## 1. Palette

### 1.1 The 60/30/10 mapping

| Share | Role | Tokens |
|---|---|---|
| **60% — paper** | Page background, card surfaces, the field the photography sits on | `--color-paper`, `--color-surface` |
| **30% — ink** | Headings, body text, dark sections (footer, contact band), primary-button fill | `--color-ink` |
| **10% — accent** | Reserved for the few highest-value moments only (see rule below) | `--color-accent` |

**The accent-discipline rule** (this is the one decision that keeps "10%" honest instead of decorative): the
default button fill across the whole product — nav CTA, "التالي", "إرسال الطلب", package "اختيار" — is **ink**, not
gold. Gold (`--color-accent`) is reserved for: the WhatsApp CTA (true last-mile conversion moment, §4.1), prices
and the running total, the selected/active state (calendar day, chip, journey-stepper current step), focus rings,
and small emphasis marks (eyebrow labels, the logo's aperture glyph reused as a divider). If gold shows up on
every button the way a generic "primary color" would, it stops reading as valuable — that scarcity *is* the
10%.

### 1.2 Core colours (5, max)

| Token | Hex | Role |
|---|---|---|
| `--color-paper` | `#FAF6EF` | Page background (the "60%" base) |
| `--color-surface` | `#FFFCF7` | Cards, header, dialogs, elevated panels — a hair lighter than paper so surfaces lift without a hard edge |
| `--color-ink` | `#241E1A` | Primary text, headings, dark-section backgrounds (footer, contact band), default button fill |
| `--color-accent` | `#8A6A2E` | Antique brass/gold — sparing, see §1.1 rule |
| `--color-line` | `#8F8270` | Functional UI borders: inputs, buttons, calendar cells, table rules |

### 1.3 Derived tints (not new hues — each is a shade/tint of a core colour above; listed for implementation, not counted against the 5)

| Token | Hex | Derived from | Role |
|---|---|---|---|
| `--color-ink-muted` | `#5C5148` | ink | Secondary text on light backgrounds |
| `--color-ink-on-dark-muted` | `#C9BFB3` | ink (light counterpart) | Secondary text **on** ink-coloured backgrounds (footer address line, etc.) |
| `--color-accent-deep` | `#6E5322` | accent | Hover/pressed state of accent fills and links |
| `--color-accent-soft` | `#C7A75E` | accent | Text/icons **on** ink backgrounds (footer social icons); chip fill under ink text (price pill) — never as text on paper, see §1.4 |
| `--color-paper-sunk` | `#F1EAE0` | paper | Recessed fields: input backgrounds, disabled state |
| `--color-hairline` | `#EAE1D5` | line | **Decorative-only** divider (does not need 3:1 — see §1.4) |

### 1.4 Semantic colours (4)

Each ships as a deep colour (for text/icon) + a pale tint (for chip/badge backgrounds). Badges pair the tint with
**`--color-ink` text** (13–16:1, always safe) plus a semantic-coloured icon — the colour is reinforcement, never
the only signal (see §4.4).

| Token | Hex | Tint token | Tint hex | Role |
|---|---|---|---|---|
| `--color-success` | `#2F6D4F` | `--color-success-tint` | `#E4EFE7` | Confirmed, verified, completed |
| `--color-warning` | `#8A5A12` | `--color-warning-tint` | `#F6E9D2` | Action needed, time-sensitive, awaiting the bride |
| `--color-danger` | `#9C2F2A` | `--color-danger-tint` | `#F5E3DF` | Rejected, error, expired, destructive |
| `--color-info` | `#2D5F7A` | `--color-info-tint` | `#E1EBF0` | Neutral status, informational, in review |

### 1.5 Contrast table (WCAG 2.1, computed — relative-luminance formula, not eyeballed)

Every pair actually specified for text or a UI border/boundary in this document, with the exact ratio. ✅ = meets
the target on that row (≥4.5:1 body text / ≥3:1 large text (≥24px, or ≥19px bold) and UI borders).

| Foreground on background | Ratio | Use | Target | ✓ |
|---|---|---|---|---|
| ink `#241E1A` on paper `#FAF6EF` | **15.28:1** | Body text | 4.5:1 | ✅ |
| ink on surface `#FFFCF7` | **16.09:1** | Body text on cards | 4.5:1 | ✅ |
| ink on paper-sunk `#F1EAE0` | **13.79:1** | Text inside recessed fields | 4.5:1 | ✅ |
| ink-muted `#5C5148` on paper | **7.15:1** | Secondary/meta text | 4.5:1 | ✅ (AAA margin) |
| ink-muted on surface | **7.53:1** | Secondary text on cards | 4.5:1 | ✅ |
| ink-muted on paper-sunk | **6.45:1** | Disabled-field helper text | 4.5:1 | ✅ |
| paper on ink | **15.28:1** | Footer/contact-band body text | 4.5:1 | ✅ |
| surface on ink | **16.09:1** | Button text on ink-fill buttons | 4.5:1 | ✅ |
| accent `#8A6A2E` on paper | **4.66:1** | Gold inline text/links, prices | 4.5:1 | ✅ |
| accent on surface | **4.91:1** | Gold text on cards | 4.5:1 | ✅ |
| accent on paper-sunk | **4.21:1** | — | 4.5:1 | ❌ **rule: no small gold text on sunk fields — use ink instead; accent icons/large text there still clear 3:1** |
| accent-deep `#6E5322` on paper | **6.67:1** | Hover-state gold text | 4.5:1 | ✅ |
| accent-deep on surface | **7.02:1** | Hover-state gold text on cards | 4.5:1 | ✅ |
| surface on accent (button fill) | **4.91:1** | **Primary gold-button text — always use surface, never ink, on a gold fill** | 4.5:1 | ✅ |
| ink on accent (button fill) | 3.28:1 | — | 4.5:1 | ❌ **rule: never put ink text on a solid accent fill; use surface** (3.28 only clears the 3:1 large-text floor, not worth the ambiguity) |
| surface on accent-deep | **7.02:1** | Pressed-state gold-button text | 4.5:1 | ✅ |
| accent-soft `#C7A75E` on ink | **7.15:1** | Footer social-icon links, text on dark hero overlay | 4.5:1 | ✅ |
| ink on accent-soft | **7.15:1** | Ink text on a light-gold chip (price pill) | 4.5:1 | ✅ |
| accent-soft on paper | 2.14:1 | — | 4.5:1 | ❌ **rule: accent-soft is for ink-background or ink-text contexts only — never as text directly on paper/surface** |
| accent on ink (dark section) | 3.28:1 | Large gold headline text/icons on the dark footer only | 3:1 | ✅ (large text/UI only — use accent-soft for small text, row above) |
| line `#8F8270` on paper | **3.48:1** | Input/button borders, table rules | 3:1 | ✅ |
| line on surface | **3.67:1** | Card/dialog borders | 3:1 | ✅ |
| line on paper-sunk | **3.14:1** | Borders on disabled/recessed fields | 3:1 | ✅ |
| line on ink | **4.39:1** | Footer column dividers | 3:1 | ✅ |
| hairline `#EAE1D5` on paper | 1.20:1 | **Decorative divider only** (section rules, table zebra — never an input border or anything conveying state) | n/a — exempt, non-informational | — |
| ink-on-dark-muted `#C9BFB3` on ink | **9.08:1** | Secondary text in the footer/contact band | 4.5:1 | ✅ |
| success `#2F6D4F` on paper | **5.70:1** | Success text/icon | 4.5:1 | ✅ |
| success on success-tint `#E4EFE7` | **5.20:1** | Success badge icon+text | 4.5:1 | ✅ |
| warning `#8A5A12` on paper | **5.49:1** | Warning text/icon | 4.5:1 | ✅ |
| warning on warning-tint `#F6E9D2` | **4.93:1** | Warning badge icon+text | 4.5:1 | ✅ |
| danger `#9C2F2A` on paper | **6.83:1** | Danger text/icon | 4.5:1 | ✅ |
| danger on danger-tint `#F5E3DF` | **5.93:1** | Danger badge icon+text | 4.5:1 | ✅ |
| danger on paper-sunk | **6.16:1** | Inline field-error text | 4.5:1 | ✅ |
| info `#2D5F7A` on paper | **6.43:1** | Info text/icon | 4.5:1 | ✅ |
| info on info-tint `#E1EBF0` | **5.72:1** | Info badge icon+text | 4.5:1 | ✅ |
| ink on success/warning/danger/info-tint | **13.3–14.0:1** | Alternative badge pattern: ink text always, semantic colour only on the icon | 4.5:1 | ✅ |
| `--color-accent` focus ring on paper/surface | 4.66 / 4.91:1 | Focus indicator | 3:1 (non-text) | ✅ |

Badge pattern used everywhere (§4.4): tint background + **ink** text (safest, always ≥13:1) + a semantic-coloured
icon + the coloured left rule shown in the table above — three redundant signals, so colour is never the only one.

---

## 2. Typography

### 2.1 Faces

| Role | Family | Weights used | License | Source |
|---|---|---|---|---|
| **Display** (H1/H2, hero, section titles) | **El Messiri** | 600 (SemiBold) only | SIL Open Font License 1.1, free, self-hostable | fonts.google.com/specimen/El+Messiri |
| **Text** (body, UI, forms, labels, buttons) | **Cairo** | 400 (Regular), 700 (Bold) | SIL Open Font License 1.1, free, self-hostable | fonts.google.com/specimen/Cairo |

**2 font families, 3 weights total** (the caps this system runs under). Both are part of Google's Arabic type
project, both ship real Arabic **and** Latin glyphs designed together (not a bolted-on Latin fallback), so no
third family is needed for the Latin fragments that appear (the "SONDOS YAR PHOTOGRAPHY" Latin lock-up, email
Latin content, `SAR`, phone-number digits). Latin system-font stack as a network-failure fallback only:
`"El Messiri", "Segoe UI", Tahoma, sans-serif` / `"Cairo", "Segoe UI", Tahoma, sans-serif`. Self-host both as
`woff2` (subset to Arabic + Latin + the few punctuation marks in use) — no runtime Google Fonts request, matching
the brand's privacy posture and removing a render-blocking third-party origin.

**Why this pairing**: the logo mark is a genuine calligraphic gesture (§0) paired with a plain serif "SONDOS YAR"
Latin lock-up — i.e. the brand is already "one expressive move + one disciplined workhorse." El Messiri has
enough traditional Arabic character in its letterforms to echo that gesture at heading sizes without becoming
illegible or costing a second decorative-only font; Cairo is the most road-tested geometric Arabic UI face for
dense booking/admin content (forms, tables, prices) at GCC scale. Together they read premium-editorial rather
than either "generic corporate sans" or "wedding-invitation script," which matches "premium, authoritative,
light" without losing warmth.

**No letter-spacing on Arabic, anywhere** — this is a real fix, not just a rule restated: the current
`.eyebrow` class ships `letter-spacing: 0.04em` (`index.css:115`) on Arabic text today, which breaks Arabic's
cursive letter-joining. Every text token below has `letter-spacing: normal`. If a Latin-only micro-label ever
needs tracking (e.g. a standalone "SAR" unit or the Latin logo lock-up), scope it to an explicit `:lang(en)` /
`.latin` selector — never the default.

### 2.2 Fluid type scale

Single-`vw` `clamp()` terms (same pattern already in the codebase — e.g. `clamp(2.6rem, 11vw, 5.5rem)` at
`index.css:292` — kept for continuity, just disciplined into named tokens with Arabic-tuned minimums and line
heights). Body line-heights are all ≥1.6 as required; Arabic needs the extra room for diacritics and descenders
that Latin doesn't.

| Token | `font-size` | `line-height` | Weight/face | Used for |
|---|---|---|---|---|
| `--text-display-xl` | `clamp(2.5rem, 9vw, 4.5rem)` | 1.25 | El Messiri 600 | Hero H1 |
| `--text-display-lg` | `clamp(2rem, 6vw, 3.25rem)` | 1.3 | El Messiri 600 | Section H1/H2 |
| `--text-heading-md` | `clamp(1.25rem, 3vw, 1.55rem)` | 1.4 | Cairo 700 | Card/service H3 |
| `--text-heading-sm` | `clamp(1.05rem, 2vw, 1.2rem)` | 1.45 | Cairo 700 | H4, stepper step title |
| `--text-body-lg` | `clamp(1.05rem, 2.2vw, 1.25rem)` | **1.8** | Cairo 400 | Hero/intro paragraphs |
| `--text-body-md` | `clamp(0.95rem, 1.2vw, 1.05rem)` | **1.7** | Cairo 400 | Default body/UI text |
| `--text-body-sm` | `clamp(0.85rem, 1vw, 0.92rem)` | **1.65** | Cairo 400 | Helper text, captions, meta |
| `--text-label` | `clamp(0.85rem, 0.9vw, 0.95rem)` | 1.4 | Cairo 700 | Buttons, nav, badges, form labels |
| `--text-numeral-price` | `clamp(1.5rem, 4vw, 2.25rem)` | 1.2 | Cairo 700, tabular | SAR figures |

Root stays at the browser default (100% / no forced `font-size` on `html`) so user browser zoom and OS text-size
settings keep working — the current codebase already does this correctly; keep it.

### 2.3 Numerals policy

This fixes a real, evidenced bug: `MyBookings.tsx`/`AdminDashboard.tsx`/`PackageConfigurator.tsx` all instantiate
`Intl.NumberFormat('ar-SA', …)` **without** a numbering-system override. The `ar-SA` locale's default numbering
system is Eastern Arabic-Indic (٠١٢٣...), so today's prices, dates and the one plain `numberFormatter` in
`PackageConfigurator.tsx:44` silently render Eastern digits. Inspection item 16 ("Email tables don't isolate
`+966…` — renders `…966+`") is a downstream symptom of the same root cause: Eastern-vs-Western digit mixing plus
missing bidi isolation on a phone number embedded in RTL text.

**Rule: Western digits (0–9) for anything transactional or copyable; Eastern digits (٠–٩) only for purely
decorative, non-transactional labels.**

| Content | Digits | Mechanism |
|---|---|---|
| Prices (SAR), deposit amounts | Western | `Intl.NumberFormat('ar-SA-u-nu-latn', { style: 'currency', currency: 'SAR', maximumFractionDigits: 0 })` |
| Dates (booking date, countdown, handover slot) | Western | `Intl.NumberFormat`/`DateTimeFormat` with `-u-nu-latn`, `numberingSystem: 'latn'` |
| Phone numbers | Western, **and** bidi-isolated | Wrap in `<bdi dir="ltr">` or `unicode-bidi: isolate` in CSS, so `+966 50 564 7418` never reverses inside RTL flow — directly fixes inspection item 16 |
| Booking reference / order IDs, selection counter ("12 / 30"), gallery index ("3 / 32"), page/quantity steppers | Western | Same `-u-nu-latn` pattern; `font-variant-numeric: tabular-nums lining-nums` so digits align in tables/receipts |
| Countdown segments (HH:MM, days remaining) | Western, tabular | Same, isolated in its own inline box so the colon/segments don't get bidi-reordered |
| Decorative step badges on marketing pages only (e.g. "الخطوة ١ من ٤" flourish, **not** the functional journey stepper) | Eastern allowed | Plain literal Eastern-Indic glyphs in copy; never used where the number must be read precisely or copied |

Default rule of thumb: **if it will ever be typed into a phone dialer, a bank app, or compared/sorted by the
customer or admin, it's Western.** Apply `-u-nu-latn` at every `Intl.NumberFormat`/`DateTimeFormat` call site
that currently omits it.

---

## 3. Tokens

### 3.1 `:root` block

```css
:root {
  /* ===== Colour — core (5) ===== */
  --color-paper: #FAF6EF;
  --color-surface: #FFFCF7;
  --color-ink: #241E1A;
  --color-accent: #8A6A2E;
  --color-line: #8F8270;

  /* Colour — derived tints (shades/tints of the 5 above, see §1.3) */
  --color-ink-muted: #5C5148;
  --color-ink-on-dark-muted: #C9BFB3;
  --color-accent-deep: #6E5322;
  --color-accent-soft: #C7A75E;
  --color-paper-sunk: #F1EAE0;
  --color-hairline: #EAE1D5;

  /* Colour — semantic (4), each with a pale tint for badge/chip backgrounds */
  --color-success: #2F6D4F;      --color-success-tint: #E4EFE7;
  --color-warning: #8A5A12;      --color-warning-tint: #F6E9D2;
  --color-danger:  #9C2F2A;      --color-danger-tint:  #F5E3DF;
  --color-info:    #2D5F7A;      --color-info-tint:    #E1EBF0;

  /* Shadow tint — warm (ink-based), never pure black */
  --shadow-ink: 36 30 26;

  /* ===== Typography ===== */
  --font-display: "El Messiri", "Segoe UI", Tahoma, sans-serif;
  --font-text: "Cairo", "Segoe UI", Tahoma, sans-serif;

  --text-display-xl: clamp(2.5rem, 9vw, 4.5rem);
  --text-display-lg: clamp(2rem, 6vw, 3.25rem);
  --text-heading-md: clamp(1.25rem, 3vw, 1.55rem);
  --text-heading-sm: clamp(1.05rem, 2vw, 1.2rem);
  --text-body-lg: clamp(1.05rem, 2.2vw, 1.25rem);
  --text-body-md: clamp(0.95rem, 1.2vw, 1.05rem);
  --text-body-sm: clamp(0.85rem, 1vw, 0.92rem);
  --text-label: clamp(0.85rem, 0.9vw, 0.95rem);
  --text-numeral-price: clamp(1.5rem, 4vw, 2.25rem);

  --leading-display: 1.25;
  --leading-heading: 1.4;
  --leading-body-lg: 1.8;
  --leading-body-md: 1.7;
  --leading-body-sm: 1.65;
  --leading-label: 1.4;

  /* ===== Spacing (4px base) ===== */
  --space-3xs: 0.25rem;  /* 4px  */
  --space-2xs: 0.5rem;   /* 8px  */
  --space-xs:  0.75rem;  /* 12px */
  --space-sm:  1rem;     /* 16px */
  --space-md:  1.5rem;   /* 24px */
  --space-lg:  2rem;     /* 32px */
  --space-xl:  3rem;     /* 48px */
  --space-2xl: 4rem;     /* 64px */
  --space-3xl: 6rem;     /* 96px */
  --space-4xl: 8rem;     /* 128px */

  --page-gutter: clamp(1rem, 4vw, 2.5rem);
  --section-space: clamp(4rem, 8vw, 7rem);

  /* ===== Radii — ONE shape language: a single 4px unit, three multiples ===== */
  --radius-unit: 0.25rem;
  --radius-sm: 0.25rem;   /* inputs, small buttons, status badges (chips) */
  --radius-md: 0.5rem;    /* cards, dialogs, photo tiles, dropdowns */
  --radius-lg: 0.75rem;   /* mobile bottom sheets, large modal containers */
  --radius-full: 999px;   /* pills: selectable filter/option chips, avatar, WhatsApp button */
  /* Rule: rounded-rect (sm/md/lg) = informational/static. Full pill = interactive/selectable.
     Never mix the two meanings on the same shape. */

  /* ===== Shadows — warm (ink-tinted), 3 levels ===== */
  --shadow-sm: 0 1px 2px rgb(var(--shadow-ink) / 0.06), 0 1px 1px rgb(var(--shadow-ink) / 0.04);
  --shadow-md: 0 8px 24px rgb(var(--shadow-ink) / 0.10), 0 2px 6px rgb(var(--shadow-ink) / 0.06);
  --shadow-lg: 0 24px 48px rgb(var(--shadow-ink) / 0.16), 0 8px 16px rgb(var(--shadow-ink) / 0.08);

  /* ===== Z-index ===== */
  --z-header: 100;
  --z-dropdown: 200;
  --z-overlay: 900;
  --z-dialog: 950;
  --z-skip-link: 1000;
  --z-toast: 1100;

  /* ===== Breakpoints (4 max — reference these literal values in every @media;
     CSS custom properties cannot be read inside @media conditions without a build
     step, and D1 forbids adding one without the owner's approval, so these are
     documented constants, not live tokens) =====
     --bp-sm: 36rem   (576px)  paired/2-col forms begin, larger gallery grid
     --bp-md: 48rem   (768px)  configurator 2-col, admin table view, stepper expands
     --bp-lg: 64rem   (1024px) desktop header/nav, 2-col hero, dialogs center instead of sheet
     --bp-xl: 80rem   (1280px) container hits max width, admin 3-col detail, wider gallery grid
  */

  /* ===== Container widths ===== */
  --container-narrow: 48rem;  /* forms, dialogs, single-column text */
  --container: 75rem;         /* default page content */
  --container-wide: 90rem;    /* admin queue/table, gallery management */

  /* ===== Motion ===== */
  --duration-instant: 100ms;
  --duration-fast: 180ms;
  --duration-base: 240ms;
  --duration-slow: 400ms;
  --duration-deliberate: 600ms;

  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-decelerate: cubic-bezier(0, 0, 0.2, 1);
  --ease-accelerate: cubic-bezier(0.4, 0, 1, 1);
  --ease-premium: cubic-bezier(0.16, 1, 0.3, 1);

  /* ===== Focus ring ===== */
  --focus-ring-width: 3px;
  --focus-ring-color: var(--color-accent);
  --focus-ring-offset: 3px;

  /* ===== Controls ===== */
  --control-height: 2.75rem;       /* 44px min touch target */
  --control-height-lg: 3.15rem;    /* primary CTA height */
}

/* Dark-background context override (footer, contact band): swap the two
   text-on-dark tokens components should read instead of the light-mode pair */
.on-dark {
  --text-color: var(--color-paper);
  --text-muted-color: var(--color-ink-on-dark-muted);
  --link-color: var(--color-accent-soft);
  --focus-ring-color: var(--color-accent-soft);
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
    scroll-behavior: auto !important;
  }
}
```

### 3.2 Motion spec

**Reduced-motion safety net (the important structural rule, not just a fast version of the animation)**: every
`.reveal`-type element's **base CSS state is its final, visible state** (`opacity: 1; transform: none`). Only a
JS-added class (`.reveal--armed`, toggled by an `IntersectionObserver` after checking
`matchMedia('(prefers-reduced-motion: reduce)').matches`) switches it to the animated `from → to` pair. This way
reduced-motion *and* a JS failure both degrade to "fully visible, no animation," never to "stuck invisible" — a
common real bug in scroll-reveal implementations.

| Moment | What animates | Duration/easing | Reduced-motion fallback |
|---|---|---|---|
| **Entry** (sections/cards on scroll) | `opacity 0→1` + `translateY(12px→0)`, `IntersectionObserver` threshold 0.15, `rootMargin: "0px 0px -10% 0px"`, fires once, staggered 60–80ms per sibling (cap ~5 steps) | `--duration-slow` / `--ease-decelerate` | No animation, final state only |
| **Hover** (`pointer: fine` only) | Buttons: background/border-color. Cards: `translateY(-2px)` + `shadow-sm→shadow-md`. Gallery tiles: inner `img` `scale(1→1.04)` inside `overflow: hidden` frame. Links: underline grows from the reading-start edge | `--duration-fast` / `--ease-standard` | Colour/shadow change only kept (cheap, not disorienting); scale/translate dropped |
| **Active/press** | `scale(0.98)` on buttons | `--duration-instant` | Kept (near-instant, not a motion-sickness concern) |
| **Route change** (custom History-API router in `App.tsx`) | Outgoing page fades `opacity 1→0`, new page `0→1`; scroll resets. **No slide** — a fade reads "settled/editorial," not "appy" | `--duration-base` / `--ease-standard` | Instant swap, no fade. Also: the existing `behavior:'smooth'` hash-scroll in `App.tsx:778` must become `behavior: prefersReducedMotion ? 'auto' : 'smooth'` — today it ignores the media query unconditionally (evidenced in the inspection report) |
| **Dialogs/sheets** (AuthDialog, admin action dialog, lightbox, mobile menu) | Backdrop `opacity` fade. Desktop panel: `scale(0.96→1)` + fade + `translateY(8px→0)`. Mobile: bottom sheet `translateY(100%→0)` | `--duration-base` (panel), `--duration-fast` (backdrop) / `--ease-premium` | Instant show/hide, no scale/slide |
| **Countdown urgency pulse** (hold deadline <10% remaining) | Chip `opacity 1↔0.85`, 1600ms, infinite, **ambient only — never the sole signal**: label text and danger/warning tokens already convey urgency without it | 1600ms `ease-in-out` | Pulse removed entirely; static chip |
| **Calendar day selection** | `background-color` transition only, no bounce/scale | `--duration-fast` / `--ease-standard` | Kept (cheap) |
| **Toast** | Slide+fade from block-start, auto-dismiss progress bar (linear, width 100%→0 over visible duration), pauses on hover/focus | `--duration-base` in, linear countdown | Fade only, no slide |
| **Upload dropzone dragover** | Border colour → accent, `scale(1→1.01)` | `--duration-fast` | Border colour only |

---

## 4. Component inventory

Shape-language rule from §3.1 applies throughout: **rounded-rect radii = informational/static, full pill =
interactive/selectable.** Every interactive component has explicit `:focus-visible` per §3.1's focus-ring token,
min `--control-height` (44px) touch target, and keyboard operability — none of this is optional per the binding
constraints.

### 4.1 Buttons

One shared base (`--control-height`, `--radius-sm`, `--text-label` Cairo 700, `--duration-fast` transitions,
`:focus-visible` ring), four variants:

| Variant | Fill | Text | Border | Hover | Disabled | When |
|---|---|---|---|---|---|---|
| **Primary** | `--color-ink` | `--color-surface` (16.09:1) | none | `--color-accent-deep`… no — fill darkens via a 6% black overlay, not a hue change | `--color-paper-sunk` fill, `--color-ink-muted` text, `cursor: not-allowed` | Everyday primary action: "التالي", "إرسال الطلب", "اختيار هذا البكج" |
| **Secondary** | transparent | `--color-ink` | 1px `--color-line` (3.48:1) | border → `--color-accent`, text → `--color-accent-deep` | border `--color-hairline`, text `--color-ink-muted` | Secondary action alongside a primary one: "رجوع", "إلغاء" |
| **Ghost** | transparent | `--color-ink` | none | background tint `--color-paper-sunk` | text `--color-ink-muted`, no hover | Low-emphasis/tertiary: dialog close, "تعديل" inline links |
| **Accent (rare)** | `--color-accent` → `--color-accent-deep` on hover | `--color-surface` (4.91:1 / 7.02:1) | none | fill darkens to accent-deep | fill `--color-line`, text `--color-surface` at reduced but still-legible pairing (avoid opacity) | Genuinely rare, high-value moments only: final "تأكيد ودفع العربون" submit, WhatsApp (below) |
| **WhatsApp — one implementation, reused everywhere** | `--color-accent` fill (same "accent" variant, not WhatsApp's own green — see rationale) | `--color-surface` | none | `--color-accent-deep` | n/a (always a live link) | Footer, contact section, portfolio inquiry, handover final step, rejected/cancelled-booking guidance |

**Why the WhatsApp button is gold, not WhatsApp-green**: introducing `#25D366` would be a 6th core colour and
would clash with the disciplined ivory/ink/gold system (the logo itself is monochrome — nothing else on the site
is a saturated brand-borrowed hue). Using the accent gold + a WhatsApp glyph icon keeps the visual system closed
at 5 core colours while still being instantly recognisable as "message us." It also happens to satisfy §1.1's
rule perfectly: WhatsApp contact *is* one of the few genuinely high-value actions.

One WhatsApp component, label and `href` (pre-filled message) vary by context:

- Footer / contact band: `تواصلي عبر واتساب` → generic inquiry text (already live in `App.tsx`)
- Portfolio inquiry: `استفسري عن موعدكِ عبر واتساب`
- Handover final step (new — decisions.md step 8): pre-filled message placeholder for the copywriter:
  `مرحبًا، معي حجز رقم {رقم_الحجز} وموعد استلام الألبوم يوم {التاريخ} الساعة {الوقت}.`

### 4.2 Links

- **Inline link** (within body copy): `--color-ink` text, `border-bottom: 1px solid var(--color-line)`, hover →
  border-color `--color-accent`. Never colour-alone (the underline is the primary signal; colour shift is
  secondary).
- **Nav link**: no underline at rest; `aria-current="page"` state gets `box-shadow: inset 0 -2px var(--color-accent)`
  (kept from the current pattern — it already works) + `--color-ink` text instead of today's muted default so the
  active page reads as unmistakably current.

### 4.3 Cards

Base: `--color-surface` bg, 1px `--color-line` border (or `--color-hairline` when purely decorative grouping, not
a clickable boundary), `--radius-md`, `--shadow-sm` → `--shadow-md` + `translateY(-2px)` on hover **only if
interactive**. Padding `--space-md` (mobile) / `--space-lg` (desktop).

Variants: package/pricing card, photo card (gallery tile — §4.7), booking-summary card, admin queue card,
**testimonial card** (built, not populated — surface card, a large opening quotation mark using the logo's
aperture-icon motif in `--color-accent-soft` as a decorative corner mark, quote text, name + optional context
line; **ships with zero content on Home until the owner supplies real quotes from «لُطفكم» per D7** — do not fill
with placeholder testimonial text, an empty component is correct here).

### 4.4 Status badges — never colour-only

Rounded-rect chip (`--radius-sm`, not pill — see shape rule), tint background, **`--color-ink` text always**, a
semantic-coloured icon leading the text, and a 3px `border-inline-start` in the semantic colour as a third,
redundant signal. Full booking-status mapping (statuses from `shared/admin.ts`):

| Status | Tint | Icon | Arabic label (placeholder) |
|---|---|---|---|
| `pending_review` | info | clock | قيد المراجعة |
| `approved_hold` | warning | hourglass (+ countdown chip alongside, §4.6) | تم القبول — بانتظار العربون |
| `payment_pending` *(reused for "receipt uploaded, awaiting verification" per D2)* | info | receipt/upload | الإيصال قيد المراجعة |
| `confirmed` | success | check-circle | الحجز مؤكد |
| `rejected` | danger | x-circle | لم يتم قبول الطلب |
| `cancelled` | neutral (`--color-paper-sunk` bg, `--color-ink-muted` text/icon — cancellation isn't necessarily an error) | slash | الحجز ملغي |
| `expired` | neutral (same as cancelled) | clock-x | انتهت مهلة الحجز |
| `contract_pending` / `contract_signed` *(legacy — D2 keeps old rows readable)* | info | clock | same info treatment **+ a small "مسار سابق" caption** so admins understand why a status outside the new flow appears |

### 4.5 Form fields

Label above field (start-aligned), `--control-height`, `--radius-sm`, `--color-surface` bg + 1px `--color-line`
border at rest (3.48–3.67:1). States: hover (border → ink-muted-adjacent, no colour swap needed), **focus**
(border → `--color-accent` 2px + the standard focus ring), filled, **error** (border → `--color-danger`, helper
text in danger + an alert-triangle icon — never red border alone), **disabled** (bg → `--color-paper-sunk`, text
→ `--color-ink-muted`, border → `--color-line` on sunk 3.14:1 — **explicit tokens, not `opacity: 0.5`**, which is
the classic way disabled states silently fail contrast). Required fields get a small `--color-accent` asterisk +
`aria-required`, not colour alone (a "مطلوب" caption on first error is the real signal).

### 4.6 Dialogs

Overlay: `rgb(var(--shadow-ink) / 0.55)` scrim. Panel: `--color-surface`, `--radius-lg`, `--shadow-lg`, focus-trapped,
`Escape` closes **the topmost layer only** and is **disabled while a submit request is in flight** (a real fix —
inspection item 5 found the admin action dialog's `Escape` also closing the parent panel mid-submit, leaving
stale UI while the server may still commit and email). A `submitting` state replaces the confirm button with a
spinner and disables backdrop-click/Escape until the request settles. Mobile: bottom sheet (`--radius-lg` top
corners only, slides from block-end, drag-handle bar decorative-only, not the sole close affordance — a close
button is always present too).

### 4.7 Notices / toasts

Same tint+icon+ink-text pattern as badges (§4.4), `--radius-md`, `4px` `border-inline-start` in the semantic
colour. **Inline notice**: persistent, lives in page flow (e.g. "الإيصال قيد المراجعة" banner on My Bookings).
**Toast**: ephemeral, block-start of viewport, `--shadow-md`, auto-dismiss with a linear shrinking progress bar,
pauses on hover/focus, `aria-live="polite"` (assertive only for destructive-action confirmations).

### 4.8 Journey stepper

Maps 1:1 to decisions.md's proposed 8-step journey (flagged there as "to be specified, not yet approved" — I'm
using it as the structural backbone since that's the only journey on record; owner should confirm wording, see
§9). Placeholder step labels:

١) الطلب → ٢) الموافقة والحجز المبدئي → ٣) قبول الشروط ورفع الإيصال → ٤) تأكيد الحجز → ٥) الاستعداد لليوم →
٦) اختيار الصور → ٧) تجهيز الألبوم → ٨) الاستلام

**Desktop** (≥`--bp-lg`): horizontal, steps flow **right-to-left** (step 1 rightmost — RTL mirror note: a Stripe-
style horizontal stepper reference reads left-to-right; this one is the mirror image of that). Circular markers
(`--radius-full`, 2rem): completed = ink fill + check + surface text; current = accent 2px border on surface fill,
bold label; upcoming = line border on surface, ink-muted label. Connector line: `--color-line`, progressively
fills `--color-ink` behind completed steps.

**Mobile**: compact header only — "الخطوة ٣ من ٨ — قبول الشروط ورفع الإيصال" + a slim progress bar (accent fill on
a line-coloured track) + a "عرض جميع الخطوات" disclosure that expands the full vertical list (steps flow
top-to-bottom — vertical orientation needs no RTL mirroring, but the connector/marker still use logical
properties).

### 4.9 Countdown

Used for the hold deadline (`approved_hold`, proposed 48h per D5) and the gallery-selection window (proposed 14
days per D5). Semantic-tinted chip (warning by default → danger when <10% of the window remains), hourglass icon,
Western tabular digits (§2.3), explicit label ("الوقت المتبقي: …"). Visual tick every 60s; `aria-live="polite"`
region updates only on meaningful threshold crossings (not every tick) so assistive tech isn't spammed. Pulse
animation is ambient-only per §3.2 — text/colour already carry the urgency. On expiry: terminal neutral/danger
state, relevant action buttons disable, an explanatory notice (§4.7) replaces the countdown.

### 4.10 Gallery tile + lightbox

**Tile**: locked to the photo's **native** aspect ratio — the owner's three pre-cropped ratios (16:9, 3:2, 4:5)
are used directly, never force-cropped to a fourth ratio (this also fixes inspection item: "wedding-04/05/07 have
wrong orientation classes," by not hand-assigning orientation classes at all — the grid auto-flows by each tile's
own ratio, `grid-auto-flow: dense`, not `:nth-child` pinning). Lazy-loaded, `--radius-md`, hover scale (desktop,
§3.2). In selection mode: a checkbox overlay at the **reading-start corner** — physically **top-right** in this
RTL app (`inset-block-start` + `inset-inline-start`) — this is the RTL mirror of where an LTR gallery would put
it (top-left).

**Lightbox**: full-screen overlay, largest available crop, prev/next chevrons, Western-digit index ("3 / 32"),
selection toggle synced with the tile, close button, focus-trapped, `Escape` closes, swipe on mobile.

**RTL mirror note (explicit, as required)**: in this RTL layout, the **visually-left** chevron (‹) means
**التالي / next** and the **visually-right** chevron (›) means **السابق / previous** — the reverse of an LTR
lightbox reference. Arrow keys follow **physical/visual** direction, not logical reading order (pressing the
physical Right key moves to the photo physically on the right, i.e. "previous" in RTL reading order) — chosen
because people key off the on-screen chevron they're looking at, not the abstract reading direction; stated
explicitly here so it isn't left ambiguous. Swipe gesture follows the same physical convention.

### 4.11 Selection counter

Persistent chip/bar: desktop = sticky alongside the gallery grid; mobile = fixed bottom bar above the safe area.
Two tiers, since decisions.md separates favouriting from the final package selection: **"❤ تفضيل"** (favourite,
unlimited, the bride's own shortlist) is a lighter secondary count; **"✓ المختارة: 12 / 30"** (select-for-album,
capped at the package's exact photo count from `photoCountOptions`) is the prominent count with an accent
progress-bar fill. Select action disables with an inline message once the cap is reached (swap-by-deselecting
first, not silently blocked). Submit ("تأكيد الاختيار") enables only at an exact match to the target count and
opens a confirm dialog (§4.6) before locking — decisions.md: "submits → locked," an effectively irreversible
action that deserves the confirm step.

### 4.12 Upload dropzone

One base component, two contexts. Dashed `--color-line` border (2px), `--radius-md`, `--color-paper-sunk` bg at
rest, upload-cloud icon, primary instruction + "أو اسحبي وأفلتي الملف هنا" + accepted formats/size caption
(`--text-body-sm`, ink-muted) — and a real `<input type="file">` behind a proper button, never a bare clickable
`div`. States: idle, dragover (border → accent, tint bg, `scale(1.01)`), uploading (per-file progress bar, accent
fill on a line-coloured track, filename/size/cancel), success (thumbnail + check, success tint), error (danger
tint row, explicit reason text, retry).

- **Customer receipt upload**: single file (image/PDF).
- **Admin bulk gallery upload**: many files at once (decisions.md: "bulk, automatically"). Grid of thumbnails,
  per-item + overall progress ("14 / 40 صورة — يتم الرفع…"), and a **"مراجعة قبل النشر"** staging step before
  anything becomes visible to the customer — matches the privacy-first, admin-controlled brand value; "automatic"
  means automatic *upload/processing*, not automatic customer-visibility.

### 4.13 Calendar day states

Fixes inspection item 13 (colour-only states, no grid role). `BookingCalendar.tsx` already has **three** logical
states worth keeping (`available` / `pending` — an unconfirmed prior request exists for that date / `unavailable`)
plus **today**, **past**, and **selected** — six states total, each with a non-colour signal so it survives
grayscale/colour-blind viewing:

| State | Fill | Text | Non-colour signal |
|---|---|---|---|
| Available | surface | ink | none needed — the unmarked default |
| Selected | accent | surface | small check icon under the date |
| Pending (another unconfirmed request exists) | warning-tint | ink | a small dot/asterisk marker + still clickable, with the existing inline warning copy pattern kept |
| Unavailable/blocked | paper-sunk | ink-muted | **strikethrough on the date number** + `aria-disabled` |
| Past | paper-sunk (no border) | ink-muted | reduced visual weight, no strikethrough (distinct from "blocked" — different meaning, different mark), `aria-disabled` |
| Today | (whatever the day's own state fill is) | — | 2px ink ring around the cell + a small dot below the number |

Grid semantics: `role="grid"`, week rows, `role="gridcell"` days, full Arabic `aria-label` per cell stating date +
state (already partly present — formalising it closes the gap). Legend below the grid: icon/pattern swatch + label
per state, not colour swatches alone.

### 4.14 Admin tables and queue

**Table**: sticky header row, `--color-ink` bold text on `--color-surface`; row hover → `--color-paper-sunk`; 1px
`--color-hairline` row dividers (no zebra striping — cleaner at this density); sortable headers show a direction
icon, never colour alone; numeric/currency columns are **end-aligned** (= physically right in RTL, consistent
with the rest of the table) with the digits themselves isolated `dir="ltr"` inside that cell so "1,600" never
reverses. Selectable rows (checkbox column, reading-start aligned) for bulk actions. Real pagination/cursor
("تحميل المزيد") replaces today's hard 50-row cap with no pagination — **note**: this needs an additive
`cursor`/`before` param on `GET /api/admin/bookings`; flagged for the backend/architect stage, not something this
design assumes already exists.

**Daily queue** (new admin landing page — "لوحة اليوم", replacing the flat filter+list as the default view; the
full searchable table moves to a "كل الطلبات" tab): four urgency-grouped stat/list cards —

- طلبات جديدة (pending_review awaiting the proposed 24h SLA)
- إيصالات بانتظار المراجعة (payment_pending)
- حجوزات ستنتهي مهلتها قريبًا (approaching hold deadline)
- تسليمات اليوم/غدًا (handover slots)

Each card: count + a short list, click-through to the relevant detail view.

---

## 5. Page layouts

Grid/type/colour/motion tokens throughout are the ones defined in §1–§3; only layout, hierarchy and photo
assignments are new information here.

**Routing note**: `App.tsx` currently recognises exactly five paths (`type AppPath = '/' | '/portfolio' |
'/packages' | '/my-bookings' | '/admin'`) via a hand-written `switch`, and React Router is forbidden (binding
constraint). §5.6 (Gallery selection) and §5.7 (Handover booking) are deliberately designed as **stage views
inside `/my-bookings`** — conditionally rendered by the active booking's `status`, the same way the journey
stepper (§4.8) already treats them as later steps of one evolving page — rather than as new top-level routes.
This keeps the routing surface additive-free: no new `AppPath` entries needed. If a later stage still prefers
separate URLs for deep-linking (e.g. a direct link to the receipt-upload step), that only needs a query string
or hash read by `/my-bookings`, not a new path literal.

### 5.1 Photo plan — all 32, assigned

Per §0's methodology note, only `IMG_2845 (1) copy.webp` was visually verified by me; the rest use decisions.md's
filenames/descriptions as-is, with no invented content. "Detail frame" = no individual caption exists in
decisions.md beyond the folder-level aesthetic description (henna/rings/red-gold dress details, ivory/champagne/
blush/black-bisht palette) — the exact pick within that ratio group is flexible.

**Dual-purpose (used on Home and again in the full Portfolio grid — normal, not a conflict):**

| Slot | File | Ratio | Content (from decisions.md, or "confirmed by direct viewing" where noted) |
|---|---|---|---|
| Home hero / Portfolio lead | `4.5/IMG_2845 (1) copy.webp` | 4:5 | Bouquet (blush/white) against a black bisht with gold embroidery — **confirmed by direct viewing**, zero identifiable-face risk |
| Home featured-work strip #1 / Portfolio | `16-9/2M4A0708 ابيض copy.avif` | 16:9 | Groom's hand reaching for the bride's hennaed hand, red-and-gold sleeve |
| Home featured-work strip #2 / Portfolio | `3.2/2M4A4068 copy.jpg copy.avif` | 3:2 | Rings on satin |
| Home featured-work strip #3 / Portfolio | `4.5/2M4A1262 copy 2.avif` | 4:5 | Gown displayed under a floral arch |
| Packages page banner / Portfolio | `3.2/2M4A1670 copy.jpg copy.avif` | 3:2 | Bride in her gown with bouquet among men in bishts |

**Full Portfolio grid order** (all 32, exactly once each; grid auto-flows each tile at its native ratio per
§4.10 — this sequencing is the intended rhythm, not a rigid requirement):

1. IMG_2845(1)copy.webp (4:5, lead) · 2. 2M4A1670 copy.jpg copy.avif (3:2) · 3. 2M4A0708 ابيض copy.avif (16:9) ·
4. 2M4A8403 copy 2.avif (4:5 — couple's hands with rings and bouquet) · 5. 2M4A4068 copy.jpg copy.avif (3:2) ·
6. 2M4A1262 copy 2.avif (4:5) · 7. 2M4A0881 copy 2.avif (16:9 — two hands holding phones showing wedding photos) ·
8. 2M4A0331 copy 2.avif (3:2, detail frame) · 9. IMG_2989.JPG copy.avif (4:5 — bride holding her shoes) ·
10. 2M4A0691 copy 2.avif (3:2, detail frame) · 11. 2M4A1589 copy 2.avif (4:5 — family group, **faces blurred**) ·
12. 2M4A2256 copy 2.avif (16:9 — hand-in-hand detail, watch) · 13. 2M4A8490 copy 2.avif (3:2 — ring handover) ·
14. 2M4A1955 copy 2.avif (4:5, detail frame) · 15. 2M4A0822 copy 2.avif (3:2, detail frame) ·
16. 2M4A0379 ستوري copy.jpg copy.avif (4:5 — couple from behind, banquet hall) ·
17. 2M4A0931 copy.jpg copy.avif (3:2, detail frame) · 18. 2M4A2024 copy 2.avif (4:5, detail frame) ·
19. 2M4A6038 copy.avif (16:9 — dark, gold-toned detail) · 20. IMG_2143.JPG copy.avif (3:2, detail frame) ·
21. 2M4A2258 copy 2.avif (4:5, detail frame) · 22. 2M4A1034 copy 2.avif (3:2, detail frame) ·
23. IMG_3275.JPG copy.avif (4:5, detail frame) · 24. 2M4A1416 copy.jpg copy.avif (3:2, detail frame) ·
25. IMG_4305 copy.avif (4:5, detail frame) · 26. 2M4A1459 copy 2.avif (3:2, detail frame) ·
27. IMG_7663.JPG copy.avif (4:5, detail frame) · 28. IMG_3139.JPG copy.avif (3:2, detail frame) ·
29. 2M4A3396 ستوري.jpg copy.avif (4:5, detail frame) · 30. IMG_3185.JPG copy.avif (3:2, detail frame) ·
31. IMG_7748.JPG copy.avif (4:5, closing frame) · 32. 2M4A8498 copy 2.avif (3:2, closing frame)

**Alt-text formula** (copywriter fills the bracket per photo, pattern only, not final copy):
`"لقطة [من تفاصيل الحناء والخواتم / لفستان العروس تحت القوس المزهر / ...] من أعمال المصورة سندس يار"` for the
photos with a known subject above; generic `"لقطة تفصيلية من أعمال المصورة سندس يار"` for detail-frame photos.

**Gallery Selection page (§5.5) is NOT this set** — it renders each booking's own admin-uploaded event photos
(private, per-customer, populated at runtime). Keep these two photo sources conceptually separate everywhere in
implementation.

### 5.2 Home (`/`)

**Desktop** (Hero pattern like a restrained Stripe/Aesop hero — text column + full-bleed media column, not a
busy carousel):

1. **Hero**: 2-col grid (`0.85fr` text / `1.15fr` media, ≥`--bp-lg`; stacked, media first visually... **RTL
   note**: media sits at the grid's **second** (left, inline-end) column and text at the **first** (right,
   inline-start) column — this is already how the current CSS places it (`hero__content` grid-column 1, i.e.
   the right/start column in RTL) and is correct: keep it, don't mirror it to "image to the right" just because
   many LTR hero references put image-right — the existing choice is already the correct RTL mirror of a
   text-left/image-right LTR reference). Eyebrow, `--text-display-xl` H1, `--text-body-lg` description, primary
   button ("شاهدي الأعمال") + WhatsApp-tier is not here — secondary button "ابدئي طلب الحجز" (secondary variant,
   not accent — the accent gold stays reserved). Media: `IMG_2845` at native 4:5, slow `scale(1→1.05)` over 8s on
   load (freezes under reduced motion).
2. **Introduction** (text-only band, unchanged structurally — brand statement, no photo, keeps rhythm from
   photo-heavy hero into a breathing moment).
3. **NEW — Featured work** (Home currently has no portfolio teaser at all — this is a structural addition,
   consistent with "expand the content"/"modular components"): 3-tile strip (the dual-purpose photos above),
   `--section-space` padding, "شاهدي جميع الأعمال" text-link to `/portfolio`.
4. **Services** (existing 3-card grid, restyled to tokens, small line-icon per card instead of no icon — keeps
   this section fast/light, deliberately photo-free so it reads distinct from the photography sections).
5. **Contact band** (`.on-dark` context, ink bg, WhatsApp accent button — unchanged structurally).

**Mobile**: single column, hero media 4:5 (same crop as desktop — no separate mobile crop needed, a real win from
using the owner's native ratios), featured-work strip becomes a horizontal snap-scroll row (3 tiles, `scroll-snap-
type: x mandatory`, RTL-native so swiping right reveals the next tile in reading order) or stacks — snap-scroll
preferred to avoid 3 large tiles stacking to an overlong page.

### 5.3 Portfolio (`/portfolio`)

**Desktop**: header (eyebrow + H1 "من أعمالنا"), then the 32-tile auto-flowing masonry grid from §5.1/§4.10
(`grid-auto-flow: dense`, ratio-driven spans, replacing the `:nth-child`-pinned 8-item grid and its wrong-
orientation bug). `--container-wide` at ≥`--bp-xl` so the grid has room to breathe. Closing text-link "استفسري
عن موعدكِ" → WhatsApp.

**Mobile**: single/2-column flow (`--bp-sm` switches 1→2 columns), each tile keeps its native ratio, lazy-loaded
throughout (already `loading="lazy"` in the current code — keep it, and add explicit `width`/`height` or
`aspect-ratio` CSS so there's no layout shift, closing inspection item 2's "no dimensions" gap).

### 5.4 Packages (`/packages`) — booking steps + configurator + calendar

**Desktop**:
1. New page banner under the header: `2M4A1670` (3:2) full-bleed short band, H1 "اختاري البكج والتفاصيل
   المناسبة" overlaid on an ink gradient-scrim corner (for text contrast — scrim, not a flat overlay, so the
   photo still reads).
2. **Process** (existing 4-step "من الاختيار إلى التأكيد" list) — restyle only, keep structure.
3. **Configurator**: ≥`--bp-md` goes 2-column — **left/start column** (inline-start, i.e. physically right in
   RTL) = the option groups (coverage → album size/pages/photo-count/box → prints → magazine → wooden
   enlargement), **right/end column** (physically left) = a **sticky running-summary card** (price breakdown +
   running total in `--text-numeral-price`, Western tabular digits). **RTL mirror note**: this is the mirror of
   a typical LTR checkout reference (options left, summary sticky-right) — here options are inline-start
   (right), summary sticky at inline-end (left), which still reads correctly because "sticky summary on the side
   you reach last while scrolling down a single column" is preserved regardless of which physical side that is.
   No pricing numbers change — this is purely a layout restyle of the same fields in `packages.ts`.
4. **Calendar** (§4.13's redesigned states) follows the configurator, full-width.
5. Summary → "متابعة" → `AuthDialog` gate if needed → review → submit (unchanged flow, restyled).

**Mobile**: single column throughout, configurator summary becomes a **collapsed sticky bottom bar** ("الإجمالي:
{price} — عرض التفاصيل") that expands to the full breakdown on tap, so the running total is always visible while
scrolling a long options list without permanently occupying screen height.

### 5.5 My Bookings (`/my-bookings`) — journey tracker

Logged-in utility page for one specific booking — deliberately **photo-light** (this is a "manage my booking"
dashboard, not a marketing page; heavy documentary photography here would feel oddly impersonal, like ads
inside a bank statement). Optional-only: a very low-opacity blurred ambient texture behind the page header using
`2M4A1955` (`aria-hidden`, purely decorative) — explicitly a nice-to-have, drop it if it competes with the
countdown/status content.

**Layout**: journey stepper (§4.8) at top, status badge (§4.4) + guidance text, the countdown (§4.9) when a hold
or selection window is active, booking summary card, and (new, per D2) the **terms-acceptance + receipt-upload**
step inline when status is `approved_hold`/`payment_pending` — checkbox "أوافق على شروط الحجز" (links to terms,
short placeholder) + the upload dropzone (§4.12, receipt context) + submit. **Desktop**: stepper horizontal top,
content below in `--container-narrow` (this page is read/act, not browse — a narrower measure suits it).
**Mobile**: compact stepper header (§4.8), stacked content, sticky bottom action bar for the primary next step.

### 5.6 Gallery selection — `/my-bookings` stage view (customer's own event photos)

Not the 32 marketing photos (§5.1) — this renders whatever the admin has bulk-uploaded and published (§4.12,
§5.7) for that specific booking, via short-lived signed URLs per D6 (proposed), never a permanent public path.

**Desktop**: `--container-wide`, selection counter (§4.11) sticky at the grid's edge, tile grid (§4.10) — but
here tiles are uniform (admin-uploaded previews, likely a consistent working ratio, unlike the mixed-ratio
portfolio), lightbox (§4.10) for full review, "تأكيد الاختيار" primary button enabled only at exact-count match,
opens the lock confirmation dialog. A visible **selection-window countdown** (§4.9, 14-day proposed default) sits
above the grid.

**Mobile**: 2-column tile grid, selection counter fixed to the bottom (above safe-area), lightbox full-screen with
swipe.

### 5.7 Handover booking — `/my-bookings` stage view (pickup or delivery, D3: both)

Utility/form page, photo-free (same reasoning as §5.5). A segmented control (pill-shaped per §3.1 shape rule —
this is a selectable choice) toggles "استلام من الاستوديو" / "توصيل"; pickup shows a location note + time-slot
picker (reuses the calendar/slot pattern from §4.13, simplified to time-of-day slots rather than full-month);
delivery adds an address form (§4.5 field states) + the same slot picker. Confirmation summary + the WhatsApp
button (§4.1, handover context, pre-filled reference+slot message) as the final step, matching decisions.md
exactly ("الاستلام… reminder; final step = WhatsApp").

### 5.8 Admin

`--container-wide`, functional/data-dense, **no marketing photography anywhere in admin** — small logo mark only
in a slim top bar (distinct from the public header — no nav, no WhatsApp CTA, just brand mark + admin identity +
sign-out).

- **Daily queue** (§4.14): the new landing view, 4 urgency cards in a responsive grid (1 col mobile → 2 col
  `--bp-md` → 4 col `--bp-xl`).
- **Booking detail**: ≥`--bp-xl` goes 3-column — customer/package summary (sticky, start column) · status-history
  timeline + admin notes (center) · action panel (end column, buttons per `getAllowedAdminActions(status)` from
  `shared/admin.ts` — the state machine itself is unchanged, only its presentation). Mobile: stacked, action
  panel becomes a sticky bottom bar.
- **Receipt review** (new): the uploaded receipt (zoomable, served via the same short-lived signed URL as
  gallery previews — never permanently cached), expected-deposit-amount line (**placeholder token, depends on
  D4 — see §9**), two actions: "تأكيد الاستلام" (→ `confirmed`) and "رفض الإيصال" (opens a dialog requiring a
  reason textarea + an editable short-extension field, defaulting to +24h — matches decisions.md: "rejects the
  receipt with a reason and a short extension").
- **Gallery upload** (new): bulk dropzone (§4.12) → thumbnail management grid with per-photo draft/published
  state, bulk publish/unpublish/delete, and — once the customer's selection is locked (§5.6) — an "تصدير الأسماء
  المختارة" action producing a plain copyable/downloadable filename list (decisions.md: "admin exports the
  selected file names").
- **Blocked dates** (existing `BlockedDatesManager`, keep functioning): a settings-style calendar-admin view,
  restyled to §4.13's tokens, unchanged behaviour.

---

## 6. Header, footer, mobile menu

### 6.1 Header

Keep structurally: sticky, logo + brand name (start side, i.e. right), nav (Home/Portfolio/Packages/My Bookings +
contact-scroll), one dominant primary CTA ("ابدئي طلب الحجز," **ink primary variant**, not accent gold — keeps
§1.1's discipline). **Deliberately no Instagram/TikTok icons in the main desktop bar** — adding social icons next
to the primary CTA would create two competing "leave the page" targets in the one place that should have a
single dominant action; they go in the mobile menu and footer instead (§6.2, §6.3), both expected, lower-stakes
locations. Auth controls (login/logout) keep their current position, restyled to tokens. Fix the oversized-logo
asset per §0.

### 6.2 Mobile menu

Keep the native `<details>/<summary>` disclosure pattern — it's already accessible, needs no JS, and fits D1's
"no animation library, native motion" directly. Restyle: panel becomes a full-height sheet that slides in from
the **reading-start edge — physically the right edge in this RTL app** (`inset-inline-start: 0`) — **explicit RTL
mirror note**: an LTR reference mobile menu opens from the left; this one opens from the right, which is the
correct mirror, not a copy of the LTR original. Backdrop scrim on open. Content: nav links (active state gets the
accent inset-shadow indicator, matching desktop), auth controls, **new** small Instagram + TikTok icon row (below
nav, above the WhatsApp/booking CTA), then the WhatsApp-tier booking CTA prominent at the bottom.

### 6.3 Footer

Restyled to `.on-dark` tokens (§3.1), expanded from today's single row into four columns collapsing to a stack
on mobile:

1. **Brand**: logo (small, on ink — use the transparent re-export per §0) + «المصورة سندس يار» + city (existing
   copy, no invented address).
2. **Contact**: WhatsApp number as a live link (bidi-isolated per §2.3, fixing the `+966…` reversal bug).
3. **Social — new**: Instagram + TikTok, both `@sndsyar` (handle confirmed in both source documents; the URLs
   `instagram.com/sndsyar` and `tiktok.com/@sndsyar` are the standard platform URL built from that already-
   confirmed handle, not a new fact). Icons in `--color-accent-soft` on the ink background (7.15:1, §1.5).
4. **Quick links**: Home / Portfolio / Packages / My Bookings.

Bottom bar: existing copyright line, unchanged.

### 6.4 Favicon / brand mark

Replace the current off-brand purple Vite-template favicon (`public/favicon.svg`, confirmed unrelated to this
brand) with a simple monochrome mark derived from the logo's own **aperture/lens glyph** (§0's correction) on an
ivory roundel — single colour (`--color-ink`), legible at 16–32px. This is also the asset that fixes the "wrong
favicon path" build-bloat defect noted in the baseline log.

---

## 7. GCC market taste notes

The brand evidence here (§0) is already disciplined: a **monochrome** calligraphic logo, a plain serif Latin
lock-up, warm-but-not-oversaturated documentary photography. That's a strong signal not to reach for a
gold-drenched, heavily-ornamented treatment by default — this particular brand already reads premium through
restraint, and piling on more gold/pattern would fight the mark rather than support it.

Where this system still brings GCC-appropriate warmth, deliberately:

- **The accent gold** (§1) is real antique brass, not a generic Bootstrap "warning yellow" — closer to the
  gold-thread embroidery visible in the photos (`IMG_2845`'s black bisht trim) than to a Western tech-startup
  yellow.
- **The photography itself carries the blush/champagne/deep-red/black-bisht palette** the owner's own photos
  already have (§0, decisions.md). The UI chrome stays ivory/ink/gold/neutral **on purpose** — richness comes
  from letting full-bleed photography breathe (§5.2's hero, §5.3's grid), not from painting buttons and cards in
  pink or red. Recreating the photo's palette in flat UI colour would be redundant next to the photo and would
  also collide with the danger-red semantic meaning (§1.4) — reusing "deep red" decoratively next to an error-red
  badge would blur a meaning that needs to stay unambiguous.
- **Arabic-calligraphic accent, used once, not tiled**: the logo's aperture-lens glyph (§0) reused as a small
  divider/loading motif (§4.3's testimonial-card corner mark) is the one calligraphic/graphic flourish in the
  system — deliberately singular, not a repeating pattern background, so it stays a signature rather than
  wallpaper.
- **What this system avoids on purpose**: ornate gold borders/frames around every card, drop-shadow-heavy
  "luxury" gradients, or defaulting every price/CTA to gold (§1.1's scarcity rule again) — those read as a
  generic "Gulf-luxury" stereotype rather than this specific brand's own (quite restrained) visual evidence. A
  bridal-photography client in this market can be genuinely tech-forward and editorial rather than maximalist —
  this system assumes that, based on what the brand evidence actually shows, not on a category assumption.

### Rationale for the design decisions (traceable to the ambition reference)

- **60/30/10 mapped to real components, not vibes** (§1.1): every button/badge/surface in §4 cites which of the
  three shares it belongs to.
- **"Subtle premium entry animations"** → §3.2's IntersectionObserver reveal + the `--ease-premium` curve
  specifically for dialogs/hero — "subtle" enforced by keeping translateY to 12px and opacity-only for most
  hover states, nothing bouncy.
- **"Modular components"** → §4's inventory is written so each component is a single implementation reused by
  reference everywhere it appears (the WhatsApp button, the badge pattern, the notice/toast pattern, the calendar
  states) rather than one-off CSS per screen — directly answering the inspection report's "11 separately written
  primary buttons" and "3 different accent-dark values" defects.
- **"Fully responsive"** → §3.1's 4-breakpoint cap (replacing 15) plus every layout in §5 stating its mobile
  behaviour explicitly, not left implicit.

---

## 8. Dark mode

**Out of scope for this run — stated explicitly, not left ambiguous.** Neither `decisions.md` nor the computed
task requests it. More substantively: this is a photography-led editorial site where the warm documentary imagery
is the star (§7); a dark UI chrome would compete with that imagery's own warm tonal range rather than support it,
and the 60/30/10 brief itself is specified as a **light**-background system (60% ivory/paper). The one candidate
for a dark surface — the admin tool — wasn't requested either and stays on the same light tokens for consistency
with the public site's component library (§4.14 reuses the same button/badge/table tokens, not a separate admin
theme).

Nothing here blocks adding it later if the owner wants it: every colour in §3.1 is a semantic CSS custom
property (`--color-ink`, not a hardcoded hex, everywhere in §4–§6), so a future `@media (prefers-color-scheme:
dark)` block would only need to redefine the token values, not touch component code — the same structural
approach already used for the `.on-dark` footer context in §3.1.

---

## 9. Unresolved (owner decisions needed — with a proposed default each)

These block a literal, final implementation of specific numbers/assets in §4–§6. Nothing above invents a value
for any of them — placeholders are shown as `{...}` tokens.

1. **D4 — deposit rule (amount or %) and bank details shown to customers.** Directly needed for: the receipt-
   upload step copy (§5.5), the receipt-review "expected amount" line (§5.8). **Proposed default: 20% of the
   package's `estimatedTotal`, shown alongside bank transfer details the owner supplies** — a common photography-
   industry deposit rate, offered only as a starting point for the owner to confirm or override; not used as a
   stated fact anywhere else in this document.
2. **D5 — timing defaults** (hold 48h / reminders 24h+6h / admin SLA 24h / selection window 14 days / preview
   retention 30 days) are already "PROPOSED" in decisions.md, and this document designs against them (§4.9, §5.6,
   §5.8) as parameters, not hardcoded into the component design — if the owner changes any number, only the
   config value changes, not the countdown/queue component itself. **Proposed default: adopt D5's own proposed
   numbers as-is**, since no better source exists yet.
3. **D6 — photo storage (signed URLs, previews-only)** is "PROPOSED"; §5.6/§5.8's gallery and receipt viewers are
   designed assuming it. **Proposed default: adopt D6 as-is.**
4. **D7 — real testimonials, owner-supplied only, from Instagram «لُطفكم».** The testimonial card (§4.3) is built
   and ready but ships **empty** on Home until the owner supplies actual quotes. **Proposed default: leave the
   component out of the live page entirely until content exists**, rather than showing an empty card shape.
5. **Final crop/face check on the 31 AVIF photos** (§0) — I could not visually verify these myself. **Proposed
   default: a one-time admin visual pass before the redesign ships**, confirming no selected crop reveals the
   bride's identifiable face, consistent with the brand's own stated privacy value.
6. **Exact Arabic step-labels for the 8-step journey stepper (§4.8)** and all other Arabic placeholder strings in
   this document are explicitly short placeholders for the copywriter role, not final copy — flagging so the next
   stage doesn't mistake them for approved final text. Also worth relaying to that stage: the inspection report's
   item 17 (existing masculine-form bugs — «حاول», «طلبك», «١ صفحات», «{n} طلبات», «عرايس» vs «عرائس») is copy work
   outside this design document's scope, but should be corrected in the same pass since it directly affects the
   feminine-singular voice requirement.
