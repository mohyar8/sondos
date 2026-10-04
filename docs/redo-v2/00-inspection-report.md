# Sundus Yar — Inspection Report (handoff §18)

Date: 2026-09-23 · Code: `C:\Users\azooz\Desktop\sundus-yar\app` · Baseline commit: `d6b7cb2` (untouched handoff zip)
Method: 4 parallel read-only inspectors (booking, admin, auth/email, design) + direct reads. Every claim below
was evidenced with file:line by an inspector; paths are relative to `app/`. No files were modified. `npm ci` /
lint / build have NOT been run yet (handoff §18 forbids installing during inspection).

---

## 1. Important project tree

```
app/
  index.html  vite.config.ts  wrangler.jsonc  eslint.config.js  tsconfig{,.app,.node,.worker}.json
  migrations/  0001_initial.sql == 0002_create_booking_schema.sql (byte-identical)  0003_…  0004_…
  public/images/  brand-logo.jpeg (5000×3245)  portfolio/wedding-01..08.jpeg (~99 MB)  products/* (UNUSED, ~12.6 MB)
  shared/   booking.ts (catalog validation + server-side total)  admin.ts (status machine)  notifications.ts
  src/
    main.tsx  App.tsx (router + public pages + header/footer)  index.css (only global CSS)
    auth/  AuthContext.tsx (provider, the single Firebase listener)  auth-context.ts (types + useAuth)
    api/   bookings.ts  admin.ts
    data/  packages.ts (price catalog)      lib/ firebase.ts
    components/ PackageConfigurator  BookingCalendar  AuthDialog  EmailVerificationGate  MyBookings
                AdminDashboard  BookingActions  BlockedDatesManager   (each with its own .css)
    App.css  assets/{react,vite}.svg  assets/hero.png   <- dead Vite-template leftovers
  worker/   index.ts (router, /api/health, /api/availability)  bookings.ts  profile.ts  auth.ts (jose JWKS)
            admin.ts  admin-workflow.ts  admin-auth.ts  email.ts  email-templates.ts  email-env.d.ts  http.ts
```

## 2. Technologies (locked versions from package-lock.json)

React 19.2.8 · react-dom 19.2.8 · TypeScript 6.0.3 · Vite 8.2.1 · Firebase 12.17.1 · jose 6.2.9 ·
Wrangler 4.124.0 · @cloudflare/vite-plugin 1.53.0 · ESLint 10.8.1 · typescript-eslint 8.67.0 ·
eslint-plugin-react-hooks 7.1.1 · @vitejs/plugin-react 6.0.5. Machine: Node 24.16.0, npm 11.13.0.
Styling: plain CSS, one file per component. No Tailwind, no animation library, no router library.

## 3. Routing (actual)

`src/App.tsx` implements a custom History-API router: one `popstate` listener (App.tsx:756-766, cleaned up),
`handleNavigate` (789-820) ignores modified/middle clicks and `_blank`, `pushState`s, and bumps a `revision`
counter. Routes `/`, `/portfolio`, `/packages`, `/my-bookings`, `/admin`; anything else renders Home
(`getActiveAppPath`, 119-121). Only the active page is mounted (switch 824-853). Titles per route (92-98,
769). Hash targets scroll after render via `requestAnimationFrame` (771-786) — but always `behavior:'smooth'`,
ignoring `prefers-reduced-motion`.

## 4. Authentication architecture (actual)

- `AuthProvider` wraps `<App/>` (main.tsx:9). Exactly ONE `onAuthStateChanged` in src/ (AuthContext.tsx:464),
  subscribed after `setPersistence(browserLocalPersistence)`, unsubscribed in cleanup (:570).
- Profile = GET `/api/profile` (404 `PROFILE_NOT_FOUND` → `profileRequired`). Register: create user →
  displayName → PUT profile → send verification email (AuthContext.tsx:632-770).
- Five context members (`isEmailVerified`, `sendVerificationEmail`, `reloadFirebaseUser`, `refreshIdToken`,
  `checkEmailVerification`) are added by `declare module './auth-context'` inside AuthContext.tsx:41-49
  instead of in auth-context.ts.
