# 13 — Threat model (STRIDE) for the go-live features and the motion layer

| | |
|---|---|
| Date | 2026-09-28 |
| Author role | Application-security architect (threat modelling before any code is written) |
| Inputs read | `11-golive-plan.md` (all 1,126 lines), `12-motion-spec.md` (all 1,214 lines), `app/worker/**` at `c80f4c2` (auth, admin-auth, admin, admin-workflow, bookings, profile, http, index, scheduled, jobs, notify/outbox, portal/gates, portal/request, portal/portal-routes, portal/admin-portal-routes), `app/migrations/0001`, `0005`, `app/wrangler.jsonc`, `app/public/_headers`, and the findings index of `10-security-baseline.md` for cross-reference |
| Writes | Only this file. Nothing under `app/` was changed. Nothing was executed against any remote system |
| Relationship to the plan | This document is the G0-2 deliverable in substance (11 §5.4 names `security/golive/w0-threat-model.md`; the orchestrator asked for this path instead). Every abuse case G0-2 lists is covered in §8 |
| Verdict | **GO-WITH-FIXES.** The plan's controls are strong where it has them (append-only settings, re-auth enforced by a DB CHECK, SQL predicates, gate v2, CSV neutralisation). It has four structural gaps: (1) none of the go-live blockers in `10-security-baseline.md` is scheduled; (2) G1-12 promotes the admin **by email**, a known path to admin takeover; (3) customer-visible admin text that needs no re-auth can carry payment instructions, which gets around the re-auth that protects the bank section; (4) the motion plan adds a second production deploy path that skips the go-live preflight. All four can be fixed by amending the plan before wave 1. |

---

