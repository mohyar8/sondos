# Sundus Yar — Motion Spec: "Cinematic native" layer + design switch (redo-v2, doc 12)

Status: SPEC, rev. 2 (reconciled with `13-threat-model.md` and the three plan reviews of 2026-09-28; §0 lists every
binding change). Date: 2026-09-28. Author role: motion designer + frontend engineer (UI/UX, RTL, performance,
accessibility); rev. 2 by the lead architect. Nothing in `app/` was modified to write this document.

**Schedule**: the motion units are scheduled in the **combined wave plan of `11-golive-plan.md` §5**, with exclusive
file ownership across both plans. They keep their MOT names here; their combined ids are in §0.3 and §8.2.

**Read first**: `decisions.md` (binding constraints, D1, D12), `03-design-system.md` (§1 palette, §2 type, §3.2
motion), `08-copy-ar.md` (all Arabic strings reused below come from it or from the live site), `10-security-baseline.md`
(SEC-07: the CSP moves from Report-Only to enforced, so every rule below is written to survive an enforced
`script-src 'self' 'sha256-…'` + `style-src 'self'` + `img-src 'self'`).

**Code facts this spec builds on** (read in the repo on 2026-09-28, HEAD `c80f4c2`, which is also the tag
`design-classic-v1`):

| Fact | Where | Consequence for motion |
|---|---|---|
| CSR SPA, `<div id="root">` only; custom History-API router, one `popstate` listener, `handleNavigate` does `pushState` + `setBrowserLocation` | `index.html`, `src/App.tsx` | Page transitions wrap the router's state update; no React Router. |
| Hero photo is the LCP, preloaded by the one inline script in `index.html` (CSP hash in `public/_headers`) | `index.html`, `HeroSection.tsx` | The intro may NOT touch `index.html` (the hash would change) and may NEVER hide the hero `<img>`. |
| Reveal contract: `.reveal` = final visible state; `useReveal` adds `.reveal--armed` only to below-fold elements when motion is allowed, `.is-revealed` on intersection, `--reveal-index` stagger | `styles/motion.css`, `layout/useReveal.ts` | Every scroll effect reuses this contract; `useReveal` stays unchanged. It skips non-`HTMLElement` targets, so an SVG must never carry `.reveal` itself. |
| `base.css` collapses every animation/transition to 0.01 ms under `prefers-reduced-motion: reduce` (with `!important`) | `styles/base.css` | A safety net, not the design: every cinematic from-state is ALSO scoped to `(prefers-reduced-motion: no-preference)`. |
| Placeholder colour set inline (`style={{ backgroundColor }}`, CSSOM, CSP-safe) on `.home-hero__media`, `.home-featured__item`, `.portfolio-tile`, `.packages-banner` | pages | Wipe veils use `background-color: inherit`: the photo "develops" out of its own dominant tone. |
| Logo = raster: `logo-ink-{112,224}.{webp,png}` (296×224 at 224 px), made by `scripts/make-brand-assets.mjs` from `../assets-originals/brand-logo.jpeg` (5000×3245 master) | `data/brand-images.ts` | The intro needs sharper rasters (448/672) generated from the master; no new tool. |
| z-index: header 100, overlay 900 (mobile menu, email-verification gate), dialog 950, skip link 1000, toast 1100 | `styles/tokens.css` | Intro sits at 990: above everything present at load, below the skip link. |
| Header logo = `.site-header__logo` (`block-size: 2.75rem`, 3.5rem from 64rem), sticky header | `SiteHeader.tsx/.css` | The intro's logo lands on this exact box (FLIP). |
| Toolchain: Vite 8.2, TypeScript 6.0, React 19.2, wrangler 4.124 (supports `deploy --tag/--message`, `versions list`, `rollback`), Node 24 (global `WebSocket`), Chrome 154 installed | `node_modules`, machine | Scripts and the audit tool need no new dependency. |

---

## 0. Binding controls (rev. 2)

These changes come from the reviews and win over anything below that still reads otherwise. The sections that
implement them were edited in place; the unit acceptance in §8.2 carries each one.

### 0.1 Release and build integrity

| Id | Sev | Control as adopted | Where |
|---|---|---|---|
| H6 / TM-05 | HIGH | `VITE_SITE_DESIGN` unset or empty → **classic** (not cinematic) until a release pins it. There is **one deploy path** for both plans: `scripts/release.mjs` + `scripts/release-preflight.mjs` (11 §7.0, unit W3-19). `build-design.mjs` only builds and serves (no `--deploy`, no `--allow-dirty`); every `deploy:*` script calls `release.mjs`. "Return to classic" rebuilds the **currently released tag** as classic, or rolls back to the last classic version at or above the launch floor; it never deploys HEAD | §7.1, §7.4, §7.5, MOT-01, MOT-02 |
| TM-14 | MEDIUM | `build.assetsInlineLimit: 0` so no `data:` URI can be emitted; the release preflight also fails on `data:image` in `dist/client`. The cinematic build is checked under the **enforced** CSP on preview: 0 violations across intro, view transitions, ticker and khatam (N-43) | MOT-01, MOT-13 |
| TM-22 | LOW | `motion-audit.mjs` launches Chrome with `--remote-debugging-port=0` on 127.0.0.1 and a temp profile (port read from `DevToolsActivePort`), kills it on exit, never prints `VITE_*` values, keeps the 127.0.0.1-only Fetch interception | MOT-06 |
| M7 | MEDIUM | The classic-parity **hard gate** is the DOM comparison plus the emitted-CSS hashes. Screenshots are compared only after `document.fonts.ready` and every image's `decode()`, with ≤ 0.1% differing pixels; audit builds use a stub Firebase config; the worktree build runs `npm ci` | §7.3, MOT-06 |
| M3 | MEDIUM | Motion and feature units share one schedule with one owner per file per wave (11 §5.5): e.g. `src/App.tsx` is owned by W3-16 (legal routes), then W4-09 (MOT-09), then W5-02 (MOT-10); `vite.config.ts` by W1-16 (MOT-01), then W2-18 (config guard); `package.json` by W1-13, W2-19 (MOT-02), W3-19; `README.md` by W5-04, then W6-05 (MOT-13); `src/pages/home/StorySection.tsx` by W3-18 (MOT-08), then W4-10 (MOT-12) | §8 |
| M5 | MEDIUM | `whenReady()` caches the resolved module and `loadedModule()` returns it synchronously; the router renders `module.default` directly once loaded, so the view-transition snapshot contains the destination H1 on the first visit | §6.1, MOT-05, MOT-09 |
| L5 | LOW | MOT-11 (ticker) is built only after the owner's **written** answer to §9 Q2; until then the unit ships the static band for everyone | §3.9, MOT-11 |

### 0.2 Motion UX and accessibility

| Id | Sev | Control as adopted | Where |
|---|---|---|---|
| UX-01 | HIGH | (a) Repeat visits: a non-personal day number in `localStorage['sy:intro:v1']` skips the intro for **60 days**; the session flag stays; storage failure → skip (fail closed). (b) The visible intro is **≤ 1.8 s** from t0 (no F5 hold, ink ≈ 600 ms, glide 500 ms). (c) After an intro, the hero enters with **one ≤ 400 ms opacity fade** (no E2 veil, no E5 stagger; the photo settle stays). (d) The F0 decode wait is **≤ 200 ms**; the audit reports the `logo-not-ready` rate on Fast 4G. (e) Acceptance: hero H1 and primary CTA at opacity 1 by **t0 + 2.2 s** on 4× CPU + Fast 4G, in addition to the LCP check | §4.4–§4.6, MOT-10, MOT-06 |
| UX-09 | MEDIUM | `--cine-dur-vt-in` 450 ms and `--cine-dur-vt-out` 250 ms; `::view-transition { pointer-events: none }` so taps are not lost; a static pending hairline if the route chunk takes more than 100 ms; the mobile menu closes instantly inside the transition; a page entered through a view transition skips its E5 words and E7 veils (`html[data-cine-entry="vt"]`) | §2, §6, MOT-09 |
| UX-10 | MEDIUM | No mount veils: photo wipes run only through the reveal contract (below-the-fold tiles on first arrival); a portfolio filter change adds **no motion**; no settle on filtered tiles | §3.6, MOT-04 |
| UX-11 | MEDIUM | `focusin` and `click` (capture, on `document`) and any router navigation finish the intro instantly; focus reaching the header logo finishes it too; the jank guard triggers on two consecutive long animation frames over 50 ms; VoiceOver iOS and TalkBack acceptance | §4.6, MOT-10 |
| UX-12 | MEDIUM | Viewfinder corners in `--cine-gold` with a 1 px `--color-ink` hairline (legible on a light bridal hero too); intro khatam at ≥ 0.35 opacity; MOT-12's criterion restated as "≥ 4.5:1 **at rest**, measured against the lightest banner pixel under the scrim" | §3.2, §3.10, MOT-12 |
| UX-17 | LOW | TalkBack/Chrome Android added; VoiceOver iOS gives one swipe stop per heading; resting line breaks with motion on equal classic at 320/375/768 px; `aria-label` dropped if the name from content is verified identical on every tested screen reader | §3.4, MOT-07 |
| UX-18 | LOW | Ticker static on `(pointer: coarse)`; paused while any dialog or the mobile menu is open; the toggle's accessible name switches between «إيقاف الشريط» and «تشغيل الشريط» (no `aria-pressed`) | §3.9, MOT-11 |
| Storage | — | `sy:intro:v1` in `localStorage` (a day number) and `sessionStorage` (`'1'`) is the only storage the motion layer uses; the W1-13 grep gate enforces it | §4.6, A6 |

### 0.3 Unit ids in the combined plan

| MOT | Combined id | Wave | MOT | Combined id | Wave |
|---|---|---|---|---|---|
| MOT-01 | W1-16 | 1 | MOT-08 | W3-18 | 3 |
| MOT-03 | W1-17 | 1 | MOT-09 | W4-09 | 4 |
| MOT-05 | W1-18 | 1 | MOT-12 | W4-10 | 4 |
| MOT-02 | W2-19 | 2 | MOT-10 | W5-02 | 5 |
| MOT-04 | W2-20 | 2 | MOT-11 | W5-03 | 5 |
| MOT-06 | W2-21 | 2 | MOT-13 | W6-05 | 6 |
| MOT-07 | W3-17 | 3 | | | |

---

## 1. The motion concept

**«حبرٌ وضوء» — Ink & Light.** The site moves the way one of Sundus's photographs is made: the viewfinder locks
on, the lens aperture opens, her name is written in ink, and each photo develops out of its own tone instead of
popping in. Gold appears only as thread (the embroidery on the black bisht in the hero photo): a thin khatam
(8-point Islamic star) and a ring that trace themselves once and then rest. Everything starts at the reading edge
(the right, in this RTL site: ink strokes run right to left, veils retreat to the left, the next page is revealed
from the right; only the Latin «SONDOS YAR» wipes left to right, because Latin reads that way), and everything
lands slowly on long, feathered easings. This suits the identity because every element is already brand-owned and
the palette is untouched: the aperture glyph and the calligraphy come from the logo, the corners are a
photographer's viewfinder rather than a tech HUD, the gold is the 10% accent used as a line, and the pace is the
brand's own promise («بأسلوب هادئ وأنيق»). It is cinematic through choreography and restraint, not through
spectacle: nothing bounces, spins, counts up, follows the cursor, hijacks scrolling, or arrives from off-screen
(D12); photos never reveal a face (the veils are colour, not crops); prices never animate.

### 1.1 What was taken from the references, and what was left out

| Reference element | Sundus translation | Decision |
|---|---|---|
| Harrat: skippable logo intro, mark flies to its place | Aperture opens, name written in ink, logo glides into the header (§4) | Kept, ≤ 1.8 s, once per 60 days, skip on any input (UX-01) |
| Harrat: hero photo settle 1.08 → 1 over 2.4 s | Same, on the hero `<img>` | Kept |
| Harrat: staggered rise of hero copy (22 px, 900 ms) | Same distances and duration | Kept |
| Harrat: word-by-word headline (`.words .w > span`), Arabic variant uses opacity + 0.4em, no clipping | Display headings only (El Messiri), Arabic-safe splitter (§3 E5) | Kept, stricter |
| Harrat: image wipe reveals (`::after` scaleX) | Veil in the photo's own placeholder colour (§3 E7) | Kept |
| Harrat: endless ticker with RTL variant | Services ticker WITH a pause button (WCAG 2.2.2) | Kept, made accessible; built only after the owner's written D12 decision, static on phones (L5, UX-18) |
| Harrat: `animation-timeline: view()` | Parallax on photos only (§3 E8) | Kept; reveals stay on IntersectionObserver (works everywhere) |
| Harrat: cross-document View Transitions, diagonal "fracture" clip-path | Same-document `startViewTransition` in the custom router, a softer 8% slant "veil" (§6) | Kept, calmer |
| Harrat: custom easing tokens, complete reduced-motion off-switch | `--cine-*` tokens (§2), every effect has an explicit reduced-motion state | Kept |
| Reel: HUD framing marks | Viewfinder corners (intro + hero photo) | Kept (photographic meaning) |
| Reel: radiating star inside thin circles | Khatam inside gold rings + aperture ring (§5) | Kept |
| Reel: morphing truchet/star patterns | A static interlaced khatam that draws once | Kept without morphing (calm) |
| Reel: wireframe torus | — | **Dropped**: 3D/tech register, off-identity, GPU cost |
| Reel: bold brand reveal | The intro | Kept |

### 1.2 Explicitly out of scope (do not add)

