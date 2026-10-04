## Local SEO plan — Sundus Yar (المصورة سندس يار), Madinah

Read-only research; no files were changed. Sources actually checked are cited inline. Everything below traces to either (a) code I read in `app/` with file:line, (b) `runs/redo-v2/decisions.md` / `00-inspection-report.md`, or (c) a live WebSearch/WebFetch query listed in §0. Anything not backed by one of those three is in **§12 Unresolved**, not asserted as fact.

**Blocking fact found during research:** `app/wrangler.jsonc` has no `routes` / custom-domain configuration, and no production domain is named anywhere in `decisions.md` or the inspection report. Every absolute URL below therefore uses the placeholder **`https://sndsyar.example`** (`.example` is the IANA-reserved documentation TLD, chosen so it can't be mistaken for a real domain). Swap it everywhere once the real domain is decided — see §12.

---

### 0. What I verified, and how

Code read: `app/index.html`, `app/wrangler.jsonc`, `app/vite.config.ts`, `app/src/main.tsx`, `app/src/App.tsx` (full routing/header/footer/section markup and the title-setting effect), `app/src/data/packages.ts` (full price catalog), `app/worker/index.ts` (confirms the Worker only intercepts `/api/*`), `app/public/` tree.

Keyword/behavior verification (WebSearch, today): `مصورة عرايس المدينة المنورة`, `مصور زفاف المدينة المنورة`, `اسعار تصوير زفاف المدينة المنورة`, `سندس يار مصورة المدينة المنورة انستقرام`, `مصورة نساء فقط عرايس المدينة المنورة بدون رجال`, `باقات تصوير عروس اسعار المدينة المنورة بكج`. I don't have Google Autocomplete/Keyword Planner access in this environment, so this is real-SERP verification (what's actually ranking and how competitors/directories phrase things), not a keyword-volume tool — flagged honestly, not presented as more than it is.

Platform-mechanics verification (WebSearch/WebFetch, today): GBP category list for photographers, GBP service-area-business address rules, Cloudflare Workers `_headers` support, schema.org type validity for "Photographer", and — important, dated — **Google fully deprecated FAQ rich results in May 2026** (removed from Search Console API by Aug 2026); this directly changes how I'm scoping the FAQPage ask below.

---

### 1. Arabic keyword research

Do **not** just translate English photographer SEO terms — the verified Arabic search behavior has its own shape:

- **`مصورة` (feminine) vs `مصور` (masculine/generic) is a real signal, not a grammar detail.** Searches like `مصورة نساء فقط عرايس المدينة المنورة` and `استديو تصوير نسائي` genuinely exist (verified) — Saudi brides specifically search for a *female* photographer for privacy/modesty reasons during prep. Sundus Yar's brand already uses the feminine form everywhere (`مصورة سندس يار`, `مصورة عرايس` in the Instagram bio per the inspection report) — keep it that way; it's doing real targeting work, not just grammatical agreement.
- **`عرايس`/`عروس` (bride-specific) vs `زفاف` (wedding, gender-neutral) are both real, but different competitors own them.** `زفاف` terms are dominated by directories (`zafaf.net`, `nsawer.com`) and classifieds (`haraj.com.sa`). `عرايس` terms surface more individual female photographers' Instagram/TikTok accounts. Sundus Yar is a bride-specific photographer, so `عرايس` phrasing is the better primary fit; `زفاف` is worth a secondary mention for reach.
- **Branded search has a real collision risk.** Searching for the brand pulled up `قاعة سندس للمناسبات` (an unrelated events hall in Madinah, verified) when the query was shortened. Always render/use the full two-word brand `المصورة سندس يار` or `سندس يار مصورة` together in titles, schema `name`, and anywhere the brand is referenced — never just `سندس`.
- **`رخيص/رخيصة` (cheap) modifiers are common in the results but are a strategic trap, not a keyword to chase.** Several ranking pages are literally titled "أرخص 25 مصورة عرايس" — bargain-hunter intent. Optimizing for "cheap" pulls in price-shoppers, which fights a premium, detail-driven brand positioning (per the design-system snapshot in the inspection report). Recommendation: don't target `رخيص`; let `اسعار`/`باقات` (price/packages, neutral) do the commercial-intent work instead.
- **Competitive landscape is winnable.** Most of what currently ranks for these terms is directory listings and content-farm listicles (`companyproductservice.com`, `reviewandblog.com` — phone-number-in-title spam pages), not real photographer websites. A real site with GBP + consistent NAP + genuine on-page content has a realistic shot at outranking these over time (see §9 for the honest timeline).
- **No English-language demand signal found**, and the site is Arabic-only (`index.html:2` `lang="ar" dir="rtl"`, no `/en/` route exists). Hreflang is **not needed today** — a single-language site should not add self-referential hreflang complexity. If an English version is ever built, use `hreflang="ar-SA"` / `hreflang="en-SA"` / `hreflang="x-default"` pairs at that time, not before.
- **URL slugs: keep them as-is.** `/`, `/portfolio`, `/packages` are short, stable, transliterated (not Arabic) slugs already wired into a hand-rolled History-API router (`App.tsx:59-121`) that React Router is forbidden from replacing. Arabic URL slugs carry a marginal keyword-in-URL signal (weak ranking factor) but cost you clean copy-paste in WhatsApp messages and percent-encoding ugliness — not worth the churn or the router rewrite risk here. No change recommended.

