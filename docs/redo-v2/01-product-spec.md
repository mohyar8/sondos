# Sundus Yar — Product Specification: The Complete Redo
Run 1 of 8 (`redo-v2-spec`) · 2026-09-23 · Grounded in `app/` at baseline `d6b7cb2`, `decisions.md`, `00-inspection-report.md`

Every claim below is either (a) a fact about the existing code, cited `file:line`, or (b) a proposal clearly
marked as new. Nothing here invents testimonials, reviews, prices, addresses, bank details or legal text.

---

## 1. Executive summary

The owner asked to "redo the project and make it as perfect as it can be" and, on top of the visual rebuild
(D1, separate track), added a genuinely new product: a **private client portal**. Today the site is a request
form with a 7-action admin status machine (`shared/admin.ts:6-77`) and manual WhatsApp handling for everything
after approval. This spec adds: online terms + receipt upload (replacing the manual contract steps, D2),
automatic hold expiry and reminders (none exist today — `worker/index.ts` exports only `fetch`, no
`scheduled` handler), a private post-event photo gallery with a selection quota, album production status, and
pickup/delivery slot booking (D3) — ending, as the owner specified, at a WhatsApp handoff.

**Scope-and-price flag for the founder:** this is materially larger than a site redesign. It needs private
object storage (R2, D6), a Cron Trigger, ~7 new database tables, and a two-sided (bride + admin) workflow with
timers. Recommend treating it as its own change order, not folded into the original redo price.

**Architecture decision (stated up front because it shapes everything below):** the existing status machine
(`bookingStatuses`, `adminBookingActions` in `shared/admin.ts`) is small, exhaustively typed, and already
covers the pre-event pipeline well. Rather than growing it into a 20-value enum, this spec adds **exactly one**
new admin action (`reject_receipt`) to it and pushes every other new capability (gallery, album, handover,
questionnaire, feedback) into **new, separate tables** that a booking owns once it reaches `confirmed`. This
is the minimum-footprint design that satisfies "preserve existing... unless explicitly asked to propose an
additive change" — see §4.

---

## 2. Personas and the one primary action of every page

| Persona | Who | Wants |
|---|---|---|
| **العروس (the bride)** | The customer, always addressed feminine singular | To book confidently, know exactly what happens next, and get her album with minimal back-and-forth |
| **سندس (Sundus)** | Sole owner/admin (D1 `users.role='admin'`, `worker/admin-auth.ts:86-97`) | To process requests fast, never miss a deadline, and hand over albums without digging through WhatsApp threads |

No other persona exists in the code or the brief (no staff roles, no groom-facing flows). Family/others who may
collect an album are addressed in §12 (unresolved).

| Page | Route | New? | Primary action |
|---|---|---|---|
| Home | `/` | existing | Drive to booking (`/packages#packages` CTA — `App.tsx:365-367`) |
| Portfolio | `/portfolio` | existing | Build trust in the work, drive to booking |
| Packages | `/packages` | existing | Submit one booking request (`PackageConfigurator`) |
| **My Bookings** | `/my-bookings` | existing, becomes the **hub** | Resolve whatever is the single most urgent open step on her active booking (terms+receipt → questionnaire → handover slot → feedback) |
| **Gallery** | `/gallery` | **NEW** | Select exactly her quota of photos and submit |
| Admin | `/admin` | existing, gains a 3rd tab | Act on whatever needs Sundus's attention right now |

Only **one** new top-level route is proposed (`/gallery`). Everything else (terms/receipt, questionnaire,
handover-slot booking, feedback) is a new expandable panel inside the existing `MyBookings` card
(`MyBookings.tsx:318-440` already has the `isExpanded`/`onToggle` pattern to extend). This keeps the custom
History-API router (`App.tsx:756-853`, no React Router, per binding constraint) essentially untouched.

---

## 3. Customer journey — stage by stage

Each stage lists: entry trigger · what the bride sees/does · what Sundus sees/does · timers · emails ·
exit conditions · failure paths. DB status in *italics* where it maps to `booking_requests.status`
(unchanged values unless noted); stages after `confirmed` are tracked in new child tables (§4), not by
inventing new statuses.

### 3.1 `pending_review` — *pending_review*
- **Trigger:** she submits the configurator (`worker/bookings.ts:634-709`, unchanged).
- **She sees/does:** confirmation screen; card in `/my-bookings` labelled "قيد المراجعة."
- **Admin sees/does:** new request in the queue and list; approves or rejects.
- **Timer:** admin SLA, default 24 h (badge only — does not block late action).
- **Emails:** admin-new-booking + customer-received (both exist, `email-templates.ts:242-333`, unchanged).
- **Exit:** `approve` → 3.2, or `reject` → *rejected* (terminal).
- **Failure paths:** *date conflict* — if the date got taken between submission and approval, `approve` is
  blocked server-side today (`isDateUnavailableForApproval`, `worker/admin-workflow.ts:349-388`) — unchanged,
  reused as-is.