Cursor followers, smooth-scroll libraries/scroll hijacking, WebGL/canvas, Lottie, autoplay video, sound,
per-letter or scrambled text, number count-ups (prices/totals are transactional, §2.3 of the design system),
parallax on text, infinite ambient loops other than the pausable ticker, any motion inside `/admin` or inside the
`/my-bookings` journey content (only the route transition into `/my-bookings`), any change to hover/press/dialog/
lightbox/mobile-menu/FAQ/countdown motion (they stay exactly as `03-design-system.md §3.2` specifies).

---

## 2. Motion tokens

All cinematic tokens live in `src/design/cinematic/tokens.css`, scoped to `:root[data-design="cinematic"]`, so the
classic build neither ships nor resolves them. They alias existing colour tokens; **no new hex** (the
"no hex outside tokens.css" rule holds). Existing `--duration-*` / `--ease-*` tokens stay untouched for classic and
for component micro-interactions.

```css
/* src/design/cinematic/tokens.css — the only place cinematic timing lives */
:root[data-design="cinematic"] {
  /* ---- Durations ---- */
  --cine-dur-tick: 180ms;      /* header-logo hand-off, small state flips */
  --cine-dur-exit: 300ms;      /* things leaving (intro decorations) */
  --cine-dur-vt-out: 250ms;    /* outgoing page dims under the incoming one (UX-09) */
  --cine-dur-fade: 400ms;      /* intro veil dissolve; single hero fade after an intro (UX-01) */
  --cine-dur-glide: 500ms;     /* logo FLIP to the header, viewfinder lock (UX-01) */
  --cine-dur-vt-in: 450ms;     /* incoming page veil (UX-09; was 750ms) */
  --cine-dur-word: 800ms;      /* one word of a display heading */
  --cine-dur-rise: 900ms;      /* copy blocks, section reveals */
  --cine-dur-wipe: 1100ms;     /* photo veils */
  --cine-dur-draw: 1600ms;     /* khatam stroke draw, whole figure */
  --cine-dur-settle: 2400ms;   /* hero photo settle */
  --cine-dur-ticker: 60s;      /* one full ticker cycle (≈ 28 px/s for the current copy) */

  /* ---- Easings ---- */
  --cine-ease-settle: cubic-bezier(0.16, 1, 0.3, 1);   /* fast start, long feathered landing (= --ease-premium) */
  --cine-ease-rise: cubic-bezier(0.22, 1, 0.36, 1);    /* quint-out, for text */
  --cine-ease-glide: cubic-bezier(0.65, 0, 0.25, 1);   /* in-out for wipes, FLIP, page veil (softer than Harrat's .7,0,.2,1) */
  --cine-ease-exit: cubic-bezier(0.4, 0, 1, 1);        /* accelerate away (= --ease-accelerate) */
  --cine-ease-ink: linear;                             /* constant brush speed inside one stroke */

  /* ---- Stagger ---- */
  --cine-stagger-word: 70ms;   /* per word; JS caps the index at 12 */
  --cine-stagger-item: 90ms;   /* per sibling block (reveal contract; useReveal caps --reveal-index at 4) */
  --cine-stagger-tile: 120ms;  /* per photo tile */

  /* ---- Distances and scales ---- */
  --cine-rise: 22px;
  --cine-word-rise: 0.4em;           /* em: scales with the heading size */
  --cine-settle-from: 1.08;          /* hero photo */
  --cine-tile-settle-from: 1.05;     /* portfolio tiles */
  --cine-parallax-shift: 4%;         /* ± within an overscan of 1.10 (5% per side) */
  --cine-parallax-overscan: 1.1;
  --cine-exit-shift: 6%;             /* hero/banner drift while leaving the viewport */
  --cine-exit-overscan: 1.12;        /* grows with the drift so no edge ever shows */
  --cine-lock-from: 1.06;            /* viewfinder corners converge from here */
  --cine-vt-slant: 8%;               /* page-veil edge slant */

  /* ---- Hero choreography (relative to release, §3 E2–E5) ---- */
  --cine-hero-eyebrow-delay: 100ms;
  --cine-hero-words-delay: 200ms;
  --cine-hero-lead-delay: 650ms;
  --cine-hero-actions-delay: 800ms;
  --cine-hero-corners-delay: 900ms;

  /* ---- Colour roles (aliases only) ---- */
  --cine-gold: var(--color-accent);             /* lines on paper/surface */
  --cine-gold-on-dark: var(--color-accent-soft);/* lines on ink or on dark photos */
  --cine-intro-bg: var(--color-paper);

  /* ---- Layer ---- */
  --z-intro: 990;   /* above header/overlay/dialog present at load, below the skip link (1000) */
}
```

**Token rules**

1. Only compositor properties are animated in page content: `opacity`, `transform`, and the individual
   `translate` / `scale` properties. Exceptions, each bounded: `stroke-dashoffset` (SVG ≤ 10rem, or the intro logo
   ≤ 11rem tall), SVG mask children (intro only, ≤ 1.4 s once), `clip-path` on `::view-transition-new(root)` only
   (a static snapshot). Never animated: width/height/inset/margin/padding/font-size/letter-spacing/`filter`/
   `backdrop-filter`/`background-color`/`background-position`/`box-shadow`.
2. Settle and parallax must sit on **different elements** (settle on `<img>` via `scale`, parallax on the parent
   `<picture>` via `translate`+`scale`), because two animations on the same property replace each other.
3. Custom properties that carry numbers into CSS (`--wi`) are set from integers in JS through React's `style`
   prop (CSSOM; allowed by `style-src 'self'`). Never `setAttribute('style', …)`, never a string built from data.
4. `will-change` only while an animation runs (intro stage during the glide) and removed afterwards.

---

## 3. Effects catalogue

Every selector below is prefixed `:root[data-design="cinematic"]` (written `:cine` in this section for brevity).
That prefix (a) makes the classic build inert even if a file leaked in, and (b) gives cinematic rules
specificity ≥ (0,3,0), so they win regardless of the order Vite concatenates CSS in.

### 3.0 Matrix

| # | Effect | Where | Trigger | Animated properties | Reduced motion | Owner unit |
|---|---|---|---|---|---|---|
| E1 | Logo intro | `/` first arrival, at most once per 60 days | load | opacity, transform, SVG mask (bounded) | never plays | MOT-10 |
| E2 | Hero photo veil + settle | Home hero | load / intro exit | `::after` transform, `<img>` scale | static photo, no veil | MOT-04 |
| E3 | Viewfinder corners | hero photo (+ intro) | load | opacity, scale | corners shown static | MOT-04 |
| E4 | Hero copy rise | eyebrow, lead, actions | load | opacity, translate | static | MOT-04 |
| E5 | Display-heading words | hero H1, portfolio H1, packages H1 (load); story H2, contact H2 (reveal) | load / reveal | opacity, translate per word | plain inline text | MOT-07, MOT-12 |
| E6 | Section reveal (tuned) | every `.reveal` | IntersectionObserver | opacity, translate | static (existing contract) | MOT-04 |
| E7 | Photo wipes + tile settle | featured strip, below-the-fold portfolio tiles | reveal only (no mount veils; a filter change adds no motion) | `::after` transform, `<img>` scale | no veil | MOT-04 |
| E8 | Scroll-driven parallax | hero, featured tiles, packages banner | scroll (CSS timeline) | `<picture>` translate + scale | off | MOT-04 |
| E9 | Packages banner settle + lead rise | `/packages` banner | load | `<img>` scale, opacity/translate | static | MOT-04 |
| E10 | Services ticker (only after the owner's written decision, §9 Q2) | Home, between hero and story | continuous, pausable; static on coarse pointers | `translate` | static wrapped line, no button | MOT-11 |
| E11 | Gold khatam | story mark, contact emblem (draw); ticker glyph, intro backdrop (static) | reveal | `stroke-dashoffset`, opacity | fully drawn, static | MOT-08, MOT-12 |
| E12 | Page transitions | public routes, path changes without `#hash` | navigation | VT snapshots: opacity, clip-path | instant swap | MOT-09 |

### 3.1 E2 — Hero photo: veil + settle

- **Where**: `.home-hero__media` (frame) and `.home-hero__image` (the LCP `<img>`).
- **Behaviour**: a veil in the photo's dominant colour (`background-color: inherit` from the inline placeholder;
  near-black for `bouquet-bisht`) covers the frame and retreats toward the inline end (left), so the photo is
  exposed from the reading edge (right) like a print developing; underneath, the photo settles from 1.08 to 1.
  The classic `hero-zoom` (1 → 1.05 over 8 s) is replaced, not stacked.
- **Timing** (relative to release `h0`): veil 0 → 1100 ms `--cine-ease-glide`; settle 0 → 2400 ms
  `--cine-ease-settle`. `h0` = first frame on a normal load, or the intro's exit start (§4).
- **CSS**:
  ```css
  @media (prefers-reduced-motion: no-preference) {
    :cine .home-hero__image { animation: cine-settle var(--cine-dur-settle) var(--cine-ease-settle) both; }
    :cine .home-hero__media::after {
      content: ""; position: absolute; z-index: 1; inset: 0; pointer-events: none;
      background-color: inherit;          /* the photo's placeholder tone */
      transform-origin: left center;      /* = inline-end in this RTL-only document */
      animation: cine-veil-out var(--cine-dur-wipe) var(--cine-ease-glide) both;
    }
    /* Hold while the intro plays (§4.5) — pseudo-elements cannot go inside :is() */
    :cine[data-cine-intro="playing"] :is(.home-hero__image, .home-hero__content > *, .home-hero__title .cine-w),
    :cine[data-cine-intro="playing"] .home-hero__media::before,
    :cine[data-cine-intro="playing"] .home-hero__media::after { animation-play-state: paused; }
  }
  @keyframes cine-settle   { from { scale: var(--cine-settle-from); } to { scale: 1; } }
  @keyframes cine-veil-out { from { transform: scaleX(1); } to { transform: scaleX(0); } }
  ```
  (`:cine` stands for `:root[data-design="cinematic"]`; in `:cine[data-cine-intro]` both attributes sit on `:root`.)
- **LCP**: the `<img>` is never `opacity:0`, `visibility:hidden`, `display:none`, clipped or inside
  `content-visibility`; it is painted on the first frame beneath the veil (and beneath the intro). LCP does not
  account for occlusion, so the LCP timestamp is the image's own paint. Verified by acceptance A4 (LCP element =
  `img.home-hero__image`, LCP within +100 ms of classic).
- **Reduced motion**: no `::after` box at all (declared only inside `no-preference`), no settle: the photo is
  simply there.
- **Entry variants (rev. 2, UX-01/UX-09)**: `html[data-cine-entry]` records how the current page was entered and
  persists until the next navigation (so removing it never restarts an animation). `"intro"` (set by `LogoIntro` at
  module evaluation, together with `data-cine-intro="playing"`): no veil and no word stagger; `.home-hero__content`
  fades in once (`opacity`, `--cine-dur-fade` = 400 ms, from F6) and the photo settle stays. `"vt"` (set by
  `page-transition` before `startViewTransition`): no veil, no E5 words, no E7 veils; the page veil is the one
  motion. Absent (a plain load without intro): E2–E5 as specified here. The overriding rules live in `intro.css` and
  `transitions.css` with higher specificity (`animation: none` / the single fade).
- **RTL**: veil origin physical `left` because the document is RTL-only (`<html dir="rtl">`). If an LTR context is
  ever added, override with `:dir(ltr)` → `transform-origin: right center`.
- **Performance**: `transform` on a pseudo-element and `scale` on the image are composited; zero layout.
- **Without JS / failure**: CSS-only; if the intro controller dies while holding, the boot-time failsafe timer
  releases the hold (§4.6).

### 3.2 E3 — Viewfinder corners

- **Where**: `.home-hero__media::before` (and, in the intro, around the logo — §4).
- **Rev. 2 (UX-12)**: the arms are drawn in `--cine-gold` (accent, not accent-soft) and each arm is doubled by a
  1 px `--color-ink` hairline on its inner side (two more gradients per arm in the same `background` list), so the
  marks stay visible on a dark photo and on a light bridal hero alike. The `--cine-gold-on-dark` values in the CSS
  below are replaced accordingly.
- **Behaviour**: four thin gold L-marks inset from the photo frame's corners — a photographer's framing marks.
  They lock on (opacity 0 → 0.9, `scale` 1.06 → 1) after the veil has mostly passed, then rest permanently.
- **Timing**: delay `--cine-hero-corners-delay` (900 ms), 700 ms, `--cine-ease-settle`.
- **CSS** (static final state for everyone; animation only with motion):
  ```css
  :cine .home-hero__media::before {
    content: ""; position: absolute; z-index: 2; pointer-events: none;
    inset: clamp(0.625rem, 2.5vw, 1rem);
    --cine-vf-arm: clamp(1rem, 4vw, 1.5rem);
    --cine-vf-line: 1.5px;
    background:
      linear-gradient(var(--cine-gold-on-dark) 0 0) left top / var(--cine-vf-arm) var(--cine-vf-line) no-repeat,
      linear-gradient(var(--cine-gold-on-dark) 0 0) left top / var(--cine-vf-line) var(--cine-vf-arm) no-repeat,
      linear-gradient(var(--cine-gold-on-dark) 0 0) right top / var(--cine-vf-arm) var(--cine-vf-line) no-repeat,
      linear-gradient(var(--cine-gold-on-dark) 0 0) right top / var(--cine-vf-line) var(--cine-vf-arm) no-repeat,
      linear-gradient(var(--cine-gold-on-dark) 0 0) left bottom / var(--cine-vf-arm) var(--cine-vf-line) no-repeat,
      linear-gradient(var(--cine-gold-on-dark) 0 0) left bottom / var(--cine-vf-line) var(--cine-vf-arm) no-repeat,
      linear-gradient(var(--cine-gold-on-dark) 0 0) right bottom / var(--cine-vf-arm) var(--cine-vf-line) no-repeat,
      linear-gradient(var(--cine-gold-on-dark) 0 0) right bottom / var(--cine-vf-line) var(--cine-vf-arm) no-repeat;
    opacity: 0.9;
  }
  @media (prefers-reduced-motion: no-preference) {
    :cine .home-hero__media::before {
      animation: cine-lock var(--cine-dur-glide) var(--cine-ease-settle) var(--cine-hero-corners-delay) both;
    }
  }
  @keyframes cine-lock { from { opacity: 0; scale: var(--cine-lock-from); } to { opacity: 0.9; scale: 1; } }
  ```