Full keyword-to-page list with intent is in the structured `keywords` field of this response.

---

### 2. Keyword → page mapping (summary table)

| Page | Primary intent | Head terms | Notes |
|---|---|---|---|
| `/` | Local + branded, top of funnel | مصورة عرايس المدينة المنورة، مصور زفاف المدينة المنورة، المصورة سندس يار | Eyebrow above H1 already carries the local keyword (`App.tsx:488`) |
| `/portfolio` | Evaluation, visual/informational | أعمال تصوير عرايس المدينة المنورة، افكار تصوير عروس | Generic H1 today (`App.tsx:595`) — see §3 |
| `/packages` | Commercial/transactional | اسعار تصوير عرايس المدينة المنورة، باقات تصوير عروس، حجز مصورة عرايس | H1 topic mismatch today — see §3, highest-value on-page fix found |
| `/my-bookings` | None — private app view | — | noindex, nofollow, excluded from sitemap |
| `/admin` | None — internal tool | — | noindex, nofollow, excluded from sitemap |

---

### 3. Per-page title / meta description / H1

Full detail (including the exact current-vs-proposed H1 diff) is in the structured `page_meta` field. Two concrete on-page findings worth flagging in prose:

1. **`/packages` H1 mismatch.** The page mounts `ProcessSection` then `PackagesSection` (`App.tsx:736-745`). `ProcessSection`'s heading is an `<h1>` reading **"خطوات حجز بسيطة"** ("simple booking steps" — `App.tsx:640`), while the actual pricing/packages content sits under `PackagesSection`'s `<h2>` **"اختاري البكج والتفاصيل المناسبة"** (`App.tsx:669`). So the one H1 that exists on the page targeting `اسعار`/`باقات` intent is topically about the booking process, not packages. Fix: swap heading levels (H1↔H2) between the two, or give `PackagesSection` a more keyword-explicit H1 like **"باقات وأسعار تصوير العروس"** while keeping the current friendly copy as a subheading. This is a same-file, low-risk text/tag-level change.
2. **`/` and `/portfolio` are otherwise clean** — I traced every `<h1>` in `App.tsx` (lines 489, 595, 640) and confirmed each is mounted on exactly one route at a time (the router only mounts the active page, `App.tsx:824-853`), so there is no duplicate-H1-per-page issue despite three `<h1>` literals existing in the file.
3. Character counts above are approximate guides — Google truncates by pixel width, not a fixed count. Re-check each string in a SERP preview tool before shipping.

---

### 4. Open Graph & Twitter Card tags

**The hard SPA constraint:** `index.html` is one static file served for every route not matched by `run_worker_first: ["/api/*"]` (`wrangler.jsonc:8`). Social-share crawlers (WhatsApp, Instagram, X, LinkedIn, Slack) **do not execute JavaScript** — they only ever read this one static `<head>`. So whatever OG tags live in the raw `index.html` are what *any* shared link shows, regardless of which route was actually shared, unless you do the prerender-lite step in §6.4.

**Static baseline — add to `index.html` now** (covers the brand/home case correctly, which is the most likely thing to get shared from WhatsApp/Instagram bio):

```html
<meta property="og:type" content="website" />
<meta property="og:site_name" content="المصورة سندس يار" />
<meta property="og:title" content="المصورة سندس يار | مصورة عرايس في المدينة المنورة" />
<meta property="og:description" content="تصوير عرائس في المدينة المنورة مع المصورة سندس يار. تغطية احترافية ليوم عرسكِ بأسلوب هادئ وأنيق." />
<meta property="og:url" content="https://sndsyar.example/" />
<meta property="og:image" content="https://sndsyar.example/images/og/home-1200x630.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:locale" content="ar_SA" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="المصورة سندس يار | مصورة عرايس في المدينة المنورة" />
<meta name="twitter:description" content="تصوير عرائس في المدينة المنورة مع المصورة سندس يار." />
<meta name="twitter:image" content="https://sndsyar.example/images/og/home-1200x630.jpg" />
<link rel="canonical" href="https://sndsyar.example/" />
```