## Contents
1. [Scope, method, assumptions](#1-scope-method-assumptions)
2. [System model and trust boundaries](#2-system-model-and-trust-boundaries)
3. [Attackers](#3-attackers)
4. [Assets](#4-assets)
5. [Controls that already exist or are planned (preserve)](#5-controls-that-already-exist-or-are-planned-preserve)
6. [STRIDE by component](#6-stride-by-component)
7. [Focus areas in depth](#7-focus-areas-in-depth)
8. [Abuse cases → controls](#8-abuse-cases--controls)
9. [Required controls (TM-nn)](#9-required-controls-tm-nn)
10. [New negative tests for RV/red teams (N-31 …)](#10-new-negative-tests-for-rvred-teams-n-31-)
11. [Plan amendments that need the owner's approval](#11-plan-amendments-that-need-the-owners-approval)
12. [Residual risks (accepted or out of scope)](#12-residual-risks-accepted-or-out-of-scope)

---

## 1. Scope, method, assumptions

**In scope.** Every feature that 11 adds (endpoints #1–#40, migration 0007, the jobs, the admin portal tabs, the customer stage views, the scripts), plus the motion layer of 12 (design switch, intro, view transitions, ticker, CSS/JS under `src/design/`, `build-design.mjs`, `motion-audit.mjs`).

**Method.**
- STRIDE per component and trust boundary (§6), then a deeper look at each focus area the orchestrator named (§7).
- Each threat is tagged with its attacker (§3), its current or planned control (citing a unit id or a file), the gap, and a required control id (TM-nn, §9).
- Severity uses the baseline's scale: **BLOCKER** (release cannot proceed), **HIGH** (fix before the unit that introduces the surface merges), **MEDIUM** (fix before go-live), **LOW** (hardening/recommended).

**Assumptions (checked in code where possible).**
- A1 Auth is a Firebase ID token in `Authorization: Bearer`. There are no cookies and no CORS headers, so there is **no CSRF surface** on the API (verified: `worker/http.ts`, no `Access-Control-*` anywhere).
- A2 D1 serialises writes, and a `batch()` is one transaction, so a single conditional `INSERT … SELECT`/`UPDATE … WHERE` is atomic (the plan's E4 relies on this, and it holds).
- A3 Production at go-live runs with `ONLINE_CONFIRMATION="on"`, no R2 binding, no `PDPL_SIGNOFF_REF`, no `MEDIA_SIGNING_KEY`, no email provider (11 §4.2, §7.4). Private media is therefore **off**. The gated threats are still modelled, because the code is built and shipped (dark).
- A4 One admin (0007 `ux_users_single_admin`). The admin role is read from D1 on every request (`worker/admin-auth.ts:88`).
- A5 A **new** Firebase project and a **new** production D1 at launch (11 §7.2–7.3). The "owner not yet registered" window from baseline SEC-01 therefore **re-opens** at launch.
- A6 Firebase ID tokens live about 60 minutes. The Worker does no revocation check (`worker/auth.ts`, baseline SEC-11).

---

## 2. System model and trust boundaries

```
 [Anonymous browser]──TB1──┐
 [Customer browser]──TB1───┤  static assets + _headers (CSP, XFO)     ┌──────────── TB4 ─────────────┐
 [Admin browser]────TB1────┼──► Cloudflare edge ──► Worker (API, cron) ├─► D1 (bookings, settings,     │
      │  │                 │    run_worker_first: /api/*               │   terms, audit, outbox)      │
      │  └─TB2─► Firebase Auth (sign-in, re-auth, TOTP; JWKS)◄─TB3─────┤─► R2 MEDIA (gated, absent)   │
      └──TB5─► wa.me / WhatsApp (out of band, unauthenticated)         │─► Resend (absent at launch)  │
 [Operator laptop]──TB6─► wrangler / Cloudflare dashboard / Firebase console (deploy, D1 execute, secrets)
```

| TB | Boundary | What crosses it | Trust decision today |
|---|---|---|---|
| TB1 | Browser ↔ Worker | JSON bodies, multipart uploads, path ids, query strings, bearer tokens | Server re-validates everything: exact keys, byte caps, SQL predicates |
| TB2 | Browser ↔ Firebase | password, TOTP, refresh token (IndexedDB) | Firebase's own controls; the refresh token persists on the device |
| TB3 | Worker ↔ Firebase JWKS | public keys | `jose` RS256, iss/aud pinned, `auth_time` required |
| TB4 | Worker ↔ D1/R2/Resend | bound SQL, object bytes, email payloads | Worker is fully trusted; DB CHECKs and triggers are the last line of defence |
| TB5 | Site ↔ WhatsApp | prefilled text, phone numbers, receipts sent by customers | **Nothing** from WhatsApp is authenticated; it is a social channel |
| TB6 | Operator ↔ Cloudflare/Firebase | deploys, vars, secrets, `d1 execute`, role promotion | Whoever holds the account holds everything; triggers can be dropped |

Data flows that matter most for fraud:
- **F1 bank details**: admin PUT `/settings/bank` (AD+R) → `settings_revisions` → customer GET `/confirmation`, but only after accepting the terms and only while a deposit is owed → the customer's bank app.
- **F2 studio WhatsApp number**: admin PUT `/settings/contact` (AD+R) → `/api/bookings/me.studio` → `wa.me` links in the hub.
- **F3 customer-visible admin text**: pickup address/instructions (AD only), delivery-area names (AD only), receipt rejection reasons (AD only, gated), terms (AD+R) → customer views.
- **F4 PII**: profile (names, phone, email), event profile, delivery address → admin portal, queue, CSV export, WhatsApp templates.

---

## 3. Attackers

| Id | Attacker | Capabilities | Typical goals |
|---|---|---|---|
| **X1** | Anonymous internet user | Public site, public Firebase web config (API key, project id), REST sign-up, any HTTP client, lookalike domains | Take over the admin role (launch window), abuse sign-up, enumerate, get round the private-media gate, scrape availability, phish customers |
| **X2** | Malicious registered customer | A verified account (throwaway inbox), valid tokens, full control of her own inputs (names, addresses, notes, files, WhatsApp text) | IDOR, stored XSS/CSV/bidi payloads into the admin portal, flooding (requests, events, uploads), races on slots, fake "deposit sent" notices, forged or reused receipts |
| **X3** | Compromised customer account | X2 plus a real bride's history: bookings, address, consent, phone | Redirect album delivery, grant photo-publishing consent, change the phone so the studio's WhatsApp reaches the attacker, read the bank details, accept terms on her behalf |
| **X4** | Compromised admin session | (a) a stolen refresh or ID token **without** the password (shared device, malware, XSS), or (b) a phished password (no MFA required at sign-in, D8) | IBAN or WhatsApp swap (payment fraud), payment instructions planted in customer-visible text, bulk PII export, tampering with terms, hiding the evidence |
| **X5** | Curious insider on a shared device | Physical access to an unlocked browser where the admin or a customer is signed in (persistent Firebase session) | Browse customers' PII, export CSV (needs re-auth), flip consents, read downloaded CSVs in `Downloads/` |
| X6 | Cloud-account insider / operator error (context) | Cloudflare dashboard, `wrangler d1 execute`, secrets, deploy | Opening the gate by mistake, deploying the wrong config, promoting the wrong uid, dropping triggers |

---

## 4. Assets

| Rank | Asset | Why it matters |
|---|---|---|
| 1 | **Payment instructions shown to customers**: IBAN, account holder, bank name, the studio's WhatsApp number, and any text that could pass as payment guidance | A swap sends real deposits to a fraudster. This is the highest-impact abuse |
| 2 | Admin role and admin session | Gives read access to all PII and write access to settings, states and exports |
| 3 | Private media: receipts (bank screenshots showing names and account numbers), bridal previews | PDPL special handling, reputational harm; gated today |
| 4 | Customer PII: names, phones, emails, event dates, venue, delivery address, special requests | PDPL; also reveals when a home is empty on the wedding day |
| 5 | Consent state (`publish_photos`) | Publishing photos without real consent is the studio's core brand promise broken |
| 6 | Booking integrity: dates, holds, deposits, terms acceptance evidence, audit trail | Disputes, double-booking, legal evidence |
| 7 | Availability of the booking flow and the admin queue | Flooding buries real requests during peak season |
| 8 | Deploy and config integrity (wrangler.jsonc, `_headers`, build flags) | One wrong deploy opens the media gate or ships the wrong CSP |

---

## 5. Controls that already exist or are planned (preserve)

Checked in code at `c80f4c2` or specified in 11/12. Regressing any of these is itself a finding.

| Control | Where | Notes |
|---|---|---|
| RS256 + JWKS, iss/aud pinned, `exp`/`iat`/`auth_time`/`sub` required, `kid` present, email required | `worker/auth.ts:84-128` | G1-2 must only **add** `authTime` and `secondFactor` |
| Admin role from D1 on every request, then `email_verified`, then role | `worker/admin-auth.ts:66-103` | Both dispatchers call it before routing |
| Exact-key JSON with a byte cap enforced while reading (chunked-safe), strict UTF-8 | `worker/portal/request.ts:readJsonBody` | New routes must use it. Legacy `profile.ts`/`bookings.ts`/`admin.ts` blocked-dates do **not** (baseline SEC-05) |
| Multipart: Content-Length required and checked before reading, exact part list | `worker/portal/request.ts:readMultipartBody` | Reads up to 3 copies of the body into memory (see TM-09) |
| Private-media deny-list: decodes, NFKC, lower-cases, splits camelCase, checks template + request path; fails at load if a route is declared `open` | `worker/portal/gates.ts` | Word-based, so a new synonym gets past it (TM-10) |
| Customer dispatcher: gate → method → auth → id decode; ownership is left to the handler | `worker/portal/portal-routes.ts:343-392` | Ownership is **not** central (baseline SEC-16 → TM-06) |
| Date double-booking: partial UNIQUE index + `INSERT … WHERE NOT EXISTS` + conditional approve | `migrations/0001:72`, `worker/bookings.ts:506-551`, `worker/admin-workflow.ts:605-650` | Strong; the flow-2 approve keeps it |
| Transitions: `AND status = ?` + history insert guarded by `CASE WHEN changes()=1` in one batch | `worker/admin-workflow.ts:661-702` | The pattern the new units must copy |
| Outbox: dedupe key = primary key, claim mark, stale-claim recovery, recipient/payload NULLed at terminal status | `worker/notify/outbox.ts` | The claim mark is a timestamp (TM-15) |
| Logs: fixed codes and counts only | `worker/scheduled.ts`, `index.ts:283` | Keep as a review grep rule (TM-17) |
| Email HTML escaped, bidi-isolated references/phones | `worker/email-templates.ts:114-151` | New templates reuse it |
| 0007: append-only settings/terms/audit (triggers), DB CHECK on `reauth_at` ≤ 10 min, IBAN shape, single-admin index, snapshots | 11 §2.2 | Excellent integrity design; see TM-03 for what it does not stop |
| Flow 2 self-gated inside the approve SQL; `SETTINGS_CHANGED` on a race | 11 #18 | Keep |
| CSV: every field quoted, formula prefix `'`, bidi/C0/C1 stripped, RA + audit | 11 #38, G2-11 | Small additions in TM-13 |
| WhatsApp: digits-only number, `encodeURIComponent`, fixed host, templates never carry bank details or foreign links | G1-11, G2-15 | Keep; TM-19 |
| Motion: CSSOM-only styles, no inline script/style, no `data:`, no `innerHTML`/`eval`, static SVG paths, `/admin` excluded, compile-time-only flag, `shell:false` scripts | 12 §2 rule 3, §8.1 A6 | Keep; TM-14 adds a build-output check |

---

## 6. STRIDE by component

Legend: S spoofing, T tampering, R repudiation, I information disclosure, D denial of service, E elevation of privilege. "Plan" = the control already in 11/12. "Gap → TM" = what this document requires.

### 6.1 Identity and admin session (TB2/TB3)

| # | STRIDE | Attacker | Threat | Plan / code | Gap → TM |
|---|---|---|---|---|---|
| I-1 | E, S | X1 | **Admin takeover at launch.** Attacker signs up with the owner's public email in the new Firebase project (REST `accounts:signUp`), saves a profile so D1 stores that email under **their** uid, moves the account to their own inbox, and `promote-admin.mjs --email` promotes their uid | G1-12 promotes **by email**; the Worker never compares `users.email` with the token's email | **TM-02** (HIGH): promote by uid, check stored email against the token email in-band, create the owner account before the public deploy; baseline C-1/C-2 |
| I-2 | S | X4b | Phished admin password → full admin, including bank changes (re-auth only asks for the same password) | RA 10 min; MFA optional (D8); 2F only for media routes | **TM-03** (HIGH): 2F, or delayed activation, for bank/contact/deposit/terms |
| I-3 | E | X4a, X5 | Stolen or persisted refresh token → admin reads **indefinitely** (all PII, customers directory, timeline) without the password | RA only on sensitive writes; no max session age | **TM-07** (MEDIUM): `auth_time` ≤ 12 h on every admin route, instant global admin sign-out, idle sign-out |
| I-4 | R, E | X4 | After an incident, "disable user in Firebase" leaves ID tokens valid for about 60 minutes | Runbook §7.9 disables Firebase first | **TM-07**: `admin_sessions_valid_after` in D1; runbook order: invalidate in D1 → kill switch → Firebase |
| I-5 | S | X1 | Unverified-email squatting: attacker's row blocks the real customer (409), notifications misdirected | Not addressed in 11 | **TM-01** (baseline SEC-04 / C-2) |
| I-6 | E | X6 | `ADMIN_MEDIA_MFA="off"` set as a production secret disables 2F for media | "Allowed only in .dev.vars" (convention) | **TM-21** (LOW): preflight rejects it; features list it as a blocker |

### 6.2 Customer portal API (TB1) — bookings, confirmation, event profile, consent, handover, feedback

| # | STRIDE | Attacker | Threat | Plan / code | Gap → TM |
|---|---|---|---|---|---|
| C-1 | I, T | X2 | **IDOR**: `GET/POST /api/bookings/{otherId}/confirmation\|event-profile\|handover\|feedback\|consent` | Each handler binds `user_id = ?uid` (SB-2); 404 for foreign ids | **TM-06** (HIGH): central ownership resolution in the dispatcher (baseline C-16) + nested-id rules + a two-customer test matrix |
| C-2 | T | X2 | Nested-id confusion: `deliveryAreaId` inactive/unknown, `slotId` for the other method, a gallery `photoId` from another gallery, a `receiptId` from another booking | Predicates listed for slots/areas; gallery FK `(gallery_id, photo_id)` | **TM-06**: child ids are resolved only through the owned booking; the gallery id is never taken from the client |
| C-3 | T | X3, X5 | **Consent grant** by a compromised account or a relative on a shared phone → photos "consented" | Upsert when the value changes; withdrawal always allowed | **TM-08** (MEDIUM): a grant requires a recent sign-in and admin re-confirmation before publishing; withdrawal has no friction |
| C-4 | T | X3 | Delivery address redirect: attacker books a delivery handover to their own address, or changes the profile phone so the studio's "handover day" WhatsApp goes to them | Address snapshot; no self-reschedule | **TM-08**: recent sign-in for handover booking and profile phone/email changes; admin sees "phone changed since booking" |
| C-5 | D | X2 | Flooding: unbounded booking requests (baseline SEC-03); repeated `PUT event-profile` (each writes a `booking_events` row); consent flip-flops (each writes an event) | Not addressed | **TM-01** (C-3/C-4) + **TM-11** (MEDIUM): limiter on all CO writes; events only when content changes |
| C-6 | T | X2 | Terms acceptance with a stale or forged version | `?termsVersion = (current)` inside the UPDATE; server writes the current version, not the client's value | OK. **TM-18** (LOW): add `bodySha256` to the event |
| C-7 | S | X2 | Fake "I sent the deposit" notices (#4) to pressure the admin | Notice never changes status or deadline; queue shows it | OK. **TM-20** (LOW): UI copy says a notice is not a payment |
| C-8 | I | X2 | Bank details returned before acceptance, or after `confirmed` | Only after acceptance and while `approved_hold`/`payment_pending` | OK (keep a test: N-04/N-16) |
| C-9 | T | X2 | Bidi/format characters in names, addresses and special requests reorder admin views (Trojan-Source style) | C0/C1 refused; bidi **not** refused (baseline SEC-10) | **TM-12** (MEDIUM) |

### 6.3 Admin portal API (TB1) — settings, terms, queue, calendar, customers, export, timeline, handover slots

| # | STRIDE | Attacker | Threat | Plan / code | Gap → TM |
|---|---|---|---|---|---|
| A-1 | T | X4b | **IBAN swap** | AD+R, immutable revisions, audit, 72 h banner, per-booking `bank_revision_id`, `bankDetailsChangedSinceAcceptance`, kill switch | **TM-03** (HIGH): the only barrier is the password the attacker already has |
| A-2 | T | X4a | **Payment instructions planted in AD-only text** (pickup address/instructions, delivery-area names, receipt rejection reason) with a stolen token and **no password**, e.g. «للتأكيد حوّلي العربون إلى SA… ثم راسلينا على 05…» | Rendered as text; no content rules; pickup is AD (not AD+R) | **TM-04** (HIGH): refuse IBAN-like, URL-like and phone-like content in customer-visible admin text; pickup moves to AD+R |
| A-3 | T | X4b | WhatsApp number swap → customers' deposit notices and questions reach the fraudster, who "confirms" a new IBAN over chat | AD+R, 72 h banner | **TM-03**: same second factor or delay; customers see a "studio number changed" notice |
| A-4 | T, R | X4b | Malicious terms version (payment instructions, links, bidi tricks) | AD+R, immutable, SHA-256 | **TM-04** + **TM-18**: same content rules; the event carries the hash |
| A-5 | I | X4a, X5 | Bulk PII: customers directory, search, timeline, calendar | AD only | **TM-07** (session age); export RA kept |
| A-6 | I | X4 | CSV export to exfiltrate | AD+R, ≤ 5,000 rows, audited | OK; **TM-13** (LOW) hardening |
| A-7 | T | X4 | Capacity lowered below bookings / slot deactivated during a booking race | `CAPACITY_BELOW_BOOKED` | **TM-15**: the check must sit inside the same UPDATE, not in a pre-read |
| A-8 | R | X4 | "It wasn't me": admin denies a change | Append-only `admin_audit_log` with `reauth_at`; `booking_events` actor | OK. Reads of PII are not audited (accepted residual, §12) |
| A-9 | I | X4 | PII in API URLs (`?q=` names/phones in `GET /api/admin/bookings`, `/customers`) reaches logs if observability is ever enabled | Kept out of the address bar only | **TM-17** (MEDIUM) |
| A-10 | D, E | X4 | Single-admin lockout: attacker changes the Firebase password or email | Promote script `--replace`; runbook | OK; **TM-02** makes `--replace` uid-based |

### 6.4 Private media (gated): receipts, galleries, `/api/media`

| # | STRIDE | Attacker | Threat | Plan / code | Gap → TM |
|---|---|---|---|---|---|
| M-1 | E, I | X1, X6 | Gate bypass via a synonym path (`/proof`, `/files`, `/upload`, `/images`) that reads R2 | Word deny-list; E3 handler re-check | **TM-10** (MEDIUM): `getMediaBucket()` is the single choke point and returns null unless PM holds; extend the deny-list |
| M-2 | T | X2 | Polyglot (JPEG/PDF + HTML/JS), SVG/HTML renamed, content-type spoofing | Magic-byte sniff, client type ignored, nosniff, CSP sandbox, PDF as attachment | **TM-09**: store the sniffed type, cap trailing bytes, never serve an R2 `httpMetadata` type that came from the client |
| M-3 | D | X2 | Pixel bomb (small file, 60,000 × 60,000 px) crashes the admin's review tab | Size cap only | **TM-09**: parse and cap dimensions from the header |
| M-4 | I | X2, admin client bug | EXIF/GPS in receipts (customer's home location) or gallery previews (venue/home) | Client re-encode (G5-3, G5-4) | **TM-09**: server strips or refuses metadata-bearing images (client re-encoding can be bypassed) |
| M-5 | I | X1 | Signed-URL leakage and replay (shared link, browser cache on a shared device, logs) | HMAC, `e` ≤ 2 h, 10 min admin / 1 h customer, no edge cache | **TM-09**: `no-referrer`, a revocation check on every GET, `private` cache bounded by the remaining lifetime |
| M-6 | I | X1 | R2 key guessing / public bucket | UUID keys; signature required | **TM-09**: assert the bucket has no public access, no custom domain, no CORS |
| M-7 | D | X2 | Memory exhaustion: concurrent 5 MiB uploads (3 in-memory copies each) | `attempt_no` ≤ 10, one pending | **TM-11**: per-uid concurrency + limiter |
| M-8 | S | X2 | Receipt reuse or forgery | SHA-256 reuse warning | Accepted: a hash is a hint only; **TM-20** (the bank statement is the truth) |

### 6.5 Cron, outbox, retention (TB4)

| # | STRIDE | Attacker | Threat | Plan / code | Gap → TM |
|---|---|---|---|---|---|
| J-1 | T | (fault) | Cron double-fire or overlap → duplicate reminders/events, double purge | Dedupe keys, state selection, claim + stale claim | **TM-15**: random claim tokens for new claim jobs; two-phase purge |
| J-2 | T | (race) | Cron expiry vs admin `extend_hold`/`confirm_payment`/`approve` | Expiry conditional on the exact `hold_expires_at` read | **TM-15**: `extend_hold` conditional on the same read; approve's targeted expiry mirrors it |
| J-3 | I | (fault) | Reminder sent for a booking that has since been cancelled | Supersede on anchor change | **TM-15**: the drain re-checks eligibility or supersedes on a state change |
| J-4 | T | X6 | Retention job deletes rows needed as evidence | RP fail-closed; never deletes bookings/receipts/audit | OK; **TM-15** bounded two-phase |

### 6.6 Browser surface, headers, motion layer (TB1 client side)

| # | STRIDE | Attacker | Threat | Plan / code | Gap → TM |
|---|---|---|---|---|---|
| B-1 | E | X2 | Stored XSS from names/notes/addresses/terms into the admin portal or emails | React text only, no `dangerouslySetInnerHTML`, email escaping, timeline key whitelist | **TM-12** (links from data) + **TM-14** (enforced CSP as the second layer) |
| B-2 | T | X1 | Clickjacking of `/admin` (re-auth dialog, settings save) | `X-Frame-Options: DENY`; `frame-ancestors 'none'` exists only in a Report-Only CSP | OK via XFO; **TM-14** enforces the CSP |
| B-3 | E | X1 | CSP too broad: `script-src` allows `https://apis.google.com` and the reCAPTCHA paths (known gadget hosts), not needed for email/password + TOTP | Report-Only; enforcement deferred to "after a clean period" | **TM-14** (MEDIUM): prune, set a deadline, add a report endpoint |
| B-4 | T | (build) | Vite's `assetsInlineLimit` silently emits `data:` URIs that the enforced `img-src 'self'` blocks, and that the motion rule forbids | Rule stated, not checked | **TM-14**: set it to 0 or check the build output |
| B-5 | I | X5 | Shared device: persistent Firebase session, downloaded CSVs, cached gallery images | No PII/tokens in Web Storage; only the intro flag in sessionStorage | **TM-07** + **TM-13** export warning |
| B-6 | T | X6 | Motion deploy script ships a build that skips the go-live preflight (R2 binding, placeholder D1, wrong Firebase project, wrong CSP hash) | `build-design.mjs --deploy` checks design markers only; `--allow-dirty` | **TM-05** (HIGH) |
| B-7 | I | — | View Transition snapshots of `/my-bookings` | In-memory only; `/admin` excluded | Accepted |

---

## 7. Focus areas in depth

### 7.1 IDOR on bookings, galleries, receipts, handovers, questionnaires

**Surface.** Every CO route takes `{bookingId}` from the path (#2–#14). Galleries add photo ids, handovers add slot and area ids, and receipts add receipt ids (admin). Booking ids are UUIDv4 (`crypto.randomUUID()`, `bookings.ts:498`), so guessing is not practical. They do leak, though: in email links, `?booking=` deep links, screenshots sent over WhatsApp, and the shared-device history. **Ownership in SQL is the only real control, and it rests on each handler.**

**Analysis.**
- The dispatcher passes an **unverified** `bookingId` (`portal-routes.ts:94`, "Ownership is NOT checked yet"). One of about 14 future handlers forgetting `AND user_id = ?` exposes bank details, addresses and consent. The plan's mitigation (SB-2 + N-04) is testing, not structure.
- **Nested ids.** `POST handover` takes `slotId` and `deliveryAreaId`. Slots are global (not owned), so the rule is *eligibility* (active, future, method, capacity), which the plan covers. `deliveryAreaId` must be `is_active = 1` inside the INSERT (the plan implies this but does not state it). Gallery selection takes photo ids; the composite FK `(gallery_id, photo_id)` blocks cross-gallery ids **only if** `gallery_id` comes from the owned booking and never from the body.
- **Admin IDs.** The single admin sees everything by design. `customerId` in `/api/admin/bookings` and `/customers/{id}` is admin-only.
- **Questionnaire** (event profile): readable by the owner at any status (GET), writable only while `confirmed` and before the event. The admin view (#22) is read-only.
- **Existence oracle.** A foreign id must give the **same** 404 body and, where practical, similar timing as a non-existent one. With a central pre-check (TM-06) both paths run the same single query.

**Required**: TM-06 (central ownership plus nested-id rules), N-36.

### 7.2 Admin settings tampering: IBAN and WhatsApp swap (payment fraud)

**What the plan does well.** Revisions are append-only (trigger). Sensitive sections need `reauth_at` ≤ 10 minutes, **enforced by a DB CHECK**. Every write goes to the audit log with the re-auth time. There is a 72 h banner and a `bank_mismatch` queue section. Each booking pins `bank_revision_id`. The customer sees `bankDetailsChangedSinceAcceptance`. A kill switch exists. Admin WhatsApp templates never carry bank details.

**Where it still fails.**
1. **X4b (phished password)** passes re-auth trivially: re-auth asks for the same factor the attacker already holds. MFA is optional (D8), and R1 (MFA as a hard gate for Run 4) was relaxed. The payoff is direct: every flow-2 customer who opens the confirmation panel after the swap sees the attacker's IBAN.
2. **X4a (token, no password)** cannot touch the bank section. But it **can** write customer-visible text through AD-only routes: pickup address/instructions (#31, up to 500 characters), delivery-area names (#34), and, once media opens, receipt rejection reasons (#18 `reject_receipt` `note`). A line such as «تم تحديث الحساب البنكي: SA…» in the pickup instructions gets around the re-auth that protects the bank section. The customer copy «اعتمدي بيانات الحساب الظاهرة هنا فقط» even tells her to trust what the portal shows. (**TM-04**)
3. **Detection has no out-of-band channel at launch** (no email provider). The owner learns of a swap only by opening `/admin`, where the attacker is also active. The 72 h banner is good, but it is seen only inside the compromised surface.
4. **Kill switch latency.** `ONLINE_CONFIRMATION="off"` needs a build and a deploy. A dashboard var edit is faster, but the next `wrangler deploy` overwrites it.
5. **Lookalike text.** Bank name and account holder refuse C0/C1 but **not** bidi or zero-width characters. A holder name can be made to *display* as the studio's name while reading differently, or an IBAN group can be visually reordered next to it.

**Required**: TM-03 (second factor **or** a 24 h delayed activation for changes to an existing bank/contact revision, with the previous revision staying in force, plus a customer-visible "changed on" notice), TM-04, TM-12 (bidi/format refusal in bank fields), TM-07 (session age, global sign-out). Runbook: add the dashboard-var kill switch, including the `keep_vars` caveat.

### 7.3 Terms-version tampering

- **Customer side (X2/X3).** The client sends only `termsVersion`. The server compares it with the current version inside the UPDATE and writes the **current** value and server time. A stale version gets 409 and a reload. **Sound.**
- **Admin side (X4b).** A malicious new version can carry payment instructions, links or bidi tricks. It is immutable afterwards (good evidence, bad for the victim). → TM-04 content rules apply to the terms body. TM-03 applies to publishing.
- **Evidence (X6).** `terms_versions` is immutable to the Worker, but anyone with `wrangler d1 execute` can drop the trigger. Storing `bodySha256` in the `terms_accepted` event's `details` (itself immutable by the 0007 trigger) and showing the customer the version she accepted (read-only, even after v+1 exists) makes silent substitution detectable. → TM-18.
- The terms body must never be rendered as HTML or markdown, and URLs must never be auto-linked (the plan already says plain text; TM-04 adds "no autolink" to every admin-authored text).

### 7.4 Slot and date double-booking races

- **Event date.** Protected by the partial UNIQUE index `ux_booking_requests_blocking_event_date` plus conditional statements. Even a wrong predicate cannot produce two blocking rows. The flow-2 approve adds targeted expiry of stale holds in the same batch. Order matters: the expiry `UPDATE` must run **before** the approve `UPDATE` in the batch, and both must bind the same `?now` (the plan does this).
- **Handover slots.** No unique index can express "≤ capacity", so correctness rests on the single-statement `INSERT … SELECT … WHERE (SELECT COUNT(*) … status='scheduled') < capacity`. D1's single-writer serialisation makes this atomic (verified in 11 §2.3). Each of these paths needs the **same** predicate inside the statement, never a pre-read:
  - customer re-book after `no_show`/`cancelled` (UPDATE), where the count must exclude the booking's own row;
  - admin `reassign`;
  - admin capacity decrease (`UPDATE handover_slots SET capacity=? WHERE id=? AND ? >= (SELECT COUNT(*) …)`);
  - admin deactivate (decide: allowed with bookings, then queue them for reassignment; or refused).
  → TM-15.
- **Gallery quota** (two tabs): the predicate is in the statement (G5-2). Keep it.
- **Hold vs cron**: `extend_hold` must be conditional on `status` and the exact `hold_expires_at` it read, and must refuse when that deadline is already past. Otherwise it can resurrect a hold the cron is expiring at the same moment, after another bride's approval has been freed. → TM-15.
- **Terms publish**: `INSERT … SELECT MAX(seq)+1` with `expectedCurrentVersion` and `UNIQUE(seq)`. Sound.
- **Settings save vs approve**: the `?ruleId = MAX(id)` predicate gives `SETTINGS_CHANGED`. Sound.

### 7.5 Upload handling (gated today, shipped dark)

| Concern | Plan | Required addition (TM-09) |
|---|---|---|
| Type | Magic bytes: JPEG `FF D8 FF`, PNG signature, WebP `RIFF….WEBP`, PDF `%PDF-`; client type ignored | Refuse SVG/XML/HTML (`<`, BOM + `<`) before sniffing; for images require the end marker (JPEG `FF D9`, PNG `IEND`, WebP RIFF length = file length) and refuse > 1 KiB of trailing bytes (polyglot carriers); store the **sniffed** type in `media_objects.content_type` and set R2 `httpMetadata` from it; serve only the DB type |
| Size | 5 MiB file, 5,275,648 B request, Content-Length first | Keep. Add per-uid concurrency ≤ 2 and the limiter (TM-11), because each request holds about 3 in-memory copies |
| Dimensions | none | Parse width/height from the header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X) and refuse > 8,000 px on a side or > 40 MP (receipts); galleries ≤ 4,096 (matches the DB CHECK) |
| Metadata / GPS | Client re-encodes (G5-3, G5-4) | Server strips JPEG APP1–APP15 (keep APP0 and ICC in APP2), PNG `eXIf`/`tEXt`/`iTXt`/`zTXt`, WebP `EXIF`/`XMP ` chunks, **or** refuses metadata-bearing gallery images outright (the admin pipeline should never produce them; refusing surfaces client bugs). PDFs: accepted as they are (document metadata is the customer's own), served as attachment only |
| Polyglot rendering | `nosniff`, CSP `sandbox`, CORP same-origin, PDF attachment | `Content-Security-Policy: default-src 'none'; img-src 'self'; sandbox`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Disposition` with a **generated** ASCII filename (never the original filename: header injection, PII) |
| Keys | `r/<bookingId>/<receiptId>`, `g/<galleryId>/<photoId>/(p|t)`, regex-checked; filenames never in keys | Keys minted only server-side; the media handler also checks that the key exists in `media_objects` with `deleted_at IS NULL` (instant revocation after purge or erasure, instead of waiting up to the URL lifetime) |
| Signed URL | HMAC-SHA256, constant-time verify, `e` ≤ 2 h ahead, rotation with `_PREVIOUS` for 2 h | MAC input is a versioned tuple `v1\|<key>\|<e>` (no ambiguity); verify **before** any D1/R2 call; customer lifetime ≤ 3,600 s, admin ≤ 600 s; `Cache-Control: private, max-age=min(remaining, lifetime)`; URLs are never persisted client-side (G6-3 already says this) |
| Bucket | no public access implied | Release checklist asserts the R2 bucket has public access **off**, no custom domain, no CORS policy |
| Hash reuse | SHA-256 warning | A hint only (one changed byte defeats it). The admin confirms against the bank statement (TM-20) |
| PDF content | attachment | Admin UI warns not to follow links inside a receipt PDF. Optionally accept images only if the owner agrees |

### 7.6 CSV injection in exports

The plan's G2-11 is close to complete: every field quoted with `"` doubled, `'` prefix for `= + - @`, TAB, CR, first non-space; bidi/C0/C1 stripped; phones as digits; notes excluded; RA; audit. Additions (TM-13, LOW):
- Also neutralise leading full-width `＝ ＋ － ＠` (U+FF1D, U+FF0B, U+FF0D, U+FF20) and `|` (LibreOffice DDE paths). Also strip U+2028/U+2029 and zero-width characters.
- Emit numeric columns (totals, amounts) from integers without a prefix, so they stay numeric; never pass a customer string into a numeric column.
- The export dialog tells the admin the file contains personal data and should be deleted after use (shared-device X5).
- Test matrix: Excel (Windows), LibreOffice, Google Sheets import, Numbers. Arabic intact thanks to the BOM.

### 7.7 WhatsApp link/text injection and impersonation

- **Link injection.** The number goes through one builder (G1-11), must match `^[1-9]\d{7,14}$`, and is always prefixed with `https://wa.me/`. The message is `encodeURIComponent`. The DB CHECK on `whatsapp_number` mirrors this. `966500000000?text=x` and `+966…` with letters are refused (N-21). **Sound.** Keep one builder only: lint for `wa.me` string literals outside `src/lib/whatsapp.ts`.
- **Text injection.** Admin → customer templates interpolate the customer's own first name, reference, date, amount and handover details. A customer who plants a URL in her own name only affects messages sent to herself (self-inflicted). But names are rendered **as studio-authored text** in the WhatsApp message. Refusing URLs in name fields (TM-12) removes the "studio sent me a link" confusion at no cost.
- **Customer → studio text.** It is prefilled but editable by the customer, so it is **never evidence** (fake "I paid" claims). The queue treats `deposit_notice_sent` as a notice only (TM-20).
- **Impersonation.** A fraudster's WhatsApp account named like the studio messages customers with a "new IBAN".
  - Controls: the portal is the only source of bank details, and the customer copy in G4-1 says so.
  - Add: when the studio's WhatsApp number changed in the last 72 h, the hub and confirmation panel show «تم تحديث رقم التواصل بتاريخ …». The compiled public number (`src/lib/whatsapp.ts:11`) is quoted as the fallback to verify with. It cannot be changed by an admin session; only by a deploy. (TM-03/TM-19)
- **`admin_whatsapp_opened`** logs only a template id (closed list). Good.

### 7.8 Stored XSS through names and notes in the admin portal (and customer views)

- **Sources** (all attacker-controlled by X2/X3): first/last name (80), phone (normalised), event profile (venue 120, area 120, special requests 1,000), delivery district/street/landmark, feedback comment, and the filenames the admin chose (gallery). Admin-authored (X4): notes, terms, pickup, area names, rejection reasons.
- **Sinks**: admin list/detail/queue/calendar/customers/timeline/contact sections, CSV, emails, `.ics`, `wa.me` text, `aria-label`/`title` attributes.
- **Controls in plan**: React text rendering, no `dangerouslySetInnerHTML`, timeline details through a key whitelist (G3-9), `escapeHtml` + bidi isolation in emails, `.ics` escaping, CSV neutralisation.
- **Gaps** (TM-12):
  1. Links built from data: `mailto:`/`tel:` in the admin contact section must use fixed schemes with `encodeURIComponent`, and no `href` may ever come from free text.
  2. Bidi/format characters are not refused anywhere (baseline SEC-10).
  3. The DB does not refuse control characters in `event_profiles`, `handovers` address fields or `feedback` (only length CHECKs), so the Worker is the only guard. Every new handler must call the shared text validator, and N-20/N-41 must hit each field.
  4. Render every user string in the admin with `<bdi>` (or `dir="auto"` on the cell) so a string cannot bleed direction into neighbouring amounts or references.
- **Second layer**: an enforced CSP (TM-14). Today's policy is Report-Only, so a React escape bug would run.

### 7.9 Rate limiting and abuse (booking requests and uploads)

The baseline (SEC-03) found **no limiter at all** and an unbounded per-account request count. 11 adds about 20 new write routes and schedules no limiter. Required (TM-01 for the baseline C-3/C-4, TM-11 for the new routes):

| Route class | Limit (initial) | Key |
|---|---|---|
| `POST /api/bookings` | ≤ 5/hour, and ≤ 3 open requests per account (atomic in the INSERT), horizon ≤ 730 days | uid |
| `PUT /api/profile` | ≤ 10/hour | uid |
| CO writes #3, #4, #7, #8, #11, #12, #14 | ≤ 30/10 min combined; event-profile and consent write an event **only when the value changes**; consent ≤ 10 changes/day | uid |
| Receipt upload #5 | ≤ 6/hour, ≤ 2 concurrent; `attempt_no` ≤ 10 (DB) | uid |
| `GET /api/availability` (public) | edge cache 60 s + ≤ 60/min | IP |
| CSP report route (C-10) | ≤ 30/min | IP |
| Admin reads | ≤ 600/10 min (catches a scripted scrape with a stolen token) | uid |

Use the Cloudflare `ratelimits` binding (no dependency). It is fail-open by nature, so a limiter outage must not block real users, and the atomic caps remain the hard bound. Firebase side: email-enumeration protection on, and the default sign-up quotas.

### 7.10 Cron idempotency

The existing design is solid (dedupe keys as the primary key, state-based selection, claim marks, stale-claim recovery, bounded ticks, isolated jobs). For the new jobs (G3-4 event and handover reminders, G4-9 feedback request, G5-5 retention, G6-4 selection reminders and orphan sweep), TM-15 requires:
- Dedupe keys `<kind>:<bookingId>:<anchor>` with no PII. The anchor is the relevant deadline/slot/date, so a reschedule re-arms and a repeat cannot.
- A random claim token (`crypto.randomUUID()`) for any new claim-based job, instead of the ISO start time. Cloudflare cron is at-least-once, and two overlapping ticks that share a millisecond would read back each other's claims.
- The drain or the job **re-checks eligibility** (status still `confirmed`, slot still scheduled) or supersedes the row when the state changes, so a cancelled booking never gets its reminder.
- Retention and orphan sweep are **two-phase**: claim (`purge_claim`, already in 0005) → delete R2 → mark `deleted_at`. Re-runnable. They never touch keys that are referenced, younger than 24 h, or pending. Counts-only logs. `RP` fail-closed.
- Every job keeps the per-tick bound and the tick budget, and writes its heartbeat.

### 7.11 PDPL gate bypass

The gate is OC ∧ PDPL ∧ R2 ∧ KEY (+2F for admin). Bypass classes and their status:

| Bypass | Status |
|---|---|
| Encoded or cased path (`%72eceipt`, `Receipt`, `//`, trailing `/`) | Blocked: literal template match on raw segments → 404; deny-list decodes + NFKC (N-13) |
| Route declared `open` with a deny-word | Blocked at module load (E1) |
| **Synonym path** (`/proof`, `/files`, `/upload`, `/images`, `/attachments`, `/download`) serving R2 bytes | **Open**: the deny-list is word-based → TM-10 |
| Handler reads `env.MEDIA` directly | E3 says handlers call `getMediaBucket(env)`, but it checks only binding shape → TM-10: return null unless `isPrivateMediaAllowed(env)` (the full PM predicate); grep/lint: no `env.MEDIA` / `Reflect.get(env, 'MEDIA')` outside `gates.ts` |
| Metadata leaks while gated (keys, URLs in timeline/detail/events) | Keep `booking_events.details` for receipt/gallery events to **ids only** (never object keys or URLs); admin detail exposes `latestReceiptStatus` only |
| `env.mediatest` binding merged into production types or build | G1-3 checks `dist/…/wrangler.json`; TM-05 makes this a hard preflight on **every** deploy path |
| A dev commits `PDPL_SIGNOFF_REF` into `wrangler.jsonc` vars | Needs R2 + KEY as well (defence in depth); the preflight also refuses the var in production |
| `ADMIN_MEDIA_MFA="off"` as a production secret | TM-21 |

### 7.12 Logging of PII

- Worker logs today are fixed codes and counts. The rule (SB-7) holds for new code only if reviewers enforce it. TM-17: an RV grep gate on `console\.(log|info|warn|error)\(` whose arguments are not a string literal or a `code=`/`count=`/`job=` template.
- URLs are the leak channel. The admin search sends `q` (names, phones, emails) in the query string of API requests. That is harmless while Workers Logs/Logpush are off (Q22) but becomes a PDPL problem the day observability is switched on. TM-17: move `q` to a `POST …/search` body, **or** document that observability must drop query strings.
- The CSP report endpoint (C-10) stores directive + blocked-URI **origin only** (a blocked URI can contain a signed URL or a path with a booking id).
- Client: `window.reportError` (motion layer, G1-7) sends nothing off-device; keep it so (no telemetry SDK).
- `audit.details` and `booking_events.details` are allowlisted ids and counts (G1-9); the bank values are never included (revision id only). Keep.
- Error envelopes never echo input (SB-9). Keep.

### 7.13 Clickjacking and headers

- `/*` static responses carry `X-Frame-Options: DENY` (enforced today) and `frame-ancestors 'none'` (Report-Only). `/admin` and `/my-bookings` are SPA-fallback static responses, so they get the headers (smoke test in 11 §7.7).
- Worker responses (`/api/*`) do not read `_headers`. JSON is not framable in a useful way, but `/api/media` (HTML-sniffable bytes in theory) and the CSV must set their own `X-Frame-Options`/CSP (TM-09).
- Missing (baseline SEC-12): `Strict-Transport-Security` (at the custom-domain cut-over) and `Cross-Origin-Opener-Policy: same-origin` (safe: no popup sign-in is used). → TM-01 (C-9).

### 7.14 CSP and the new motion code

The motion spec was written for an enforced `script-src 'self' 'sha256-…'`, `style-src 'self'` and `img-src 'self'`, and it respects it:
- React `style` props and `element.style.*` are CSSOM writes, which CSP permits.
- There is no `setAttribute('style')`, no `<style>`/`<script>` injection, no `url()` in the cinematic CSS, and the SVG `<image>` is same-origin.
- The mask is a static fragment reference.
- `index.html` is untouched, so the hash is stable.
- View-transition pseudo-elements and `startViewTransition` have no CSP interaction.

Remaining risks (TM-14):
1. **Vite asset inlining.** Any imported asset under 4 KiB becomes a `data:` URI in the JS/CSS. `img-src 'self'` blocks it and it breaks the "no data:" rule. Set `build.assetsInlineLimit: 0` (the owner of `vite.config.ts` in the wave that lands it), or fail the build or preflight if `dist/client/assets/*` contains `data:image`.
2. **Enforcement timing.** 11 keeps Report-Only "until a clean period". Set a bound: enforced within 7 days of the first production deploy and **before** private media or the public promotion, with a `report-to` endpoint (baseline C-10).
3. **Allowlist breadth.** Remove `https://apis.google.com` and the reCAPTCHA hosts unless a Report-Only run shows they are needed. Email/password + TOTP through the modular Firebase SDK does not need gapi; reCAPTCHA is only for phone auth or reCAPTCHA Enterprise.
4. **Trusted Types.** The codebase has no HTML sinks, so add `require-trusted-types-for 'script'` in a Report-Only header first, then enforce if Firebase stays clean.
5. **Module worker** (G5-4 resize worker) falls under `worker-src` → `script-src 'self'`: fine. Verify under the enforced policy on preview.
6. **Verification.** Enforced policy on preview with the cinematic build: 0 violations across intro, VT, ticker, khatam draw, sign-in/up/reset/verify, admin, receipts/galleries under `mediatest`.

### 7.15 sessionStorage, client storage and shared devices

- Motion writes exactly one key, `sy:intro:v1 = '1'`, in a narrow try/catch. It is non-personal. **No threat.** Keep A6's "storage holds only the non-personal intro flag" as a review grep (`localStorage|sessionStorage|indexedDB` in `src/` must show only this key and Firebase's own persistence).
- Firebase Auth persists the refresh token in IndexedDB (`browserLocalPersistence`). On a shared device (X5), whoever opens the browser **is** the admin or the bride until sign-out.
- Admin mitigation (TM-07): server-side `auth_time` ≤ 12 h on every admin route, a 30-minute idle sign-out in the admin SPA, and `browserSessionPersistence` when signing in from `/admin` (optional, owner's choice).
- Customer mitigation (TM-08): recent sign-in for the few harmful writes (consent grant, handover address, phone/email change).
- No drafts of bank data or terms in storage (G3-5, G4-6), and no signed URLs persisted (G6-3). Keep.

### 7.16 Deploy and config integrity (a new finding from reading both plans together)

- 11 §7.5 prescribes a manual inspection of `dist/sundus_yar_website/wrangler.json` (account, D1 id, vars, **no `r2_buckets`**, `preview_urls:false`) before `wrangler deploy`.
- 12 §7.4 adds `npm run deploy:classic|cinematic`. That runs `wrangler deploy` itself after checking only the **design markers**, and it offers `--allow-dirty`.
- The README will document the motion command as "the one command to return to today's design", so this becomes the path people use in a hurry (incident, rollback of the look), and it skips every go-live check. It could ship a build whose `wrangler.json` carries a merged R2 binding, the placeholder D1 id, the wrong Firebase project, or an `index.html` whose inline-script hash no longer matches `_headers`.
- → **TM-05** (HIGH): one preflight module used by every deploy path, and no `--allow-dirty` for production.

---

## 8. Abuse cases → controls

G0-2's list (11 §5.4), plus the orchestrator's focus list.

| # | Abuse case | Attacker | Controls (plan + TM) | Residual |
|---|---|---|---|---|
| AB-1 | IBAN swap after admin takeover | X4b | AD+R, DB CHECK, append-only revisions, audit, 72 h banner, `bank_revision_id`, customer "changed" flag, kill switch; **TM-03** (2F or 24 h delayed activation), **TM-07** | Real-time phishing of password + TOTP within 10 minutes (§12) |
| AB-2 | Payment instructions planted via pickup/area/rejection text, no password | X4a | **TM-04** content refusal + pickup to AD+R | Low after TM-04 |
| AB-3 | WhatsApp number swap / studio impersonation | X4b, X1 | AD+R; templates without bank details; **TM-03**, **TM-19** notices + compiled fallback number | Social engineering outside the portal |
| AB-4 | Fake "I sent the receipt" notices | X2 | Notice ≠ status change; admin records the amount; **TM-20** | Admin process discipline |
| AB-5 | Hold squatting | X2 | Holds only after admin approval; 48 h cap before the event; ≤ 3 open requests (**TM-01**); the queue shows repeat offenders | Admin judgement |
| AB-6 | Receipt reuse / forged receipt | X2 | SHA-256 hint; **TM-20** bank-statement rule | Forged images are always possible |
| AB-7 | CSV injection | X2 | G2-11 + **TM-13** | — |
| AB-8 | Stored XSS via names/terms/addresses | X2, X4 | React text, escaping, whitelist; **TM-12**, **TM-14** | — |
| AB-9 | Enumeration of booking ids | X1, X2 | UUIDv4; 404 without an oracle; **TM-06** | Leaked ids are still useless without ownership |
| AB-10 | Gated-route bypass | X1, X6 | E1–E3, E6; **TM-10**, **TM-05**, **TM-21** | — |
| AB-11 | Single-admin lockout | X4b | Script `--replace` (uid-based after **TM-02**); Firebase console recovery; Time Travel | Needs Cloudflare + Firebase owner access |
| AB-12 | Audit tampering | X4, X6 | Triggers; no API deletes; **TM-18** hash in events; **TM-25** account hardening | Cloud-account holder can drop triggers |
| AB-13 | Admin role takeover at launch | X1 | **TM-02**, **TM-01** (C-1/C-2) | — |
| AB-14 | Consent granted by someone other than the bride | X3, X5 | **TM-08** recent sign-in + admin re-confirmation | — |
| AB-15 | Album delivery redirected | X3 | **TM-08** recent sign-in + phone-change flag; courier checks the recipient's name | Physical-world check |
| AB-16 | Booking/event flood, queue burial, email quota | X2 | **TM-01** (C-3/C-4), **TM-11** | Many accounts × limits |
| AB-17 | Slot double-booking | X2 | Single-statement capacity predicate; **TM-15** for re-book/reassign/capacity | — |
| AB-18 | EXIF/GPS leakage | X2, admin client bug | Client re-encode; **TM-09** server strip/refuse | — |
| AB-19 | Signed URL shared or replayed | X1 | HMAC, short lifetime; **TM-09** revocation check, no-referrer | ≤ 1 h window if not revoked |
| AB-20 | Wrong build deployed (gate open, wrong CSP) | X6 | **TM-05** | — |
| AB-21 | PII in logs | — | SB-7; **TM-17** | — |

---

## 9. Required controls (TM-nn)

Each has a severity, where it lands, and how it is verified.

| Id | Sev | Applies to | Control | Verify |
|---|---|---|---|---|
| **TM-01** | **BLOCKER** (release) | Plan §5 (new units W1/W2), G8 release gate, G9-1 | Schedule the `10-security-baseline.md` go-live blockers that 11 omits entirely: **C-1/C-2** (admin bound to uid + verified email; never store an unverified email; SEC-01/04/14), **C-3/C-4** (open-request cap, horizon, `ratelimits` binding; SEC-03), **C-5** (bounded bodies in legacy handlers; SEC-05), **C-9** (COOP now, HSTS at the domain cut-over; SEC-12), **C-10** (enforced CSP + report endpoint; SEC-07), **C-16** (central ownership; SEC-16 → TM-06). Add "zero open baseline go-live items" to the G8 release gate | RV-1/RV-2 check each C-n against its SEC acceptance; G8-1 re-runs the baseline attacks |
| **TM-02** | HIGH | G1-12, G1-2, runbook §7.6 | Promote **by uid**: `promote-admin.mjs --uid <uid from the Firebase console of the verified owner account> --email <email>` updates `WHERE id=? AND lower(email)=lower(?)`, requires `changes()=1`, templates only a uid validated `^[A-Za-z0-9]{1,128}$` (the email is compared, never trusted); `authorizeAdminRequest` also requires stored `users.email` = token email (case-insensitive); runbook: the owner's account is created and email-verified in the new Firebase project **before** the public deploy, and her uid is recorded in the release log | N-31, N-32 |
| **TM-03** | HIGH | G1-2, G2-1, G3-5, G4-1, G4-5, §7.9 runbook; owner decision (§11) | Bank, contact, deposit and terms writes need `RA` **and** a second factor when Identity Platform is enabled. Otherwise a change to an **existing** bank or contact revision takes effect 24 h after it is saved (`effective_at` on the revision; customers keep the previous revision until then; queue alert; cancel = save a new revision; the first-ever revision is immediate). Customer panel shows «آخر تحديث لبيانات الحساب: …» and, within 72 h of a contact change, a notice citing the compiled public number as the check. Kill-switch runbook adds the dashboard-var path (and warns that `wrangler deploy` overwrites dashboard vars) | N-45, G8-3 IBAN-swap drill |
| **TM-04** | HIGH | G2-1 (pickup, delivery areas, terms), G2-3 (`reject_receipt`/any customer-visible note), G1-6 validators, G3-5/G4-6/G4-2 UIs | "Payment instructions only in the bank section": server refuses, in every admin-authored customer-visible field (pickup address/instructions, delivery-area names, terms body and summary, rejection reasons, any note shown to customers), (a) IBAN-like tokens `/S\s*A\s*\d\s*\d(?:[\s-]*[0-9A-Z]){10,}/i` and digit runs ≥ 10 (after removing spaces/dashes), (b) URL-like tokens (`://`, `www.`, `wa.me`, `t.me`, `bit.ly`, a `\.[a-z]{2,}/` domain pattern), (c) phone-number-like runs other than the configured studio number, (d) bidi/format characters. **Pickup moves to AD+R.** Customer views render all admin text as plain text with **no autolinking** | N-33, N-34 |
| **TM-05** | HIGH | MOT-02 (`scripts/build-design.mjs`), G9-1, 11 §7.5 | One `scripts/release-preflight.mjs` (no dependency) called by every deploy path (motion scripts, runbook) **before** `wrangler deploy`. It asserts, from the generated `wrangler.json`: expected `account_id` and `name`; production D1 id ≠ placeholder and = the recorded id; **no `r2_buckets`**; `preview_urls: false`; `ONLINE_CONFIRMATION` as expected; no `PDPL_SIGNOFF_REF` / `MEDIA_SIGNING_KEY` in vars; `ADMIN_MEDIA_MFA` = `required`; `FIREBASE_PROJECT_ID` = the build's `VITE_FIREBASE_PROJECT_ID`; `_headers` hash matches the `index.html` inline script; design markers; no `data:image` and no secret patterns in `dist/client`. It also requires a clean tree (**drop `--allow-dirty` for production**) and prints the target for the owner's typed go-ahead | N-35 |
| **TM-06** | HIGH | G1-4 (dispatcher), every CO unit (G2-5, G2-8, G2-12, G3-1, G4-7, G5-2), RV-2/G8-1 | Customer dispatcher resolves ownership once (`SELECT id, status, flow_version, event_date FROM booking_requests WHERE id=? AND user_id=?`) → `404 BOOKING_NOT_FOUND` with an identical body for foreign and non-existent ids; handlers receive `OwnedBooking` **and** still bind `user_id=?uid` in their own writes; child ids: `deliveryAreaId` must be active inside the INSERT; the gallery id always comes from the owned booking; photo ids validated through `(gallery_id, photo_id)`; slot ids validated as UUIDs and eligibility checked in the statement; two-customer IDOR matrix over every CO route in both gate states | N-36, N-04 |
| **TM-07** | MEDIUM | G1-2, G2-4, G1-8, §7.9 runbook | Every admin route requires `auth_time` ≤ 12 h (`403 REAUTH_REQUIRED` → re-auth dialog); D1 value `admin_sessions_valid_after` (an append-only settings section or 0008) rejects tokens whose `auth_time` is earlier (instant global sign-out, set by the promote script and by a re-auth-guarded "sign out everywhere" button); admin SPA idle sign-out after 30 minutes; incident runbook order: invalidate in D1 → kill switch → Firebase disable → password/MFA reset | N-44 |
| **TM-08** | MEDIUM | G2-5, G3-1, `profile.ts` (C-2 unit), G3-12, G3-8 | Customer recent-sign-in (`auth_time` ≤ 10 min, the same guard as admin RA) for: consent **grant** (withdrawal always free), booking a delivery handover, profile phone/email change. Admin views show "consent granted on … (not yet confirmed by the studio)" and "phone changed since booking". Operating rule: the studio confirms consent with the bride before publishing any photo | N-39 |
| **TM-09** | MEDIUM | G2-13, G3-3, G4-7, G4-8, G5-1, G5-2, release checklist | Upload/serve rules of §7.5: pre-sniff refusal of markup, end-marker + trailing-bytes check, dimension caps, server-side metadata strip (receipts) / refusal (gallery), sniffed type stored and served, media response headers (CSP `default-src 'none'; sandbox`, XFO, `nosniff`, CORP, `no-referrer`, generated ASCII filename, `private` bounded cache), MAC over `v1\|key\|e`, verify before I/O, `deleted_at IS NULL` check per GET, R2 bucket private with no custom domain and no CORS | N-37, N-38, N-47 |
| **TM-10** | MEDIUM | G1-3 (`gates.ts`), G1-4, RV-1 | `getMediaBucket(env)` returns null unless `isPrivateMediaAllowed(env)` (OC ∧ PDPL ∧ KEY ∧ R2 shape): the single choke point; grep gate: no `env.MEDIA`/`Reflect.get(env, 'MEDIA')` outside `gates.ts`; extend `PRIVATE_MEDIA_SEGMENTS` with `upload(s)`, `file(s)`, `image(s)`, `picture(s)`, `attachment(s)`, `proof(s)`, `slip(s)`, `document(s)`, `download(s)`, `pdf`, `thumb(s)`, `preview(s)` (checked: none of the 11 §3.2 open paths contains these words); receipt/gallery `booking_events.details` carry ids only | N-48, N-13 |
| **TM-11** | MEDIUM | C-4 unit + every CO write unit, G4-7, `index.ts` availability | The limits table in §7.9 through the `ratelimits` binding; event-profile/consent events written only on change; consent ≤ 10 changes/day; upload concurrency ≤ 2 per uid; public availability cached 60 s at the edge | N-40 |
| **TM-12** | MEDIUM | Shared validator (`shared/text.ts`, new) used by G1-6, G2-1, G2-5, G2-7, G2-8, G3-1, `profile.ts`; admin UIs G3-x/G4-x | One text validator for every free-text field (customer and admin): NFC-normalise, refuse C0/C1, bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), invisible format characters (U+200B, U+2060, U+FEFF, U+2028, U+2029; ZWNJ/ZWJ allowed), code-point caps = DB CHECKs; names also refuse URLs/`@`-handles; admin UI wraps every user string in `<bdi>`; `mailto:`/`tel:` only with fixed schemes and `encodeURIComponent`; no `href` from free text (covers baseline C-13) | N-41, N-20 |
| **TM-13** | LOW | G2-11, G4-3 | CSV additions of §7.6 (full-width formula starters, `\|`, U+2028/9, numeric columns unprefixed, PII warning in the export dialog, 4-app test matrix) | N-42 |
| **TM-14** | MEDIUM | G1-10, G9-1, MOT-01/MOT-13 (`vite.config.ts`), C-10 | Enforced CSP within 7 days of the first production deploy and before private media or public promotion; `report-to` endpoint (counts, origin-only URIs); prune Google script hosts not needed after a Report-Only run; `require-trusted-types-for 'script'` in Report-Only first; `build.assetsInlineLimit: 0` or a preflight check for `data:image`; enforced-policy run on preview with the cinematic build → 0 violations across all motion effects and auth flows | N-43, N-27 |
| **TM-15** | MEDIUM | G2-3, G2-7, G3-1, G3-4, G4-9, G5-5, G6-4 | Race/idempotency rules of §7.4 and §7.10: every capacity/eligibility check inside the writing statement (re-book, reassign, capacity decrease, deactivate); `extend_hold` conditional on the read `hold_expires_at` and refusing an expired hold; random claim tokens for new claim jobs; eligibility re-check or supersede before send; two-phase purge | N-46, N-18 (extended) |
| **TM-16** | LOW | G2-12, G4-1 | Confirmation panel: IBAN rendered LTR-isolated (`<bdi dir="ltr">`), grouped for display, copy button copies the normalised IBAN; when `bankDetailsChangedSinceAcceptance`, the new details are shown only under an explicit warning with the verification instruction (TM-03) | G8-3 walk |
| **TM-17** | MEDIUM | RV-1…RV-7 grep rule, G2-10/G3-2 search, C-10 report route, Q22 | Log hygiene grep gate (§7.12); admin search moves `q` to a POST body **or** the owner accepts in writing that observability stays off / drops query strings; CSP reports store directive + origin only | N-28 extended |
| **TM-18** | LOW | G2-12, G2-1, G4-1 | `terms_accepted` event details `{"termsVersion","bodySha256"}`; the customer can view the exact accepted version read-only; terms body passes TM-04 + TM-12 | RV-2 |
| **TM-19** | LOW | G1-11, G2-15, G4-5 | Keep one WhatsApp builder (lint: no `wa.me` literal outside `src/lib/whatsapp.ts`); message length cap; a "studio number changed" notice (TM-03) | N-21 |
| **TM-20** | LOW | G2-3 UI (BookingActions), G4-4, G6-1, OPERATIONS.md | Operating rule in UI copy and docs: WhatsApp notices, receipts and hash matches are not proof of payment; `confirm_payment` requires the amount seen **in the bank app/statement**; hash reuse is a hint; do not follow links inside receipt PDFs | G8-3 |
| **TM-21** | LOW | G1-2, G1-3, TM-05 | `ADMIN_MEDIA_MFA` counts as "off" only when the exact value `off` is present **and** preflight is not in production mode; `features.privateMedia.blockers` lists `ADMIN_MFA_DISABLED`; preflight refuses it for production | N-35 |
| **TM-22** | LOW | MOT-06, MOT-02 | Motion tooling: Chrome `--remote-debugging-port=0` (random) on 127.0.0.1 with a temp profile, killed on exit; no `VITE_*` values printed; `motion-audit` Fetch-interception keeps all traffic on 127.0.0.1 (as specified) | MOT-06 review |
| **TM-23** | LOW | Release checklist, OPERATIONS.md | Cloudflare account and Firebase project owner accounts have 2FA; scoped API tokens only; Time Travel bookmark before every remote write (already in the runbook); document that D1 triggers do not bind account holders | G9-1 log |
| **TM-24** | LOW | C-8 (baseline), Q20 | Preview host behind Cloudflare Access; preview on the dev Firebase project with OC off (Q20 default) | G8-2 |

---

## 10. New negative tests for RV/red teams (N-31 …)

These extend 11 §6.4. Each must run locally (and on preview where noted). No production tokens.

- **N-31** `promote-admin.mjs` with a uid whose stored email differs from the given email → refused, 0 rows changed; `--email` alone → usage error.
- **N-32** Admin row whose `users.email` ≠ the token's email (simulated via local SQL) → 403 on every admin route.
- **N-33** `PUT /settings/pickup`, `POST/PATCH /delivery-areas`, `POST /settings/terms`, `reject_receipt` note carrying `SA03 8000 0000 6080 1016 7519`, `sa0380000000608010167519`, `https://x.test`, `wa.me/9665…`, `0551234567` (not the studio's), or U+202E → 400.
- **N-34** Stale token (`auth_time` 11 min) → `PUT /settings/pickup` → 403 `REAUTH_REQUIRED` (after TM-04 moves pickup to AD+R).
- **N-35** Preflight on a `wrangler.json` with `r2_buckets`, placeholder D1 id, `preview_urls` missing, `ADMIN_MEDIA_MFA:"off"`, a mismatched Firebase id, a stale `_headers` hash, a `data:image` asset, or a dirty tree → refuses. `npm run deploy:classic` calls the same preflight.
- **N-36** Two customers: B uses A's booking id on every CO route (both gate states) → identical 404 body. B uses an inactive `deliveryAreaId` → 409. B selects a photo id from another gallery → 404/409, no row.
- **N-37** Upload: PNG header claiming 60,000 × 60,000 → 400. JPEG with EXIF GPS → stored without APP1 (receipt) or refused (gallery). `<svg…>` bytes → 415. JPEG with 200 KiB of HTML after `FF D9` → refused. `%PDF-` + HTML → served only as an attachment under CSP `sandbox`.
- **N-38** Signed URL for an object after purge (`deleted_at` set) but before `e` → 404. URL with `e` > now + lifetime → 403. MAC over a different key → 403. No D1/R2 call before MAC verification (instrumented locally).
- **N-39** Consent grant with `auth_time` > 10 min → 403 `REAUTH_REQUIRED`; withdrawal with an old token → 200.
- **N-40** 100 identical `PUT event-profile` → 1 `event_profile_saved` event, then 429 past the limit. 20 consent toggles → capped. 3 concurrent receipt uploads by one uid → the third gets 429.
- **N-41** Names/addresses/special requests/bank holder containing U+202E, U+2066, U+200B, U+FEFF, U+2028 → 400; ZWNJ in an Arabic name → accepted.
- **N-42** CSV cells starting `＝HYPERLINK(…)`, `|cmd`, `  =1`, U+2028 → neutralised; totals remain numeric.
- **N-43** `grep -r "data:image" dist/client/assets` = 0. Enforced CSP on preview (cinematic): 0 violations on `/`, `/portfolio`, `/packages`, `/my-bookings`, `/admin`, sign-in/up/reset/verify, intro, VT forward/back, ticker, khatam.
- **N-44** Admin token with `auth_time` 12 h 1 s → 403 on `GET /api/admin/bookings`. After "sign out everywhere", a token issued earlier → 403.
- **N-45** Bank change to an existing revision without 2F → customers keep seeing the old IBAN until `effective_at`; queue alert present; cancelling restores; with 2F → immediate.
- **N-46** Two scheduled ticks fired concurrently (local `/cdn-cgi/handler/scheduled` ×2) → no duplicate outbox rows, events or purges. A reminder for a booking cancelled after queueing is superseded.
- **N-47** Release checklist: the R2 bucket's public access is off, it has no custom domain and no CORS rules (dashboard or `wrangler r2 bucket` read-only commands; owner-run).
- **N-48** Local env with an R2 binding + KEY but **no** `PDPL_SIGNOFF_REF` → `getMediaBucket(env)` returns null; a scratch route on a non-deny-listed path (`/proof`) that calls it → 503 (reverted).

---

## 11. Plan amendments that need the owner's approval

1. **TM-03 vs D8.** Either (a) enable Identity Platform + TOTP and require a second factor for bank/contact/deposit/terms writes (sign-in stays password-only), or (b) accept a 24 h delay before a *changed* bank account or WhatsApp number reaches customers. *Recommended default: (b) at launch, (a) as soon as Identity Platform is enabled.* Without either, the IBAN-swap defence reduces to "the attacker does not know the password".
2. **TM-04.** Pickup settings move from AD to AD+R; admin text shown to customers may not contain account numbers, links or phone numbers.
3. **TM-07.** Admin sessions older than 12 h must re-enter the password; idle sign-out after 30 minutes.
4. **TM-08.** Granting photo-publishing consent, booking a delivery and changing phone/email ask the bride to re-enter her password if her sign-in is older than 10 minutes. Withdrawal never does.
5. **TM-01.** The baseline go-live fixes become build units in waves 1–2 (about 8 small commits). This adds scope to the 70-unit plan but no new dependency.
6. **TM-05.** The "return to classic" deploy command runs the same release preflight and cannot deploy a dirty tree to production.
7. **TM-17.** Accept in writing that Workers observability stays off, or move admin search to POST.

---

## 12. Residual risks (accepted or out of scope)

- **Real-time phishing of password + TOTP** (adversary-in-the-middle on a lookalike domain) defeats TOTP. The mitigations are a custom domain the owner recognises, the TM-03 delay, and the audit trail. Passkeys (WebAuthn) would close it; that is a later project.
- **Social engineering over WhatsApp** (a fraudster posing as the studio). The portal is the source of truth; the copy says so; it cannot be fully prevented technically.
- **Forged receipts and fake WhatsApp claims** are always possible. The bank statement is the only proof (TM-20).
- **Cloudflare/Firebase account compromise** (X6) bypasses every Worker and DB control, triggers included. Mitigated only by account hygiene (TM-23) and Time Travel.
- **No out-of-band alert channel at launch** (no email provider). Detection of admin misuse relies on the owner opening `/admin`. Resend (Q12) would allow a "bank details changed" email to the owner's personal address.
- **Admin PII reads are not audited** (only exports and receipt views are). Acceptable for a single-admin studio; revisit if a second admin is ever added.
- **Signed URLs** remain bearer tokens for up to 1 hour for anyone the customer shares them with, until TM-09's revocation check applies.
- **Git history with original photos** (baseline SEC-06) is outside this plan but blocks any `git push`. The handoff `git archive` of the release tag does not include history.
- **Privacy notice / PDPL disclosure pages** (baseline SEC-15) belong to the pages/motion plan (11 Q11). They are a legal go-live item, not a technical control here.