- **Contrast**: decorative (no information), exempt from 3:1; rev. 2 uses gold + ink hairline so the marks read on
  both dark and light photos (UX-12: accent-soft is only 2.14:1 on paper and would vanish on a light hero).
- **RTL**: symmetric. **Perf**: one pseudo-element, painted once, composited scale/opacity.

### 3.3 E4 — Hero copy rise

- **Where**: `.home-hero__content > .eyebrow`, `.home-hero__lead`, `.home-hero__actions`.
- **Behaviour**: opacity 0 → 1 and `translate` 22 px → 0, `--cine-ease-rise`, 900 ms.
- **Timing**: eyebrow +100 ms, lead +650 ms, actions +800 ms (the headline words run in between, E5).
  Everything readable by h0 + 1.5 s; photo settled by h0 + 2.4 s.
- **CSS**: `@keyframes cine-rise { from { opacity: 0; translate: 0 var(--cine-rise); } to { opacity: 1; translate: 0 0; } }`
  applied with `animation: cine-rise var(--cine-dur-rise) var(--cine-ease-rise) <delay> both`.
- **Reduced motion**: nothing (static). **Keyboard**: the buttons are focusable from the first frame; a focus ring
  on a still-rising button is acceptable (≤ 1.7 s window) and never hidden (opacity reaches 1 before the
  delay+duration ends).

### 3.4 E5 — Display-heading word reveal (Arabic-safe)

- **Where**: only El Messiri display headings: hero H1 «يومكِ لكِ وحدكِ، وصوركِ لا تُنشر إلا بإذنكِ» (load,
  d0 = 200 ms), portfolio H1 «من أعمالنا» (load, d0 = 120 ms), packages H1 «اختاري باقتكِ وتفاصيل يومكِ» (load,
  d0 = 120 ms), story H2 «أنا سندس» (reveal), contact H2 «جاهزة لتوثيق يومكِ؟» (reveal). Section H2s in Cairo keep
  the plain rise (E6) — word reveal is reserved for display moments.
