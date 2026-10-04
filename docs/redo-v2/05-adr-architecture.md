# ADR-001: Client portal on the existing single Worker
**Online confirmation (D2), timed holds and reminders, private media, photo selection, handover**

| | |
|---|---|
| Status | Proposed. Written in Run 1 `redo-v2-spec` on 2026-09-23. It becomes binding for Runs 2–8 once the owner accepts it. |
| Deciders | The owner (Sundus Yar). Author: solution architect. |
| Inputs | `decisions.md` (D1–D8), `00-inspection-report.md`, `01-product-spec.md`, `03-design-system.md`, and the code in `app/` at baseline `d6b7cb2`. Where the documents disagree, the code wins. |
| Handoffs | **compliance-officer**: PDPL residency and cross-border transfer, retention periods, sensitive-data classification (§2.7, U1, U9). **security-auditor**: signing-key management, upload and serving hardening, admin-account MFA, breach handling (§2.7). |

> **The decision in three lines**
> 1. Keep ONE Cloudflare Worker (it serves the SPA assets and `/api/*`, and gains a `scheduled()` handler on two Cron Triggers), together with D1, Firebase Auth and Resend. Add exactly one managed service: a **private R2 bucket that can only be reached through the Worker binding**.
> 2. D2 reuses the existing statuses (`approved_hold → payment_pending → confirmed`) and adds one column, `flow_version`. Existing rows stay on the unchanged manual path. The only status change a customer can trigger is a single atomic D1 batch. Everything after `confirmed` lives in child tables, and the 15 journey stages are **computed from those tables, never stored**.
> 3. Every write checks its own deadline, and a sweep runs every 15 minutes. Uploads go through the Worker, which checks the file's leading bytes (its "magic bytes") and its size. Images are resized in the admin's browser, so the originals never leave her machine. Private images are served through **short-lived HMAC-signed URLs** (links that carry a signature and an expiry time).

---

## 1. Context

### 1.1 Required inputs (architect rule 1)
| Input | In the spec? | How this ADR handles it |
|---|---|---|
| Current user count and 12-month target | **No** | I did not invent a number. Costs are priced at the scales the orchestrator asked for (10 and 1,000 bookings a month) plus a 100,000-user stress line. The owner should supply the real figures (U2). |
| Data sensitivity | Yes | Personal data of Saudi residents. Already stored today: names, phone numbers, emails. **New:** deposit receipts (financial data), delivery addresses, photos of brides and guests, questionnaire free text, and feedback. |
| Integrations | Yes | Firebase Auth (email/password), Resend (built but not configured), Cloudflare Workers and D1 (R2 is new), Google JWKS (the public keys used to verify sign-in tokens), and WhatsApp deep links only (no API). There is no payment gateway and no Nafath, Etimad or ZATCA integration. |
| Budget ceiling | **No** | I did not invent one. The complexity cap is applied as if the budget were under SAR 50,000: at most one deployment target, and a written justification for every managed service beyond the second (§4.3). The owner should supply the ceiling (U2). |

### 1.2 Facts from the code that drive this decision
- **The status CHECK constraint appears in two tables.** `booking_requests.status` (`migrations/0001_initial.sql:40-53`) and `booking_status_history.from/to_status` (`0001:97-125`), plus the partial unique index on the blocking statuses (`0001:72-80`) and the open-request index (`0004`). The list of blocking statuses is repeated in `worker/index.ts:143-149`, `worker/bookings.ts:286-309,518-538`, `worker/admin-workflow.ts:368-374,513-519` and `worker/admin.ts:778-784,845-851`. SQLite cannot alter a CHECK constraint, so adding a status means rebuilding both tables.
- **Admin transitions are atomic today.** The code runs a conditional `UPDATE` and then a history `INSERT` whose `to_status` becomes NULL when `changes() ≠ 1`, which forces the whole D1 batch to roll back (`admin-workflow.ts:483-585`). No code path lets a customer change a status.
- **The hold is written but never enforced.** It is fixed at 24 h (`admin-workflow.ts:17`). `worker/index.ts:215-287` exports only `fetch`, and `wrangler.jsonc:1-20` has no crons and no R2. The availability, duplicate and approval checks all filter on explicit status lists that exclude `expired` (`index.ts:138-152`, `bookings.ts:281-313`, `admin-workflow.ts:362-377`). **Setting a row to `expired` frees the date with no other change.**
- **Where the photo quota comes from.** `album.photoCount` is one of 30, 45, 60 or 80 (`src/data/packages.ts:88`, `shared/booking.ts:685-700`). It is `null` when the booking has no album (`shared/booking.ts:669-676`).
- **Email.** `sendEmail` quietly returns `skipped` when Resend is not configured (`email.ts:163-168`). `renderEmailLayout` is not exported (`email-templates.ts:197`). The idempotency key for status emails is `booking-status:<id>:<from>:<to>` (`worker/admin.ts:986-987`), so two actions that leave the status unchanged would produce the same key and the second email would be dropped.
- **Frontend.** `App.tsx:10-14` imports AdminDashboard, AuthDialog, MyBookings and PackageConfigurator statically, which produces one 470.79 kB chunk. `AuthProvider` wraps the whole app (`main.tsx:9`) and imports `firebase/auth` statically (`AuthContext.tsx:1-12`), so Firebase stays in the entry chunk under the auth model we must preserve. `BookingActions.tsx:64` types its labels as `Record<AdminBookingAction,string>`, so every new admin action must be added to that file in the same commit or the build breaks.
- **Images need a different access mechanism.** The only authentication is a bearer token sent in a header; there are no cookies. An `<img>` tag cannot send a bearer token, so private images need signed URLs.