### 3.2 `approved_hold` — *approved_hold*
- **Trigger:** admin `approve`.
- **She sees/does:** "تم قبول الطلب وحجز التاريخ" with a **new** live countdown to `hold_expires_at`
  (the column already exists and is already written on approval — `worker/admin-workflow.ts:479-482` — it is
  simply never read by the UI or enforced today; both are new).
- **Admin sees/does:** date is held; can still `cancel`.
- **Timer:** hold window, default **48 h** (today hardcoded to 24 h at
  `worker/admin-workflow.ts:17` — raising it is a deliberate, D5-driven change, see §6).
- **Emails:** reminder at 24 h and 6 h before deadline (new).
- **Exit:** she completes 3.3 before the deadline → 3.4.
- **Failure paths:** *hold expires* (deadline passes with nothing submitted) → *expired* (new scheduled job,
  see below); *admin cancels* → *cancelled*.

### 3.3 Terms + receipt ("أكملي حجزك") — still *approved_hold* until submitted
- **Trigger:** she opens the new panel from her `/my-bookings` card.
- **She sees/does:** the booking terms (plain-language summary, not a lawyer contract — see §12), a required
  checkbox, the deposit amount/bank details (D4, still open), and a file upload for the receipt (image/PDF).
  One combined submission, matching decisions.md's step 3.
- **Admin sees/does:** nothing yet (no action required until she submits).
- **Timer:** same hold deadline as 3.2 — this **is** the "upload receipt" deadline; there is no separate one.
- **Emails:** none new at this sub-step.
- **Exit:** valid submission stamps `terms_accepted_at` and creates a `booking_receipts` row, and status moves
  to *payment_pending* → 3.4.
- **Failure paths:** *receipt never uploaded* — same mechanism as "hold expires" above (unified, not a
  separate failure path — see §4 rationale).

### 3.4 Receipt review — *payment_pending*
- **Trigger:** her submission in 3.3.
- **She sees/does:** "بانتظار التحقق من الإيصال" (existing `payment_pending` label, reused per D2).
- **Admin sees/does:** the uploaded receipt (signed URL, never a public path) inside the existing booking
  detail panel, next to `BookingActions` (`AdminDashboard.tsx:485-491`); confirms or rejects with a reason.
- **Timer:** receipt verification SLA, default 24 h.
- **Emails:** none until a decision is made.
- **Exit:** `confirm_payment` (existing action, unchanged target `confirmed`) → 3.5.
- **Failure paths:** **new** `reject_receipt` action — stays in *payment_pending* (does **not** bounce back to
  `approved_hold`), extends `hold_expires_at` by a short default (24 h), stores the reason, and lets her
  re-upload a replacement receipt (see §4). *Admin cancels* is still available.

### 3.5 Confirmed — *confirmed*
- **Trigger:** `confirm_payment`.
- **She sees/does:** "الحجز مؤكد," `confirmed_at` shown (existing, `MyBookings.tsx:427-432`).
- **Admin sees/does:** booking now only needs `cancel` as a status action; everything else below is
  new child-table work, not a `booking_requests.status` change.
- **Emails:** existing status-changed template (unchanged).
- **Exit:** immediately enters 3.6 (pre-event engagement) in parallel with waiting for the event date.

### 3.6 Pre-event engagement — booking stays *confirmed*
- **Trigger:** automatic on confirmation.
- **She sees/does:** countdown to the event date; the questionnaire ("تفاصيل يومكِ": venue, start time,
  requests, **publishing consent defaulting to NO**); add-to-calendar; can revise consent anytime before the
  event.
- **Admin sees/does:** her questionnaire answers on the booking detail panel.
- **Timer:** pre-event reminders, default 7 days and 1 day before the event.
- **Emails:** reminder emails (new).
- **Exit:** event date passes → 3.7.
- **Failure paths:** *admin cancels* or she asks via WhatsApp to cancel (no self-service cancel button — see
  §11) → *cancelled*, questionnaire/consent data retained per §12 privacy notes.

### 3.7 Gallery open (`galleries.status = 'open'`)
- **Trigger:** Sundus bulk-uploads previews for this booking.
- **She sees/does:** private grid at `/gallery`; favourites; lightbox; "اخترتِ {n} من أصل {quota} صورة" where
  quota = `packageSnapshot.album.photoCount` (30/45/60/80, exactly as decisions.md specifies) — coverage-only
  bookings need a fallback default (§12).