No X/Twitter account is confirmed to exist for this brand — include the `twitter:` tags anyway, they're also read as a fallback by Slack/Discord/LinkedIn link previews, not just X.

**OG image asset needed:** none of the current or incoming images are a 1200×630 (1.91:1) crop. Recommend exporting one from the new privacy-safe detail-shot set described in `decisions.md` (e.g., the 16:9 hand/henna detail shot, `2M4A0708 ابيض copy.avif` per the owner's photo list) rather than the 5000×3245 `brand-logo.jpeg` — stays on-brand with the "no bride faces" privacy value and looks like a real photo, not a logo card. This is an image-pipeline task (coordinate with whoever runs the `sharp` pipeline approved in D1), not something I can produce here.

Per-route enhancement (so Google specifically — which does render JS — gets the right `og:url`/canonical per page even before any prerender step) is covered by the same mechanism as canonical/description in §6.2.

---

### 5. Structured data (JSON-LD) proposal

**Important, current caveat before anything else:** Google fully deprecated **FAQ rich results in Search on 7 May 2026**, and removed FAQ support from Search Console/the Rich Results Test by June–Aug 2026 (verified live, today). `FAQPage` is still valid schema.org markup and doesn't hurt anything, but **do not promise the client a FAQ dropdown in Google search results** — that feature is gone, for everyone, not just this site. Reasons to still add it: (a) it's cheap, (b) some non-Google surfaces / AI answer engines still parse it, (c) the visible FAQ copy itself is good long-tail content regardless of the schema. Set expectations accordingly.

**Also important:** structured data must describe content that's actually visible on the page. The `FAQPage` questions below need a real, visible FAQ section added to `/packages` — there's no FAQ UI on the site today (I checked; `ProcessSection` is a 4-step list, not Q&A). This is a small content addition, not a schema-only task.

**5.1 — LocalBusiness / ProfessionalService** (place on `/`, static in `index.html` or injected once at app root — this doesn't change per route):

Schema.org has **no dedicated "Photographer" business type** (verified) — the documented pattern for photography businesses is `LocalBusiness` + `ProfessionalService`. No street address is used deliberately: the footer today only publishes `"المدينة المنورة، المملكة العربية السعودية"` (`App.tsx:449`, no street), matching the privacy-first brand value and Google's own guidance for a **service-area business** (no public storefront → hide address, use `areaServed` instead — verified). Do not invent geo-coordinates.

```json
{
  "@context": "https://schema.org",
  "@type": ["LocalBusiness", "ProfessionalService"],
  "@id": "https://sndsyar.example/#business",
  "name": "المصورة سندس يار",
  "alternateName": "Sondos Yar Photography",
  "description": "مصورة عرايس في المدينة المنورة، تقدّم تغطية تصوير يوم العرس وباقات ألبومات ومطبوعات.",
  "url": "https://sndsyar.example/",
  "telephone": "+966505647418",
  "priceRange": "$$",
  "areaServed": { "@type": "City", "name": "المدينة المنورة" },
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "المدينة المنورة",
    "addressCountry": "SA"
  },
  "sameAs": [
    "https://www.instagram.com/sndsyar/",
    "https://www.tiktok.com/@sndsyar"
  ]
}
```

Notes on specific fields:
- `telephone` uses E.164 (`+966505647418`) matching the number already used in the WhatsApp link (`App.tsx:103`) — note the visible footer label only shows the local format `0505647418` (`App.tsx:458`), a minor NAP-formatting inconsistency worth a one-line polish, not urgent.
- `priceRange` is deliberately kept as a generic `"$$"` tier rather than a number range. The real numbers (§5.2) are scoped per service so nothing implies "a full package costs 1600 SAR" when that's actually just the cheapest coverage tier alone.
- `logo`/`image` intentionally omitted from this example — the only current brand image is a 5000×3245 JPEG (`brand-logo.jpeg`) already flagged in the baseline as oversized; add `logo` once a properly sized export exists.
- Do **not** add a licensing claim (`"مصرحة من وزارة العمل"`) to this schema or the site. That string is currently only in the Instagram bio per the inspection report, not on the website, and legal/licensing claims must be exact and owner-confirmed — see §12.

**5.2 — Service / OfferCatalog** (pairs with the LocalBusiness block; mirrors `src/data/packages.ts` exactly — real, preserved prices, not invented):

```json
{
  "@context": "https://schema.org",
  "@type": "Service",
  "serviceType": "تصوير عرائس",
  "provider": { "@id": "https://sndsyar.example/#business" },
  "areaServed": { "@type": "City", "name": "المدينة المنورة" },
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "باقات وخيارات تصوير العروس",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "تغطية ساعتان" }, "price": "1600", "priceCurrency": "SAR" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "تغطية 4 ساعات" }, "price": "3200", "priceCurrency": "SAR" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "تغطية 6 ساعات" }, "price": "4800", "priceCurrency": "SAR" },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "تغطية 8 ساعات" }, "price": "6400", "priceCurrency": "SAR" },
      {
        "@type": "Offer",
        "itemOffered": { "@type": "Service", "name": "الألبوم الصغير (23 × 32 سم)" },
        "priceSpecification": { "@type": "PriceSpecification", "minPrice": 450, "maxPrice": 650, "priceCurrency": "SAR" }
      }
    ]
  }
}
```

Extend the same `Offer`/`PriceSpecification` pattern for the medium/large album, prints, magazine and wooden-enlargement tiers using the exact figures already in `src/data/packages.ts:14-160` — not reproduced in full here to keep this example readable.

**5.3 — FAQPage** (place on `/packages`, next to a new visible FAQ section; every answer below is traceable to real code/copy, nothing invented):

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "ما مدة تغطية التصوير المتاحة؟",
      "acceptedAnswer": { "@type": "Answer", "text": "تتوفر تغطية من ساعتين حتى 8 ساعات، تختارين المدة المناسبة لبرنامج يوم عرسكِ." }
    },
    {
      "@type": "Question",
      "name": "هل يمكن تخصيص حجم الألبوم وعدد صفحاته؟",
      "acceptedAnswer": { "@type": "Answer", "text": "نعم، تتوفر ثلاثة أحجام للألبوم (صغير، وسط، كبير) بعدد صفحات 10 أو 15 أو 20 صفحة، مع ألبوم صغير مرافق." }
    },
    {
      "@type": "Question",
      "name": "كيف تسير خطوات الحجز؟",
      "acceptedAnswer": { "@type": "Answer", "text": "تختارين تفاصيل التغطية والألبوم، ثم تحددين التاريخ وترسلين الطلب. يُراجع طلبكِ أولًا، وبعد اعتماده يصلكِ التأكيد وتعليمات العربون لإكمال الحجز." }
    },
    {
      "@type": "Question",
      "name": "هل السعر الظاهر عند تصميم الباقة نهائي؟",
      "acceptedAnswer": { "@type": "Answer", "text": "السعر الظاهر تقديري بحسب اختياراتكِ، ويُعتمد السعر النهائي عند تأكيد الحجز." }
    }
  ]
}
```

(Q3's answer is close to verbatim existing copy at `App.tsx:650-652`; Q4 is a safe restatement of the existing "السعر التقديري" label at `App.tsx:671-672`.) Four more FAQ candidates exist but are **withheld from this proposal** because the facts aren't settled yet — see §12 (deposit amount/refundability, women-only claim, service area beyond Madinah, selection/turnaround timing).

---

### 6. Technical SEO for a client-rendered SPA on Cloudflare Workers

Be honest about the architecture: one `index.html`, titles set by JS per route (`App.tsx:769`), no SSR, `not_found_handling: "single-page-application"` (`wrangler.jsonc:7`) meaning **every unmatched path returns HTTP 200 with the same shell** — including typos, which shows up as "soft 404" noise in Search Console. That's an accepted platform trade-off given React Router is forbidden and a custom History-API router is already built (`App.tsx:59-121`); not something to "fix," just something to monitor periodically.

**6.1 — What's already right, and can be extended, not replaced.** `App.tsx:768-787` already has exactly the right pattern: a `useEffect` keyed on `activePath` that sets `document.title`. Extend this same effect for description/canonical/robots-meta/JSON-LD instead of inventing new architecture:

```ts
// Illustrative extension of the existing effect at App.tsx:768-787 — not a file edit, a sketch for whoever implements it
const pageSeo: Record<PublicPath, { description: string; robots?: string }> = {
  '/': { description: '…' },
  '/portfolio': { description: '…' },
  '/packages': { description: '…' },
  '/my-bookings': { description: 'صفحة خاصة لإدارة الحجز.', robots: 'noindex, nofollow' },
}