- Worker verifies Firebase ID tokens with `jose` remote JWKS (worker/auth.ts:4-139: RS256, aud, iss, exp,
  iat, auth_time). `email_verified` enforced on POST /api/bookings, GET /api/bookings/me and all admin routes;
  intentionally not on /api/profile.
- Admin role = D1 `users.role` only (worker/admin-auth.ts:46-97), read on every request. Profiles are always
  created as `customer`; admins are promoted by manual SQL. The client has NO role check and NO admin nav link.

## 5. Booking flow and where its state lives

All booking state is local to `PackageConfigurator` (draft persisted in localStorage
`sundus-yar-booking-draft-v1`, PC:154-222). Single page: coverage → album (size/photos/pages/box) → prints →
magazine → wooden enlargement → `BookingCalendar` (month view, one-month fetch) → summary → "continue" →
`AuthDialog` gate if needed → review → POST `/api/bookings` → success. The server accepts only
`{eventDate, selection}` and recomputes the total from the shared catalog (shared/booking.ts:559-611) — no
client total is trusted. Insert is atomic (`INSERT…WHERE NOT EXISTS`) and backed by unique indexes.
Prices (src/data/packages.ts): coverage 1600/3200/4800/6400 · album small 450/550/650, medium 750/800/900,
large 850/950/1050 (10/15/20 pages) · prints A6 13, A5 16, A4 20 · magazine 40 + 15/extra page (1–5) ·
wooden 30×40 = 80 · box normal 0 / VIP 200.

## 6. Worker and D1 architecture

One Worker serves the SPA assets (`not_found_handling: single-page-application`) and `/api/*`
(`run_worker_first`). D1 `sundus-yar-bookings`: `users`, `blocked_dates`, `booking_requests` (status CHECK, 9
values), `booking_status_history`. Status machine (shared/admin.ts:6-77):
`pending_review → approved_hold → contract_pending → contract_signed → payment_pending → confirmed`,
`reject` → rejected, `cancel` → cancelled; `expired` exists but nothing produces it. Transitions are atomic
(conditional UPDATE + history INSERT in one batch; admin-workflow.ts:483-552). Blocked dates: Riyadh "today",
single-statement race-safe insert. SQL is fully parameterised; no IDOR found.

## 7. Resend integration status — NOT CONFIGURED

Code is complete: Arabic RTL HTML+text templates for admin-new-booking, customer-received and all 9 statuses,
`escapeHtml` on every customer value, `Idempotency-Key` per transition, `ctx.waitUntil`, 10 s timeout.
But `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL` (+ optional `ADMIN_NOTIFICATION_EMAIL`, `EMAIL_REPLY_TO`)
exist only as optional types in worker/email-env.d.ts; nothing in wrangler.jsonc, no `.dev.vars`, no docs.
Missing config returns silently → today every email is skipped with no log. `worker-configuration.d.ts` is stale.

## 8. Task 16 page split — PRESENT
Four public pages + protected /admin, conditional mounting, required titles, contact-scroll rules, CTA to
`/packages#packages`, `id="packages"` and `id="contact"` all present in App.tsx.

## 9. Permanent auth controls — PRESENT
`NavigationAuthControls` (App.tsx:145-206): disabled placeholder while initializing, «تسجيل الدخول» opens
AuthDialog in account mode, «تسجيل الخروج» with in-flight guard, Arabic failure message, redirect to `/`
from /my-bookings after sign-out. (Copy bug: «حاول» is masculine, App.tsx:289.)

## 10. The three runtime-crash fixes — PRESENT AND VERIFIED
23 `event.target/currentTarget` reads in src/, all synchronous, none inside a functional updater
(PackageConfigurator 1041/1065/1079/1141/844; AdminDashboard 1225/1251/1268 copy to a const first).
Magazine resets to 1 page on add/remove (PC:509-512); admin filters keep YYYY-MM-DD strings and only add valid
dates to URLSearchParams (api/admin.ts:457-486); from>to shows Arabic validation (AdminDashboard.tsx:892).

## 11. Conflicts between the code and the handoff document