- **Admin sees/does:** upload progress; can see her live favourite/selection count.
- **Timer:** selection window, default 14 days from open.
- **Emails:** gallery-ready notice on open; reminders at 7 and 2 days before the deadline.
- **Exit:** she submits exactly her quota → locked (3.8).
- **Failure paths:** *selection deadline missed* — does **not** auto-select for her; the booking is flagged
  "متأخرة" in the admin queue for manual follow-up, and admin can extend the deadline (new `reject_receipt`-
  style small action on the gallery, not on `booking_requests.status`).

### 3.8 Gallery locked (`galleries.status = 'locked'`)
- **She sees/does:** read-only confirmation of her chosen photos.
- **Admin sees/does:** exports the selected original filenames as a downloadable list, scoped to this
  booking, to match against her Lightroom catalog.
- **Exit:** admin begins album production → 3.9.
- **Failure paths:** admin may reopen a locked gallery for a correction (logged, admin-only).

### 3.9–3.11 Album production (`album_production.stage`)
- **design → printing → ready**, each a one-field admin update visible on her card.
- **Emails:** notice when it reaches "ready," asking her to schedule handover.
- No customer-facing deadline (production time is the owner's own vendor-dependent lead time — not
  timeboxed here; inventing an SLA would be an invented business fact).

### 3.12 Handover scheduling
- **Trigger:** album reaches "ready."
- **She sees/does:** chooses **pickup or delivery** (D3, both required), then a concrete bookable time slot
  from admin-managed availability; delivery additionally asks for an address.