useEffect(() => {
  document.title = pageTitles[activePath]

  const descriptionTag = document.querySelector('meta[name="description"]')
  const seo = activePath in pageSeo ? pageSeo[activePath as PublicPath] : undefined
  if (descriptionTag && seo) descriptionTag.setAttribute('content', seo.description)

  let canonicalTag = document.querySelector('link[rel="canonical"]')
  if (!canonicalTag) {
    canonicalTag = document.createElement('link')
    canonicalTag.setAttribute('rel', 'canonical')
    document.head.appendChild(canonicalTag)
  }
  canonicalTag.setAttribute('href', `https://sndsyar.example${activePath}`)
  // ...existing hash-scroll logic unchanged below...
}, [activePath, browserLocation.hash, browserLocation.revision])
```

Google specifically **does** render JavaScript and does read the post-render DOM for title/description/canonical/JSON-LD (documented, long-standing behavior) — so this covers Google. It does **not** cover non-JS crawlers or social-share bots — that's §6.4.

**6.2 — `robots.txt`** (new static file at `public/robots.txt` — confirmed safe: the Worker only intercepts `/api/*` per `run_worker_first` in `wrangler.jsonc:8`, so any literal file in `public/` is served directly by Cloudflare's static-asset layer before the SPA fallback ever triggers):

```
User-agent: *
Allow: /
Disallow: /my-bookings
Disallow: /admin

Sitemap: https://sndsyar.example/sitemap.xml
```

Correction to a common misconception, stated explicitly because the nav literally links to `/my-bookings` (`App.tsx:239-241`, "حجوزاتي"): **`Disallow` stops crawling, it does not guarantee a URL stays out of the index** if it's linked from elsewhere — Google can still index a disallowed URL with no snippet. The actual noindex control is §6.3.

**6.3 — `public/_headers`** (Cloudflare Workers-with-assets natively support `_headers`/`_redirects` in the static asset directory — verified live). This is the authoritative noindex mechanism because it doesn't depend on JS execution timing at all:

```
/my-bookings
/my-bookings/*
/admin
/admin/*
  X-Robots-Tag: noindex, nofollow
```

Confidence note, stated honestly: Cloudflare's docs confirm `_headers` applies to "static asset responses" and explicitly do **not** apply to responses your Worker code generates. Since `/my-bookings` and `/admin` are *not* handled by `worker/index.ts` (it only matches `/api/*`, confirmed by reading the file) they're served by the built-in SPA-fallback asset handler, which I'm confident counts as a "static asset response" — but this exact interaction (path-pattern matching against the SPA fallback specifically) isn't spelled out word-for-word in Cloudflare's docs. **Verify with `curl -I https://<domain>/admin` after the first deploy** and confirm the header is present; if it isn't, fall back to (a) the client-side `<meta name="robots">` injection in the §6.1 sketch as a second layer, which is why both are recommended together, not either/or.

**6.4 — canonical.** Self-referencing absolute URL per route via the §6.1 mechanism. The static `index.html` baseline canonical should point to `/` (the safest default for the raw, pre-JS file, which is also what `/my-bookings` and `/admin` serve before any script runs).

**6.5 — sitemap.xml** (new static file at `public/sitemap.xml`, three URLs only — `/my-bookings` and `/admin` must never appear here):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://sndsyar.example/</loc><priority>1.0</priority></url>
  <url><loc>https://sndsyar.example/packages</loc><priority>0.9</priority></url>
  <url><loc>https://sndsyar.example/portfolio</loc><priority>0.8</priority></url>
</urlset>
```

`lastmod` deliberately omitted rather than filled with a guessed date — add it at build/deploy time if the pipeline can generate a real one. `changefreq`/`priority` are largely ignored by Google today; harmless to include for other consumers.

**6.6 — image alt-text strategy.** Current pattern is generic and repeats across all 8 gallery images (`App.tsx:19-56`): *"صورة مختارة من أعمال تصوير العرائس للمصورة سندس يار — اللقطة [الأولى/الثانية/...]"* — same boilerplate with only the ordinal changing, describes nothing about what's actually in the photo. Same issue on the hero image alt (`App.tsx:518`). This under-serves both accessibility (screen-reader users learn nothing about the image) and image search (Google Images rewards specific, descriptive alt text). Proposed template: **`[what's actually visible] — تصوير عرائس، المصورة سندس يار، المدينة المنورة`**, using the real photo descriptions already documented in `decisions.md`'s owner-photo inventory, e.g.:
  - "يد العريس تمتد نحو يد العروس المزينة بالحناء بكم أحمر وذهبي — تصوير عرائس، المصورة سندس يار، المدينة المنورة" (for the `2M4A0708` detail shot)
  - "خاتمان على قماش الساتان خلال تصوير العروس — تصوير عرائس، المصورة سندس يار، المدينة المنورة" (for `2M4A4068`)
  - "فستان الزفاف معروض أسفل قوس مزيّن بالورود — تصوير عرائس، المصورة سندس يار، المدينة المنورة" (for `2M4A1262`)
  This is a template + worked examples, not final copy — exact filenames/alt text is Run 2/3's job once photos are moved into `public/` with clean slugs (per `decisions.md`).

**6.7 — Core Web Vitals targets** (current standard thresholds — "good"): **LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1**. Tied to two defects the inspection report already logged, cross-referenced here because Core Web Vitals is a confirmed Google ranking signal:
  - The hero image is almost certainly the LCP element on `/` and is currently `wedding-01.jpeg` at 5036×8953px / 23.4MB, loaded with no `loading`, no `width`/`height`, no `fetchpriority` (`App.tsx:516-519`, inspection report defect #2). This alone will blow the LCP budget. The owner's new AVIF set (77–617KB, pre-sized 1920×1080 for the 16:9 slot) is the fix once moved into `public/` — flag `fetchpriority="high"` and explicit `width`/`height` for whichever image becomes the new hero, and keep `loading="lazy"` on below-the-fold gallery images (already correctly set at `App.tsx:608`).
  - The build baseline shows one 470.79KB JS chunk carrying admin, booking and Firebase code on the home page load (`decisions.md` baseline). This delays interactivity and hurts INP. This is squarely a performance-auditor task (code-splitting), flagged here only because of its direct CWV/ranking impact — coordinate, don't duplicate that work.
  - Tooling note: Google retired the standalone Mobile-Friendly Test tool; use PageSpeed Insights/Lighthouse mobile audit and Search Console's Core Web Vitals + mobile-usability reports instead.

**6.8 — is a prerender step worth it? (honest, tiered verdict)**
  - **Tier 0 — do this, near-zero cost:** the §6.1 JS-based per-route meta/canonical/JSON-LD extension. Covers Google (which renders JS) for all three public routes, plus the noindex safety net for the two private routes. No new dependency.
  - **Tier 1 — recommended, small effort, still no new dependency:** a build-time "prerender-lite" script (plain Node `fs` string templating, run after `vite build`) that copies the built `index.html` into `dist/portfolio/index.html` and `dist/packages/index.html`, swapping only the `<title>`/`<meta>`/OG/canonical/JSON-LD block per route while pointing at the same JS/CSS bundle. This is what actually fixes the social-share-preview problem (§4) and gives non-JS crawlers (some AI/answer-engine bots don't render JS) correct `<head>` content immediately, without touching the React component tree at all. Roughly half a day of work; worth doing before launch.
  - **Not recommended right now: full content-in-HTML prerendering** (SSG plugin, `react-dom/server`, or a headless-browser snapshot). This would need a new dependency (owner approval required per the binding constraints), and is genuinely awkward here because `App` is wrapped in `AuthProvider` (`main.tsx:9`) which starts a real Firebase `onAuthStateChanged` listener (`AuthContext.tsx:464`) — rendering that tree outside a browser needs careful mocking to avoid either crashing the build or baking in stale auth state. For a 3-page marketing site where Google already reliably renders JS, the ROI doesn't clear the risk today. Revisit only if AI-crawler/answer-engine visibility becomes a measured priority later.

---

### 7. Google Business Profile checklist

Set up as a **Service-Area Business** (verified Google guidance: no public storefront with signage → hide the address, list service area instead; a home/studio-based photographer is explicitly one of Google's own examples of this business type).

- **Business name field:** exactly `المصورة سندس يار` — nothing appended. Verified rule: GBP explicitly prohibits keyword-stuffing the name field (e.g., `المصورة سندس يار - مصورة عرايس المدينة المنورة`) and this risks suspension, not just a style nitpick.
- **Address:** hidden; service area = المدينة المنورة. Confirm with the owner whether to add neighboring areas (unresolved, §12).
- **Primary category:** "Wedding Photographer" (confirmed to exist as a GBP category). Verify the exact Arabic label shown in your specific dashboard's category picker before saving — UI strings shift and I can't pixel-verify it from here.
- **Secondary categories:** "Photographer" and, if it matches reality, "Portrait Studio" — add only categories that reflect services actually offered.
- **Phone:** `+966 50 564 7418` (same number already used for WhatsApp, `App.tsx:103`) — confirm this number is actively monitored as a business line before publishing it as the GBP phone.
- **Website URL:** the production domain root once decided (§12) — do not launch GBP pointed at a `*.workers.dev` URL if avoidable.
- **Description:** third-person, fact-only, e.g.: *"تصوير عرائس في المدينة المنورة. تغطية ليوم العرس، وباقات ألبومات ومطبوعات. التواصل والحجز عبر الموقع الإلكتروني وواتساب."* — no invented years-of-experience or client counts.
- **Services section:** mirror the real catalog — تغطية العروس (بالساعة)، ألبومات، مطبوعات، مكبّرات خشبية — pulled straight from `src/data/packages.ts`.
- **Photos:** logo + cover photo + a set of real work photos. Reuse the same privacy-safe detail shots going onto the website (no bride faces, per the brand's own stated value) rather than sourcing anything new.
- **Booking/website link:** point to `/packages#packages` — this exact anchor is already the site's real booking CTA target in three places (`App.tsx:410, 505, 575`).
- **Attributes:** check the dashboard for a women-owned/women-led attribute and an "by appointment only" attribute if accurate — I won't assert the exact current attribute string without seeing your live dashboard.
- **Reviews — process, not numbers.** No review count exists to cite and none should be invented. Tactic, directly grounded in the product roadmap already documented in `decisions.md` step 8 ("بعدها: شكر، طلب تقييم" — thank-you + feedback request after handover): once that flow ships, have the post-handover WhatsApp message include a direct GBP review link. That's the natural, highest-response-rate moment to ask — don't ask earlier in the journey.
- **NAP consistency check:** name/phone format/city string should match exactly across the site footer, JSON-LD, GBP, and the Instagram bio once all are live.

---

### 8. Instagram / TikTok linking

Checked: **zero links to Instagram or TikTok exist anywhere in the current codebase** (grepped `src/` for `instagram|tiktok|sndsyar` — only the WhatsApp number and link exist, footer at `App.tsx:441-467`). The brand has a real, active Instagram (`@sndsyar`, ~2.3k followers per the inspection report's verified brand-evidence section) and TikTok (`@sndsyar`) that the website currently does nothing with. This is close to a free win:

- Add icon links next to the existing WhatsApp link in `SiteFooter` (`App.tsx:441-467`) — real `<a>` tags, `target="_blank" rel="noopener noreferrer"`, proper Arabic `aria-label` (e.g., `"المصورة سندس يار على إنستغرام"`), pointing to `https://www.instagram.com/sndsyar/` and `https://www.tiktok.com/@sndsyar`. Verify these resolve correctly before shipping — I relied on the inspection report's direct verification (dated today) rather than my own browsing, which is disallowed for this task anyway.
- Mirror both URLs in `sameAs` on the LocalBusiness JSON-LD (already included in §5.1) — this is also how Google Business Profile typically surfaces social links automatically, rather than through a distinct manual GBP field.
- **Direction that matters at least as much: the Instagram/TikTok bio link pointing back to the site.** With ~2.3k already-engaged local followers, fixing the bio link is a faster lead lever than organic SEO for months (see §9). I can't check or change the current bio link from here — flagged in §12 as an owner action, with a suggested UTM tag (`?utm_source=instagram&utm_medium=bio`) so Instagram-driven traffic is measurable once it's live.
- Honest framing: TikTok/Instagram links help trust, brand recall, and conversion; they are not a meaningful direct Google-ranking input. Don't oversell them as an SEO tactic — sell them as a distribution/conversion tactic, which is what they actually are.
- Once D7 (real testimonials, currently only PROPOSED per `decisions.md`) is approved, the Instagram "لُطفكم" highlight is the source — that's a copywriting task for later, not something to draft here without owner sign-off.

---

### 9. Honest expectations

Organic ranking for the competitive head terms (`مصورة عرايس المدينة المنورة` and family) realistically takes **months**, not weeks — the current top results include established directories with years of domain history. Nothing in this plan changes that; on-page/technical work is necessary groundwork, not a shortcut.

**For leads now** (the client needs bookings, not a 6-month content calendar): the fastest real levers, in order, are (1) GBP fully set up as above — Maps/local-pack visibility can move much faster than organic web ranking, (2) fixing the Instagram/TikTok bio links to point at the live site — that's an existing, already-engaged audience, not a cold one, (3) the `/packages` page itself being fast, correctly titled, and one clear WhatsApp/booking CTA away from conversion. A multi-month blog/content plan is **not** the recommendation for this launch — revisit content marketing only after GBP + the three core pages are live and converting.

---

### 10. Prioritized fix list with effort estimates

| Priority | Item | Effort | Where |
|---|---|---|---|
| High | Confirm production domain (blocks every absolute URL below it) | Owner decision | — |
| High | Static meta baseline in `index.html`: description, canonical, OG/Twitter, favicon path fix | S (1–2h) | `app/index.html` |
| High | Add `public/robots.txt` + `public/sitemap.xml` | S (30–60m) | `app/public/` |
| High | Add `public/_headers` with `X-Robots-Tag: noindex` for `/my-bookings`, `/admin`; verify via `curl -I` post-deploy | S (30m + verification) | `app/public/_headers` (new) |
| High | Extend the existing per-route `useEffect` (App.tsx:768-787) for description/canonical/robots-meta/JSON-LD | M (2–4h) | `app/src/App.tsx` |
| High | Fix `/packages` H1/H2 mismatch (§3) | S (30m) | `app/src/App.tsx:640, 669` |
| High | Add Instagram/TikTok links to footer | S (30–60m) | `app/src/App.tsx:441-467` |
| High | Fix favicon reference (`index.html:6` wrong relative path; also causes a 510KB duplicate build asset per the baseline) — point to the already-existing but unused `public/favicon.svg` | S (15m) | `app/index.html:6`, coordinate with performance-auditor |
| Medium | Rewrite gallery/hero alt text to be descriptive per §6.6 | M (2–3h, depends on Run 2/3's final photo set) | `app/src/App.tsx:16-57, 518` |
| Medium | Hero image LCP fix: dimensions, `fetchpriority`, swap to new optimized AVIF | M | Coordinate with performance-auditor / image pipeline (D1) |
| Medium | New visible FAQ section on `/packages` + FAQPage JSON-LD (§5.3) | M (content + component, not schema-only) | New section in `app/src/App.tsx` |
| Medium | Build-time prerender-lite script (§6.8 Tier 1) | M (~half day) | New build script, no new dependency, needs sign-off since it touches the build pipeline |
| Medium | Export a 1200×630 OG share image from the new photo set | S–M (~1h) | Image pipeline |
| Medium | Full GBP profile setup per §7 | M (owner/admin time, not dev) | Google Business Profile dashboard |
| Low | Full content-in-HTML prerendering (SSG/headless) | Not recommended now — see §6.8 | — |
| Low | Footer phone format consistency (`+966` vs local format) | Trivial | `app/src/App.tsx:458` |
| Low | Multi-month content/blog plan | Defer — see §9 | — |

---

### 11. Launch SEO checklist

- [ ] Production domain decided and wired into every URL above
- [ ] `index.html` static meta (title, description, canonical, OG, Twitter, fixed favicon) shipped
- [ ] `public/robots.txt` and `public/sitemap.xml` deployed and reachable
- [ ] `public/_headers` noindex confirmed live via `curl -I` on `/my-bookings` and `/admin`
- [ ] Per-route description/canonical/JSON-LD wired via the extended `useEffect`
- [ ] `/packages` H1/H2 fixed
- [ ] LocalBusiness + Service JSON-LD live on `/`; FAQPage JSON-LD + matching visible FAQ live on `/packages`
- [ ] Instagram + TikTok links live in footer; `sameAs` added to schema
- [ ] Instagram/TikTok bio links confirmed pointing at the live production domain
- [ ] Hero image fixed for LCP (dimensions + fetchpriority + optimized source)
- [ ] Gallery/hero alt text rewritten to be descriptive, not boilerplate
- [ ] Google Business Profile fully built per §7 and submitted for verification
- [ ] Site submitted in Google Search Console (and Bing Webmaster Tools) with sitemap
- [ ] Mobile usability + Core Web Vitals checked in PageSpeed Insights before calling launch done

---

### 12. Unresolved — owner must decide (each with a proposed default)

1. **Production domain.** Nothing configured in `wrangler.jsonc`, none named in `decisions.md`. *Proposed default: none — this needs an explicit decision before any URL in this document goes live; treat as blocking.*
2. **Is the shoot women-only / male-free?** Real, verified search intent for this (`مصورة نساء فقط`), but not documented anywhere in the codebase or inspection report. *Proposed default: do not publish this claim until confirmed; omit from meta/FAQ/GBP attributes in the meantime.*
3. **Geographic service area beyond Madinah** (travel fee, nearby cities)? Affects GBP service-area list and whether to target any keywords outside Madinah. *Proposed default: Madinah only, until told otherwise.*
4. **Deposit amount/percentage and refund policy** — D4 in `decisions.md` is explicitly OPEN. Cannot appear in FAQ/schema until decided. *Proposed default: keep this FAQ question unpublished until D4 resolves.*
5. **Selection window / turnaround / retention timing** — D5 in `decisions.md` is PROPOSED, not decided (14-day selection, 30-day retention, etc.). *Proposed default: don't state specific day-counts publicly until D5 is formally decided; if asked, keep language vague ("خلال مدة تُحدد بعد التصوير") rather than a number.*
6. **Exact current licensing wording** ("مصرحة من وزارة العمل" per the Instagram bio) — authority names and licensing status can change and must be exact if published as a claim on-site or in schema. *Proposed default: do not add a licensing claim to the website/schema until the owner supplies current, exact wording.*
7. **What does the Instagram/TikTok bio link currently point to?** Can't check from here (no browser access permitted for this task). *Proposed default: once the production domain is live, point both bio links to the homepage with a UTM tag for measurement.*
8. **GBP service-area radius / neighboring cities**, and the exact Arabic category label shown in the live GBP category picker — both need to be confirmed by whoever has dashboard access. *Proposed default: Madinah city only; primary category "Wedding Photographer" / closest exact Arabic match.*
9. **Real testimonial content** — D7 in `decisions.md` is PROPOSED (owner's Instagram "لُطفكم" highlight as source). Not drafted here; must come from the owner, never invented. *Proposed default: hold off on any testimonial section/schema (`Review`/`AggregateRating`) until D7 is decided and real content is supplied.*