| Handoff says | Code actually | Evidence |
|---|---|---|
| "TypeScript in Strict mode" | `strict` is not set in any tsconfig | tsconfig.app/node/worker.json |
| Migrations are the source of truth | 0001 and 0002 are byte-identical plain `CREATE TABLE` → a fresh `migrations apply` fails at 0002, so 0003/0004 never apply | migrations/ |
| Admin "pagination" to preserve | none — hard limit 50, no cursor; older bookings unreachable | AdminDashboard.tsx:609, admin.ts:368 |
| "Preserve the existing admin link" | there is no admin link anywhere; client has no role check | App.tsx:226-248 |
| Wooden enlargement "sizes, variants, images" | one fixed item (30×40, 80 SAR), quantity only | packages.ts:155-160 |
| Hold / expiry behaviour | `hold_expires_at` is written but never enforced; no cron; `expired` never produced; an approved hold blocks the date forever | index.ts exports only `fetch` |
| Product images for packages | all 6 files in public/images/products are unreferenced | grep |
| Email "later task" | confirmed: nothing configured, silent no-op | §7 |

## 12. Defects found (ranked; none fixed yet)

HIGH
1. Duplicate migrations 0001/0002 (above). Production DB state unknown — must check before fixing.
2. Portfolio images 6–23 MB each (~99 MB); the hero (wedding-01, 5036×8953, 23.4 MB) loads eagerly with no
   `srcset`/dimensions. Logo is a 5000×3245 JPEG shown at ~46 px.
3. Stale ID token after email verification: `getIdToken` sends the cached token (AuthContext.tsx:1147-1160);
   server returns 403 → customer locked out of «حجوزاتي» for up to 1 h.

MEDIUM
4. Holds never expire (no `scheduled` handler / cron).
5. Admin action dialog: Escape also closes the whole booking panel mid-submit (AdminDashboard.tsx:812-827 vs
   BookingActions.tsx:219-228) → stale UI while the server may commit and email.
6. Booking impossible if localStorage throws — stage change sits inside the `try` after `setItem` (PC:555-581).
7. Any transient token failure signs the customer out (PC:602-620, 672-679, 740-746).
8. Verification-email send failure is hidden by the gate (EmailVerificationGate.tsx:32-40); profile form has
   no exit (AuthDialog.tsx:853-914).
9. Focus lost on booking stage changes (PC:463-465, 574, 716, 736, 773).
10. `.gitignore` does not cover `.dev.vars*`, `.env*`, `.wrangler/` → secrets could be committed.

LOW
11. Calendar "today" uses browser timezone (frozen at mount) vs server Asia/Riyadh.
12. Missing spaces render «…ر.س.للصفحة الأولى» / «…ر.س.للوحدة» (PC:1109-1110, 1127-1128).
13. Color-only calendar states/legend; day grid has no role (BookingCalendar.css:173-242, BC:466-469).
14. Admin notes: 2000 chars allowed but 4000-byte body cap rejects long Arabic notes.
15. Admin email deep link `/admin?booking=` is ignored.
16. Email tables don't isolate `+966…` (renders `…966+`).
17. Copy: masculine forms (حاول، طلبك، يمكنك), «عرائس» vs «عرايس», «١ صفحات», «{n} طلبات».

## Design-system snapshot (for the redesign)

System fonts only (no Arabic webfont); 128 distinct hex colors; 11 separately written primary buttons; 3
different "accent-dark" values; 15 distinct breakpoints; one radius token; no motion; App.css dead; gallery
spans hard-coded by `:nth-child`; wedding-04/05/07 have wrong orientation classes; contrast fails: portfolio
eyebrow 4.08:1, portfolio intro 4.48:1, input borders 1.52:1. Tone: warm, feminine singular address.

## Brand evidence — Instagram @sndsyar (public profile, viewed 2026-09-23)

Name «سُندس يار» · «مصورة عرايس» · «مصرحة من وزارة العمل» · «جميع الصور تُنشر بموافقة العروس» ·
bookings 0505647418 · TikTok @sndsyar · ~2.3k followers · highlights incl. «لُطفكم» (client kindness —
real testimonials live there; must be supplied by the owner, never invented).
Visual: monochrome calligraphic «سندس» logo with a small flower, "SONDOS YAR PHOTOGRAPHY"; warm golden,
documentary family-emotion photography (fathers, grooms in gold-trimmed bisht, blush florals); brides' faces
are blurred in public posts → privacy is a core brand value.