- **Component**: `@site-design/DisplayHeading` with props `{ level: 1 | 2; id: string; className: string;
  text: string; trigger: 'load' | 'reveal' }`. Classic renders exactly `<h1 id className>{text}</h1>` (prop order
  `id`, `className` = today's attribute order). Cinematic renders:
  ```tsx
  <h1 id={id} className={`${className} cine-words`} data-cine-trigger={trigger} aria-label={text}>
    {words.map((word, index) => (
      <Fragment key={index}>
        {index > 0 && ' '}
        <span className="cine-w" style={wordStyle(index)}>{word}</span>
      </Fragment>
    ))}
  </h1>
  // type WordStyle = CSSProperties & Record<'--wi', number>
  // function wordStyle(i: number): WordStyle { return { '--wi': Math.min(i, 12) } }   // no cast needed
  ```
- **Arabic safety rules (binding)**:
  1. Split ONLY on ASCII whitespace `/[ \t\n\r]+/` after `trim()`. Never on U+00A0 (NBSP is intentional), never on
     ZWNJ/ZWJ, never inside a word, never per letter. Punctuation («،» «؟» «»») stays attached to its word.
  2. The real spaces stay as text nodes between spans (copy/paste, line breaking and `text-wrap: balance` work as
     today).
  3. If `text` contains `[A-Za-z0-9]`, or fewer than 2 words, render plain text (no spans): atomic inlines are bidi
     neutrals, and a run of Latin words split into inline-blocks would be re-ordered right-to-left.
  4. `text` is a plain string prop (no JSX children), so `aria-label` always equals the visible text and nothing
     can be injected.
  5. No `overflow: hidden`/clip mask on Arabic lines (diacritics such as the kasra in «يومكِ» and the damma in
     «تُنشر» overflow the line box), no letter-spacing, `translate` in `em`.
- **CSS** (`src/design/cinematic/words.css`):
  ```css
  :cine .cine-w { display: inline; }                         /* reduced motion: identical to plain text */
  @media (prefers-reduced-motion: no-preference) {
    :cine .cine-words .cine-w { display: inline-block; }
    :cine .cine-words[data-cine-trigger="load"] .cine-w {
      animation: cine-word var(--cine-dur-word) var(--cine-ease-rise) both;
      animation-delay: calc(var(--cine-words-d0, 120ms) + var(--wi, 0) * var(--cine-stagger-word));
    }
    :cine .reveal--armed .cine-words[data-cine-trigger="reveal"] .cine-w { opacity: 0; translate: 0 var(--cine-word-rise); }
    :cine .reveal--armed.is-revealed .cine-words[data-cine-trigger="reveal"] .cine-w {
      opacity: 1; translate: 0 0;
      transition: opacity var(--cine-dur-word) var(--cine-ease-rise), translate var(--cine-dur-word) var(--cine-ease-rise);
      transition-delay: calc(var(--wi, 0) * var(--cine-stagger-word));
    }
  }
  @keyframes cine-word { from { opacity: 0; translate: 0 var(--cine-word-rise); } to { opacity: 1; translate: 0 0; } }
  ```
  Hero sets `--cine-words-d0: var(--cine-hero-words-delay)` on `.home-hero__title` (in `hero.css`).
- **Screen readers**: the heading's accessible name is `aria-label` (read once); the spans are presentational.
  Acceptance includes NVDA, VoiceOver (iOS) and TalkBack (Chrome Android) reading each heading once, with one swipe
  stop per heading, not per word (UX-17). If the name computed from content is verified identical on all three,
  `aria-label` is dropped (some translation and reader tools ignore it).
- **Suppressed** under `html[data-cine-entry="intro"]` and `html[data-cine-entry="vt"]` (see E2): one motion per
  moment (UX-01, UX-09).
- **Resting layout**: with motion on, the words rest as `inline-block`; line breaks at 320/375/768 px must equal the
  classic heading's (UX-17), otherwise the words fall back to `display: inline` at rest.
- **Reduced motion**: spans are `display: inline` → pixel-identical to classic (acceptance: identical line breaks,
  ≤ 0.5% differing pixels in the heading box).
- **Perf**: ≤ 8 composited words at a time; 70 ms stagger; last hero word ends at h0 + 1.49 s.
- **Failure**: spans are ordinary text; a CSS/JS failure leaves a readable heading.

### 3.5 E6 — Section reveal (existing contract, cinematic tuning)

- **Where**: every `.reveal` (section headings, cards, steps, trust badges, FAQ list, contact blocks).
- **Behaviour**: same contract as classic; cinematic lengthens the rise to 22 px / 900 ms / `--cine-ease-rise` and
  the sibling stagger to 90 ms (`--reveal-index` 0–4 from `useReveal`, unchanged).
- **CSS** (`scroll.css`, specificity (0,4,0) beats classic (0,2,0); the revealed rule follows the armed rule):
  ```css
  @media (prefers-reduced-motion: no-preference) {
    :cine .reveal.reveal--armed {
      transform: none; translate: 0 var(--cine-rise);
      transition: opacity var(--cine-dur-rise) var(--cine-ease-rise), translate var(--cine-dur-rise) var(--cine-ease-rise);
      transition-delay: calc(var(--reveal-index, 0) * var(--cine-stagger-item));
    }
    :cine .reveal--armed.is-revealed { translate: 0 0; }
  }
  ```
- **Reduced motion / failure**: unchanged classic guarantees (`.reveal` is the visible state; never armed).
- **Print**: `@media print { :cine .reveal.reveal--armed { opacity: 1; translate: 0 0; } }` (plus the existing
  per-page print rules).

### 3.6 E7 — Photo wipes (featured strip, portfolio tiles) + tile settle

- **Where**: `.home-featured__item::after` (3 tiles; `.reveal` sits on the `ul`), `.portfolio-tile::after` (32
  tiles; `.reveal` sits on each `li`).
- **Behaviour**: when armed, each tile is covered by a veil in its own placeholder colour; on reveal the veil
  retreats toward the left (1100 ms, `--cine-ease-glide`), staggered 120 ms; portfolio images also settle from
  1.05 → 1 over 1400 ms with the same delay. The strip/tile container itself does not fade (the veil does the
  work). **Rev. 2 (UX-10)**: there are **no mount veils**. Tiles above the fold (never armed) are plain photos on
  arrival; a category filter change adds **no motion** (new tiles in view appear at once, below-the-fold ones reveal
  through the contract if `useReveal` arms them); a page entered through a view transition plays no tile veil
  (`data-cine-entry="vt"`). A bride filtering quickly never sees colour blocks over the photos.
- **CSS sketch** (`scroll.css`):
  ```css
  @media (prefers-reduced-motion: no-preference) {
    :cine :is(.home-featured__item, .portfolio-tile)::after {
      content: ""; position: absolute; z-index: 1; inset: 0; pointer-events: none;
      background-color: inherit; transform-origin: left center; transform: scaleX(0);
    }
    :cine .home-featured__list.reveal--armed { opacity: 1; translate: 0 0; }          /* after the E6 rules */
    :cine .home-featured__list.reveal--armed .home-featured__item::after { transform: scaleX(1); }
    :cine .home-featured__list.reveal--armed.is-revealed .home-featured__item::after {
      transform: scaleX(0); transition: transform var(--cine-dur-wipe) var(--cine-ease-glide);
    }
    :cine .home-featured__list.is-revealed .home-featured__item:nth-child(2)::after { transition-delay: var(--cine-stagger-tile); }
    :cine .home-featured__list.is-revealed .home-featured__item:nth-child(3)::after { transition-delay: calc(2 * var(--cine-stagger-tile)); }

    :cine .portfolio-grid__item.reveal--armed { opacity: 1; translate: 0 0; }
    :cine .portfolio-grid__item.reveal--armed .portfolio-tile::after { transform: scaleX(1); }
    :cine .portfolio-grid__item.reveal--armed.is-revealed .portfolio-tile::after {
      transform: scaleX(0);
      transition: transform var(--cine-dur-wipe) var(--cine-ease-glide) calc(var(--reveal-index, 0) * var(--cine-stagger-tile));
    }
    :cine .portfolio-grid__item.reveal--armed.is-revealed .portfolio-tile__image {
      animation: cine-settle-tile 1400ms var(--cine-ease-settle) calc(var(--reveal-index, 0) * var(--cine-stagger-tile)) both;
    }
    /* rev. 2 (UX-10): no rule for :not(.reveal--armed) tiles — unarmed tiles never get a veil */
    :cine[data-cine-entry="vt"] :is(.home-featured__item, .portfolio-tile)::after { transform: scaleX(0); transition: none; }
  }
  @keyframes cine-settle-tile { from { scale: var(--cine-tile-settle-from); } to { scale: 1; } }
  ```
  Because unarmed tiles have no veil at all, no animation is created and cancelled on mount (the rev. 1 flash
  argument no longer applies).
- **Hover**: the existing hover `transform: scale(1.04)` on tile images composes with the `scale` settle (different
  properties). The veil is `pointer-events: none`, so tiles stay clickable during the wipe.
- **Privacy**: veils are solid colour, never a crop; no face is revealed by motion.
- **Reduced motion / failure**: no pseudo-element box; tiles are plain photos (classic).

### 3.7 E8 — Scroll-driven parallax

- **Where**: `<picture>` inside `.home-hero__media`, `.home-featured__item`, `.packages-banner`.
- **Behaviour**: featured tiles drift −4% → +4% while crossing the viewport (overscan 1.10, so no edge ever shows);
  hero and banner are framed at rest (scale 1, no drift) and, only while leaving the viewport, drift down 6% and
  grow to 1.12. Photos only — never text, never the header.
- **CSS** (`scroll.css`):
  ```css
  @supports (animation-timeline: view()) {
    @media (prefers-reduced-motion: no-preference) {
      :cine :is(.home-hero__media, .home-featured__item, .packages-banner) > picture { position: absolute; inset: 0; display: block; }
      :cine .packages-banner > picture { z-index: -2; }                 /* keeps the ink scrim (::after, z -1) above */
      :cine .home-featured__item > picture {
        animation: cine-parallax linear both;                          /* shorthand FIRST: it resets animation-timeline */
        animation-timeline: view(block);
        animation-range: cover 0% cover 100%;
      }
      :cine :is(.home-hero__media, .packages-banner) > picture {
        animation: cine-parallax-exit linear both;
        animation-timeline: view(block);
        animation-range: exit 0% exit 100%;
      }
    }
  }
  @keyframes cine-parallax {
    from { translate: 0 calc(var(--cine-parallax-shift) * -1); scale: var(--cine-parallax-overscan); }
    to   { translate: 0 var(--cine-parallax-shift);            scale: var(--cine-parallax-overscan); }
  }
  @keyframes cine-parallax-exit {
    from { translate: 0 0; scale: 1; }
    to   { translate: 0 var(--cine-exit-shift); scale: var(--cine-exit-overscan); }
  }
  ```
- **Perf**: runs on the compositor (Chrome, Safari 26); zero scroll listeners; zero main-thread cost.
- **Support**: Firefox (no scroll-driven animations by default) and older browsers get static photos. On phones
  the featured tiles sit inside a horizontal scroller, so their `view(block)` timeline is inactive → static (fine).
- **CLS**: frames have fixed `aspect-ratio`/`block-size`; making `<picture>` absolute does not change their size.
- **Reduced motion / failure**: no animation, `<picture>` stays as in classic.

### 3.8 E9 — Packages banner (load)

- **Where**: `/packages` banner (the route's LCP image, text on an ink scrim).
- **Behaviour**: `.packages-banner__image` settles 1.06 → 1 (2400 ms); H1 words (E5, d0 = 120 ms); the lead
  `.packages-banner__text` rises at +500 ms. **No veil** here: the banner's `::after` is already the contrast scrim,
  and the text must stay legible on top from the first frame.
- **Reduced motion**: static.

### 3.9 E10 — Services ticker

- **Gate (rev. 2, L5)**: MOT-11 builds the moving ticker only after the owner answers §9 Q2 in writing ("keep the
  ticker"). Until then, or if she chooses the static band, cinematic renders the reduced-motion band for everyone.
- **Phones and overlays (rev. 2, UX-18)**: on `(pointer: coarse)` the band is static like reduced motion (no
  continuous motion on phones, no stored pause state); the track also pauses while any `dialog[open]` or the open
  mobile menu exists (`:cine:has(dialog[open], <mobile-menu open selector>) .cine-ticker__track { animation-play-state:
  paused }`, the selector taken from `MobileMenu.tsx`); the toggle's accessible name switches between «إيقاف الشريط» and
  «تشغيل الشريط» to match its icon, with no `aria-pressed` (this replaces the static name in the markup below).
- **Where**: Home, a thin band between the hero and the story section (`<ServicesTicker />` in `HomePage.tsx`;
  classic renders `null`).
- **Content** (verified, already on the site — no new claims): «تصوير عرائس في المدينة المنورة» · «تغطية يوم العروس» ·
  «ألبومات ومطبوعات» · «مجلات تصوير» · «التفاصيل» · «الأيادي والخواتم» · «لحظات من اليوم» ·
  «جميع الصور تُنشر بموافقة العروس». Separator: the khatam glyph (E11), gold, `aria-hidden`.
- **Markup**:
  ```tsx
  <div className="cine-ticker" data-paused={paused}>               {/* not a landmark */}
    <div className="cine-ticker__viewport" aria-hidden="true">
      <div className="cine-ticker__track">
        <ul className="cine-ticker__list">{items}</ul>
        <ul className="cine-ticker__list cine-ticker__list--clone">{items}</ul>
      </div>
    </div>
    <button type="button" className="cine-ticker__toggle" onClick={toggle}>
      <PauseOrPlayIcon />                       {/* shape changes: two bars / triangle — never colour only */}
      <span className="visually-hidden">{paused ? 'تشغيل الشريط' : 'إيقاف الشريط'}</span>   {/* rev. 2: name matches the icon */}
    </button>
  </div>
  ```
  The whole moving text is `aria-hidden` (it repeats content that exists on the page); the only focusable element
  is the button, outside the hidden subtree. New strings «إيقاف الشريط» / «تشغيل الشريط» → copywriter review (noun
  form, like «تخطي إلى المحتوى»).
- **Motion**: the track (two identical copies, each ending with a trailing gap equal to the item gap) moves
  `translate: 0 → 50%` — i.e. **rightwards**, so in RTL the next phrase enters from the reading end (left);
  `linear`, `--cine-dur-ticker` (60 s), infinite.
- **Pause rules (WCAG 2.2.2)**: the button (persists for the page view, not stored); `:hover` on pointer devices;
  off-screen (one IntersectionObserver sets `data-offscreen` directly on the element; disconnected on unmount);
  hidden tab (browsers throttle).
- **CSS essentials**: band `overflow: hidden; contain: layout paint`; `white-space: nowrap` per item; El Messiri
  600, `--text-heading-md`, `--color-ink-muted` on paper (7.15:1); edge fades via `::before/::after` paper→transparent
  gradients (static); fixed block size (no CLS); 44 px toggle at the inline end with a visible focus ring.
  ```css
  @media (prefers-reduced-motion: no-preference) and (pointer: fine) {          /* rev. 2: phones get the static band */
    :cine .cine-ticker__track { animation: cine-ticker var(--cine-dur-ticker) linear infinite; }
    :cine .cine-ticker:is([data-paused="true"], [data-offscreen="true"]) .cine-ticker__track { animation-play-state: paused; }
    :cine:has(dialog[open]) .cine-ticker__track { animation-play-state: paused; }   /* + the open mobile-menu selector */
    @media (hover: hover) { :cine .cine-ticker:hover .cine-ticker__track { animation-play-state: paused; } }
  }
  @media (prefers-reduced-motion: reduce), (pointer: coarse) {
    :cine .cine-ticker__list--clone, :cine .cine-ticker__toggle { display: none; }
    :cine .cine-ticker__list { flex-wrap: wrap; justify-content: center; row-gap: var(--space-2xs); }
    :cine .cine-ticker__track { inline-size: auto; }
  }
  @keyframes cine-ticker { to { translate: 50% 0; } }
  ```
- **D12 note**: the ticker is the one continuous, ambient motion; phrases do cross the viewport edge. It is slow,
  pausable, static under reduced motion and on phones, and never carries information found only there. The owner's
  written confirmation (§9 Q2) is a precondition of MOT-11; until then the static band ships for everyone (L5).
- **Print**: one copy, wrapped, no button.

### 3.10 E11 — Gold khatam ornament

Full construction in §5. Placements:

| Placement | Size / stroke | Colour | Motion |
|---|---|---|---|
| Story label «سندس يار» (the one «أنا» moment) — before the label | `mark` 3.5rem, stroke 2.2 units | `--cine-gold` | draws on reveal, 1.6 s |
| Contact band, inline-end, behind the actions | `emblem` clamp(7rem, 22vw, 10rem), stroke 1 unit, opacity 0.45 | `--cine-gold-on-dark` | draws on reveal |
| Ticker separators | `glyph` 0.7em, filled star, no ring | `--cine-gold` | static |
| Intro backdrop | min(78vmin, 30rem), stroke 0.3 unit, opacity target **0.35** (rev. 2, UX-12: 0.2 was invisible at phone brightness) | `--cine-gold` | fade + scale 0.94 → 1 (no draw: a large stroke repaint is too costly on mid Android) |

The draw uses the reveal contract on an **HTML wrapper** `<span class="cine-khatam-frame reveal">` because
`useReveal` ignores SVG elements (they are not `HTMLElement`). Decorative: `aria-hidden="true"`, `focusable="false"`.

### 3.11 E12 — Page transitions

See §6.

---

## 4. Logo intro storyboard (E1)

### 4.1 Decision: reveal the raster through an animated SVG mask — do not vectorise now

**Decision**: keep the owner's calligraphy as pixels and reveal it through an SVG `<mask>` whose contents are
animated (a circular iris for the aperture, four wide "brush" strokes following the writing order, a left-to-right
bar for the Latin lock-up, and a final full-coverage fill). Only geometric decorations (rings, khatam, viewfinder)
are vector.

**Why**:
1. **Fidelity and ownership**: the calligraphy is the brand. Auto-tracing (potrace-style) rounds the qalam's
   tapered terminals and the aperture's arc segments; a hand-traced vector is a new brand asset that the owner must
   approve and that no one on this project can produce to calligrapher standard. The raster comes straight from the
   5000×3245 master through the existing, deterministic `make-brand-assets.mjs`.
2. **No new tool or dependency**: tracing needs a new tool; the mask needs nothing.
3. **The effect reads the same**: a wide round-capped brush moving along the letters' path in writing order
   reveals ink exactly where a pen would have passed. True stroke-order animation of a vector centreline is the only
   thing lost; it is listed as a future upgrade (open question 6).
4. **Cost is bounded**: the masked area is ≤ 11rem tall (≤ 528 device px at DPR 3), animated for ≤ 1.4 s once per
   session, and a jank guard (§4.6) ends it early on a struggling device.
5. **CSP-clean**: same-origin `<image href>` (img-src 'self'), no `data:` URI (blocked by img-src), no inline style
   or script, mask referenced by a static fragment id.

### 4.2 Assets (MOT-03)

`scripts/make-brand-assets.mjs` gains an `INTRO_LOGO_HEIGHTS = [448, 672]` pass that writes
`public/images/brand/logo-ink-448.webp` and `logo-ink-672.webp` (same trim + ink recolour + transparent background as
the existing logos, WebP quality 90, deterministic). Existing outputs must stay byte-identical. Budget: 448 ≤ 25 KB,
672 ≤ 40 KB. `brand-images.ts` gains `brandIntroLogo = { alt, width: 296, height: 224, webp448, webp672 }`
(no PNG: every browser that runs the intro decodes WebP).

Chosen at module evaluation, without layout: stage height `H = clamp(120, 0.24 × min(innerWidth, innerHeight), 176)`
CSS px; use 448 if `H × devicePixelRatio ≤ 448`, else 672.

### 4.3 Geometry of the logo (measured on `logo-ink-224.png`, viewBox `0 0 296 224`)

| Part | Bounding box (x, y) | Notes |
|---|---|---|
| Aperture glyph | 118–173, 4–60; centre ≈ (145.5, 32), r ≈ 28 | a separate component |
| Small top-right stroke (damma) | 262–279, 0–34 | separate component |
| Calligraphy body «سندس» | 0–295, 18–173 | one connected component |
| «SONDOS YAR» | 13–258, 179–206 | Latin, reads LTR |
| «PHOTOGRAPHY» | 57–209, 212–223 | Latin |

Mask content (`<mask id="cine-intro-mask" maskUnits="userSpaceOnUse" x="-8" y="-8" width="312" height="240">`,
`mask-type: alpha`, all shapes white; every stroke `fill="none" stroke-linecap="round" stroke-linejoin="round"
pathLength="1"`, base `stroke-dasharray: 1; stroke-dashoffset: 1.01` — 1.01, not 1, so no round-cap dot shows
before a stroke starts):

| id | Shape | Stroke width | Covers |
|---|---|---|---|
| `iris` | `<circle cx="145.5" cy="32" r="30"/>`, `transform: scale(0→1)`, `transform-box: fill-box; transform-origin: center` | fill | aperture (nearest body pixel is ≥ 32.5 from the centre) |
| `ink-1` | `M284 4 L286 58 L244 58 L244 30` | 50 | damma, the first س's vertical and head |
| `ink-2` | `M236 62 C222 92 206 128 170 134 L96 134` | 42 | the descent and the baseline |
| `ink-3` | `M172 118 L164 60 L146 112 L128 58 L112 110 L96 60` | 34 | the teeth of ن / د, right to left |
| `ink-4` | `M70 72 L66 150 C60 172 20 172 8 140 C2 110 6 80 26 46` | 30 | the last tooth and the final س bowl |
| `latin` | `<rect x="0" y="176" width="296" height="48"/>`, `transform: scaleX(0→1)`, origin **left** | fill | «SONDOS YAR PHOTOGRAPHY», left to right |
| `fill` | `<rect x="-8" y="-8" width="312" height="240" opacity="0"/>` → 1 | fill | guarantees 100% of ink at the end, whatever the brush paths miss |

The implementer tunes the brush paths by overlaying them at 30% opacity in a local scratch page (never a debug
flag in production code). Acceptance: no calligraphy pixel appears ahead of the brush front; the `fill` rect
completes the logo.

Brush durations are proportional to path length (≈ 124 / 159 / 277 / 253 units) so the "pen" moves at a constant
speed: 90 / 120 / 200 / 190 ms (≈ 600 ms in total; rev. 2, UX-01), `--cine-ease-ink` (linear), back to back.

### 4.4 Storyboard

Structure (all `aria-hidden="true"`, no focusable content):

```
div.cine-intro[data-phase]            position:fixed; inset:0; z-index:var(--z-intro); contain:strict; display:grid; place-items:center
  div.cine-intro__veil                absolute inset 0, background var(--cine-intro-bg) — faded with opacity (never background-color)
  svg.cine-intro__khatam              interlaced khatam (§5), min(78vmin, 30rem), stroke var(--cine-gold)
  div.cine-intro__stage               block-size clamp(7.5rem, 24vmin, 11rem); aspect-ratio 296/224; transform-origin 0 0
    div.cine-intro__viewfinder        inset -18%; the 8-gradient corner technique of E3, in --cine-gold, arm 14%
    svg.cine-intro__logo              viewBox 0 0 296 224, overflow visible
      defs > mask#cine-intro-mask     (§4.3)
      image href=logo-ink-{448|672}.webp width 296 height 224 mask="url(#cine-intro-mask)"
      path.cine-intro__ring           aperture ring: M145.5 0.5 A31.5 31.5 0 1 0 145.5 63.5 A31.5 31.5 0 1 0 145.5 0.5 (counter-clockwise from the top), stroke --cine-gold, 1 unit
```

Timeline (rev. 2, UX-01: ≤ 1.8 s visible, no hold) — `t0` = first frame after the logo is decoded (≤ **200 ms** after
the first React commit, §4.6):

| Frame | t (ms) | What the visitor sees | Implementation | Properties |
|---|---|---|---|---|
| F0 wait | −200…0 | Paper. (Identical to the blank paper before JS; the page is already painted underneath.) | `data-phase="wait"`; veil opacity 1 | — |
| F1 lock | 0 → 500 | Four gold corners converge on an empty frame | viewfinder `cine-lock` (`--cine-dur-glide`) | opacity, scale |
| F1 | 0 → 700 | A gold khatam settles behind | khatam opacity 0 → 0.35, scale 0.94 → 1, `--cine-ease-settle` | opacity, scale |
| F2 iris | 100 → 500 | The aperture opens from its centre | mask `iris` scale 0 → 1, `--cine-ease-settle` | SVG mask (bounded) |
| F2 | 150 → 650 | A gold ring traces around the aperture, counter-clockwise | ring dashoffset 1.01 → 0, `--cine-ease-glide` | stroke-dashoffset |
| F3 ink | 400 → 1000 | «سندس» is written right to left in four strokes | `ink-1…4` dashoffset 1.01 → 0, linear, chained (90/120/200/190 ms) | SVG mask |
| F4 latin | 950 → 1250 | «SONDOS YAR PHOTOGRAPHY» wipes in left to right | mask `latin` scaleX 0 → 1, origin left, `--cine-ease-glide` | SVG mask |
| F5 seal | 1250 → 1300 | (invisible completion; no hold) | mask `fill` opacity 0 → 1 | SVG mask |
| F6 leave | 1300 → 1800 | The logo glides and shrinks into the header logo's place; corners, ring and khatam fade (300 ms); the paper veil dissolves (400 ms from +100) revealing the hero, which fades in once (400 ms; E2 entry variant "intro") | `data-phase="leave"`, `data-cine-intro="leaving"`; stage `transform: translate(dx,dy) scale(s)` set via CSSOM, `transition: transform var(--cine-dur-glide) var(--cine-ease-glide)`; `will-change: transform` | transform, opacity |
| F7 land | 1650 → 1800 | The real header logo fades in under the landing logo | `data-cine-intro="landing"` → `.site-header__logo` opacity 0 → 1 over `--cine-dur-tick` | opacity |
| F8 done | 1850 | Overlay unmounted; `data-cine-intro` removed (`data-cine-entry="intro"` stays until the next navigation) | — | — |

Hero H1 and primary CTA reach opacity 1 at ≈ t0 + 1.7 s; acceptance allows up to t0 + 2.2 s on 4× CPU + Fast 4G.

FLIP maths (one layout read, at F6 start): `from = stage.getBoundingClientRect()`,
`to = document.querySelector('.site-header__logo').getBoundingClientRect()`; `dx = to.left − from.left`,
`dy = to.top − from.top`, `s = to.height / from.height` (both boxes have the logo's 296:224 ratio, the header one
because its width is `auto`). If the target is missing or has zero size, the stage fades and scales to 0.96 instead.
The header is sticky, so the target is always on screen.

While `data-cine-intro` is `playing` or `leaving`: `.site-header__logo { opacity: 0 }` (no double logo during the
glide). Base cinematic rule: `.site-header__logo { transition: opacity var(--cine-dur-tick) linear }`.

### 4.5 The hero hold (contract between MOT-10 and MOT-04)

- `data-cine-intro="playing"` on `<html>` pauses every hero entrance animation at its first frame (E2–E5 rules in
  §3). The photo is still painted (LCP-safe); the text is at opacity 0 behind an opaque overlay.
- At F6 the attribute becomes `leaving`: the paused animations resume from zero. Because `data-cine-entry="intro"`
  is set, the hero's entrance is the single 400 ms content fade plus the photo settle (no veil, no word stagger;
  UX-01), played while the overlay dissolves.
- On a normal load (no intro), the attribute never exists and the hero entrance starts on the first frame.

### 4.6 Rules: when it plays, skipping, LCP safety, failure

**Plays only if ALL hold** (decided once, synchronously, at module evaluation of `LogoIntro.tsx` — before
`createRoot().render()` runs, because `App.tsx` imports it; no layout read):

1. `normalizePathname(location.pathname) === '/'` and `location.hash === ''` (the query string is ignored, so
   Instagram/UTM arrivals see it; `/#contact` and any other route are deep links → no intro).
2. `matchMedia('(prefers-reduced-motion: reduce)').matches === false`.
3. `document.visibilityState === 'visible'` and the page is not prerendering (`Reflect.get(document, 'prerendering') !== true`).
4. Navigation type is not `back_forward` (`performance.getEntriesByType('navigation')[0]`, checked with
   `instanceof PerformanceNavigationTiming`).
5. `document.referrer` is not same-origin (parse with `new URL`; catch **only** `TypeError` → treat as external).
6. Save-Data is off: `const c: unknown = Reflect.get(navigator, 'connection')` → object → `Reflect.get(c, 'saveData') !== true`
   (typed without casts).
7. **Repeat-visit rule (rev. 2, UX-01)**: `sessionStorage['sy:intro:v1'] !== '1'` **and** `localStorage['sy:intro:v1']`
   is absent or holds a day number (whole days since 1970-01-01 UTC, as a decimal string, validated `^\d{5}$`) at
   least **60** days before today. Both reads sit inside a `try/catch` that catches **only** `DOMException` (storage
   blocked/SecurityError) and then **skips** the intro (fail closed: we cannot remember, so we never risk replaying
   it); any other error is re-thrown; a malformed stored value counts as "seen" (skip) and is overwritten at the next
   play. Both keys are written (`'1'` and today's day number; nothing personal) when the intro actually starts at
   `t0`, in the same narrow try/catch. A reload, a new visit from another page of the site, Back/Forward, and a
   return from Instagram or WhatsApp within 60 days: no intro.

The reason is written once to `data-cine-intro-reason` on `<html>` (`play | not-home | deep-link | reduced-motion |
hidden | back-forward | internal-referrer | save-data | seen | storage-unavailable | logo-not-ready |
verification`) for QA; it contains nothing personal.

**Skip**: `pointerdown`, `keydown`, `wheel`, `touchstart`, `scroll` on `window` (capture, passive), and
`visibilitychange` → hidden. Any skip before F6 jumps to F6 with shorter timings (glide 350 ms, veil 300 ms, no
delay) and sets the mask `fill` to 1 instantly, so a half-written logo never glides.
**Instant finish (rev. 2, UX-11)**: `focusin` and `click` on `document` (capture), any router navigation
(the `cine:navigate` event that `runRouteUpdate` dispatches on `document`; a listener removed at unmount), and focus reaching `.site-header__logo` finish the intro at once
(no glide), because assistive technology (VoiceOver double-tap, Voice Control, switch access) can activate or move
focus without the events above. Keys are **not**
`preventDefault`-ed: the first Tab both skips and moves focus to the skip link, which sits above the intro (z 1000 >
990) and is visible immediately. The overlay keeps `pointer-events: auto` until it unmounts, so the synthetic click
that follows a skipping tap cannot land on a button underneath. `visibilitychange` → hidden finishes instantly
(no animation). All listeners are removed at F6/unmount.

**LCP safety (binding)**:
- The hero image request starts from `index.html`'s preload, independent of the intro; the intro never edits
  `index.html` (CSP hash untouched).
- The hero `<img>` is painted on the first frame under the overlay; never hidden (see E2).
- The intro's own largest paint (the logo `<image>`, ≤ 232×176 CSS px) is smaller than the hero photo on every
  viewport from 320 px up, so it can never become the LCP element; the veil and khatam are not image candidates.
- The intro never waits on the network: the logo fetch starts at module evaluation (`new Image()`,
  `decoding='async'`, `img.decode().then(() => true, () => false)` — rejection handled); if it is not decoded within
  **200 ms of the first commit** (rev. 2, UX-01), the intro is abandoned (`logo-not-ready`): the veil fades in 200 ms
  and the hero plays normally. Neither storage key is written in that case. `audit:motion` reports how often
  `logo-not-ready` happens on Fast 4G.
- No layout read until F6 (one read); no scroll locking (never toggle `overflow` on `html`/`body`: the scrollbar
  gutter change would be a layout shift).

**Failure containment**:
- **Failsafe timer** (4500 ms), armed at module evaluation **before** `data-cine-intro="playing"` is set, removes
  the attributes and marks the intro done even if React never mounts the component.
- **Silent error boundary**: `LogoIntro` wraps its view in a local class boundary (not exported) whose
  `getDerivedStateFromError` renders `null` and whose `componentDidCatch` releases the hold and calls
  `window.reportError(error)` — an intro bug can never unmount the app.
- **Jank guard (rev. 2, UX-11)**: when `PerformanceObserver.supportedEntryTypes` includes `long-animation-frame`,
  two consecutive entries longer than 50 ms during F1–F5 trigger a skip. Observer disconnected at F6/unmount.
- **Email-verification gate**: `LogoIntro` reads `useAuth()` (existing context — no new Firebase listener); if
  `firebaseUser !== null && !isEmailVerified` it finishes instantly (`verification`), so the gate (z 900) is never
  covered.
- **StrictMode**: the effect's cleanup clears every timer/listener/observer and resets the phase, but never marks the
  module-level "done" flag; the re-run resumes correctly. Module-level decision state is computed once.
- **Timers**: every `setTimeout`/`requestAnimationFrame` id is stored and cleared in cleanup.

**Accessibility**: the overlay is `aria-hidden` and contains nothing focusable; the page underneath stays in the
accessibility tree and keyboard order the whole time (no `inert`), so screen-reader users are never delayed; the first
swipe, double-tap or focus move ends the intro (UX-11); the header logo is never focusable while invisible because
focus reaching it finishes the intro first; total auto-motion ≤ 1.8 s (< 5 s, WCAG 2.2.2 not triggered); no flashing.

---

## 5. The gold khatam ornament

### 5.1 Construction

An 8-point star {8/2} = two squares of circumradius **R = 44** on centre (50, 50) in a `0 0 100 100` viewBox, one
rotated 45° to the other. Outer points at angles −90°, −135°, … (every 45°); the concave points sit at radius
`r = R · cos 45° / cos 22.5° = 44 × 0.70711 / 0.92388 = 33.676`, halfway between (at −112.5°, −157.5°, …). The
coordinates reduce to three numbers: `50 ± 44`, `50 ± 31.113` (`R cos 45°`) and `50 ± 12.887` (`r sin 22.5°`).
Check: the square edge `y = −x + 56` meets the upright square's top edge `y = 18.887` at `x = 37.113` ✓
(distance from centre √(12.887² + 31.113²) = 33.676 ✓).

All paths start at the top and run **counter-clockwise on screen** (towards the left first) — the drawing moves in
the reading direction.

| Part | Path | Used in |
|---|---|---|
| Outer ring (r 48) | `M50 2 A48 48 0 1 0 50 98 A48 48 0 1 0 50 2` | mark, emblem |
| Star outline (16 vertices, the Rub el Hizb silhouette) | `M50 6 L37.11 18.89 L18.89 18.89 L18.89 37.11 L6 50 L18.89 62.89 L18.89 81.11 L37.11 81.11 L50 94 L62.89 81.11 L81.11 81.11 L81.11 62.89 L94 50 L81.11 37.11 L81.11 18.89 L62.89 18.89 Z` | mark, glyph (filled) |
| Square A (diamond) | `M50 6 L6 50 L50 94 L94 50 Z` | emblem, intro (interlaced) |
| Square B (upright) | `M18.89 18.89 L18.89 81.11 L81.11 81.11 L81.11 18.89 Z` | emblem, intro (interlaced) |
| Inner ring (r 24, echoes the aperture rings) | `M50 26 A24 24 0 1 0 50 74 A24 24 0 1 0 50 26` | emblem, intro |
| Pupil (echoes the aperture's solid centre) | `<circle cx="50" cy="50" r="3.2"/>` filled | mark, emblem |

Arcs are written as two semicircle paths (not `<circle>`) so `pathLength` behaves identically in every engine.
`sweep-flag = 0` = counter-clockwise on screen (SVG y points down).

### 5.2 Component

`@site-design/Khatam` — props `{ variant: 'glyph' | 'mark' | 'emblem' | 'interlaced'; tone: 'ink' | 'on-dark';
draw: boolean }`. Classic returns `null`. Cinematic renders
`<span class="cine-khatam-frame[ reveal]"><svg class="cine-khatam cine-khatam--{variant} cine-khatam--{tone}"
viewBox="0 0 100 100" aria-hidden="true" focusable="false">…</svg></span>` (`reveal` only when `draw`).

Stroke width is in user units (no `vector-effect: non-scaling-stroke`, which breaks `pathLength` dashing in
Chromium): mark (56 px) 2.2 → ≈ 1.2 px; emblem (160 px) 1 → 1.6 px; intro (480 px) 0.3 → 1.4 px. Glyph: star
outline filled, no stroke, no ring.

### 5.3 Stroke-draw technique

```css
:cine .cine-khatam { display: block; inline-size: var(--cine-khatam-size); aspect-ratio: 1; overflow: visible;
  fill: none; stroke: var(--cine-khatam-color, var(--cine-gold)); stroke-width: var(--cine-khatam-stroke);
  stroke-linecap: round; stroke-linejoin: round; }
:cine .cine-khatam--on-dark { --cine-khatam-color: var(--cine-gold-on-dark); }
@media (prefers-reduced-motion: no-preference) {
  :cine .cine-khatam-frame.reveal.reveal--armed { opacity: 1; translate: 0 0; }          /* the frame itself does not fade */
  :cine .cine-khatam-frame.reveal--armed :is(.cine-khatam__ring, .cine-khatam__star, .cine-khatam__square, .cine-khatam__inner) {
    stroke-dasharray: 1; stroke-dashoffset: 1.01;                                     /* 1.01: no round-cap dot at rest */
  }
  :cine .cine-khatam-frame.reveal--armed .cine-khatam__pupil { opacity: 0; }
  :cine .cine-khatam-frame.reveal--armed.is-revealed :is(.cine-khatam__ring, .cine-khatam__star, .cine-khatam__square, .cine-khatam__inner) {
    stroke-dashoffset: 0;
    transition: stroke-dashoffset calc(var(--cine-dur-draw) * var(--d, 0.6)) var(--cine-ease-glide) calc(var(--cine-dur-draw) * var(--s, 0));
  }
  :cine .cine-khatam-frame.reveal--armed.is-revealed .cine-khatam__pupil {
    opacity: 1; transition: opacity calc(var(--cine-dur-draw) * 0.15) linear calc(var(--cine-dur-draw) * 0.85);
  }
}
```

Order within the 1.6 s: outer ring `--s:0 --d:0.5`; star or square A `--s:0.15 --d:0.6`; square B `--s:0.3 --d:0.6`;
inner ring `--s:0.5 --d:0.5`; pupil fades in at 85%. (`--s/--d` are set per class in `khatam.css`, not inline.)
Every path carries `pathLength="1"`.

- **Reduced motion / failure**: figure fully drawn and static (base state).
- **Perf**: `stroke-dashoffset` repaints only the SVG's box (≤ 10rem), once; the intro backdrop never draws (fade +
  scale only).
- **RTL**: counter-clockwise from the top = the reading direction.
- **Contact placement**: `.contact-band` gets `position: relative; overflow: clip` (clip, not hidden: no scroll
  container) in `khatam.css`; the emblem frame is `position: absolute`, inline-end, vertically centred,
  `pointer-events: none`, `z-index: 0` under the content — no overflow at 320 px.

---

## 6. SPA page transitions (E12) in the custom router

### 6.1 Integration points (MOT-09 owns `App.tsx` changes)

`App.tsx` keeps its single `popstate` listener and `handleNavigate`. Both stop calling `setBrowserLocation`
directly and instead call `runRouteUpdate(update, request)` from `@site-design/page-transition`:

```ts
// in handleNavigate, after the existing guards, computed synchronously (never read `event` later):
const request: RouteUpdateRequest = {
  kind: 'push',
  samePath: normalizePathname(destination.pathname) === normalizePathname(window.location.pathname), // BEFORE pushState
  toPathname: normalizePathname(destination.pathname),
  toHash: destination.hash,
  animate: !verificationRequired,
}
// …existing pushState…
runRouteUpdate(() => {
  resetFailedLazyComponents()
  setBrowserLocation((current) => readBrowserLocation(current.revision + 1))
}, request)
```

For `popstate`, `samePath` compares against a `renderedPathnameRef` that App updates in an effect when
`browserLocation.pathname` changes (bookkeeping only; no behaviour change in classic). `handleNavigate` and the
`popstate` handler are memoised with empty dependencies, so `animate` must be read from a ref that mirrors
`verificationRequired` on every render (never from the stale closure).

- **Classic** `runRouteUpdate(update)` = `update()` — byte-for-byte the current behaviour.
- **Cinematic** algorithm:

```
runRouteUpdate(update, request):
  if request.samePath || request.toHash !== '' || !request.animate || request.toPathname === '/admin':
      update(); return                                                      // identical to classic (hash scroll as today)
  if matchMedia('(prefers-reduced-motion: reduce)').matches
     || document.visibilityState !== 'visible'
     || !('startViewTransition' in document):
      delete html.dataset.cineEntry                                          // the destination's own entrance may play
      flushSync(update); focusRouteHeading(); return                         // no animation, focus still managed
  token = ++latestToken
  document.dispatchEvent(new Event('cine:navigate'))   // rev. 2 (UX-11): LogoIntro listens and finishes at once
  pendingTimer = setTimeout(() => { html.dataset.cineVtPending = '' }, 100)   // rev. 2 (UX-09): static hairline if the chunk is slow
  void waitForRoute(request.toPathname, 300ms)          // resolves on chunk ready OR timeout; never rejects
    .then(() => { clearTimeout(pendingTimer); if (token === latestToken) startTransition(update, request) })
    .catch(reportOnce)                                  // only a programming error can land here

startTransition(update, request):
  activeTransition?.skipTransition()                    // rapid clicks: the old update still runs (per spec)
  delete html.dataset.cineVtPending
  html.dataset.cineVt = request.kind === 'pop' ? 'back' : 'forward'   // BEFORE the call: names the header for capture
  html.dataset.cineEntry = 'vt'                         // rev. 2 (UX-09): the destination skips E5/E7; kept until the next navigation
  t = document.startViewTransition(() => {
        flushSync(update)                               // commit the new route synchronously inside the callback
        scrollToPageTop()                               // new state is captured at the top (router effect repeats it, idempotent)
        focusRouteHeading()
      })
  activeTransition = t
  t.ready.then(noop, ignoreExpectedAbort)               // AbortError / InvalidStateError / TimeoutError DOMException → ignore; else reportOnce
  t.updateCallbackDone.then(noop, reportOnce)
  t.finished.then(cleanup, (e) => { cleanup(); reportOnce(e) })
  cleanup: if (activeTransition === t) { activeTransition = null; delete html.dataset.cineVt }
```

- `waitForRoute` uses the additive `whenReady(): Promise<void>` that MOT-05 adds to `createRetryableLazy`
  (resolves when the chunk has loaded **or failed** — the error boundary handles failures) and
  `routeReady(path)` in `lazy-components.ts` (`/` resolves immediately: Home is in the entry chunk). Pages are
  usually preloaded already by the existing hover/focus/touch preloading.
- **Loaded-module rendering (rev. 2, M5)**: `React.lazy` stays uninitialised until its first render, and
  `RouteErrorBoundary key={activePath}` creates a new Suspense boundary per route, so a `flushSync` inside the VT
  callback would otherwise commit `RouteFallback` on the first visit. `createRetryableLazy` therefore also exposes
  `loadedModule(): { default: ComponentType } | null` (set when `whenReady()` resolves successfully), and MOT-09's
  `renderCurrent` in `App.tsx` renders `loadedModule().default` directly when it is available, falling back to the
  lazy component otherwise. Acceptance: with a warm chunk, the new VT snapshot contains the destination H1 on the
  first visit.
- `reportOnce(error)` → `window.reportError(error)` once per error object (`WeakSet`); nothing is swallowed
  silently, nothing is logged with data. `noop` is a named function documented as "the success path needs no
  action" (not a catch).
- `flushSync` runs outside any React render (inside the VT callback or a native/React event handler) — allowed.

### 6.2 CSS (`src/design/cinematic/transitions.css`)

```css
@media (prefers-reduced-motion: no-preference) {
  :cine[data-cine-vt] .site-header { view-transition-name: cine-header; }   /* header stays put; default 250 ms cross-fade */
  :cine[data-cine-vt]::view-transition-old(root),
  :cine[data-cine-vt]::view-transition-new(root) { mix-blend-mode: normal; }  /* UA default plus-lighter would over-expose */
  :cine[data-cine-vt]::view-transition-old(root) { animation: cine-vt-dim var(--cine-dur-vt-out) var(--cine-ease-exit) both; }
  :cine[data-cine-vt]::view-transition-new(root) { animation: cine-vt-in var(--cine-dur-vt-in) var(--cine-ease-glide) both; }
  :cine[data-cine-vt="back"]::view-transition-new(root) { animation-name: cine-vt-in-back; }
}
@media (prefers-reduced-motion: reduce) {
  :cine::view-transition-group(*), :cine::view-transition-old(*), :cine::view-transition-new(*) { animation: none !important; }
}
/* rev. 2 (UX-09) */
:cine::view-transition { pointer-events: none; }                 /* taps during the ≈ 450 ms veil reach the live page */
:cine[data-cine-vt] :is(<mobile-menu panel selector>, <mobile-menu scrim selector>) { transition: none; }  /* menu closes instantly inside the update; selectors from MobileMenu.css */
:cine[data-cine-entry="vt"] .cine-words .cine-w { animation: none; opacity: 1; translate: 0 0; }        /* one motion per moment */
:cine[data-cine-vt-pending] .site-header::after {                 /* static 2 px hairline while a slow chunk loads */
  content: ""; position: absolute; inset-inline: 0; inset-block-end: 0; block-size: 2px;
  background-color: var(--color-accent-deep); opacity: 1;
}
@keyframes cine-vt-dim { to { opacity: 0.5; } }
/* Forward: the new page is uncovered from the right (reading start) with an 8% slanted edge. */
@keyframes cine-vt-in {
  from { clip-path: polygon(100% 0, 100% 0, 100% 100%, calc(100% + var(--cine-vt-slant)) 100%); }
  to   { clip-path: polygon(calc(0% - var(--cine-vt-slant)) 0, 100% 0, 100% 100%, 0 100%); }
}
/* Back: mirrored, uncovered from the left. */
@keyframes cine-vt-in-back {
  from { clip-path: polygon(0 0, 0 0, calc(0% - var(--cine-vt-slant)) 100%, 0 100%); }
  to   { clip-path: polygon(0 0, calc(100% + var(--cine-vt-slant)) 0, 100% 100%, 0 100%); }
}
```

The content does not slide (D12): it is uncovered in place while the old page dims beneath it.
`view-transition-name` is applied only while `data-cine-vt` exists, so the header has no side effects the rest of
the time. **Rev. 2 (UX-09)**: the destination's own E5 words and E7 veils do **not** play inside the veil
(`data-cine-entry="vt"`); only the E9 photo settle (a scale on the image, no text motion) may continue. The
`.site-header::after` hairline assumes `.site-header` is already `position: sticky` (a positioned box), which it is;
if `SiteHeader.css` already uses `::after`, the rule moves to `::before` (the implementer checks).

### 6.3 Fallback, focus, scroll

| Situation | Behaviour |
|---|---|
| No `startViewTransition` (older Safari/Firefox) | `flushSync(update)` + focus management; no animation |
| Reduced motion | same as above (JS check) + CSS `animation: none !important` belt |
| Hash navigation (`/packages#packages`, `#contact`, `/#contact`) or same path | plain `update()` exactly as classic; the router's existing smooth/instant hash scroll runs (a veil followed by a scroll would be two motions) |
| `/admin`, email-verification gate active | plain update |
| Rapid second click | previous transition skipped (its update still applied); latest navigation wins via `latestToken` |
| Chunk slow (> 100 ms) | a static hairline under the header shows the tap was received (UX-09); after 300 ms the transition starts anyway and reveals the existing `RouteFallback`; the page appears when it arrives |
| Chunk already loaded | the router renders the loaded module directly (M5), so the snapshot holds the real page, not the fallback |
| Mobile menu navigation | the menu's close transition is disabled while `data-cine-vt` exists, so it never freezes in the old snapshot (UX-09) |
| Back/Forward | same, mirrored veil (`data-cine-vt="back"`) |

**Focus** (cinematic only — classic keeps today's behaviour; see open question 1): after a path change,
`focusRouteHeading()` focuses `#main-content h1`, falling back to `main#main-content`; if the element has no
`tabindex` it gets `tabindex="-1"` and a `{ once: true }` `blur` listener removes it again; `focus({ preventScroll:
true })`. `:focus-visible` shows the ring only after keyboard use. Screen readers announce the new page heading.

**Scroll**: unchanged semantics: new path → top (explicitly inside the VT callback so the captured new state is at
the top, plus the router's own idempotent effect); hash → the router's existing lookup; Back/Forward → top of the
restored route (as today). `history.scrollRestoration` is not touched.

---

## 7. The design switch

### 7.1 Flag

`VITE_SITE_DESIGN = classic | cinematic`, **build-time only**, default **`classic`** when unset or empty (rev. 2,
H6: an unset flag must never ship a partial motion layer; `scripts/release.mjs` always passes the design
explicitly, and `npm run build:cinematic` / `npm run dev:cinematic` select the cinematic layer). Read only in
`vite.config.ts` (via `loadEnv(mode, cwd, 'VITE_SITE_DESIGN')`, so `.env*` files and the process environment both
work, the process environment winning). Any other value **fails the build** with a clear message (a typo must never
silently ship the other design). It is public, non-secret configuration; application code never reads
`import.meta.env.VITE_SITE_DESIGN` (so it is not even embedded in the bundle). No runtime switch, no query parameter:
the classic bundle contains no cinematic code at all.

### 7.2 Mechanism: one alias, twin modules

```ts
// vite.config.ts (sketch — no casts, no new dependency)
const SITE_DESIGNS = ['classic', 'cinematic'] as const
type SiteDesign = (typeof SITE_DESIGNS)[number]

function readSiteDesign(mode: string): SiteDesign {
  const raw = loadEnv(mode, process.cwd(), 'VITE_SITE_DESIGN').VITE_SITE_DESIGN ?? ''
  if (raw === '') return 'classic'                       // rev. 2 (H6)
  const match = SITE_DESIGNS.find((design) => design === raw)
  if (match === undefined) {
    throw new Error(`VITE_SITE_DESIGN must be "classic" or "cinematic" (got ${JSON.stringify(raw.slice(0, 32))}).`)
  }
  return match
}

export default defineConfig(({ mode }) => {
  const designDir = fileURLToPath(new URL(`./src/design/${readSiteDesign(mode)}/`, import.meta.url))
  return {
    plugins: [react(), cloudflare()],                    // W2-18 adds the config-guard plugin in wave 2
    resolve: { alias: [{ find: /^@site-design\/([A-Za-z-]+)$/, replacement: `${designDir}$1` }] },
    build: { assetsInlineLimit: 0 },                     // rev. 2 (TM-14): never emit data: URIs
  }
})
```

- `tsconfig.app.json`: `"paths": { "@site-design/*": ["./src/design/cinematic/*"] }` — consumers type-check against
  the cinematic modules; each classic twin types its exports against the cinematic ones
  (`import type CinematicX from '../cinematic/X'` … `const X: typeof CinematicX = …; export default X`; the type-only
  import is erased, so no cinematic code enters the classic bundle), and the classic build (part of every unit's
  acceptance) fails on any missing export.
- Members (each a pair `src/design/{classic,cinematic}/<Name>`): `boot` (side-effect module imported by `main.tsx`
  right after `./index.css`; cinematic sets `data-design="cinematic"` on `<html>` and imports `tokens.css`,
  `hero.css`, `scroll.css`), `DisplayHeading`, `Khatam`, `LogoIntro`, `ServicesTicker`, `page-transition`.
  Component files export only a default component (react-refresh rule); `page-transition` exports functions and a
  type only.
- Every cinematic stylesheet is imported by a cinematic module, so it is emitted only in cinematic builds.

### 7.3 How classic stays byte-for-byte today's look

1. Classic twins import **no CSS** and render **no DOM** of their own: `boot` is `export {}`; `LogoIntro`,
   `ServicesTicker`, `Khatam` return `null`; `DisplayHeading` returns the same element with the same props in the
   same order; `runRouteUpdate(update)` calls `update()`.
2. Consumer edits must produce identical classic DOM: same tags, same attribute order, same text nodes, no wrapper
   elements, no conditional keys.
3. Per-unit invariant, checked by `scripts/motion-audit.mjs parity --ref <commit before the unit>` (MOT-06). **Hard
   gate (rev. 2, M7)**: classic CSS bytes identical (sha256 of every emitted `.css`) and classic DOM identical (hashed
   asset names normalised) on `/`, `/portfolio`, `/packages`, `/my-bookings` (signed out). **Supporting check**:
   screenshots at 375 × 812 and 1280 × 800 with reduced motion emulated, taken only after `document.fonts.ready` and
   `decode()` of every image in the viewport, with ≤ 0.1% differing pixels. Audit builds use a stub Firebase config
   (no network), and the worktree build runs `npm ci` first. JS bytes may differ (call sites), rendering may not.
4. Build-output check: `grep` over the classic `dist/client/assets/*` finds no `cine-`, `data-design`,
   `startViewTransition` or `view-transition`.
5. Release check against the tag: `parity --ref design-classic-v1`. Differences are allowed only where product
   units (Runs 4–8) changed public pages; the report must attribute each difference to a named product unit. The
   motion units' own contribution must be zero.

### 7.4 Scripts — build and preview locally; deploy only through the release script

**Rev. 2 (H6, TM-05)**: there is one deploy path for the whole project, `scripts/release.mjs` with
`scripts/release-preflight.mjs` (unit W3-19, `11-golive-plan.md` §7.0). The motion scripts build and serve; they never
deploy.

`scripts/build-design.mjs` (MOT-02), Node only, no shell, no dependency:

```
node scripts/build-design.mjs <classic|cinematic> [--dev] [--env=production|preview]
```

- Strict argument allowlist; unknown argument → usage, exit 2. There is no `--deploy` and no `--allow-dirty`.
- Runs `tsc -b` and `vite build` through `process.execPath` + the local `node_modules/.../bin` entry points
  (`spawnSync`, argument arrays, `shell: false`), with `env = { ...process.env, VITE_SITE_DESIGN: design }`;
  `--env=preview` sets `CLOUDFLARE_ENV=preview` and the Vite mode `preview`; `--env=production` (default) **deletes**
  an inherited `CLOUDFLARE_ENV`.
- After the build it verifies the output really is the requested design (§7.3 item 4 markers) and exits non-zero on a
  mismatch. It prints design and target Worker name (read from the generated deploy config); never environment values.
- `--dev` runs `vite` with the flag for local previews.

`package.json` scripts (MOT-02 adds the build/dev ones in wave 2; W3-19 adds the release ones in wave 3):

```json
"dev:classic": "node scripts/build-design.mjs classic --dev",
"dev:cinematic": "node scripts/build-design.mjs cinematic --dev",
"build:classic": "node scripts/build-design.mjs classic",
"build:cinematic": "node scripts/build-design.mjs cinematic",
"audit:motion": "node scripts/motion-audit.mjs runtime",
"audit:parity": "node scripts/motion-audit.mjs parity",
"release": "node scripts/release.mjs",
"deploy:classic": "node scripts/release.mjs --env=production --design=classic",
"deploy:cinematic": "node scripts/release.mjs --env=production --design=cinematic",
"deploy:preview:classic": "node scripts/release.mjs --env=preview --design=classic",
"deploy:preview:cinematic": "node scripts/release.mjs --env=preview --design=cinematic"
```

`npm run build` / `npm run dev` stay unchanged and now give **classic** (the unset default).

**Documented in the README as the way to return to today's design** (W5-04, finalised by MOT-13):

```
git checkout <currently released tag>          # never HEAD: HEAD may carry unreleased work
npm run deploy:classic                         # release.mjs: clean tree, tag check, preflight, typed go-ahead
npm run deploy:preview:classic                 # try it on the preview Worker first
npx wrangler versions list                     # the message column shows design=classic|cinematic
npm run release -- --rollback <version>        # emergency: an earlier version, refused below the launch floor
```

Which design is live: `document.documentElement.dataset.design` is `"cinematic"` or undefined; the Worker version
message/tag says the same.

### 7.5 Git tag `design-classic-v1`

Already exists → `c80f4c2` (annotated, 2026-09-28, "Classic design before the cinematic motion layer"). Uses:
(1) reference for the release parity check (§7.3 item 5); (2) documentation anchor. It is **not** the way to return
to the classic design: checking it out also removes every Run 4–8 feature and would rebind nothing correctly. Use the
flag on the released tag (§7.4). After the cinematic launch, tag `design-cinematic-v1`.

---

## 8. Build units

Conventions: paths relative to `app/`; the combined plan (`11-golive-plan.md` §5) gives every unit a combined id and
guarantees that no file has two owners in one wave **across both plans**; later waves may edit a file an earlier wave
created. Each unit is ≤ 4 files except MOT-01 (5, justified). Nothing merges without the wave's review gate: two
independent reviewers per unit (application security + motion/UX), `npm run verify` green, and no open critical or
high finding (the owner cannot waive those).

### 8.1 Common acceptance (applies to every unit, referenced as A1–A6)

- **A1 Static**: `npm run verify` passes, which includes `npm run lint` (0 errors, no new warnings), `npx tsc -b`
  (app, node, worker), **both** `npm run build` (classic, the default) and the cinematic build (before MOT-02 lands:
  `VITE_SITE_DESIGN=cinematic npm run build`), `npm test` and the grep gates.
- **A2 Classic parity**: `npm run audit:parity -- --ref <pre-unit commit>` passes (§7.3 item 3: DOM + CSS hashes are the
  hard gate). Before MOT-06 lands (wave 1), do it by hand: Chrome `--headless=new --dump-dom --virtual-time-budget=8000
  --force-prefers-reduced-motion` on both builds, diff; compare CSS hashes.
- **A3 Runtime** (cinematic; Chrome, plus WebKit/Safari and Firefox where the unit adds visible behaviour): no console
  errors or warnings on `/`, `/portfolio`, `/packages`, `/my-bookings`; at **375 px and 320 px** no horizontal page
  scroll (`scrollingElement.scrollWidth ≤ innerWidth`) at t = 0, 1 s, 3 s and after scrolling to the bottom, and no
  element extends past the viewport outside an intentional scroller/clip; keyboard-only pass: tab order unchanged,
  focus ring visible at every stop, no focus lost or trapped; touch targets ≥ 44 × 44 CSS px.
- **A4 Budgets** (Home, cinematic vs classic, `audit:motion` with 4× CPU + Fast 4G, median of 5, and one Lighthouse
  mobile run in Chrome DevTools): CLS ≤ 0.01 (target 0.00); LCP element = `img.home-hero__image`; LCP ≤ classic
  + 100 ms; **hero H1 and primary CTA at opacity 1 by t0 + 2.2 s when the intro plays, and by first paint + 1.5 s
  otherwise** (UX-01); TBT ≤ classic + 30 ms; no long task > 50 ms attributable to cinematic code; Performance ≥ 90;
  Accessibility score not lower than classic. Size: cinematic adds ≤ 5 KB gzip JS and ≤ 6 KB gzip CSS in total.
  Composited layers on Home ≤ classic + 12 at rest.
- **A5 Reduced motion** (emulated): no intro, no view transition, ticker static without button, all content visible
  immediately; `document.getAnimations().filter((a) => a.playState === 'running').length === 0` 200 ms after load
  and after a navigation; print preview shows all content.
- **A6 Security (SC-0 for every unit)**: no new dependency (`package-lock.json` unchanged); no
  `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`; no inline `<script>`/`<style>`, no
  `setAttribute('style')`, CSSOM only; no `data:` URIs (`assetsInlineLimit: 0`, preflight check); no network requests
  except same-origin assets; no `console.*`; no `any`, `@ts-ignore`, `eslint-disable`, unsafe `as`; catches are
  narrow (typed check + re-throw) or report via `window.reportError`, never empty; every listener/observer/timer/rAF is
  removed in cleanup; no `event.currentTarget` in deferred code; storage holds only `sy:intro:v1` (a day number in
  `localStorage`, `'1'` in `sessionStorage`); the cinematic build shows 0 violations under the **enforced** CSP on
  preview (checked in MOT-13 with the red team, TM-14).

### 8.2 Units (in combined-wave order)

**Wave 1**

**MOT-01 · W1-16 — Design switch foundation** (frontend) — files: `vite.config.ts`, `tsconfig.app.json`, `src/main.tsx`,
`src/design/classic/boot.ts`, `src/design/cinematic/boot.ts`. *5 files, justified*: the alias, its TypeScript
mapping, both alias targets and the single import that exercises it must land atomically. Cinematic `boot.ts` only
sets `data-design="cinematic"` in this unit. Acceptance: A1, A2 (the classic build is identical to the tag in CSS/DOM;
the cinematic build differs only by `data-design="cinematic"` on `<html>`); invalid `VITE_SITE_DESIGN=clasic` fails the
build with the message; **unset → classic** (attribute absent; H6); `cinematic` → attribute present;
`build.assetsInlineLimit: 0` (TM-14); `vite dev` works in both. Security: allowlisted flag values, fail-closed on
unknown; alias regex limited to `[A-Za-z-]` names; the flag is never embedded in client code; SC-0.

**MOT-03 · W1-17 — Intro logo rasters** (frontend) — files: `scripts/make-brand-assets.mjs`, `src/data/brand-images.ts`,
`public/images/brand/logo-ink-448.webp`, `public/images/brand/logo-ink-672.webp` (the last two generated).
Acceptance: re-running the script leaves every existing brand file byte-identical (`git status` shows only the two new
files plus the two edited sources); sizes ≤ 25 KB / ≤ 40 KB; visual check at 200% zoom against the master (no halo on
paper, crisp aperture arcs); `brandIntroLogo` typed with `as const satisfies`; A1. Security: reads only the local
master, writes only inside `public/images/brand/`; sharp is the already-approved dev dependency; output has no
metadata (verify no EXIF/XMP); SC-0.

**MOT-05 · W1-18 — Route-chunk readiness API and loaded-module cache** (frontend) — files: `src/layout/retryable-lazy.ts`,
`src/layout/lazy-components.ts`. Adds `whenReady(): Promise<void>` to `RetryableLazyComponent` (starts the load like
`preload()`, resolves on success **and** on failure, never rejects), `loadedModule()` (the resolved module or `null`,
M5) and `routeReady(path: AppPath): Promise<void>` (`/` and `/admin` resolve immediately). Classic and cinematic
behaviour unchanged (nothing calls it yet). Acceptance: A1, A2; a scratch check (not committed) shows
`routeReady('/portfolio')` resolves after the chunk arrives and `loadedModule()` is then non-null, and resolves (not
rejects) with the network offline; no unhandled rejection. Security: no new rejection paths, failed-chunk re-arm logic
untouched; SC-0. (W3-16 later adds the legal pages to `lazy-components.ts` in wave 3.)

**Wave 2**

**MOT-02 · W2-19 — Build/dev scripts and design-switch docs** (frontend) — files: `package.json`,
`scripts/build-design.mjs`, `src/styles/README.md`. Implements §7.4 without any deploy path, documents the design
switch, the `--cine-*` token table and the class/attribute contract (§8.3) in `src/styles/README.md` (the root README
is written by W5-04 and finalised by MOT-13). Depends: MOT-01. Acceptance: `npm run build:classic` / `build:cinematic`
produce the right design (marker check passes; swapping markers makes the script exit non-zero);
`node scripts/build-design.mjs foo`, unknown flags, `--deploy` and `--allow-dirty` exit 2; `--env=preview` build shows
`sundus-yar-preview` as target; A1. Security: `shell: false` and argument arrays, allowlisted args, `CLOUDFLARE_ENV`
set or removed explicitly, no secrets read or printed; SC-0.

**MOT-04 · W2-20 — Cinematic tokens, hero entrance, scroll reveals, wipes, parallax** (motion) — files:
`src/design/cinematic/boot.ts`, `src/design/cinematic/tokens.css`, `src/design/cinematic/hero.css`,
`src/design/cinematic/scroll.css`. Implements §2 and E2, E3, E4, E6, E7, E8, E9 (CSS on existing markup only), the
hero hold selectors (§4.5), the header-logo hand-off rules, and print rules. Depends: MOT-01. Acceptance: A1–A6; hero
sequence matches §3 timings within ±50 ms (Performance panel); veils retreat right→left; corners use gold + ink hairline
and are visible on a light test image (UX-12); no edge ever shows during parallax at 320–1920 px; Firefox shows static
photos without errors; **a portfolio filter change adds no motion and no settle** (UX-10); hover scale still works on
tiles; LCP element and timing per A4. Security: selectors all prefixed by `:root[data-design="cinematic"]`; no hex;
no url() to anything; SC-0.

**MOT-06 · W2-21 — Motion audit and classic-parity tool** (frontend) — files: `scripts/motion-audit.mjs`. Depends:
MOT-01. Modes: `parity --ref <git-ref>` (worktree build of the ref as classic after `npm ci`, with a stub Firebase
config; HEAD classic; CSS hash and DOM compare as the hard gate; screenshots after `document.fonts.ready` and image
decode, ≤ 0.1% tolerance, as a supporting check; M7) and `runtime [--design]` (console errors, overflow at 320/375,
reduced-motion running-animation count, intro present then gone ≤ 2.0 s after t0, reload and a second session within
60 days → no intro, Tab at 300 ms → intro gone at once and focus on the skip link, VT attribute observed on nav and
focus on the new H1, taps during a VT reach the page, LCP element/time and CLS via an injected PerformanceObserver,
hero H1/CTA opacity-1 time, `logo-not-ready` rate over 10 Fast 4G loads, long tasks, 4× CPU + Fast 4G option). Chrome
over the DevTools Protocol with Node 24's global `WebSocket`; its own static server for `dist/client` with SPA
fallback. Acceptance: running it at W2 against HEAD reports parity OK; deliberately changing one CSS byte in a scratch
branch makes it fail with a readable diff; exits non-zero on any failure; cleans up worktree, Chrome profile and temp
files even on Ctrl-C. Security (TM-22): server and debugging port bound to 127.0.0.1 with `--remote-debugging-port=0`
(port read from `DevToolsActivePort`), temp profile killed on exit, requests to anything but 127.0.0.1 blocked through
`Fetch` interception (no Firebase/Google calls), static server resolves paths inside `dist/client` only (no
traversal), never prints `VITE_*` values, `shell: false` spawns, git used read-only (`worktree add --detach`, removed
after), no new dependency; SC-0.

**Wave 3**

**MOT-07 · W3-17 — Display headings (Arabic-safe words) + hero H1** (motion) — files:
`src/design/cinematic/DisplayHeading.tsx`, `src/design/cinematic/words.css`, `src/design/classic/DisplayHeading.tsx`,
`src/pages/home/HeroSection.tsx`. Implements E5 and uses it for the hero H1 (`trigger="load"`). Depends: MOT-04.
Acceptance: A1–A6; the H1's `textContent` equals the source string exactly; span count = whitespace-token count; no
span contains whitespace; a string with Latin letters renders unsplit; under reduced motion the cinematic H1 is
pixel-identical in line breaks to classic; **with motion on, the resting line breaks equal classic at 320/375/768 px**
(UX-17); NVDA, iOS VoiceOver (one swipe stop per heading) and TalkBack/Chrome Android read the heading once; words do
not animate under `data-cine-entry="intro"` or `"vt"`; the hero hold pauses the words (manual `data-cine-intro="playing"`
in DevTools). Security: text is a string prop rendered as React text, no HTML parsing; `--wi` from a clamped integer;
SC-0.

**MOT-08 · W3-18 — Gold khatam ornament + story mark** (motion) — files: `src/design/cinematic/Khatam.tsx`,
`src/design/cinematic/khatam.css`, `src/design/classic/Khatam.tsx`, `src/pages/home/StorySection.tsx`. Implements §5
(all variants and the contact-band placement CSS) and places the `mark` (draw) before «سندس يار». Depends: MOT-04.
Acceptance: A1–A6; geometry matches §5.1 (star points on the R 44 circle, concave points on r 33.68); draws
counter-clockwise from the top; no dot at rest (dashoffset 1.01); reduced motion → fully drawn; SVG never carries
`.reveal` (the frame span does); decorative (`aria-hidden`, not focusable). Security: static path data only; SC-0.

**Wave 4**

**MOT-09 · W4-09 — SPA page transitions** (motion) — files: `src/App.tsx`, `src/design/cinematic/page-transition.ts`,
`src/design/cinematic/transitions.css`, `src/design/classic/page-transition.ts`. Implements §6 as amended (UX-09, M5).
Depends: MOT-04, MOT-05 (and W3-16, which edited `App.tsx` in wave 3). Acceptance: A1–A6; forward and back veils go
in the right directions in **≤ 450 ms**; header never wipes; hash links (`/packages#packages`, `#contact`) behave
exactly as classic; rapid triple click ends on the last route with no console error and no stuck `data-cine-vt`;
**navigating from the mobile menu at 375 px in WebKit/iOS and Chrome Android: the menu closes instantly and taps during
the transition are not lost**; with a slow chunk the hairline appears after 100 ms and the page appears when it
arrives; **with a warm chunk the VT snapshot contains the destination H1 on the first visit** (M5); destination words
and tile veils do not play inside the veil; focus lands on the new H1 (keyboard: ring visible; mouse: no ring); no
unhandled rejection across 50 scripted navigations; Safari 18 and Firefox 144+ animate, older engines swap instantly.
Security: the request object holds primitives computed synchronously, every VT promise handled with narrow
expected-abort filtering + `reportError`, `/admin` excluded, the `cine:navigate` event carries no data; SC-0.

**MOT-12 · W4-10 — Display headings and ornament on the remaining surfaces** (frontend) — files:
`src/pages/home/StorySection.tsx`, `src/pages/sections/ContactSection.tsx`, `src/pages/PortfolioPage.tsx`,
`src/pages/PackagesPage.tsx`. Story H2 and contact H2 (`trigger="reveal"`), portfolio H1 and packages H1
(`trigger="load"`), contact `emblem` (on-dark, draw). Depends: MOT-07, MOT-08. Acceptance: A1–A6; classic DOM identical
(A2 is the key check for this unit); contact band has no overflow at 320 px; the emblem never overlaps the buttons' hit
areas; **the packages H1 is ≥ 4.5:1 at rest, measured against the lightest banner pixel under the scrim** (UX-12).
Security: SC-0.

**Wave 5**

**MOT-10 · W5-02 — Logo intro** (motion) — files: `src/design/cinematic/LogoIntro.tsx`, `src/design/cinematic/intro.css`,
`src/design/classic/LogoIntro.tsx`, `src/App.tsx` (renders `<LogoIntro />` once in the public-shell branch, before the
shell wrapper). Implements §4 as amended (UX-01, UX-11, UX-12). Depends: MOT-03, MOT-04, MOT-07, MOT-08, MOT-09.
Acceptance: A1–A6 plus: plays on a first visit at `/` (and at `/?utm_source=x`); does **not** play on reload,
Back/Forward, `/#contact`, `/portfolio`, same-origin referrer, reduced motion, Save-Data, blocked storage (reason
`storage-unavailable`), hidden tab, **or a new session within 60 days** (reason `seen`); each reason visible in
`data-cine-intro-reason`; **visible sequence ≤ 1.8 s after t0; t0 ≤ 200 ms after the first commit; hero H1 and CTA at
opacity 1 by t0 + 2.2 s on 4× CPU + Fast 4G, entered with the single 400 ms fade**; skip by click/tap/key/wheel/scroll
within ≤ 400 ms; `focusin`, `click` and a navigation finish it at once; **VoiceOver iOS and TalkBack: the first swipe
or double-tap ends the intro and no activation happens under the overlay** (UX-11); a tap never activates the button
beneath; first Tab shows the skip link focused; logo lands exactly on the header logo (≤ 1 px at 320, 375, 768, 1280,
1920); the jank guard fires on two consecutive LoAF entries > 50 ms; a Slow 4G first load abandons the intro
(`logo-not-ready`) without delaying LCP; killing the component (throw in dev) leaves a usable page and releases the
hero hold; intro khatam at 0.35 opacity; LCP per A4; no layout shift. Security: narrow `DOMException`/`TypeError`
catches, stored values limited to `'1'` and a validated day number, same-origin image, no `data:` URI, static mask id,
listeners/timers/observers cleaned, `useAuth()` read only (no new Firebase listener); SC-0.

**MOT-11 · W5-03 — RTL services ticker (gated on the owner's decision)** (motion) — files:
`src/design/cinematic/ServicesTicker.tsx`, `src/design/cinematic/ticker.css`, `src/design/classic/ServicesTicker.tsx`,
`src/pages/HomePage.tsx`. **Precondition (L5)**: the owner's written answer to §9 Q2. Without "keep the ticker", the
unit ships the static band for everyone (the reduced-motion rendering). Implements E10 as amended (UX-18). Depends:
MOT-04, MOT-08. Acceptance: A1–A6; moves rightwards seamlessly (no jump at the loop point at 320–1920 px) on fine
pointers only; static on `(pointer: coarse)`; pause button: 44 × 44 px, keyboard operable, visible focus ring, accessible
name toggles «إيقاف الشريط»/«تشغيل الشريط» with the icon shape; pauses on hover, off-screen and while any dialog or the
mobile menu is open (IO disconnected on unmount — no observers remain after navigating away); reduced motion: one
static wrapped copy, no button; no horizontal page scroll at 320 px; axe: no focusable element inside `aria-hidden`;
copy matches §3.9 exactly. Security: items are compile-time constants; SC-0.

**Wave 6**

**MOT-13 · W6-05 — Release gate: full motion QA matrix + final docs** (frontend) — files: `README.md`,
`src/styles/README.md`, `runs/redo-v2/verification/motion-qa.md`. Runs every A-check on the final build (Chrome,
Safari/iOS, Firefox, Samsung Internet/Android mid-range device or 4× throttle), `audit:parity -- --ref design-classic-v1`
with each difference attributed to a named unit (product units such as W3-16, W3-20 and W4-08 change public pages; the
motion units' own contribution must be zero), Lighthouse mobile for both designs, and the enforced-CSP run on preview
with the red team (0 violations across intro, VT, ticker, khatam and auth flows; TM-14). **Decides the launch design**:
the Train A release (W7-01) ships cinematic only if every A-check passes; otherwise it ships classic and the motion
layer waits for the next release. Updates the README's motion section (motion map, how to tune a token, how to disable
one effect, the §7.4 return commands). Depends: all motion units and W5-04 (README owner in wave 5). Security: confirms
SC-0 across the whole layer by grep (`innerHTML|eval|console\.|dangerouslySetInnerHTML|setAttribute\('style'` = 0 in
`src/design/`); SC-0.

### 8.3 Class and attribute contract (owned by MOT-04, documented by MOT-02)

| Name | Set by | Meaning |
|---|---|---|
| `html[data-design="cinematic"]` | cinematic `boot.ts` | the cinematic layer is present; every cinematic selector requires it |
| `html[data-cine-intro="playing\|leaving\|landing"]` | `LogoIntro` | hero hold (`playing`), header-logo hidden (`playing`, `leaving`) |
| `html[data-cine-intro-reason]` | `LogoIntro` | diagnostic reason (§4.6) |
| `html[data-cine-entry="intro\|vt"]` | `LogoIntro`, `page-transition` | how the current page was entered; suppresses E2/E5/E7 (rev. 2); kept until the next navigation |
| `html[data-cine-vt="forward\|back"]` | `page-transition` | a view transition is running |
| `html[data-cine-vt-pending]` | `page-transition` | a slow route chunk is loading (static hairline) |
| `document` event `cine:navigate` | `page-transition` | a navigation started; `LogoIntro` finishes at once |
| `.cine-words`, `.cine-w`, `--wi`, `[data-cine-trigger]` | `DisplayHeading` | word reveal |
| `.cine-khatam-frame`, `.cine-khatam--*`, `.cine-khatam__ring\|star\|square\|inner\|pupil` | `Khatam` | ornament |
| `.cine-ticker*`, `[data-paused]`, `[data-offscreen]` | `ServicesTicker` | ticker |
| `.cine-intro*`, `[data-phase="wait\|assemble\|leave"]` | `LogoIntro` | intro |
| `--z-intro` | `tokens.css` | 990 |

---

## 9. Open questions (owner or orchestrator)

**Open, need the owner**
2. **Ticker vs D12** (the only question that blocks a motion unit): keep the slow, pausable ticker (moving on
   computers, static on phones), or the static band for everyone? *Default until a written answer:* static band
   (MOT-11 ships it). Also `11-golive-plan.md` §9 Q5.
4. **Hero veil colour** on plain loads (no intro): the photo's own dominant colour (near-black for the current hero) vs
   paper. The owner judges on the preview. *Default:* the photo's colour.

**Decided in rev. 2**
1. Route-change focus management stays cinematic-only (classic is byte-for-byte); back-porting it is a separate,
   owner-approved accessibility change after launch.
3. Intro frequency: once per 60 days per browser (UX-01), plus once per session.
5. New strings «إيقاف الشريط» / «تشغيل الشريط» go to the copy reviewer with MOT-11.
6. Future: an owner-approved, hand-traced vector of the calligraphy would allow true stroke-order writing; the mask
   brushes in §4.3 are replaceable without touching the timeline.
7. Launch order: `deploy:preview:cinematic` for owner review (W5-05), then production through `release.mjs` with the
   owner's typed go-ahead (agents never deploy); the design is decided by MOT-13.
8. CSP enforcement (SEC-07, TM-14): Report-Only at the first production deploy, enforced within 7 days; the cinematic
   build is checked under the enforced policy on preview before launch.