### 1.3 Binding constraints honoured
- Prices, `shared/booking.ts`, and the booking-creation contract are unchanged.
- The auth model is unchanged: one Firebase listener, one provider, the D1-only admin role. The only auth change is the stale-token fix (HIGH #3).
- API changes are **additive**: new endpoints, new optional response fields, and two new admin action values.
- No new runtime dependency. `sharp` is already approved as a dev-only tool (D1).
- No React Router. The ≤4-files-per-task rule is kept. Data is private by default.

---

## 2. Decision

### 2.0 Component diagram, trust boundaries and data flow
```
 ZONE 1  bride's browser (untrusted)                 ZONE 2  admin's browser (trusted user, untrusted device)
+-------------------------------------------+       +-----------------------------------------------------+
| SPA entry chunk + lazy route/stage chunks |       | /admin chunk; ORIGINALS STAY ON DISK                |
| Firebase SDK keeps the ID token           |       | resize.worker (OffscreenCanvas) -> preview + thumb  |
| <img src="/api/media/<key>?e=..&s=..">    |       | (EXIF/GPS stripped by re-encoding)                  |
+----------+--------------------+-----------+       +------------------+---------------------+------------+
           |(A) sign-in         |(B) HTTPS /api/*, Bearer ID token      |(B) admin API and    |(A) sign-in
           v                    |    receipt multipart <= 5 MB          |    photo uploads    v
 +--------------------+         |                                       |    <= 1.5 MB each  (same Firebase)
 | Firebase Auth      |         v                                       v
 | (Google, US)       |  ====== TRUST BOUNDARY: Cloudflare edge -- the Worker is the ONLY policy point ======
 +---------^----------+  || Worker "sundus-yar-website"                                                  ||
           |(C) JWKS     || fetch():  verify JWT (jose + JWKS) -> email_verified -> ownership             ||
           +-------------||           (user_id inside the SQL) or D1 users.role='admin'                   ||
                         ||           -> size caps + magic bytes -> R2 put -> atomic D1 batch             ||
                         ||           -> mint signed media URLs (HMAC-SHA256)                             ||
                         || scheduled(): */15 expiry, reminders, outbox  |  0 0 retention, orphan sweep  ||
                         || secrets: RESEND_API_KEY, MEDIA_SIGNING_KEY, DEPOSIT_*  (never VITE_*)       ||
                         || static SPA assets are served WITHOUT invoking the Worker (run_worker_first)  ||
                         ==========+=====================+==========================+=====================
                          binding  |            binding  |                (D) HTTPS | API key
                                   v                     v                          v
                   +---------------------+  +------------------------+  +-------------------+ (E) SMTP
                   | D1 bookings DB      |  | R2 sundus-yar-media    |  | Resend            |------> bride's /
                   | exists; outside KSA |  | PRIVATE: no r2.dev,    |  | (account and      |        admin's inbox
                   | (D1 has no Middle   |  | no custom domain,      |  |  email data are   |
                   |  East location)     |  | region PENDING (U1)    |  |  stored in the US)|
                   +---------------------+  +------------------------+  +-------------------+
 (F) final step: the bride taps wa.me/966505647418?text=<encoded Arabic + reference + slot> -> WhatsApp (Meta)
     This is bride-initiated: from here the text is under her control and leaves our system.
```
- **Who authenticates and who authorizes.** Firebase Auth proves who the user is. The Worker is the only place that decides what she may do:
  - It verifies the JWT (`worker/auth.ts:84-98`).
  - Admin status comes from `users.role` in D1 (`admin-auth.ts:86-97`).
  - Ownership (`booking_requests.user_id = uid`) is checked **inside every SQL write**, not in an earlier read.
  - A media URL is a capability the Worker mints only after passing the same checks.
- **Where secrets live.** Only as Worker secrets: `RESEND_API_KEY`, `MEDIA_SIGNING_KEY`, `DEPOSIT_*`. Plain vars hold only non-secret configuration. The browser holds nothing but the public Firebase config and the user's own ID token. `.dev.vars*`, `.env*` and `.wrangler/` must be git-ignored before any secret exists on a developer machine (defect #10).
- **What crosses the public internet.**
  - (A) browser to Firebase: credentials.
  - (B) browser to Worker: tokens, uploads, signed URLs.
  - (C) Worker to Google: the JWKS keys.
  - (D) Worker to Resend: names, booking references and dates, stored in the US.
  - (E) mail delivery.
  - (F) WhatsApp.
  - The D1 and R2 bindings stay on Cloudflare's network, but the data still ends up stored outside the Kingdom.
- **Single points of failure, and what limits the damage.**
  1. **The one Worker script.** A bad deploy breaks the API and cron, but the static site keeps serving. Mitigation: versioned deploys and `wrangler rollback`.
  2. **The single D1 primary.** If it is down, every portal function is down; the marketing pages stay up.
  3. **Firebase Auth.** If it is down, no one can sign in. Tokens already issued stay valid for about an hour, and jose caches the JWKS keys.
  4. **Cron.** A missed run delays expiry and reminders but never corrupts data (§2.2).
  5. **Resend.** Emails queue in the outbox and are retried; the site remains the source of truth.
  6. **`MEDIA_SIGNING_KEY`.** If it leaks, links to known keys can be forged until the key is rotated.
  7. **The single admin account.** Whoever controls it can read every receipt and photo.
  8. **The admin's own machine.** It is the only place the originals exist. Backing them up is the owner's business process and is out of scope.

### 2.1 Booking state model (D2): reuse statuses, add columns and child tables
**What is stored.** `booking_requests.status` keeps its 9 values, so there is no CHECK change and no table rebuild. Everything below is additive (full sketch in §2.8):
- **New columns on `booking_requests`:**
  - `flow_version`: 1 = the legacy manual contract path (the default, so every existing row gets it); 2 = online confirmation. `approve` writes 2 only when the var `ONLINE_CONFIRMATION` is `on`. The var is a kill switch that affects **new approvals only**.
  - `deposit_amount`: a snapshot taken at approval, using the rule in `shared/deposit.ts` once D4 is decided.
  - `terms_version`, `terms_accepted_at`, `completed_at`.
- **New child tables:**
  - `booking_receipts`: one row per upload attempt. A partial unique index allows **at most one `pending` receipt per booking**.
  - `booking_events`: the audit log for every event that is not a status change, with actor `customer`, `admin` or `system`.
  - `notification_log` (the outbox) and `job_runs` (the cron heartbeat).
  - The post-confirmation tables in §2.4, §2.5 and §2.8.

**Actions under flow 2** (`shared/admin.ts` becomes flow-aware; the admin UI still just renders the server's `allowedActions`):
| Status (flow 2) | Admin actions | Customer actions | System |
|---|---|---|---|
| `approved_hold` | `extend_hold` (adds 24 h), `confirm_payment` (offline escape hatch, **note required**, U7), `cancel` | submit terms + receipt, which moves the booking to `payment_pending` | expire when `hold_expires_at` has passed |
| `payment_pending`, latest receipt **pending** | `confirm_payment` (marks the receipt `verified` in the same batch), `reject_receipt` (**reason required**; the hold becomes max(hold, now) + 24 h), `cancel` | nothing; she waits | **never expires**, because the next move is the admin's |
| `payment_pending`, latest receipt **rejected** | `extend_hold`, `cancel` | re-upload a receipt (status stays the same) | expire when `hold_expires_at` has passed |
| `confirmed` | `cancel` | post-confirmation child-table actions | none |

**Legacy rows (`flow_version = 1`).** They keep `allowedAdminActionsByStatus` exactly as today (`shared/admin.ts:38-50`): `mark_contract_sent`, `mark_contract_signed`, `request_payment`, `confirm_payment`. Their labels stay the same (`MyBookings.tsx:42-87`, `email-templates.ts:18-63`). They are **never expired by cron** (their old `hold_expires_at` has long passed) and they get no online panel. They drain naturally. Everything after `confirmed` (gallery, album, handover) applies to **every** confirmed booking, whichever flow it came through.

**Two rules for actions that leave the status unchanged.**
- `reject_receipt` and `extend_hold` write `booking_events`, not `booking_status_history`, so a history row still always means "the status changed". The batch-abort guard moves to `booking_events.event NOT NULL`, set with `CASE WHEN changes()=1 THEN '<event>' END`.
- Status emails are skipped when the status did not change. These actions send their own emails through the outbox with their own keys, which fixes the key collision at `worker/admin.ts:986-987`.

**The approve path.** It first runs the targeted expiry sweep for that event date, so a hold that has just expired never causes a false `DATE_UNAVAILABLE`.

**The first customer-initiated transition in this codebase:** `POST /api/bookings/:id/receipt`, sent as multipart with `file`, `termsVersion` and `termsAccepted=true`.
1. **Guards.** A verified Firebase token (existing helpers). `Content-Length` is required and must be within the cap; otherwise the request gets 411 or 413 before any bytes are read. The `termsVersion` must equal the current `TERMS_VERSION`, otherwise `TERMS_VERSION_MISMATCH`.
2. **Store the file.** Check the magic bytes, then `MEDIA.put('r/<bookingId>/<receiptId>', bytes, {httpMetadata:{contentType:<sniffed>}})`.
3. **Write to D1 in one batch, which is one transaction:**
   - `UPDATE booking_requests SET status='payment_pending', terms_version=?, terms_accepted_at=?now, updated_at=?now WHERE id=? AND user_id=?uid AND flow_version=2 AND status='approved_hold' AND hold_expires_at > ?now`
   - `INSERT booking_status_history … to_status = CASE WHEN changes()=1 THEN 'payment_pending' END`. This is the existing guard: NULL fails the NOT NULL constraint and the whole batch rolls back.
   - `INSERT booking_receipts (…,'pending')`. The partial unique index makes a second pending receipt impossible.
   - `INSERT booking_events ('receipt_submitted')`.
   - `INSERT notification_log (pending admin alert)`.
   - A re-upload after a rejection uses the same batch shape, but its first statement matches `status='payment_pending'` with the latest receipt `rejected` and `hold_expires_at > ?now`, and it changes no status.
4. **If the batch fails,** delete the R2 object, read the state again, and map it to `HOLD_EXPIRED`, `RECEIPT_ALREADY_PENDING` or `INVALID_STATUS_TRANSITION`. This mirrors `resolveTransitionFailure` (`admin-workflow.ts:390-430`).
5. **Retries are safe.** After refetching, the client treats `RECEIPT_ALREADY_PENDING` as success.

The UI copy for an expired hold: «انتهت مهلة الحجز المؤقت لهذا التاريخ. تواصلي معنا عبر واتساب إن رغبتِ في المتابعة.»

**Timestamp invariant.** The Worker writes every instant as `new Date().toISOString()`, and comparisons bind values in that same format. Never compare against SQLite `datetime('now')`, which uses a different format, and never use `DEFAULT CURRENT_TIMESTAMP` in new tables.

**Journey stages are derived, never stored.** They come from one pure function in `shared/journey.ts`, used by both the Worker (emails, queue) and the SPA (tracker). "Today" means the calendar date in Asia/Riyadh.
| # | Stage id | Label | It is her current stage when… (flow 2) | Deadline shown |
|---|---|---|---|---|
| 1 | `pending_review` | قيد المراجعة | status = `pending_review` | SLA badge (admin only) |
| 2 | `approved_hold` | تم القبول — التاريخ محجوز مؤقتًا | status = `approved_hold`. The main button «أكملي حجزك» opens panel 3. Flow-1 rows show the legacy guidance and no button. | `hold_expires_at` |
| 3 | `terms_and_receipt_pending` | أكملي حجزك | This is the panel opened from stage 2. It is also her current stage when `payment_pending` and the latest receipt is `rejected` (she sees the reason). | `hold_expires_at` |
| 4 | `receipt_review` | مراجعة الإيصال | `payment_pending` and the latest receipt is `pending` | none (admin SLA 24 h) |
| 5 | `confirmed` | الحجز مؤكد | `confirmed`, no `event_profiles` row, and today ≤ `event_date` | `event_date` |
| 6 | `pre_event_engagement` | تفاصيل يومكِ | `confirmed`, profile saved, and today ≤ `event_date`. After the event, and until a gallery opens, she stays here with the sub-state «نجهّز معاينات صوركِ». | `event_date` |
| 7 | `gallery_open` | معرض صورك | `galleries.status = 'open'` | `selection_deadline` (soft) |
| 8 | `gallery_locked` | تم إرسال اختياركِ | `locked`, and no `album_production` row | none |
| 9 | `album_design` | الألبوم قيد التصميم | album stage = `design` | none |
| 10 | `album_printing` | الألبوم قيد الطباعة | album stage = `printing` | none |
| 11 | `album_ready` | الألبوم جاهز | stage = `ready` and no `handovers` row. Its button opens panel 12. | none |
| 12 | `handover_scheduling` | احجزي موعد الاستلام | This is the panel opened from stage 11. It is also her current stage when a handover is `scheduled` and today < `slot_date`. | slot start |
| 13 | `handover_day` | يوم التسليم | `scheduled` and today ≥ `slot_date`. This is the final WhatsApp step. | the slot |
| 14 | `completed_feedback` | تم التسليم | handover `completed` and the gallery is not yet purged | purge date |
| 15 | `privacy_cleanup` | الخصوصية والحذف التلقائي | handover `completed`, and the gallery is purged or there never was one | none |

Legacy statuses (`contract_pending`, `contract_signed`, and `payment_pending` in flow 1) and the terminal statuses (`rejected`, `cancelled`, `expired`) map to no journey stage and render exactly as they do today.

### 2.2 Timing: `scheduled()` plus two Cron Triggers, catching up from state
- **Configuration.** `triggers.crons = ["*/15 * * * *", "0 0 * * *"]`. Cron Triggers run on UTC, so `0 0` is 03:00 Riyadh. `scheduled(controller)` dispatches on `controller.cron` to the jobs listed in `worker/jobs/registry.ts`.

| Job file | Trigger | What it does | How it catches up after a miss |
|---|---|---|---|
| `hold-expiry` | */15 | Finds flow-2 bookings that are `approved_hold`, or `payment_pending` with a rejected latest receipt, whose `hold_expires_at` ≤ now. Sets them to `expired`, writes history (`changed_by` NULL, which is safe with the foreign key), writes a `booking_events` row with actor `system`, and queues a `hold_expired` email. | Selects by state, not by time window. At most 50 per tick; the rest are handled on the next tick. |
| `hold-reminders` | */15 | Sends reminders 24 h and 6 h before `hold_expires_at` while she still owes a receipt. | Sends only if its due time ≤ now < deadline. If both reminders are due, it sends the 6 h one and marks the 24 h one `superseded`. |
| `outbox-drain` | */15 | Sends `pending` rows. A failure goes back to `pending` for up to 3 attempts within 24 h of creation (Resend keeps idempotency keys for 24 h), then becomes `failed`. | Selects by state. |
| `event-reminders`, `selection-reminders`, `handover-reminders`, `feedback-request` | */15, sent only between 09:00 and 21:00 Riyadh | Event −7 d and −1 d (only while still confirmed). Selection −7 d, −2 d, and one overdue notice. Handover −1 d. Feedback +2 d after completion. | Keyed by Riyadh date. A late reminder that is still relevant is sent once; one whose anchor has passed is marked `superseded`. |
| `retention` | 0 0 | Purges data on the schedule in §2.3. | Works in bounded batches and resumes the next day. |
| `orphan-sweep` | 0 0, Fridays (Riyadh) | Deletes R2 objects older than 24 h that no D1 row references. | Lists in pages of 1,000. |

- **The outbox (`notification_log`) is idempotent.**
  - The primary key is `dedupe_key = '<kind>:<entityId>:<anchor>'`. The same value is sent as Resend's `Idempotency-Key`, which fits within the 256-character limit in `email.ts:9`.
  - The anchor is the deadline itself (for example the `hold_expires_at` value). An extension or rejection therefore creates new keys, which **re-arms** the reminders automatically.
  - An email is rendered when it is queued and stored in `payload`. That lets the drain job stay generic, with no renderer registry. `recipient` and `payload` are set to NULL once a row reaches a terminal status (data minimisation).
  - A row is claimed by a conditional `UPDATE … SET status='sending' WHERE status='pending'` (or a stale `sending` older than 30 min).
  - The result `skipped` (Resend not configured) is terminal, and the admin queue shows it so it is no longer silent.
  - Existing emails keep their current path.
- **After a missed cron run** (Cloudflare documents no delivery or retry guarantee for scheduled events):
  - No customer can act after a deadline, because every write checks `hold_expires_at > now` itself.
  - The next tick expires everything overdue. The date is freed late by the length of the gap, and the public calendar may show it as unavailable for up to about 15 minutes. That is accepted.
  - Reminders never go out late and wrong: only the most urgent relevant one is sent.
  - `job_runs` records each start and finish, and the admin queue warns when the last successful 15-minute run is more than 60 minutes old.
- **Time.**
  - Instants are stored in UTC.
  - `event_date` and `slot_date` are Riyadh calendar dates.
  - Day arithmetic uses `Intl` with `timeZone: 'Asia/Riyadh'` (the pattern in `worker/bookings.ts:140-151`, moved into `shared/timing.ts`). Riyadh is UTC+3 with no daylight saving, but the offset is never hard-coded.
  - The D5 defaults are typed constants in `shared/timing.ts`: 48 h hold, 24 h and 6 h reminders, 24 h SLAs, a 14-day selection window, 30-day preview retention, −1 d handover reminder, +2 d feedback.
- **Bounds per tick.** At most 50 expiries and 40 emails. Emails are sent one after another, paced below Resend's default per-second limit.
- **Plan note.** On Workers Free, cron gets 10 ms of CPU, 50 D1 queries per invocation and 50 subrequests. That makes these jobs fragile, so **Workers Paid is recommended from Run 3 onward** (U3).

### 2.3 File storage: a private R2 bucket reached only through the Worker binding
- **The bucket.** One bucket, `sundus-yar-media`, bound as `MEDIA`. It has no r2.dev URL, no custom domain and no public listing.
  - Two prefixes: `r/<bookingId>/<receiptId>` for receipts and `g/<galleryId>/<photoId>/{p,t}` for gallery preview and thumbnail.
  - Keys contain only random UUIDs: never names, original filenames or phone numbers.
  - Keys are written once, so a new upload always gets a new key.
- **Region: NOT CHOSEN.** The choice is blocked on the PDPL question in §2.7 (U1). If a transfer abroad is permitted, the proposed default is the same location as the existing D1 database (check the dashboard), chosen to keep the two together, not because it is cheapest. Note that a jurisdiction setting cannot be changed after a bucket is created.
- **Upload path.** Through the Worker:
  - Multipart request with `Content-Length` required.
  - The bytes are buffered up to the cap.
  - The type is sniffed from the magic bytes and must be on the allowlist.
  - The Worker calls `put` with the sniffed content type. The type the client declares is ignored.
  - There are no presigned URLs (§3). Workers accept request bodies up to 100 MB and have 128 MB of memory, so the caps below are far inside those limits.

| Constant (`shared/media.ts`) | Value | Allowed types, checked by magic bytes |
|---|---|---|
| Receipt | ≤ 5 MiB (5,242,880 B); one pending at a time | JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF….WEBP`, PDF `%PDF-` |
| Gallery preview / thumbnail | ≤ 1.5 MiB / ≤ 256 KiB; long edge 1600 px / 480 px (U10) | JPEG, WebP |
| Photos per gallery | ≤ 1,000 (a technical guard) | none |

- **Preparation in the browser.**
  - **Admin gallery.**
    - A module Web Worker (`new Worker(new URL(...), {type:'module'})`, which Vite supports natively with no dependency) decodes each file with `createImageBitmap` and draws it on an `OffscreenCanvas`. It produces WebP at quality ≈0.80, falling back to JPEG when the browser returns a different `blob.type` because it cannot encode WebP. It falls back to the main thread when `OffscreenCanvas` is missing.
    - Files are decoded one at a time and each bitmap is closed immediately, which keeps memory in check with 24–45 MP originals.
    - Re-encoding strips EXIF and GPS data. `File.name` is kept only as a D1 metadata field.
    - Uploads run 3 at a time with retries. A bulk upload can resume after an interruption because `UNIQUE(gallery_id, original_filename)` makes a re-upload a no-op.
    - Progress uses `XMLHttpRequest` upload events, and a `beforeunload` guard warns while an upload is running.
  - **Receipts.** Images are re-encoded to at most 2000 px as JPEG at quality 0.85, which strips metadata while keeping the text readable. PDFs are uploaded unchanged.
- **Serving private images to `<img>`.**
  - **URL format:** `/api/media/<key>?e=<unixSeconds>&s=<base64url(HMAC-SHA256(MEDIA_SIGNING_KEY, "v1\n"+key+"\n"+e))>`.
  - **Verification** uses `crypto.subtle.verify`, which compares in constant time. The Worker also rejects `e` values in the past or more than 2 h ahead, and keys that don't match `^(r|g)/[0-9a-f-]{36}/[0-9a-f-]{36}(/(p|t))?$`.
  - **Lifetimes.**
    - Gallery links use `e = (floor(now/3600)+2)*3600`. Each link is valid for 60–120 minutes and stays **identical for the whole clock hour**, so the browser cache gets hits.
    - Receipt links live for 10 minutes.
  - **Issuing.** Links are minted only after ownership or admin checks, and only while the gallery is `open` or `locked` (the admin may also view `draft`).
  - **Response headers:**
    - Content type: the stored (sniffed) type.
    - `Cache-Control: private, max-age=<e-now>, immutable`.
    - `ETag` from R2's `httpEtag`, with a `304` via `get(key,{onlyIf: request.headers})`.
    - `X-Content-Type-Options: nosniff`.
    - `Content-Security-Policy: default-src 'none'; sandbox`.
    - `Cross-Origin-Resource-Policy: same-origin`.
    - `Referrer-Policy: no-referrer`.
    - `Content-Disposition: inline` for images and `attachment` for PDFs.
  - **Nothing is cached at the edge.**
  - **Key rotation.** An optional `MEDIA_SIGNING_KEY_PREVIOUS` is accepted for 2 h during a rotation.
- **Retention and deletion.** These are proposed defaults that the owner and compliance-officer must confirm (U9). A daily job enforces them; a lifecycle rule is only a safety net.

| Data | Where | Deleted when (default) |
|---|---|---|
| Gallery previews and thumbnails | R2 `g/` | 30 days after handover completion (D5), or 30 days after the booking is cancelled or expires. Safety net: an R2 lifecycle rule on `g/` deletes objects 180 days after upload. |
| Receipt files | R2 `r/` | 90 days after `event_date` for a confirmed booking; 30 days after rejection, cancellation or expiry. The D1 metadata row is kept. |
| Delivery address | D1 `handovers` | Set to NULL 30 days after the handover is completed. |
| Questionnaire free text | D1 `event_profiles` | Set to NULL 90 days after the event. The consent flag and its timestamps are kept as proof. |
| Rendered emails | D1 `notification_log` | The payload is set to NULL at a terminal status. Rows are deleted after 180 days. |
| Deleted rows (platform) | D1 Time Travel | Up to 30 days (Paid plan) before they are truly gone. This must be disclosed (see compliance). |

### 2.4 Photo selection model
- **Tables.**
  - `galleries` has one row per booking: `draft → open → locked`, and then `purged`.
  - `gallery_photos` holds `original_filename` and both keys, with `UNIQUE(gallery_id, original_filename)`.
  - `gallery_selections` stores two flags per photo, `is_selected` and `is_favourite`, with primary key `(gallery_id, photo_id)`.
- **Quota.** It is copied into the gallery row when the gallery is created:
  - `packageSnapshot.album.photoCount` (30, 45, 60 or 80), with `quota_source='package'`;
  - otherwise the coverage-only default of 30 (U11), with source `coverage_default`;
  - otherwise, if the snapshot cannot be parsed, a quota the admin enters (1–500, source `admin`).
  - The quota never changes after creation. A gallery can only be created when the booking is `confirmed` and `event_date` ≤ today in Riyadh.
- **Auto-save.**
  - The client queues selections and sends them after 600 ms as `POST /api/bookings/:id/gallery/selection` with `{ops:[{photoId, field:'selected'|'favourite', value}]}` (1–50 ops).
  - The ops are idempotent "set" operations, not toggles, so retrying is safe.
  - The server applies each op with its own conditional statement and returns the authoritative counts.
  - A "select" first inserts the base row with `INSERT OR IGNORE`, guarded by an ownership check on `user_id` and a check that the photo belongs to the gallery. It then runs `UPDATE … SET is_selected=1 WHERE … AND is_selected=0 AND (SELECT COUNT(*) … is_selected=1) < (SELECT quota …) AND gallery status='open'`.
  - A single statement is atomic in D1, so two open tabs can never push her past the quota.
  - The client rolls back an op the server refused and shows «وصلتِ إلى العدد المتاح في باقتكِ ({quota} صورة). ألغي اختيار صورة لتضيفي غيرها.»
- **Submitting and locking.** `POST …/gallery/submit` runs `UPDATE galleries SET status='locked' … WHERE status='open' AND booking is hers AND confirmed AND selected count = quota`, followed by the events guard. It requires **exactly** the quota (spec GAL-07) and a confirmation dialog in the UI. After that, any selection op returns `GALLERY_LOCKED`.
- **Deadline.** The deadline is **soft** (U19): she can still submit after it passes. The admin queue flags the booking as «متأخرة», and the admin can extend the deadline, which re-arms the reminders through the anchor. Nothing is ever auto-selected for her.
- **Admin export.** `GET /api/admin/galleries/:gid/selection` returns `{filenames}` in `sort_order`. The admin UI offers a `.txt` download (one name per line, UTF-8, created as a Blob URL that is revoked right after the click) and "copy for Lightroom" (comma-separated). Filenames are shown to the admin only, never used in keys or URLs, and never logged.
- **Photo changes.** The admin can add photos while the gallery is `draft` or `open`, and delete them only while it is `draft`. Reopening a locked gallery (GAL-11, later) requires a reason and is logged in `booking_events`.

### 2.5 Handover scheduling and the final WhatsApp step
- **Slots are defined by the admin, not typed as free text.**
  - `handover_slots` fields: `slot_date` (Riyadh), `starts_at`/`ends_at` (UTC), `method` (`pickup`, `delivery` or `both`), `capacity` (default 1, range 1–20), `is_active`.
  - A slot that has bookings cannot be deleted; it can only be deactivated.
- **Booking a slot** (`handovers` has one row per booking) uses a conditional insert: `INSERT … SELECT … WHERE the booking is hers and confirmed AND the album stage is 'ready' AND the slot is active, in the future and method-compatible AND (SELECT COUNT(*) FROM handovers WHERE slot_id=? AND status='scheduled') < capacity`. That enforces capacity for any value, not only 1. When it fails she gets `SLOT_FULL`.
- **Pickup or delivery (D3).** Delivery requires `delivery_address` (≤500 characters), which is treated as personal data and purged on the §2.3 schedule. The pickup location, delivery area and any fee are owner decisions (U13); until they are made, the site shows «سيتم تحديد مكان الاستلام عبر واتساب».
- **Reminder.** One day before, at 09:00 Riyadh or later, through the outbox.
- **Completion.** The admin marks the handover `completed`, which stamps `handovers.completed_at` and `booking_requests.completed_at` and starts the retention clock.
- **The WhatsApp deep link.**
  - It uses `src/lib/whatsapp.ts`, which holds the number `966505647418`. Today the number is duplicated at `App.tsx:103` and `MyBookings.tsx:335`.
  - `buildWhatsAppUrl(text)` returns `https://wa.me/966505647418?text=${encodeURIComponent(text)}`. Line breaks become `%0A`.
  - Latin runs (the reference and the times) are wrapped in the Unicode isolates U+2068…U+2069 so the right-to-left text does not reorder them.
  - The message is pre-filled but never sent automatically. It is written in the bride's own voice, so the verbs are first person, and it includes the reference and the slot:

  «السلام عليكم، أنا {الاسم الأول}، ورقم حجزي {المرجع}. موعد {استلام الألبوم من الاستوديو / توصيل الألبوم}: {اليوم والتاريخ}، من {البداية} إلى {النهاية}. أودّ تأكيد الموعد، وشكرًا لكم.»

  - After booking a slot she sees the button as a secondary action. It becomes the primary button on `handover_day`.

### 2.6 Frontend architecture
- **Code-splitting.**
  - `React.lazy` is used for each route in the custom router: `/admin` (AdminDashboard, BookingActions, BlockedDatesManager), `/packages` (the page plus PackageConfigurator and BookingCalendar) and `/my-bookings` (MyBookings and the journey).
  - `AuthDialog` is lazy in the header and prefetched on pointer-enter or focus of «تسجيل الدخول».
  - Each stage view and each admin section is lazy through its registry. The lightbox and the resize worker are separate chunks.
  - While a chunk loads, a Suspense fallback shows a static skeleton. If a chunk fails, an error boundary shows retry text in Arabic.
- **What stays in the entry chunk:** React, the Home and Portfolio pages, the layout, and `AuthProvider` with Firebase Auth (the auth model we must preserve).
  - Acceptance: the entry chunk contains no code from AdminDashboard, PackageConfigurator, MyBookings or AuthDialog, and the sizes of every chunk are recorded against the 470.79 kB / 130.93 kB gzip baseline.
  - If the entry chunk is still above 100 kB gzip after splitting, the owner decides on ADR-002, which would defer Firebase initialisation *inside* the single AuthProvider. That is deferred, not rejected.
- **The router.** The custom History-API router stays (`App.tsx:747-853`). There is no React Router and **no new `AppPath` literal**. `App.tsx` adds `search` to `BrowserLocation` and a `RouteContext` (`useRoute()` returns `{pathname, search, hash}`), so features can read query parameters without passing props down through every component.
- **New views mount without adding pages.** The four public pages (`/`, `/portfolio`, `/packages`, `/my-bookings`) and `/admin` stay as they are.
  - The customer hub is `/my-bookings?booking=<id>&view=complete|details|gallery|handover|feedback`.
  - The admin uses `/admin?booking=<id>&tab=queue|bookings|blocked-dates|slots`, which also fixes defect #15.
  - Emails deep-link to these URLs. An unknown or not-yet-allowed view falls back to the booking card, and the server enforces access regardless.
- **Where code lives.**
  - `shared/` holds every cross-boundary contract and pure piece of logic: request and response types, stage ids and labels, limits, timing constants and `deriveJourneyStage`. Both sides validate at runtime with type guards (no `as`).
  - The duplicated status lists (`src/api/bookings.ts:40-50`, `worker/bookings.ts:34-46`) converge on `shared/admin.ts`.
  - Feature code lives in `worker/portal/<feature>.ts`, `worker/jobs/<job>.ts`, `worker/emails/<feature>.ts`, `worker/media/*`, and `src/features/<feature>/` (component, CSS, API wrapper, helpers).
  - The page shell lives in `src/pages/`, `src/layout/` and `src/lib/`.
- **Registries.** There are 5 explicit registry files (§6.2). Each feature adds one import and one entry, so the wiring stays easy to find with a search. New features never edit the host components.

### 2.7 Security and PDPL controls
> **PDPL flag, raised before any hosting region is chosen.** This product processes personal data of Saudi residents. Today it holds names, phone numbers and emails. It is adding financial receipts, home addresses, and private photos of brides and guests. **None of the services priced here stores data inside the Kingdom:**
> - D1 does not run in the Middle East, so *the existing database already sits abroad*.
> - R2 location hints (wnam, enam, weur, eeur, apac, oc) and jurisdictions (eu, fedramp, us) include no KSA option.
> - Firebase Auth stores its data in the US.
> - Resend stores account and email data in the US whatever the sending region.
>
> **The question for the owner and compliance-officer:** must this data stay in the Kingdom, or may it be transferred abroad under the PDPL cross-border rules (SDAIA's transfer regulation, whether by adequacy or appropriate safeguards)? **I am flagging this question, not resolving it.** Until it is answered, the R2 bucket is not created and Runs 4 and 6 do not go live. If the answer is "must stay in the Kingdom", the storage and auth layers of this ADR must be decided again.

| Concern | Control in this design | Built in |
|---|---|---|
| Access to receipts and photos | Private bucket, reachable only through the Worker binding. Signed URLs are minted after an ownership or admin check and last 10 min (receipts) or 60–120 min (gallery). Keys are random UUIDs. | W4-1, W4-3, W6-1 |
| IDOR (reading or changing someone else's booking) | Every customer read or write filters on `booking_requests.user_id = uid` inside the SQL statement itself. | every portal handler |
| Upload abuse | A verified email is required; `Content-Length` is mandatory; size caps; magic-byte allowlist; one pending receipt at a time; gallery uploads are admin-only; at most 1,000 photos. | W3-3 `request.ts`, W4-1 |
| Stored XSS through an uploaded file | Only the sniffed type is served, with `nosniff`, CSP `sandbox`, PDFs as attachments, and CORP `same-origin`. | W4-1 |
| Data minimisation | Originals are never uploaded; previews are at most 1600 px; EXIF and GPS are stripped; no personal data in keys, URLs or logs; rendered email payloads are set to NULL. | W6-2, W4-4, W3-3 |
| Consent and terms | `terms_version` + `terms_accepted_at`. Publishing consent **defaults to NO**, and every change is written to `booking_events`. | W4-3, W5-1 |
| Retention | The §2.3 schedule, enforced by a daily job, with an R2 lifecycle safety net. | W8-2 |
| Logging | Fixed error codes only, following the existing pattern (e.g. `bookings.ts:433`). Never log tokens, signed URLs, names, phone numbers or IBANs. | all |
| Audit trail | `booking_status_history` records status changes; `booking_events` records everything else, with the actor. | W3-2 |

**Questions flagged for the compliance-officer (not resolved here):**
1. In-Kingdom storage versus transfer abroad, which covers D1, R2, Firebase and Resend (U1).
2. Whether receipts, bride photos or guest images count as sensitive data, and the lawful basis for processing images of guests.
3. The retention periods in U9, especially whether receipts are financial records the business must keep.
4. The content of the privacy notice, including disclosure of Time Travel and Resend retention (U16).
5. How data-subject requests (access, correction, deletion) are handled. There is no self-service; the admin runs a procedure.
6. Data processing agreements with Cloudflare, Google and Resend.

**Notes for the security-auditor (not resolved here):**
- Generating, storing and rotating `MEDIA_SIGNING_KEY`.
- Encryption at rest and key management for D1 and R2, which Cloudflare manages.
- Breach detection and notification.
- TOTP MFA and email-enumeration protection for the single admin Firebase account (U15).
- A CSP for the SPA through `public/_headers` that still allows the Firebase endpoints.
- Rate limiting: none is added, because every write is authenticated and bounded by its state.
- PDFs are not scanned for malware; they are delivered as attachments.
- A signed link can still be forwarded or screenshotted while it is valid.

### 2.8 Schema: one additive migration, `0005_portal_schema.sql` (sketch; W3-2 writes the final DDL)
The whole schema goes in at once, in Run 3, as one migration the owner reviews. That means one production schema change instead of five on a migration chain that is already fragile. It also lets the journey loader and the retention job be written against the complete schema from day one.
```sql
ALTER TABLE booking_requests ADD COLUMN flow_version INTEGER NOT NULL DEFAULT 1 CHECK (flow_version IN (1,2));
ALTER TABLE booking_requests ADD COLUMN deposit_amount INTEGER CHECK (deposit_amount IS NULL OR deposit_amount >= 0);
ALTER TABLE booking_requests ADD COLUMN terms_version TEXT;
ALTER TABLE booking_requests ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE booking_requests ADD COLUMN completed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_booking_requests_flow_status_hold ON booking_requests(flow_version, status, hold_expires_at);

CREATE TABLE IF NOT EXISTS booking_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (actor IN ('customer','admin','system')), actor_uid TEXT,
  event TEXT NOT NULL, note TEXT CHECK (note IS NULL OR length(note) <= 500), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notification_log (dedupe_key TEXT PRIMARY KEY NOT NULL, booking_id TEXT NOT NULL,
  kind TEXT NOT NULL, recipient TEXT, payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','skipped','failed','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  created_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT, provider_message_id TEXT);
CREATE TABLE IF NOT EXISTS job_runs (job TEXT PRIMARY KEY NOT NULL, last_started_at TEXT, last_finished_at TEXT,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok','error')));

CREATE TABLE IF NOT EXISTS booking_receipts (id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  object_key TEXT UNIQUE,                                   -- NULL after purge
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  status TEXT NOT NULL CHECK (status IN ('pending','verified','rejected')),
  uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT,
  rejection_reason TEXT CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 500), purged_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_receipts_one_pending ON booking_receipts(booking_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS event_profiles (booking_id TEXT PRIMARY KEY NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  venue_name TEXT, venue_area TEXT, start_time TEXT, special_requests TEXT,   -- length CHECKs in final DDL
  publishing_consent INTEGER NOT NULL DEFAULT 0 CHECK (publishing_consent IN (0,1)),
  consent_updated_at TEXT, submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL, text_purged_at TEXT);

CREATE TABLE IF NOT EXISTS galleries (id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL UNIQUE REFERENCES booking_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft','open','locked','purged')),
  quota INTEGER NOT NULL CHECK (quota BETWEEN 1 AND 500),
  quota_source TEXT NOT NULL CHECK (quota_source IN ('package','coverage_default','admin')),
  opened_at TEXT, selection_deadline TEXT, submitted_at TEXT, purged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gallery_photos (id TEXT PRIMARY KEY NOT NULL,
  gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 200),
  preview_key TEXT UNIQUE, thumb_key TEXT UNIQUE, width INTEGER NOT NULL, height INTEGER NOT NULL,
  sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (gallery_id, original_filename));
CREATE TABLE IF NOT EXISTS gallery_selections (gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES gallery_photos(id) ON DELETE CASCADE,
  is_selected INTEGER NOT NULL DEFAULT 0 CHECK (is_selected IN (0,1)),
  is_favourite INTEGER NOT NULL DEFAULT 0 CHECK (is_favourite IN (0,1)),
  updated_at TEXT NOT NULL, PRIMARY KEY (gallery_id, photo_id));
CREATE INDEX IF NOT EXISTS idx_gallery_selections_selected ON gallery_selections(gallery_id) WHERE is_selected = 1;

CREATE TABLE IF NOT EXISTS album_production (booking_id TEXT PRIMARY KEY NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('design','printing','ready')), stage_updated_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS handover_slots (id TEXT PRIMARY KEY NOT NULL, slot_date TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('pickup','delivery','both')),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 20),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)), created_at TEXT NOT NULL, UNIQUE (starts_at, method));
CREATE TABLE IF NOT EXISTS handovers (booking_id TEXT PRIMARY KEY NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL REFERENCES handover_slots(id), method TEXT NOT NULL CHECK (method IN ('pickup','delivery')),
  delivery_address TEXT CHECK (delivery_address IS NULL OR length(delivery_address) <= 500),
  status TEXT NOT NULL CHECK (status IN ('scheduled','completed')),
  booked_at TEXT NOT NULL, completed_at TEXT, address_purged_at TEXT);
CREATE INDEX IF NOT EXISTS idx_handovers_slot_scheduled ON handovers(slot_id) WHERE status = 'scheduled';
CREATE TABLE IF NOT EXISTS feedback (booking_id TEXT PRIMARY KEY NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 1000), submitted_at TEXT NOT NULL);
```
The rules for this migration:
- **Prerequisite (D8).** First, a read-only inspection of the remote database and a repair of the duplicate 0001/0002 migrations, so that 0001 through 0005 apply cleanly to a fresh local DB. Also check for duplicate data before 0004's unique index is applied remotely.
- **Additive statements only.** `ADD COLUMN` with a CHECK or DEFAULT is valid in SQLite, and every foreign key points at `booking_requests(id)`, which is the primary key in both schema variants.

---

## 3. Alternatives rejected

> **The strongest rejected alternative overall:** storing the journey stages as new `booking_requests.status` values (for example `receipt_submitted`, `receipt_rejected`, `gallery_open`).
> - It **loses on risk and complexity**. SQLite cannot alter a CHECK constraint, so it would mean rebuilding `booking_requests` *and* `booking_status_history` along with both partial unique indexes and their foreign keys.
> - That rebuild would run against a production schema whose state is unknown (D8) and a migration chain that is already broken (0001 = 0002).
> - It would also change the blocking-status list that is repeated across four Worker files.
> - The user gets **nothing** from it that the derived stages in §2.1 do not already provide.

| Area | Rejected alternative | Lost on | Specific reason |
|---|---|---|---|
| Timing | Cloudflare Workflows or a Durable Object alarm per booking | complexity (a 5th managed primitive) | Every extend, reject or cancel would have to signal or cancel a per-booking instance, and state would be split between D1 and the instances. A 15-minute resolution is plenty for deadlines of 6–48 h. |
| Upload path | Presigned R2 URLs (S3 API) for direct browser uploads | complexity and security | It needs S3 credentials and SigV4 signing (either the `aws4fetch` dependency or hand-written crypto) plus bucket CORS. The bytes also land *before* any size or type check, which would need a quarantine step. There is no gain for files of 1.5 MB or less. |
| Serving images | Blob URLs from an authenticated `fetch` | latency and memory | No native lazy loading, `srcset` or HTTP caching; hundreds of object URLs to revoke; a fresh token for every image. |
| Where binaries live | D1 BLOBs or Firebase Storage | platform limits, lock-in, compliance | D1 caps rows at 2 MB and a database at 10 GB. Firebase Storage would add a second rules and auth model and another store in the US. |
| Selection | Keep the selection in `localStorage` and submit it once | data loss | No continuity across devices, the admin can't see the count live, and a cache clear loses her work. |
| Handover | A free-text "preferred time" and WhatsApp | operational | No capacity or conflict control, reminders can't be computed, and it brings back the WhatsApp back-and-forth the owner wants to escape. |
| Frontend | A new top-level `/gallery` route (spec §2) | complexity | It needs extra AppPath, title and gate plumbing in `App.tsx`. A stage view under `/my-bookings` gives the same lazy chunk and a deep link through the query string. This also settles the disagreement between the spec and `03-design-system.md` §5. |
| Privacy | Unguessable but permanent public R2 URLs | compliance | They never expire and can't be revoked, so a forwarded link leaks bride photos and receipts. |
| Hosting | Moving to an in-Kingdom cloud now | cost and complexity (premature) | It would rewrite the stack we must preserve (Firebase Auth, D1, Resend) before any PDPL determination exists. Revisit only if the compliance-officer requires in-Kingdom storage. |
| Email | Replacing Resend with Cloudflare Email Service | maturity | It was still in public beta (not GA) at the time of writing, Resend is a binding constraint, and `email.ts` is already complete. |

---

## 4. Consequences

### 4.1 Positive
- No table rebuild.
- One deployment target.
- About SAR 19 a month at realistic volume.
- Deadlines are enforced inside each transaction, so a missed cron run cannot let a late write through.
- One source of truth for the stage, shared by the UI, emails and the admin queue.
- Private by default; originals never leave the photographer's machine.
- Legacy rows behave exactly as they do today.

### 4.2 Negative and accepted
- 12 new tables and 5 new columns.
- 5 registry files that must be edited in order.
- Firebase stays in the entry chunk.
- **There is no automated test runner, and adding one would be a new dependency.** The invariants (quota, capacity, one pending receipt, deadlines) therefore live in SQL predicates and unique indexes, and each task is checked with lint, a build and a runtime check.
- The admin has to process receipts within the SLA.
- A signing key has to be operated and rotated.
- Holds free up late by up to about 15 minutes.

### 4.3 Complexity cap (rule 3)
There is **one deployment target**: the Worker serves the SPA, the API and cron. Cron Triggers are configuration on that same Worker, so they add no new service or bill. There are **4 managed services**: 1 D1 (exists), 2 Firebase Auth (exists and is binding). The two beyond the second are justified here:
- **#3 Resend:**
  - It is already built, with Arabic templates, `escapeHtml` and idempotency, and "Resend design" is a binding constraint.
  - Reminders are the core of D5 and of the owner's engagement goal.
  - The alternatives are a beta product, or the WhatsApp Business API, which is a bigger integration with per-conversation fees.
- **#4 R2:**
  - The binary files cannot live in D1 (2 MB per row, 10 GB per database).
  - It is used through a native binding, so there are no credentials, no SDK and no dependency.
  - There are no egress fees, and it shares Cloudflare's bill and console.
  - It is private by default.

**Considered and not added:** Queues, KV, Durable Objects, Workflows, Cloudflare Images, Turnstile, and the Rate-Limiting binding.

### 4.4 Compliance named, not drafted (rule 7). Handoff: compliance-officer
- **PDPL.** Cross-border transfer for D1, R2, Firebase and Resend (§2.7). Retention and destruction, data-subject rights, and breach notification.
- **Payments.** The deposit is a bank transfer proven by a receipt image, which is financial personal data. No card data is handled and there is no payment gateway. A future gateway would need its own assessment (PCI DSS / SAMA).
- **ZATCA (Fatoora) e-invoicing.** It is not integrated. Whether deposits need e-invoices is a question for the owner's accountant or the compliance-officer (U17).
- **Nafath and Etimad.** Not integrated.
- **NCA ECC-2.** Not assessed. The compliance-officer should confirm whether it applies to a private sole-proprietor site.

### 4.5 Go-live gates (the configuration can be merged before these; the features cannot be switched on)
- **Run 3:**
  - The D1 chain is repaired, and 0005 is applied with the owner's approval.
  - Workers plan decided (U3).
  - Resend configured (U14). Otherwise every reminder is recorded as `skipped`.
- **Run 4, before `ONLINE_CONFIRMATION` is switched `on`:**
  - U1 answered, and the bucket created in the approved location.
  - The security review W4-5 passed.
  - D4: deposit rule and bank details supplied.
  - The terms text supplied (U6).
- **Run 6:**
  - The gallery security review W6-4 passed.
  - U9 retention decided.
  - U10 preview size and watermark decided.

---

## 5. Cost (SAR per month; USD 1 = SAR 3.75; before any VAT the vendors add at checkout)
**Assumptions per booking that runs the full lifecycle:**
- 400 previews at about 300 KB each plus a 40 KB thumbnail, roughly 136 MB. They live for about 3.5 months: selection, then production, then handover + 30 days.
- 1 receipt of about 1 MB, kept about 6 months.
- About 16 emails.
- About 3,000 Worker requests.
- About 700 D1 rows written and about 100k read.

**The business ceiling:** `ux_booking_requests_blocking_event_date` allows one held or confirmed booking per date. That means **at most about 31 full-lifecycle bookings a month**. "1,000 bookings a month" is therefore a conservative upper bound for the infrastructure. At the realistic ceiling of about 30 events a month, the bill stays around SAR 19.

| Service and tier | 10 bookings/mo | 1,000 bookings/mo | 100,000 users/mo (stress: 100k signed-in MAU + the 1,000-booking media load) |
|---|---|---|---|
| Workers **Paid** ($5 base: 10M requests, 30M CPU-ms included; +$0.30 per extra million requests) | **18.75** (≈30k requests) | **18.75** (≈4M requests, ≈12M CPU-ms) | **23.25** (≈14M requests: +$1.20) |
| D1 (Paid: 25B reads, 50M writes, 5 GB included) | 0 | 0 (≈0.7M writes, ≈100M reads) | 0 |
| R2 Standard (10 GB, 1M Class A and 10M Class B free; then $0.015/GB-mo; no egress fees) | 0 (≈5 GB) | **26.55** (≈482 GB; 472 GB × $0.015; ≈0.81M Class A and ≈2.5M Class B, both within free) | **26.55** |
| Resend (Free 3,000/mo and 100/day; Pro $20 for 50k; $35 for 100k) | 0 (≈160 emails) | **75.00** (Pro, ≈16k) | **131.25** (Pro 100k, ≈56k) |
| Firebase Auth, email/password (50k MAU free, then $0.0055/MAU under Identity Platform pricing) | 0 | 0 | **1,031.25** (50,000 × $0.0055) |
| **Total** | **SAR 18.75** | **SAR 120.30** | **SAR 1,212.30** |

**How the bill grows:** Workers Free at SAR 0 (possible at 10 bookings, not recommended because of the cron limits) → Workers Paid at SAR 18.75 → plus R2 storage (SAR 26.55) and Resend Pro (SAR 75) at 1,000 bookings, for SAR 120.30 → plus Firebase MAU charges (SAR 1,031.25) at 100k MAU, for SAR 1,212.30. The owner should confirm which Firebase Auth tier the project is on (U18).

**Data residency.** Every line above stores data outside the Kingdom (see §2.7). The PDPL cross-border question is flagged for the compliance-officer, not resolved here.

---

## 6. Workstreams for Runs 2–8
Each workstream owns its paths **exclusively**; no path appears in two workstreams. A workstream runs as sequential tasks (T1, T2, …) of **≤4 changed files each**, and appends to a registry count toward that limit. Every task ends with lint (0 errors), a build and a runtime check.

### 6.1 Ownership
| ID | Run | Agent | Owns exclusively | Tasks | Depends on |
|---|---|---|---|---|---|
| W2-1 public-shell | 2 | frontend-engineer | `app/src/App.tsx`, `app/src/pages/**`, `app/src/layout/**`, `app/src/lib/whatsapp.ts` | T1: extract SiteHeader, SiteFooter and PublicSiteShell into `layout/`. T2: move pages into `pages/`; add `React.lazy`, Suspense and an error boundary for each route; make AuthDialog lazy; add `RouteContext` with `search`. T3: `whatsapp.ts` (single number, bidi isolates) and adopt it. T4: restyle the markup to the tokens. | W2-2, W2-3 |
| W2-2 design-tokens | 2 | design-system-engineer | `app/src/index.css`, `app/src/styles/**`, `app/src/App.css`, `app/src/assets/**`, `app/index.html`, `app/public/_headers` | T1: tokens, base and public-section styles. T2: delete dead files, fix the favicon (the 510 kB logo copy), `_headers` (long immutable caching for hashed `/assets/*`). | none |
| W2-3 image-pipeline | 2 | frontend-engineer | `app/scripts/**`, `app/public/images/**`, `app/src/data/site-images.ts`, `app/package.json`, `app/package-lock.json`, `assets-originals/**` | T1: `sharp` as a dev dependency (already approved in D1) plus `optimize-images.mjs`. T2: generate the slugged responsive variants of the 32 photos plus a manifest. **Justified exception:** these are machine-generated files from a committed script, reviewed as one unit. T3: move the legacy 5–23 MB JPEGs and the unused `products/*` out of `public/`. **Justified exception:** these are file moves only. | none |
| W2-4 booking-configurator-ui | 2 | frontend-engineer | `app/src/components/PackageConfigurator.{tsx,css}`, `app/src/components/BookingCalendar.{tsx,css}` | T1: restyle, plus defects #6, #7, #9 and #12 (prices and API untouched). T2: calendar grid semantics, states that don't rely on colour alone, "today" in Riyadh time (#11, #13). | W2-2 |
| W2-5 auth-surfaces-ui | 2 | frontend-engineer | `app/src/components/AuthDialog.{tsx,css}`, `app/src/components/EmailVerificationGate.{tsx,css}` | Restyle; #8 (show send failures, give the profile form a way out); the lint warning at AuthDialog:285. The auth model is untouched. | W2-2 |
| W2-6 blocked-dates-ui | 2 | frontend-engineer | `app/src/components/BlockedDatesManager.{tsx,css}` | Restyle and the lint warning at :323; behaviour unchanged. | W2-2 |
| W3-0 pdpl-determination | 3 | compliance-officer | `runs/redo-v2/compliance/**` | Answer U1, U9, U16 and U17, plus the sensitive-data classification. This gates creation of the bucket and the Run 4 and Run 6 go-lives. | none (can start now) |
| W3-1 d1-state-and-chain-repair | 3 | backend-engineer | `app/migrations/0002_create_booking_schema.sql`, `runs/redo-v2/d1/**` | T1: read-only `wrangler d1 migrations list --remote`, a dump of `sqlite_master`, and a duplicate check for 0004 (the owner runs or approves each command). T2: repair the chain so 0001–0004 apply locally and match remote. No remote write without the owner's approval. | none |
| W3-2 portal-schema | 3 | data-engineer | `app/migrations/0005_portal_schema.sql` | T1: all of the §2.8 DDL. Verify it applies to a fresh local DB and to a local copy of the remote schema. Apply remotely only with the owner's approval. | W3-1 |
| W3-3 worker-platform | 3 | backend-engineer | `app/wrangler.jsonc` (edited first; see §6.2), `app/worker/index.ts`, `app/worker/scheduled.ts`, `app/worker/platform-env.d.ts`, `app/.gitignore`, `app/README.md`, `app/worker/jobs/registry.ts`, `app/worker/portal/portal-routes.ts`, `app/worker/portal/admin-portal-routes.ts`, `app/worker/portal/request.ts`, `app/worker/notify/outbox.ts` | T1: `.gitignore`, crons, `ONLINE_CONFIRMATION="off"`, env types. T2: `scheduled` export and delegation. `/api/bookings/:id/*` and `/api/media/*` go to `portal-routes`. Admin portal paths go to `admin-portal-routes` with `authorizeAdminRequest`, checked **before** the generic `/api/admin` branch. `/api/bookings/me` is unchanged. Also `scheduled.ts` and the registry with the heartbeat. T3: the two route registries and `request.ts` (verified-customer guard, bounded JSON and multipart readers that require `Content-Length`). T4: `outbox.ts` and a README section listing config names, never values. | W3-2 |
| W3-4 timing-jobs | 3 | backend-engineer | `app/shared/timing.ts`, `app/worker/email-templates.ts`, `app/worker/emails/hold.ts`, `app/worker/jobs/hold-expiry.ts`, `app/worker/jobs/hold-reminders.ts` | T1: export `renderEmailLayout` and the formatters, and fix #16 (bidi around `+966…`). Add `emails/hold.ts`. T2: `timing.ts`, the expiry and reminder jobs, and a registry line. | W3-3 |
| W3-5 journey-core | 3 | backend-engineer | `app/shared/journey.ts`, `app/worker/portal/journey-loader.ts`, `app/worker/bookings.ts`, `app/src/api/bookings.ts` | T1: `deriveJourneyStage` with the exact labels from §2.1, plus the loader. T2: add the fields `flowVersion`, `stage`, `stageDeadline` and `serverTime` to `/api/bookings/me` and its client validator; make the duplicated status lists converge. | W3-2 |
| W3-6 auth-token-refresh-fix | 3 | frontend-engineer | `app/src/auth/AuthContext.tsx`, `app/src/auth/auth-context.ts` | T1: HIGH #3. Force-refresh the ID token once when the user is verified but the cached token was issued before verification. Move the `declare module` members into `auth-context.ts`. Still one listener and one provider. | none |
| W3-7 customer-hub | 3 | frontend-engineer | `app/src/components/MyBookings.{tsx,css}`, `app/src/features/journey/**`, `app/src/lib/api-client.ts` | T1: `api-client.ts` (bearer token, abort, type guards; a transient token failure never signs her out). T2: JourneyTracker, a Countdown (corrected with server time, ticks every 30 s, respects reduced motion), StageViewHost, and the `stage-views.ts` registry. T3: restyle MyBookings as the hub, add query-string sub-views, and make the approval copy flow-aware. | W3-5, W2-1, W2-2 |
| W3-8 admin-shell | 3 | frontend-engineer | `app/src/components/AdminDashboard.{tsx,css}`, `app/src/features/admin-portal/**` | T1: restyle. T2: the `?booking=` deep link (#15) and `?tab=`; the Escape guard, part 1 of #5; mount the booking-portal host and the workspace tab; the `sections.ts` registry. | W2-1, W2-2 |
| W4-1 media-core | 4 | backend-engineer | `app/shared/media.ts`, `app/worker/media/**` | T1: `media.ts`, `sniff.ts`, `signing.ts`. T2: `serve.ts`, `media-env.d.ts`, and edits in order to the route registry and `wrangler.jsonc` (the `MEDIA` binding). The final commit, gated: `ONLINE_CONFIRMATION="on"`. | W3-3, W3-0, the owner creating the bucket and the secret |
| W4-2 confirmation-state-machine | 4 | backend-engineer | `app/shared/admin.ts`, `app/shared/deposit.ts`, `app/worker/admin-workflow.ts`, `app/worker/admin.ts`, `app/worker/emails/confirmation.ts`, `app/src/components/BookingActions.{tsx,css}` | T1: the flow-aware action map, `reject_receipt` and `extend_hold`, required notes; BookingActions labels and the required-reason UI; the Escape guard, part 2 of #5; `admin.ts` passing the context. These are compile-coupled and must ship together. T2: `admin-workflow.ts`. On approve: flow 2, 48 h hold, deposit snapshot and the targeted sweep. On confirm: mark the receipt verified. Unchanged-status actions write to events. Fix the byte-aware note limit (#14). Plus `deposit.ts` (needs D4). T3: the confirmation emails, and routing in `admin.ts` so that no email goes out when the status did not change. | W3-2, W3-4 |
| W4-3 receipt-endpoints | 4 | backend-engineer | `app/shared/portal/receipt.ts`, `app/shared/terms.ts`, `app/worker/portal/receipts.ts`, `app/worker/portal/admin-receipts.ts`, `app/worker/emails/receipt.ts` | T1: types, terms (the owner's text), `POST …/receipt` and `GET …/confirmation`. Bank details come from the `DEPOSIT_*` secrets and are shown only for flow 2 in `approved_hold` or `payment_pending`. Plus a registry line. T2: admin receipts with 10-minute signed URLs, an alert email to the admin, and a registry line. | W4-1, W4-2 |
| W4-4 receipt-ui | 4 | frontend-engineer | `app/src/features/receipt/**`, `app/src/features/admin-receipt/**` | T1: the customer panel (terms, deposit, bank details, dropzone, re-encoding in the browser, every state), plus a line in `stage-views`. T2: the admin review (zoom, expected amount, confirm, reject with a reason), plus a line in `sections`. | W4-3, W3-7, W3-8 |
| W4-5 media-security-review | 4 | security-auditor | `runs/redo-v2/security/run4/**` | Review signing and verification, key storage and rotation, upload validation, headers, PDF handling, and IDOR on receipts. It must pass before `ONLINE_CONFIRMATION` is `on`. | W4-3 |
| W5-1 event-profile | 5 | full-stack-engineer | `app/shared/portal/event-profile.ts`, `app/worker/portal/event-profile.ts`, `app/worker/jobs/event-reminders.ts`, `app/worker/emails/event.ts`, `app/src/features/event-profile/**` | T1: types and `GET`/`PUT` (consent defaults to 0; changes go to events), plus route lines. T2: the −7 d and −1 d reminders and email, plus a registry line. T3: the API wrapper and a client-side `.ics`. T4: the panel and a `stage-views` line. T5: the admin section and a `sections` line. | W3-3, W3-7, W3-8 |
| W6-1 gallery-backend | 6 | backend-engineer | `app/shared/portal/gallery.ts`, `app/worker/portal/galleries.ts`, `app/worker/portal/admin-galleries.ts`, `app/worker/jobs/selection-reminders.ts`, `app/worker/emails/gallery.ts` | T1: types and the admin operations: create (quota snapshot), upload (multipart with preview and thumbnail; a repeated filename is a no-op), delete while draft, open, extend, export. Plus a route line. T2: the customer `GET` (hourly signed URLs), the set-operations with the quota predicate, and submit-and-lock, plus a route line. T3: the selection reminders and the gallery-ready email, plus a registry line. | W4-1, W3-3 |
| W6-2 gallery-admin-ui | 6 | frontend-engineer | `app/src/features/admin-gallery/**` | T1: `resize.worker.ts` and `resize.ts`. T2: the uploader (queue, 3 concurrent, retries, resume by filename, XHR progress, `beforeunload` guard). T3: open, extend and export (`.txt` and comma-separated), plus a `sections` line. | W6-1 |
| W6-3 gallery-customer-ui | 6 | frontend-engineer | `app/src/features/gallery/**` | T1: the API wrapper and a selection-queue hook (debounced, idempotent, rolls back when refused, save indicator). T2: the grid, counter and favourites (lazy thumbnails with width and height). T3: a keyboard-operable lightbox with focus return, and the submit confirmation, plus a `stage-views` line. | W6-1 |
| W6-4 gallery-security-review | 6 | security-auditor | `runs/redo-v2/security/run6/**` | Review IDOR on galleries and selections, the scope of signed URLs, upload caps, and purging. | W6-1 |
| W7-1 album-handover-backend | 7 | backend-engineer | `app/shared/portal/handover.ts`, `app/worker/portal/album.ts`, `app/worker/portal/handover.ts`, `app/worker/portal/admin-handover.ts`, `app/worker/jobs/handover-reminders.ts`, `app/worker/emails/handover.ts` | T1: the album-stage endpoint and a ready email sent once, plus a route line. T2: slot management (admin), and slot listing and capacity-guarded booking (customer), plus route lines. T3: the −1 d reminder and completion (stamps both `completed_at` columns), plus a registry line. | W6-1 |
| W7-2 album-handover-ui | 7 | frontend-engineer | `app/src/features/handover/**`, `app/src/features/admin-handover/**` | T1: pickup or delivery, the slot picker, the address form. T2: the WhatsApp final step on handover day, plus a `stage-views` line. T3: the slot manager, the album-stage control and "complete", plus a `sections` line. | W7-1 |
| W8-1 feedback | 8 | full-stack-engineer | `app/shared/portal/feedback.ts`, `app/worker/portal/feedback.ts`, `app/worker/jobs/feedback-request.ts`, `app/worker/emails/feedback.ts`, `app/src/features/feedback/**` | T1: the endpoint (one submission per booking, private) and the +2 d request job, plus registry lines. T2: the panel and a read-only admin section, plus `stage-views` and `sections` lines. | W7-1 |
| W8-2 retention-and-privacy | 8 | backend-engineer | `app/shared/retention.ts`, `app/worker/jobs/retention.ts`, `app/worker/jobs/orphan-sweep.ts`, `app/src/features/privacy/**` | T1: the policy constants (the values decided in W3-0) and the retention job (bounded, bulk deletes of up to 1,000 keys), plus a registry line. T2: the orphan sweep and the `privacy_cleanup` view («حُذفت معاينات صوركِ تلقائيًا في {التاريخ} حفاظًا على خصوصيتكِ.»), plus a `stage-views` line. | W3-0, W6-1, W7-1 |
| W8-3 admin-queue | 8 | full-stack-engineer | `app/shared/portal/queue.ts`, `app/worker/portal/admin-queue.ts`, `app/src/features/admin-queue/**` | T1: `GET /api/admin/queue`, listing requests past the SLA, receipts waiting, holds under 24 h, overdue selections, handovers today or tomorrow, a stale cron heartbeat, and skipped emails. Plus a route line. T2: the queue UI as the admin landing view, plus a `sections` line. | W7-1, W3-8 |
| W8-4 release-verification | 8 | qa-engineer | `runs/redo-v2/verification/**` | A full NFR pass: RTL, feminine copy, keyboard, reduced motion, states not shown by colour alone, loading, empty and error states, chunk budgets, no personal data in logs. Walk all 15 stages at runtime on a local D1 with cron triggered locally. | all |

### 6.2 Shared files that must be edited in order (never in parallel; each append is one import plus one entry)
| File | Created by | Appended by, in this order |
|---|---|---|
| `app/wrangler.jsonc` | W3-3 (crons, `ONLINE_CONFIRMATION="off"`) | W4-1 (`r2_buckets` `MEDIA`, and later the gated switch to `"on"`) |
| `app/worker/jobs/registry.ts` | W3-3 | W3-4 → W5-1 → W6-1 → W7-1 → W8-1 → W8-2 |
| `app/worker/portal/portal-routes.ts` | W3-3 | W4-1 → W4-3 → W5-1 → W6-1 → W7-1 → W8-1 |
| `app/worker/portal/admin-portal-routes.ts` | W3-3 | W4-3 → W5-1 → W6-1 → W7-1 → W8-1 → W8-3 |
| `app/src/features/journey/stage-views.ts` | W3-7 | W4-4 → W5-1 → W6-3 → W7-2 → W8-1 → W8-2 |
| `app/src/features/admin-portal/sections.ts` | W3-8 | W4-4 → W5-1 → W6-2 → W7-2 → W8-1 → W8-3 |

No other file is touched by more than one workstream. `app/src/api/admin.ts`, `app/shared/booking.ts`, `app/src/data/packages.ts`, `app/worker/{auth,admin-auth,email,http,profile}.ts` and `app/src/lib/firebase.ts` stay unchanged.

---

## 7. Unresolved (owner or compliance), each with a proposed default
1. **U1, residency and PDPL transfer** (compliance-officer). *Default:* do not create the R2 bucket and do not go live with Runs 4 or 6 until it is answered. If a transfer is permitted, co-locate R2 with D1's existing region.
2. **U2, user counts, the 12-month target and the budget ceiling** (owner). *Default:* keep the costs priced at 10 and 1,000 bookings a month. The recommended fixed cost is SAR 18.75 a month.
3. **U3, Workers plan** (owner). *Default:* upgrade to Workers Paid when Run 3 ships (SAR 18.75 a month).
4. **U4, D8 migration state and D1 region** (owner with W3-1). *Default:* a read-only inspection first; no schema change until the chain is repaired.
5. **U5, D4 deposit rule and bank details** (owner). *Default:* the spec's 20% of the total, rounded up to the next SAR 50. Bank details must come from the owner. `ONLINE_CONFIRMATION` stays `off` until then.
6. **U6, the terms wording** (owner or counsel). *Default:* a plain operational summary, versioned in `shared/terms.ts`; the feature stays off until it is supplied.
7. **U7, the offline escape hatch** (`confirm_payment` from `approved_hold` with a required note) (owner). *Default:* allowed.
8. **U8, `extend_hold`** (owner). *Default:* +24 h per use, no limit on uses, every use logged.
9. **U9, retention periods** (compliance-officer and the owner's accountant). *Default:* the §2.3 table.
10. **U10, preview size and watermark** (owner). *Default:* 1600 px on the long edge, no watermark.
11. **U11, the quota for coverage-only bookings** (owner). *Default:* 30, as in the spec.
12. **U12, the maximum number of photos per gallery** (owner). *Default:* a technical guard of 1,000.
13. **U13, pickup location, delivery area and fee, and default slots** (owner). *Default:* the spec's defaults #8–#10. The owner edits the slots in admin.
14. **U14, Resend configuration** (owner). *Default:* configure it before Run 3 ships; until then emails are recorded as `skipped` and shown in the queue.
15. **U15, admin-account MFA** (security-auditor). *Default:* enable TOTP MFA and email-enumeration protection.
16. **U16, the privacy notice text and where it appears** (owner, counsel or compliance). *Default:* a dialog linked from the footer and from the terms panel, with no new route.
17. **U17, ZATCA e-invoicing for deposits** (the owner's accountant). *Default:* out of scope.
18. **U18, the Firebase Auth tier** (legacy Firebase Auth versus Identity Platform) (owner). *Default:* check the console; it only matters at the 100k stress scale and for MFA.
19. **U19, whether the selection deadline is hard or soft** (owner). *Default:* soft, with the admin flagged and able to extend it.