- **Admin sees/does:** manages slot availability; sees today's/this-week's booked slots in the daily queue.
- **Timer:** slot reminder, default 1 day before.
- **Failure paths:** *slot conflict* — same conditional-insert / unique-index pattern the codebase already
  uses for event dates (`migrations/0003…sql`'s `ux_booking_requests_blocking_event_date`,
  `worker/bookings.ts:491-554`'s `INSERT…WHERE NOT EXISTS`) applied to `handover_slots`.

### 3.13 Handover day → WhatsApp handoff
- **She sees/does:** on/after her slot, a "تواصل عبر واتساب" button opens a **prefilled** WhatsApp message
  with her booking reference and confirmed slot — same non-automatic, editable-before-send pattern already
  used everywhere else in the app (`MyBookings.tsx:332-335`, `BookingActions.tsx:425-438`). This is
  deliberately the **last** step, matching the owner's brief.
- **Admin sees/does:** marks the handover completed.
- **Exit:** `booking_requests.completed_at` is stamped (no new `BookingStatus` value — see §4) → 3.14.
- **Failure paths:** *no-show* — admin can reschedule to a new slot (LATER, see §5).

### 3.14 Completed, feedback, and privacy clean-up
- **She sees/does:** thank-you; one-time feedback request ~2 days later (rating + optional comment, private,
  never auto-published — D7); her gallery previews disappear automatically after the retention period
  (default 30 days after handover) with a clear explanation, not a silent 404.
- **Admin sees/does:** feedback in the booking detail panel, for her own private review only.
- **Emails:** feedback request; optional "previews will be removed soon" heads-up before cleanup.

---

## 4. Status-machine and data model design (grounded, additive-only)

### 4.1 The one change to `shared/admin.ts`
Add **one** admin action: `reject_receipt`, allowed only from `payment_pending`, targeting `payment_pending`
itself (a same-status action — the current `Record<BookingStatus, readonly AdminBookingAction[]>` shape
already supports this; it is simply not used that way today). Its real effect is on the new
`booking_receipts` table and on `hold_expires_at`, not on `booking_requests.status`. **No other value is
added to `bookingStatuses` or `adminBookingActions`.** `contract_pending` / `contract_signed` remain in the
enum and in `allowedAdminActionsByStatus` completely unchanged, so any pre-existing row (D8: production state
unknown) keeps working through the legacy path with zero behavior change.

### 4.2 Two additive columns on `booking_requests`
`terms_accepted_at` (nullable), `terms_version` (nullable), `completed_at` (nullable — set once handover is
marked done; gives the admin list a simple "fully wrapped up" filter without touching the `status` CHECK
constraint at all).

### 4.3 New tables (conceptual sketch — the engineering run designs exact DDL/migrations)

| Table | Key fields | Purpose |
|---|---|---|
| `booking_receipts` | booking_id, storage_key, uploaded_at, status(pending/verified/rejected), verified_at, verified_by, rejection_reason, supersedes_id | One row per upload attempt; latest is authoritative |
| `event_profiles` | booking_id (1:1), venue_name, venue_address, event_start_time, special_requests, publishing_consent (bool, default false), consent_updated_at | The pre-event questionnaire |
| `galleries` | booking_id (1:1), status(uploading/open/locked), quota, opened_at, selection_deadline, locked_at | One gallery per booking |
| `gallery_photos` | id, gallery_id, storage_key, thumbnail_key, original_filename, display_order | One row per uploaded preview |
| `gallery_selections` | gallery_id, photo_id, is_favourite, selected_at | Her favourites and final picks |
| `album_production` | booking_id (1:1), stage(design/printing/ready), estimated_ready_date | Three-stage status |
| `handover_slots` | id, method(pickup/delivery), slot_date, slot_start, slot_end, capacity | Admin-managed availability |
| `handovers` | booking_id (1:1), method, slot_id, delivery_address, status(scheduled/completed/no_show), completed_at | Her chosen slot |
| `feedback` | booking_id (1:1), rating, comment, submitted_at | Private post-handover feedback |
| `notification_log` | booking_id, kind, sent_at | De-dupes every reminder kind across cron ticks (Resend's own `Idempotency-Key`, already used per-call in `worker/email.ts`, only dedupes short-term — reminders spaced days apart need this) |

### 4.4 Infrastructure additions (not yet present — confirmed by direct read)
- `wrangler.jsonc` today has only `assets` and one `d1_databases` binding (no `r2_buckets`, no `triggers.crons`
  — verified). Needs an R2 bucket binding (D6: private, short-lived signed URLs for receipts and previews) and
  a Cron Trigger.
- `worker/index.ts` exports only `fetch` (verified, lines 215-287) — a `scheduled` export is net-new,
  additive, and never touches `fetch`.
- **No code change is needed to "free the date" on hold expiry.** The availability query
  (`worker/index.ts:138-152`), the duplicate-request check (`worker/bookings.ts:281-295`), and the approval
  conflict check (`worker/admin-workflow.ts:362-377`) all gate on an explicit `status IN (...)` list that
  already excludes `expired`. Flipping a row's status to `expired` is sufficient by itself.

---

## 5. User stories

ID prefixes as requested: `PUB-` public site, `BK-` request/approval/hold, `PAY-` terms+receipt+verification,
`EVT-` pre-event engagement, `GAL-` gallery/selection, `ALB-` album production, `HND-` handover+feedback+
cleanup, `ADM-` admin-wide, `NFR-` non-functional. "Done when the user can X."

### PUB — public site (functional only; visual system is D1/Run 2's scope)
| ID | Priority | Story / acceptance |
|---|---|---|
| PUB-01 | MVP | Every price shown on `/packages` matches `src/data/packages.ts` exactly — no rounding drift, no new fees invented. |
| PUB-02 | MVP | The privacy claim («جميع الصور تُنشر بموافقة العروس», Instagram-evidenced) is stated on the public site without inventing testimonial counts or review numbers. |
| PUB-03 | LATER | Portfolio/hero serve the owner's pre-cropped web-optimised photos with responsive `srcset`, not the legacy 6–23 MB originals (Run 2/3 file work). |
| PUB-04 | MVP | No admin link or client-side role check appears in public nav — server-only authorization (`worker/admin-auth.ts`) stays the only gate. |

### BK — request, approval, hold
| ID | Priority | Story / acceptance |
|---|---|---|
| BK-01 | MVP (preserved) | She submits one open request per date; server recomputes the total server-side — unchanged. |
| BK-02 | MVP (preserved) | Duplicate/blocked-date submissions are rejected with existing Arabic error copy — unchanged. |
| BK-03 | MVP | Once `approved_hold`, `/my-bookings` shows a live countdown to `hold_expires_at`. |
| BK-04 | MVP | A scheduled job auto-expires any `approved_hold` past its deadline with no admin action; the date is bookable again immediately. |
| BK-05 | MVP | Hold reminder emails fire once each at 24 h and 6 h before deadline, never duplicated. |
| BK-06 | MVP | A `pending_review` request older than the SLA (24 h default) shows a visual badge in the admin queue/list. |
| BK-07 | LATER | Sundus gets her own internal reminder if a request is unanswered past SLA. |

### PAY — terms + receipt + verification (replaces contract steps, D2)
| ID | Priority | Story / acceptance |
|---|---|---|
| PAY-01 | MVP | While `approved_hold` and before the deadline, she opens one panel showing terms + a required checkbox + a receipt upload, submitted together. |
| PAY-02 | MVP | That panel shows the deposit amount/% and bank details the owner supplies (D4) — never invented figures. |
| PAY-03 | MVP | A valid submission stamps `terms_accepted_at`, creates a receipt record, and moves status to `payment_pending` with no admin action required. |
| PAY-04 | MVP | Admin sees the uploaded receipt in the booking detail panel via a short-lived signed URL, never a public path. |
| PAY-05 | MVP | `confirm_payment` fires exactly as today, sets `confirmed_at`, sends the existing status-change email. |
| PAY-06 | MVP | New `reject_receipt` action keeps status at `payment_pending`, extends `hold_expires_at` (+24 h default), records a required reason, lets her re-upload. |
| PAY-07 | MVP | A receipt never uploaded is handled by the same BK-04 expiry job — no separate deadline/state. |
| PAY-08 | MVP (preserved) | Any pre-existing `contract_pending`/`contract_signed`/`payment_pending` row keeps its current labels and admin actions untouched. |
| PAY-09 | LATER | After 2 rejections on one booking, the panel also surfaces the WhatsApp contact instead of a third silent retry loop. |

### EVT — pre-event engagement
| ID | Priority | Story / acceptance |
|---|---|---|
| EVT-01 | MVP | Confirmed bride fills venue, start time, requests, and a publishing-consent toggle defaulting to NO. |
| EVT-02 | MVP | Consent is explicit, visible at all times, and revisable any time before the event. |
| EVT-03 | MVP | `/my-bookings` shows a countdown to the event date once confirmed. |
| EVT-04 | MVP | She can download an `.ics` for her event date, generated client-side from data she already has. |
| EVT-05 | MVP | Reminder emails fire at 7 days and 1 day before the event, only while still `confirmed`. |
| EVT-06 | LATER | She can edit questionnaire answers up to a cutoff (default 3 days before the event). |

### GAL — gallery and selection
| ID | Priority | Story / acceptance |
|---|---|---|
| GAL-01 | MVP | Admin bulk-uploads many preview files at once for one booking; the system auto-generates web previews/thumbnails. |
| GAL-02 | MVP | Gallery has no public URL; only the owning bride and admin can view it, via short-lived signed URLs. |
| GAL-03 | MVP | Gallery shows "اخترتِ {n} من أصل {quota} صورة," quota from her package (fallback default for coverage-only, §12). |
| GAL-04 | MVP | She can favourite/unfavourite any preview independent of final selection. |
| GAL-05 | MVP | Keyboard-accessible lightbox (Escape closes, focus returns) for full-size review. |
| GAL-06 | MVP | Selecting beyond quota is blocked client- and server-side with a clear message, never a silent failure. |
| GAL-07 | MVP | Submitting exactly her quota locks the gallery after an explicit confirm step (same irreversible-action pattern as `BookingActions`' confirmation dialog). |
| GAL-08 | MVP | Selection deadline (14 days default) is shown; reminders fire at 7 and 2 days before it. |
| GAL-09 | MVP | A missed deadline never auto-selects for her; it flags "متأخرة" in the admin queue and admin can extend it. |
| GAL-10 | MVP | After lock, admin exports the selected original filenames as one downloadable list for her Lightroom catalog. |
| GAL-11 | LATER | Admin can reopen a locked gallery for a correction, reason required, logged. |

### ALB — album production
| ID | Priority | Story / acceptance |
|---|---|---|
| ALB-01 | MVP | Admin sets stage to design/printing/ready; current stage shows on her confirmed booking card. |
| ALB-02 | MVP | Moving to "ready" sends her a notification to schedule handover. |
| ALB-03 | LATER | Admin can optionally set/edit an estimated ready-by date shown to her. |

### HND — handover (pickup/delivery, D3) + feedback + privacy clean-up
| ID | Priority | Story / acceptance |
|---|---|---|
| HND-01 | MVP | Once "ready," she picks exactly one of pickup or delivery. |
| HND-02 | MVP | She books a concrete date+time slot from admin-managed availability; double-booking the same slot is blocked server-side (same conflict-safe pattern as event-date booking). |
| HND-03 | MVP | Delivery requires a full address, handled as personal data under the same private/PDPL rules as her phone/email. |
| HND-04 | MVP | A reminder fires before her slot (default 1 day). |
| HND-05 | MVP | On/after the slot, a button opens a prefilled (not auto-sent) WhatsApp message with her reference and slot — the final step. |
| HND-06 | MVP | Admin marks handover completed; `completed_at` is stamped and the retention timer starts. |
| HND-07 | LATER | She can reschedule to a different available slot before the original passes. |
| HND-08 | MVP | ~2 days after completion she gets a one-time feedback request (rating + optional comment). |
| HND-09 | MVP | Feedback is stored for Sundus's private review only — never auto-published (D7). |
| HND-10 | MVP | Gallery previews auto-delete a fixed period after completion (30 days default); `/my-bookings` explains why they're gone, no silent 404. |
| HND-11 | LATER | Optional heads-up email a few days before auto-deletion. |

### ADM — admin-wide
| ID | Priority | Story / acceptance |
|---|---|---|
| ADM-01 | MVP | Admin home shows one glanceable list of everything needing action today (SLA-overdue requests, receipts to verify, holds expiring <24 h, overdue selections, today's handover slots), each linking straight to the booking. |
| ADM-02 | LATER | Queue becomes its own sortable/filterable view. |
| ADM-03 | MVP (preserved) | Admin access still resolves solely from D1 `users.role='admin'`; no client-side role logic added. |
| ADM-04 | MVP (preserved) | Existing blocked-dates tab and its race-safe insert are untouched. |
| ADM-05 | LATER | Admin list pagination beyond the current hard 50-row cap — flagged as a dependency, not committed here unless the owner prioritizes it (pre-existing defect, inspection report #12.3). |

### NFR — non-functional
| ID | Priority | Story / acceptance |
|---|---|---|
| NFR-01 | MVP | Every new page/panel renders correctly RTL (`dir="rtl"`), matching existing pattern. |
| NFR-02 | MVP | All new copy is feminine singular; reviewed against the existing masculine-slip defects (#17) so they aren't repeated. |
| NFR-03 | MVP | Selection state, quota progress, and countdown urgency are never color-only (fixes the same class of issue as the existing calendar-legend defect #13, applied to all new UI). |
| NFR-04 | MVP | Lightbox, terms/receipt panel, and slot picker are fully keyboard-operable with correct focus return, matching the existing modal pattern in `BookingActions`. |
| NFR-05 | MVP | All new entry animations and the countdown honour `prefers-reduced-motion`. |
| NFR-06 | MVP | Every new panel has explicit loading/empty/error states in Arabic — no blank flashes. |
| NFR-07 | MVP | Receipts and gallery photos are unreachable without a signed URL scoped to the owning customer or admin — no public bucket listing. |
| NFR-08 | MVP | Every new class of personal data (receipt, address, questionnaire, feedback) has a stated retention/deletion rule. |
| NFR-09 | MVP | No new secrets in `VITE_*`; no logging of receipt URLs, tokens, or PII in worker code. |
| NFR-10 | MVP | Gallery lazy-loads previews; no new page silently balloons past today's 470.79 kB baseline client chunk without justification. |
| NFR-11 | LATER | New panels (gallery, admin upload) are code-split rather than folded into the existing single client chunk. |

---

## 6. Timing model

| Parameter | Proposed default | Rationale |
|---|---|---|
| Admin response SLA (`pending_review`) | 24 h | Matches the owner's own "reply within a stated SLA" goal |
| Hold window (`approved_hold` → deadline) | **48 h** | D5's proposal; longer than today's hardcoded 24 h (`worker/admin-workflow.ts:17`) because the new flow adds two customer steps |
| Hold reminders | 24 h and 6 h before deadline | D5's proposal |
| Receipt verification SLA (admin) | 24 h | Mirrors the general admin SLA; the date is only *held*, not yet confirmed |
| Receipt rejection extension | +24 h to `hold_expires_at` | Fair chance to re-upload without restarting the whole hold |
| Pre-event reminders | 7 days and 1 day before event | Standard cadence, not noisy |
| Selection window | 14 days | D5's proposal |
| Selection reminders | 7 days and 2 days before deadline | Mirrors the hold-reminder cadence at 14-day scale |
| Preview retention after completion | 30 days | D5's proposal; balances her revisiting favourites against PDPL data minimization |
| Handover slot reminder | 1 day before | Standard no-show reduction |
| Feedback request delay | 2 days after completion | Gives her time to actually see the album first |
| Album production | *not timeboxed* | Vendor/printer lead time the owner controls directly — an invented number here would be an invented business fact |

Every value above (except the deliberately-untimed album stage) is also listed in "unresolved" (§12) — these
are UX defaults, not facts about the business, so they are safe to propose, but the owner should confirm them.

---

## 7. Engagement features — keep, cut, or defer

| Feature | Decision | Reason |
|---|---|---|
| Journey tracker (visual progress on her card) | **Keep, MVP** | Directly serves the owner's stated goal ("maximise engagement on the site"); replaces a WhatsApp "what's happening?" question with a glance |
| Pre-event questionnaire + consent default NO | **Keep, MVP** | Explicitly requested in decisions.md's own proposed journey (step 5) |
| Add-to-calendar | **Keep, MVP** | Cheap (pure client-side `.ics`, no new backend dependency), high perceived value, directly requested |
| Favourites in gallery | **Keep, MVP** | Not optional in practice — with 100+ previews and a hard quota, a shortlist step before committing is close to required UX, not a "nice to have" |
| Admin daily queue | **Keep, MVP (lightweight version — see ADM-01/02)** | A solo admin now has ~6 different deadline types (SLA, hold, receipt, selection, handover). Without one glanceable view, something *will* be missed. Full sortable/filterable version deferred to LATER |
| Selected-filenames export for Lightroom | **Keep, MVP** | High leverage, low cost: turns the digital selection directly into Sundus's actual production list (GAL-10) |

---

## 8. Non-functional requirements

Accessibility, RTL, motion, and error-state requirements are captured as testable stories in the `NFR-` block
of §5 (not repeated here). Two additions worth calling out on their own:

- **Privacy is structural, not cosmetic:** every new store of personal data (receipt image, delivery address,
  questionnaire text, feedback, gallery photo) needs an explicit owner and an explicit deletion rule before
  it ships — not a "we'll add retention later" placeholder. This is the direct PDPL implication of adding
  three new categories of sensitive data (financial receipt, home address, private photos) to a system that
  previously stored none.
- **Performance budget:** the existing baseline is one 470.79 kB client chunk that already loads admin,
  booking, and Firebase code on the home page (00-inspection-report.md §Baseline). The gallery in particular
  (potentially 100+ images) must not be added to that same chunk — NFR-10/11 exist specifically to prevent
  this redo from making an already-flagged defect worse.

---

## 9. What must NOT change, and every touchpoint

**Unchanged, verified by direct read:**
- All prices in `src/data/packages.ts` (coverage 1600/3200/4800/6400; albums per `pagePrices`; prints
  13/16/20; magazine 40+15/page; wooden 80; VIP box +200).
- `shared/booking.ts` validation/pricing math — zero changes.
- Existing 7 admin actions and their targets (`shared/admin.ts:52-62`) — all kept, all still reachable.
- `contract_pending`/`contract_signed` remain valid, fully functional statuses for any legacy row (D8).
- Auth model: one Firebase listener (`AuthContext.tsx:464`), D1-only admin role check
  (`worker/admin-auth.ts:86-97`), no client-side role check, no React Router.
- `worker/bookings.ts`'s `createBooking` conflict logic and atomic insert — unchanged.
- Existing 3 email templates and `renderEmailLayout` — unchanged, new templates follow the same function.
- WhatsApp number and prefilled-message pattern (`966505647418`) — reused exactly, not replaced by an API-sent
  message.

**New touchpoints on existing files (additive only, per file):**
| File | What's added |
|---|---|
| `shared/admin.ts` | One action: `reject_receipt` (§4.1) |
| `worker/index.ts` | A `scheduled` export (hold expiry, reminders, cleanup) alongside the untouched `fetch` |
| `wrangler.jsonc` | `r2_buckets` binding, `triggers.crons` — `d1_databases` untouched |
| `MyBookings.tsx` | New expandable panels per stage, reusing the existing card/expand pattern |
| `AdminDashboard.tsx` | A 3rd tab ("queue"); new sections inside the existing booking detail panel |
| `BookingActions.tsx` | New `reject_receipt` button follows the exact existing confirm-dialog pattern |
| `email-templates.ts` | New templates via the existing `renderEmailLayout` helper |
| D1 (`sundus-yar-bookings`) | 2 new nullable columns on `booking_requests`; ~10 new tables (§4.3) |

**Pre-condition before any schema-changing run ships:** D8 says production migration state is unknown, and
the existing 0001/0002 duplicate-migration defect (inspection report, HIGH #1) is unresolved. Whoever runs
Run 3 should check `wrangler d1 migrations list --remote` (read-only) and resolve that defect first — this
spec's new tables should not be the first thing to hit a migration chain that's already broken.

---

## 10. Release slicing — Runs 2 through 8

Each slice ships and is testable independently; later slices depend on earlier ones being live.

| Run | Slice | Ships |
|---|---|---|
| **2** | Design system + imagery (D1) | Token-based CSS, motion, the owner's 32 new photos integrated into hero/portfolio. No backend change. |
| **3** | Timing infrastructure | Configurable hold window, `scheduled` export (hold expiry + reminders), `notification_log`, Resend fully configured (RESEND_API_KEY/EMAIL_FROM/APP_BASE_URL — currently unset, §12), BK-03..07 |
| **4** | Terms + receipt (replaces contract steps, D2) | `booking_receipts`, R2 bucket + signed URLs, `reject_receipt` action, PAY-01..09 |
| **5** | Pre-event engagement | `event_profiles`, questionnaire, consent, add-to-calendar, EVT-01..06 |
| **6** | Post-event gallery | `galleries`/`gallery_photos`/`gallery_selections`, bulk admin upload, quota selection, favourites, lightbox, filename export, GAL-01..11 |
| **7** | Album + handover | `album_production`, `handover_slots`/`handovers`, pickup+delivery slot booking, WhatsApp handoff, ALB-01..03, HND-01..07 |
| **8** | Feedback + privacy clean-up + polish | `feedback`, retention auto-delete, admin daily queue (ADM-01), HND-08..11, full NFR pass, staged ≤4-files-per-task verification across the whole feature set |

---

## 11. Out of scope

- Online/card payment gateway — deposit stays manual bank transfer + receipt upload; no Stripe/Moyasar/PayTabs.
- Self-service customer cancellation button — stays WhatsApp-initiated, admin-executed (matches every other
  customer→admin interaction pattern already in the app; no code today lets a customer mutate her own status).
- Multi-admin / staff roles / granular permissions — single `admin` role, unchanged.
- SMS notifications — email + WhatsApp deep-links only, no Twilio/SMS provider.
- In-app real-time chat/messaging — WhatsApp deep-link only, as today.
- Automated camera/Lightroom import pipeline — "bulk upload" (GAL-01) is a manual multi-file upload by
  Sundus, not an automated ingest integration.
- Face recognition / auto-tagging of gallery photos.
- Public or shareable gallery links — private-only, no "share with family" feature.
- Album e-commerce (post-delivery reprints/upsell purchase flow).
- Loyalty or referral program.
- Native admin mobile app — admin stays responsive web.
- English-language UI / language toggle — the existing app is Arabic-only everywhere inspected (no English
  strings, no toggle in `App.tsx` or elsewhere); this redo stays Arabic-only unless the owner explicitly
  requests bilingual support, which would be a separate, larger scope addition.
- Automatic refunds.
- Multiple galleries per booking / reshoot handling.
- Video services (catalog is photography-only).
- Two-way calendar sync (OAuth) — a downloadable `.ics`/add-link only, not live sync.
- Revenue/analytics/reporting dashboards, A/B testing, marketing automation.
- Browser push notifications.
- Multi-currency — SAR only, as today.
- Detailed retouching-task tracker — album production is 3 coarse stages, not a Kanban board.
- General customer file attachments — only the one receipt upload; no open-ended attachment feature.
- Rescheduling the **event date** itself post-confirmation (only the handover slot is reschedulable, and only
  as a LATER story).
- Legal e-signature product (DocuSign-style) — "accepting terms" is a checkbox + version stamp, not a signed
  document product.
- SEO/content marketing strategy — separate concern from this journey spec.

---

## 12. Unresolved — for the owner, each with a proposed default

1. **D4 — Deposit rule + bank details.** *Proposed default:* 20% of estimated total, rounded up to the
   nearest 50 SAR; bank details cannot be defaulted — must be supplied by the owner before Run 4 ships.
2. **D6 — Photo/receipt storage.** *Proposed default:* adopt R2 private bucket + short-lived signed URLs as
   already proposed; no lower-effort alternative exists inside the current Cloudflare-only stack.
3. **D7 — Real testimonials/feedback reuse.** *Proposed default:* HND-08/09 feedback stays private by
   default; the owner may later choose to reuse a specific piece as a testimonial, but the system never
   auto-publishes it.
4. **D8 — Production D1 migration state unknown.** *Proposed default:* check
   `wrangler d1 migrations list --remote` (read-only) and resolve the existing duplicate 0001/0002 migration
   defect before Run 3's schema changes ship.
5. **Booking terms/legal text.** Who supplies the actual wording (cancellation policy, deposit
   non-refundability, etc.)? *Proposed default:* v1 ships a plain-language operational summary of facts
   already true today (date, package, total, deposit requirement, hold mechanics) — explicitly not a
   substitute for a lawyer-drafted contract; owner/counsel supplies final wording before launch.
6. **Coverage-only gallery quota.** `photoCount` is `null` when no album is added
   (`shared/booking.ts:669-676`) — what's her selection quota then? *Proposed default:* fixed 30-photo quota.
7. **Missed selection deadline.** *Proposed default:* no auto-lock; flags in the admin queue for manual
   WhatsApp follow-up; admin can extend the deadline.
8. **Pickup location.** No studio/home address is evidenced anywhere in the code or brief.
   *Proposed default:* show "سيتم تحديد مكان الاستلام عبر واتساب" until the owner supplies a fixed address.
9. **Delivery execution + fee.** Who delivers (the owner herself vs. a courier), and is there a fee?
   *Proposed default:* self-delivered by the owner within Madinah only, no fee, until stated otherwise —
   nothing should silently get charged since no delivery fee exists in `packages.ts` today.
10. **Handover slot availability.** Which days/times are bookable? *Proposed default:* Saturday–Thursday, a
    small number of fixed 1-hour slots/day, adjustable by the owner via the admin-managed slot table.
11. **Who may collect the album at pickup?** *Proposed default:* anyone presenting the booking reference —
    matches today's light-touch, non-KYC trust model; no ID verification is built.
12. **Resend email is not configured in production** (RESEND_API_KEY/EMAIL_FROM/APP_BASE_URL/
    ADMIN_NOTIFICATION_EMAIL — confirmed unset, inspection report §7). *Proposed default:* must be configured
    before Run 3 ships, or every timing-based notification in this entire spec silently no-ops exactly as
    all email does today.
13. **Engagement scope vs. price** (see §1). *Proposed default:* treat this feature set as its own change
    order with its own price, not absorbed into the original "redo the site" quote.
