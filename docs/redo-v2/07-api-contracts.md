# 07 — API Contracts (Run 1 of 8, `redo-v2-spec`)

Sundus Yar client portal — contracts for every **new** and every **changed** `/api/*` endpoint needed by
`01-product-spec.md` and `05-adr-architecture.md`. Grounded in the actual code at baseline `d6b7cb2`
(`app/worker/http.ts`, `app/worker/index.ts`, `app/worker/bookings.ts`, `app/worker/admin.ts`,
`app/worker/admin-workflow.ts`, `app/worker/admin-auth.ts`, `app/worker/auth.ts`, `app/shared/admin.ts`,
`app/shared/booking.ts`, `app/src/api/bookings.ts`, `app/src/api/admin.ts`, `app/wrangler.jsonc`,
`app/migrations/*.sql`) and in `runs/redo-v2/decisions.md`, `00-inspection-report.md`, `01-product-spec.md`,
`05-adr-architecture.md` and `08-copy-ar.md`. Where the ADR's §2.8 schema and the earlier product-spec §4.3
sketch disagree, this document follows the ADR (newer, authoritative, explicitly "writes the final DDL").

**I did not write any code and did not touch `app/`.** I designed the contract only. Persistence (indexes,
exact `CHECK`/length constraints) belongs to `database-architect`/the migration author; this document proposes
reasonable caps for anything the ADR left as "final DDL later" and flags each one.

No business facts are invented here: deposit amount, bank details, terms wording, pickup address and delivery
fee are all modelled as **fields that exist and are shown**, never as values I made up. Every such field is
listed again in §7 Unresolved.

---

## 0. What changes and what does not

**Zero breaking changes.** Every item below is either a brand-new endpoint or an **additive** change to an
existing one (new optional response fields, new optional request fields, new enum members). No existing field
is removed, renamed, retyped, or made required when it was optional; no existing status code's meaning changes.
Section §4 names every file under `app/src/api/` that touches a changed endpoint and states exactly why it
keeps working unmodified.

**Endpoints explicitly out of scope for this document** (so nothing is silently dropped): the admin daily
queue (`ADM-01`, `GET /api/admin/queue`, ADR workstream `W8-3`) is Run 8 scope and is not designed here — see
§7.8. `GET /api/health`, `GET /api/availability`, `POST /api/bookings`, `GET /api/profile`/`PUT /api/profile`,
and the three existing admin blocked-dates endpoints are **unchanged** and not repeated here except where they
inform a convention.

**Feedback is included even though the run's "Cover" list does not name it.** Stage 14/15
(`completed_feedback` / `privacy_cleanup`) and `HND-08/09` need a submission endpoint to be a complete,
buildable contract for the 15-stage journey `decisions.md` commits to; it is small (one rating + optional
comment, admin-read-only). Flagged here so it is a visible, deliberate addition, not scope creep.

---

## 1. Conventions every endpoint below follows

### 1.1 Style: REST, not GraphQL or RPC
This stays 100% REST, matching the entire existing surface: it is a CRUD-and-domain-verb admin/client API with
a known, small set of resources (bookings, receipts, galleries, slots), not a multi-resource flexible-read
client (no GraphQL need) and not an internal service-to-service call (one Worker, no RPC need).

### 1.2 The error envelope (defined once, used everywhere)
Unchanged shape from `app/worker/http.ts`, with one **additive, optional** field:

```json
{ "ok": false, "error": { "code": "STRING_CODE", "message": "Arabic, human-readable", "details": [ { "field": "venueName", "issue": "TOO_LONG" } ] } }
```

- `code` and `message` are unchanged in meaning and are on **every** error response, exactly as today.
- `details` is **new and optional**. It is only populated where a request can fail on more than one field at
  once (event-profile validation, admin slot creation); everywhere else it is omitted, exactly like today.
  Existing clients read only `.error.code`/`.error.message` (verified in `src/api/bookings.ts` and
  `src/api/admin.ts` — neither rejects unknown keys on error bodies), so adding `details` breaks nothing.
- Success bodies stay `{"ok": true, ...top-level fields...}` — never a generic `{ok:true, data:{...}}` wrapper,
  matching every existing response (`{ok:true, booking:{...}}`, `{ok:true, bookings:[...]}`, etc.).

### 1.3 Status-code honesty, and one deliberate non-use
| Status | Used for |
|---|---|
| 200 | Successful read, or a write whose effect is "set to a value" (idempotent retry lands here too) |
| 201 | A write that creates a new row for the first time |
| 400 | Malformed/invalid request body, query, or field value |
| 401 | Missing/invalid/expired bearer token (`UNAUTHORIZED` customer surface, `UNAUTHENTICATED` admin surface — both pre-existing, kept distinct on purpose, see §1.5) |
| 403 | Authenticated but not allowed: unverified email, or not the admin role |
| 404 | Booking not found **or not owned by the caller** (never 403 for ownership — see §1.5), or a genuinely missing sub-resource |
| 405 | Wrong HTTP method, `Allow` header set |
| 409 | Right shape, right auth, but the current state forbids the action (conflict) |
| 411 | Binary upload with no `Content-Length` |
| 413 | Binary upload over its cap |
| 415 | Wrong `Content-Type` (envelope) or a file whose sniffed bytes are not an allowed type |
| 500 | Unexpected server error (generic `INTERNAL_ERROR`, matches existing) |

**422 is deliberately not used anywhere in this contract.** The existing API uses 400 for every validation
failure (`INVALID_EVENT_DATE`, `INVALID_BOOKING_SELECTION`, etc.) — it never uses 422. Introducing 422 now for
only the new endpoints would split the API into two validation-error conventions. I kept the API internally
consistent instead: 400 for all client-side validation errors, old and new alike.

**429 is not used.** No rate limiter exists anywhere in this app (`05-adr-architecture.md` §2.7: "Rate
limiting: none is added, because every write is authenticated and bounded by its state") and I have not added
one — see §1.9.

### 1.4 Method/content-type hygiene (unchanged pattern, applied to every new endpoint)
- Wrong HTTP method → `405 METHOD_NOT_ALLOWED` with an `Allow` header listing the methods that path accepts,
  via the existing `methodNotAllowedResponse()` helper.
- JSON endpoints require `Content-Type: application/json` (charset ignored, matched case-insensitively on the
  part before `;`, exactly like `isJsonContentType` in `bookings.ts`/`admin.ts`/`admin-workflow.ts`) or
  `415 UNSUPPORTED_MEDIA_TYPE`.
- Multipart endpoints (receipt, gallery photo upload) require `Content-Type: multipart/form-data` (boundary
  present) or `415 UNSUPPORTED_MEDIA_TYPE`. Only the documented field names are read; any other field name in
  the multipart body is a `400 INVALID_REQUEST_BODY` — the multipart equivalent of the exact-key JSON check
  already used everywhere (`hasExactBookingBodyKeys`, `hasOnlyKeys`).
- Every new JSON request body is validated against an **exact key set** the same way: unknown keys reject the
  whole request with `400 INVALID_REQUEST_BODY`, never silently ignored.
- `Content-Length` is required on binary uploads and checked **before** any byte is read: missing →
  `411 LENGTH_REQUIRED`; present but over the cap → `413 PAYLOAD_TOO_LARGE`; this mirrors what
  `05-adr-architecture.md` §2.1 step 1 already specifies for the receipt endpoint and I apply it identically to
  gallery photo upload.

### 1.5 Auth models (four, not three — `signed-url` is new)
| Mode | What it means | 401/403 chain |
|---|---|---|
| `customer-owner` | Bearer Firebase ID token (`Authorization: Bearer <token>`), verified email required, **and** the row is scoped to `user_id = uid` inside the SQL itself | `401 UNAUTHORIZED` (bad/missing token) → `403 EMAIL_NOT_VERIFIED` → the row is simply not found for a non-owner, so **`404 BOOKING_NOT_FOUND`**, never `403`. This is deliberate and matches the ADR's IDOR control (§2.7): a 403 would confirm the booking exists; 404 does not. |
| `admin` | Bearer Firebase ID token, verified email required, **and** D1 `users.role = 'admin'` | `401 UNAUTHENTICATED` → `403 EMAIL_NOT_VERIFIED` → `403 FORBIDDEN`, exactly the existing `authorizeAdminRequest` chain, reused unchanged. |
| `signed-url` | No `Authorization` header is read at all. The query string carries `e` (expiry) and `s` (HMAC-SHA256 signature) minted by the Worker only after an ownership/admin check at **mint time**. | `403 SIGNATURE_INVALID` for a bad/expired/missing signature. This exists because `<img>` cannot send a bearer token (ADR §1.2). |
| *(unused here)* `public` | No auth at all | None of the endpoints in this document are public. (`/api/health`, `/api/availability` stay public, unchanged, not repeated here.) |

### 1.6 Idempotency — natural design, not a header, with one named exception
The existing codebase has **no** `Idempotency-Key` header anywhere (verified: `bookings.ts`, `admin.ts`,
`admin-workflow.ts`) — every mutation is made safe to retry through **conditional writes** (`UPDATE ... WHERE
status = ?`), **partial unique indexes** (one pending receipt, one row per gallery per booking), and a
refetch-and-compare pattern on batch failure (`resolveTransitionFailure` in `admin-workflow.ts` is the existing
template). I followed that same pattern for every new mutating endpoint rather than inventing a new
header-based dedup mechanism that would need its own D1 table the ADR's §2.8 schema does not define. Each
endpoint section in §3 states its specific mechanism. Two points worth stating once, here:

- **The general story:** a client that does not know whether its last request landed should re-send the same
  request. It will either get the same success again (idempotent set/PUT semantics), or a specific 409 that
  means "this already happened" (e.g. `RECEIPT_ALREADY_PENDING`, `GALLERY_ALREADY_EXISTS`) — which the client
  should treat as success and refresh its view, not show as a raw error.
- **The one endpoint I could not make fully idempotent, flagged per the "no exceptions" rule:**
  `extend_hold` (via `POST /api/admin/bookings/{bookingId}/actions`) is **intentionally repeatable, not
  idempotent** — the ADR (`U8`) defines it as "+24h per use, no limit on uses, every use logged." A genuine
  double-click before the first response returns is two legitimate uses, not a bug, and extends the hold twice.
  **Retry risk:** worst case the bride gets extra time she didn't need; there is no path where a double-submit
  costs her time or loses data. Mitigation is client-side only (disable the button while in flight); the server
  deliberately does not deduplicate this one action.

### 1.7 Pagination — every list endpoint has one, strategy matches the shape of the resource
| Resource | Strategy | Default | Max | Why |
|---|---|---|---|---|
| `GET /api/admin/bookings/{bookingId}/receipts` | `limit` only, no cursor | 20 | 50 | Bounded by the domain invariant "one pending receipt at a time"; realistically ≤10 rows ever. |
| `GET /api/admin/bookings/{bookingId}/gallery/photos`, `GET /api/bookings/{bookingId}/gallery/photos` | Cursor (`cursor`, `limit`) | 60 | 200 | Genuinely large flat list (up to 1,000 photos/gallery, ADR §2.3 `U12`); cursor avoids the offset-drift problem while photos are still being uploaded. |
| `GET /api/admin/handover-slots`, `GET /api/bookings/{bookingId}/handover/slots` | Date range (`from`/`to`), same shape as the **existing** `/api/availability` and `/api/admin/blocked-dates` | today .. +30d if omitted | 90 days | Calendar-shaped resource — matching the codebase's own established pattern for this shape is more consistent than forcing an opaque cursor onto it. |
| `GET /api/admin/bookings/{bookingId}/gallery/selection` (export) | None — always complete | — | ≤500 (= max quota) | Bounded by the 1–500 quota ceiling; the admin's offline Lightroom-matching workflow needs the complete list in one response, not a partial page. |
| `GET /api/bookings/me`, `GET /api/admin/bookings` | Unchanged | 50 / 50 | — / 100 | Pre-existing, out of scope for this run (`ADM-05` is `LATER`, inspection report defect #12.3) — not touched here. |

Cursor format: an opaque, server-generated string (`base64url` of `"<sortOrder>:<id>"`). Clients must treat it
as opaque and pass back exactly what `nextCursor` returned; `nextCursor: null` means the last page.

### 1.8 Versioning
No version bump anywhere in this document — every change is additive per §0. **If a future change must remove
a field, retype a field, change required-ness, or change what a status code means, it needs a new version.**
Since this codebase has no versioning scheme today, I recommend (not implemented, not needed yet) a
path-prefixed `/api/v2/...` scheme over a header-based one **specifically because** routing here is
`url.pathname` string matching (`worker/index.ts`) — a path prefix is a one-line branch; a header-based scheme
would need new dispatch logic that does not exist yet.

### 1.9 Rate limiting
None is added by this contract, matching the app-wide decision already recorded in
`05-adr-architecture.md` §2.7 ("every write is authenticated and bounded by its state"). Every endpoint table
row below says "None (app-wide, no limiter — ADR §2.7)". **Residual risk I am flagging, not resolving:**
`GET /api/media/{key}` and the two upload endpoints (`POST .../receipt`, `POST .../gallery/photos`) are the
highest-cost paths and, for media specifically, the check is signature-only (no session) — "a signed link can
still be forwarded or screenshotted while it is valid" (ADR §2.7). I recommend the security-auditor (already
scoped for `W4-5`/`W6-4`) confirm whether Cloudflare's zone-level WAF or the Rate Limiting binding should cover
these three paths specifically. This is a recommendation, not a contract requirement — no rate-limit behaviour
is promised to clients anywhere in this document.

### 1.10 Webhooks — not applicable
This system receives **no inbound webhooks**. Resend is outbound-only (no delivery-status webhook is
implemented, confirmed against `worker/email.ts`/`email-templates.ts`); there is no payment gateway (§1.11);
WhatsApp is a client-initiated `wa.me` deep link, never a callback into this Worker. There is nothing to sign
or verify here. **If a future run adds an inbound webhook** (e.g. Resend delivery events), it must use
HMAC-SHA256 over the raw body with a shared secret plus a timestamp to prevent replay, and ship the
verification snippet with the docs — the same pattern already used for signed media URLs in this document
(§3.C) is the template to copy.

### 1.11 Saudi/GCC payments — not applicable, and deliberately not added
**There is no payment gateway in this design**, and product-spec explicitly lists "online/card payment
gateway" as out of scope: "deposit stays manual bank transfer + receipt upload; no Stripe/Moyasar/PayTabs."
Confirmation is a **human admin** looking at an uploaded receipt image and clicking confirm/reject — never a
client-submitted status field (the client cannot set `booking_receipts.status`; only
`POST /api/admin/bookings/{bookingId}/actions` with an authenticated admin token can, per §3.B.4). No card data
of any kind ever transits any endpoint in this document — only images/PDFs of an already-completed bank
transfer. **If a SAMA-licensed gateway (HyperPay/Moyasar/Tap/PayTabs) is added later** (an alternative to D4,
not decided here), it must: verify callbacks server-side by signature, never trust a client-submitted status
field, use the gateway's hosted fields/tokenization so raw card data never transits this API, and have its
PCI-DSS scope confirmed with the gateway and a licensed advisor. This is guidance for that future decision, not
a spec for it.

---

## 2. Endpoint table

Auth legend: **CO** = customer-owner, **AD** = admin, **SU** = signed-url. Rate limit is "None*" for every row;
`*` = see §1.9 residual-risk note (applies to the three flagged rows only).

| # | Method | Path | Auth | Idempotent | Paginated | Rate limit | Change |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/api/bookings/me` | CO | Y (read) | Y (unchanged, cap 50) | None | **CHANGED** (additive fields) |
| 2 | GET | `/api/bookings/{bookingId}/confirmation` | CO | Y (read) | N | None | NEW |
| 3 | POST | `/api/bookings/{bookingId}/receipt` | CO | Y (natural, §3.B.2) | N | None* | NEW |
| 4 | GET | `/api/admin/bookings/{bookingId}/receipts` | AD | Y (read) | Y (limit, 20/50) | None | NEW |
| 5 | POST | `/api/admin/bookings/{bookingId}/actions` | AD | Y, except `extend_hold` (§1.6) | N | None | **CHANGED** (new actions + field) |
| 6 | GET | `/api/media/{key}` | SU | Y (read) | N | None* | NEW |
| 7 | GET | `/api/bookings/{bookingId}/event-profile` | CO | Y (read) | N | None | NEW |
| 8 | PUT | `/api/bookings/{bookingId}/event-profile` | CO | Y (PUT, full replace) | N | None | NEW |
| 9 | POST | `/api/admin/bookings/{bookingId}/gallery` | AD | Y (natural, unique) | N | None | NEW |
| 10 | DELETE | `/api/admin/bookings/{bookingId}/gallery` | AD | Y (200 `deleted:false` on repeat) | N | None | NEW |
| 11 | PATCH | `/api/admin/bookings/{bookingId}/gallery` | AD | Y | N | None | NEW |
| 12 | POST | `/api/admin/bookings/{bookingId}/gallery/photos` | AD | Y (filename dedup, §3.E.4) | N | None* | NEW |
| 13 | GET | `/api/admin/bookings/{bookingId}/gallery/photos` | AD | Y (read) | Y (cursor, 60/200) | None | NEW |
| 14 | DELETE | `/api/admin/bookings/{bookingId}/gallery/photos/{photoId}` | AD | Y (200 `deleted:false` on repeat) | N | None | NEW |
| 15 | GET | `/api/admin/bookings/{bookingId}/gallery/selection` | AD | Y (read) | N (bounded ≤500) | None | NEW |
| 16 | GET | `/api/bookings/{bookingId}/gallery` | CO | Y (read) | N | None | NEW |
| 17 | GET | `/api/bookings/{bookingId}/gallery/photos` | CO | Y (read) | Y (cursor, 60/200) | None* | NEW |
| 18 | POST | `/api/bookings/{bookingId}/gallery/selection` | CO | Y (set-ops, §3.E.9) | N (1–50 ops/call) | None | NEW |
| 19 | POST | `/api/bookings/{bookingId}/gallery/submit` | CO | Y (natural) | N | None | NEW |
| 20 | PATCH | `/api/admin/bookings/{bookingId}/album` | AD | Y | N | None | NEW |
| 21 | POST | `/api/admin/handover-slots` | AD | Y (unique constraint) | N | None | NEW |
| 22 | GET | `/api/admin/handover-slots` | AD | Y (read) | Y (date range, ≤90d) | None | NEW |
| 23 | PATCH | `/api/admin/handover-slots/{slotId}` | AD | Y | N | None | NEW |
| 24 | DELETE | `/api/admin/handover-slots/{slotId}` | AD | Y (200 `deleted:false` on repeat) | N | None | NEW |
| 25 | GET | `/api/bookings/{bookingId}/handover/slots` | CO | Y (read) | Y (date range, ≤90d) | None | NEW |
| 26 | GET | `/api/bookings/{bookingId}/handover` | CO | Y (read) | N | None | NEW |
| 27 | POST | `/api/bookings/{bookingId}/handover` | CO | Y (natural, PK) | N | None | NEW |
| 28 | PATCH | `/api/bookings/{bookingId}/handover` | CO | Y (natural) | N | None | NEW — ships with `HND-07` (`LATER`) |
| 29 | PATCH | `/api/admin/bookings/{bookingId}/handover` | AD | Y (completed is a no-op on repeat) | N | None | NEW |
| 30 | POST | `/api/bookings/{bookingId}/feedback` | CO | Y (compare-on-retry, §3.H.1) | N | None | NEW |
| 31 | GET | `/api/bookings/{bookingId}/feedback` | CO | Y (read) | N | None | NEW |
| 32 | GET | `/api/admin/bookings/{bookingId}` | AD | Y (read) | N | None | **CHANGED** (additive fields) |
| 33 | GET | `/api/admin/bookings` | AD | Y (read) | Y (unchanged) | None | **CHANGED** (additive fields) |

---

## 3. Endpoint-by-endpoint contracts

### 3.A `GET /api/bookings/me` — CHANGED, additive only

Existing behaviour is **100% unchanged**: same path, same method, same auth, same 50-row cap, same existing
fields (`id`, `eventDate`, `status`, `estimatedTotal`, `packageSnapshot`, `holdExpiresAt`, `confirmedAt`,
`createdAt`, `updatedAt`), same meaning for all of them.

**New, additive, per-booking fields** (computed server-side by `shared/journey.ts`'s `deriveJourneyStage`,
the same pure function the Worker uses for cron/emails — single source of truth, no drift between what the
countdown shows and what the reminder email says):

| Field | Type | Meaning |
|---|---|---|
| `flowVersion` | `1 \| 2` | `1` = legacy manual-contract row, `2` = online confirmation. |
| `stage` | one of the 15 stage ids, or `null` | `null` for legacy (`flow_version=1`) rows and for terminal statuses (`rejected`/`cancelled`/`expired`) — "map to no journey stage and render exactly as they do today" (ADR §2.1). The 15 ids: `pending_review`, `approved_hold`, `terms_and_receipt_pending`, `receipt_review`, `confirmed`, `pre_event_engagement`, `gallery_open`, `gallery_locked`, `album_design`, `album_printing`, `album_ready`, `handover_scheduling`, `handover_day`, `completed_feedback`, `privacy_cleanup`. |
| `stageLabel` | string (Arabic) or `null` | The Arabic label for `stage`, e.g. `"أكملي حجزكِ"`. Exists so a not-yet-updated client can render *something* correct without its own copy of the stage→label map. |
| `stageDeadline` | ISO datetime or `null` | The single deadline relevant to her **current** stage — `holdExpiresAt` at stages 2–3, `eventDate`-derived at stage 5–6, `selectionDeadline` at stage 7, the booked slot's start at stage 12–13, the purge date at stage 14. Its meaning is fully determined by `stage` (see the table in `05-adr-architecture.md` §2.1) — no separate "kind" field is needed. |
| `depositAmount` | integer (SAR) or `null` | Snapshot taken at approval time; `null` for legacy rows and for bookings not yet approved. |

**New top-level field**, sibling to `ok`/`bookings`: `serverTime` (ISO datetime) — so the client's countdown
components compute "time remaining" against the server clock, not the device clock (needed for `EVT-03`,
`BK-03`; ADR W3-7: "Countdown corrected with server time").

**Why this cannot break the existing client:** `src/api/bookings.ts`'s `isMyBookingsResponse`/`isCustomerBooking`
type guards check only that the *existing* named fields are present with the right type; they perform no
`Object.keys(...).length` check on the response (verified by direct read — this is the opposite of the
**request**-body exact-key checks, which only apply to bodies the client sends, not responses it receives).
Extra keys are structurally invisible to the current guard and simply ignored until a later run updates it.

Query, path, and every existing error response are unchanged.

---

### 3.B Terms acceptance, deposit info, and receipt upload/verification

#### 3.B.1 `GET /api/bookings/{bookingId}/confirmation` (CO) — NEW
Purpose: everything the "أكملي حجزكِ" panel (stage 3) and the "مراجعة الإيصال" panel (stage 4) need in one
call: terms text/version, deposit amount and bank details, and her own receipt history (status + rejection
reasons, no image URL — she does not need to re-view her own upload, only its status; see §7.2 for why no
customer-facing receipt image endpoint exists).

- Only meaningful for `flowVersion = 2`. For a legacy row, responds `409 LEGACY_FLOW_NOT_SUPPORTED` —
  a permanent "not applicable" condition, not a transient "not yet," so a 409 is more honest than a
  200-with-nulls.
- Response `200`:
  ```json
  {
    "ok": true,
    "booking": { "id": "…", "status": "approved_hold", "flowVersion": 2, "holdExpiresAt": "2026-…Z" },
    "terms": { "version": "2026-09-1", "text": "…plain-language operational summary, see §7.4…" },
    "deposit": {
      "amount": 800,
      "currency": "SAR",
      "bankDetails": { "bankName": "…", "accountName": "…", "iban": "SA…" }
    },
    "receipts": [
      { "id": "…", "status": "rejected", "uploadedAt": "…Z", "reviewedAt": "…Z", "rejectionReason": "الصورة غير واضحة، يرجى رفع صورة أوضح للإيصال." },
      { "id": "…", "status": "pending", "uploadedAt": "…Z", "reviewedAt": null, "rejectionReason": null }
    ],
    "serverTime": "2026-…Z"
  }
  ```
  `deposit.bankDetails` is `null` once `status` is `confirmed` or later (no further transfer needed; amount
  stays visible for her records). `receipts` is newest-first, `[]` if none uploaded yet.
- Errors: `401 UNAUTHORIZED`, `403 EMAIL_NOT_VERIFIED`, `404 BOOKING_NOT_FOUND`, `405`, `409
  LEGACY_FLOW_NOT_SUPPORTED`, `500 INTERNAL_ERROR`.
- Idempotent: read-only.

#### 3.B.2 `POST /api/bookings/{bookingId}/receipt` (CO) — NEW, the flagship new endpoint
Multipart, not JSON+base64: keeps the 5 MiB cap meaningful as bytes, not ~6.8 MB of base64 text, and matches
the ADR's explicit design (§2.1 step 1–3).

- **Request:** `multipart/form-data` with exactly three parts:
  | Part | Type | Required | Constraint |
  |---|---|---|---|
  | `file` | binary | Y | ≤ 5,242,880 B (5 MiB); sniffed magic bytes must be one of JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF….WEBP`, PDF `%PDF-`. The client's declared `Content-Type` on the part is **ignored**; only the sniffed type is trusted and stored. |
  | `termsVersion` | text | Y | Must equal the server's current terms version exactly, or `400 TERMS_VERSION_MISMATCH`. |
  | `termsAccepted` | text | Y | Must be the literal string `"true"`. |
- Overall request `Content-Length` required, capped at 5,275,648 B (file cap + multipart overhead margin) —
  checked before any byte is read (`411`/`413`, §1.4).
- **Server-side guards, in order** (mirrors ADR §2.1 exactly):
  1. Auth chain (§1.5).
  2. `Content-Length` present and ≤ cap → else `411`/`413`.
  3. Content-Type is multipart → else `415 UNSUPPORTED_MEDIA_TYPE`.
  4. All three parts present, `termsAccepted === "true"` → else `400 INVALID_REQUEST_BODY`.
  5. `termsVersion` matches current → else `400 TERMS_VERSION_MISMATCH`.
  6. Magic-byte sniff passes the allowlist → else `415 UNSUPPORTED_FILE_TYPE`.
  7. One D1 batch: `UPDATE booking_requests SET status='payment_pending', terms_version=?, terms_accepted_at=?
     WHERE id=? AND user_id=?uid AND flow_version=2 AND status='approved_hold' AND hold_expires_at > now` (a
     re-upload after rejection uses the sibling guard: `status='payment_pending' AND` latest receipt
     `rejected AND hold_expires_at > now`) + insert `booking_receipts` (`status='pending'`, guarded by the
     partial unique index) + insert `booking_status_history`/`booking_events` + queue the admin-alert email.
  8. If the batch fails, the just-written R2 object is deleted (no orphan) and the booking is re-read to map
     the failure to the correct code (`resolveTransitionFailure`-style, §1.6).
- **Response `200`:**
  ```json
  { "ok": true, "booking": { "id": "…", "status": "payment_pending", "holdExpiresAt": "…Z" }, "receipt": { "id": "…", "status": "pending", "uploadedAt": "…Z" } }
  ```
- **Errors:** `400 INVALID_REQUEST_BODY`, `400 TERMS_VERSION_MISMATCH`, `401 UNAUTHORIZED`,
  `403 EMAIL_NOT_VERIFIED`, `404 BOOKING_NOT_FOUND`, `405`, `409 HOLD_EXPIRED`
  (*"انتهت مهلة الحجز المؤقت لهذا التاريخ. تواصلي معنا عبر واتساب إن رغبتِ في المتابعة."* — reused verbatim
  from ADR §2.1), `409 RECEIPT_ALREADY_PENDING`, `409 INVALID_STATUS_TRANSITION`, `411 LENGTH_REQUIRED`,
  `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `415 UNSUPPORTED_FILE_TYPE`, `500 INTERNAL_ERROR`.
- **Idempotency story:** the partial unique index (`ux_booking_receipts_one_pending`) makes a second
  successful upload impossible while one is pending; a client that does not know whether its first attempt
  landed should retry identically — a lost-response-but-actually-succeeded retry gets `409
  RECEIPT_ALREADY_PENDING`, which the client must treat as success and re-fetch §3.B.1 to show the pending
  state, not as a raw error. **Residual retry risk, flagged explicitly:** if she genuinely meant to upload a
  *different, corrected* file within that window (thinking the first attempt failed), she cannot do so until
  the admin reviews and, if needed, rejects the first one — bounded by the admin SLA (24h default). This is
  accepted because the alternative (letting two receipts race) would violate the one-pending invariant the
  admin queue relies on.

#### 3.B.3 `GET /api/admin/bookings/{bookingId}/receipts` (AD) — NEW
Full history (newest first) with a freshly minted 10-minute signed view URL per row (never a public path,
per `PAY-04`/`GAL-02`-equivalent for receipts).

- Query: `limit` (default 20, max 50) — see §1.7 for why no cursor.
- Response `200`:
  ```json
  {
    "ok": true,
    "receipts": [
      { "id": "…", "status": "pending", "contentType": "image/jpeg", "byteSize": 812004, "uploadedAt": "…Z", "reviewedAt": null, "reviewedBy": null, "rejectionReason": null, "viewUrl": "/api/media/r/<bookingId>/<receiptId>?e=…&s=…" }
    ]
  }
  ```
- Errors: `401 UNAUTHENTICATED`, `403 EMAIL_NOT_VERIFIED`, `403 FORBIDDEN`, `404 BOOKING_NOT_FOUND`, `405`,
  `500 INTERNAL_ERROR`.
- Idempotent: read-only.

#### 3.B.4 `POST /api/admin/bookings/{bookingId}/actions` (AD) — CHANGED, additive
Same path, same method, same response envelope shape as today. Three additive changes:

1. **Two new `action` enum members:** `reject_receipt`, `extend_hold` (widens `AdminBookingAction` in
   `shared/admin.ts`, which `src/api/admin.ts` imports directly rather than duplicating — so the client's own
   `isAdminBookingAction` guard recognises the new values automatically with **zero edits to
   `app/src/api/admin.ts`**; see §4).
2. **One new optional request field**, `extendHours` (integer, 1–168, default 24 when the action needs one and
   omits it) — lets the admin override the extension length per the copy deck's "تمديد المهلة (بالساعات)"
   field (`08-copy-ar.md` §9.2), instead of a fixed +24h. Allowed key set widens from `{action, note}` to
   `{action, note, extendHours}`; `extendHours` present on any action other than `reject_receipt`/`extend_hold`
   is `400 INVALID_REQUEST_BODY` (kept strict, matching the codebase's existing exact-key discipline).
3. **`note` becomes conditionally required** (was always optional): non-empty, ≤500 chars, required when
   `action = reject_receipt` (copy deck: "سبب رفض الإيصال" is mandatory), and required when
   `action = confirm_payment` **is invoked from `approved_hold`** (the new offline escape hatch, ADR `U7`) —
   both cases `400 NOTE_REQUIRED` if missing/empty. For every existing action from every existing source
   status, `note` stays exactly as optional as it is today — **zero behavioural change for flow-1 rows or any
   existing action/status pair.**

**New preconditions per status, for `flow_version = 2` rows only** (flow-1 rows keep today's
`allowedAdminActionsByStatus` unchanged, verbatim, per ADR §2.1):

| Status (flow 2) | Admin actions now allowed | Effect |
|---|---|---|
| `approved_hold` | `extend_hold`, `confirm_payment` (offline escape hatch, note required), `cancel` | `extend_hold`/`confirm_payment` do **not** change `booking_requests.status` for `extend_hold`; `confirm_payment` here jumps straight to `confirmed`. Writes `booking_events`, not `booking_status_history`, when status is unchanged. |
| `payment_pending`, latest receipt `pending` | `confirm_payment` (marks the receipt `verified` in the same batch), `reject_receipt` (reason required; hold becomes `max(hold, now) + extendHours`), `cancel` | |
| `payment_pending`, latest receipt `rejected` | `extend_hold`, `cancel` | She may re-upload (§3.B.2); status is unchanged either way. |

- New response fields: none — `booking` is the (now-additive) `AdminBookingDetail` from §3.I, which already
  reflects the new `holdExpiresAt`/`latestReceipt` state.
- New errors: `400 NOTE_REQUIRED`, `400 INVALID_REQUEST_BODY` (stray `extendHours`), `409 NO_PENDING_RECEIPT`
  (`reject_receipt` when the latest receipt is not `pending`), plus the existing `409
  INVALID_STATUS_TRANSITION` reused for any other precondition miss.
- **Idempotency:** see §1.6 — every action here is a conditional write; `extend_hold` is the one named
  exception (repeatable by design, not idempotent).
- **Compile-time note for the frontend, not a wire concern:** `BookingActions.tsx` types its button labels as
  `Record<AdminBookingAction, string>` (inspection report, confirmed). Adding the two enum values requires
  that file to add matching labels **in the same commit**, or the frontend build breaks — this is an existing,
  already-flagged same-repo coupling (ADR `W4-2`), not a wire-level breaking change to any deployed client,
  since frontend and Worker ship together as one build.

---

### 3.C `GET /api/media/{key}` (SU) — NEW
Serves every private receipt/gallery file. Exact format from `05-adr-architecture.md` §2.3, reproduced here so
frontend/backend build against the same string:

```
GET /api/media/{key}?e={unixSeconds}&s={base64url(HMAC-SHA256(MEDIA_SIGNING_KEY, "v1\n" + key + "\n" + e))}
```

- `{key}` is **not** URL-encoded segment-by-segment — it is matched on the raw `url.pathname` after stripping
  the `/api/media/` prefix and **contains internal `/` characters** (`r/<bookingId>/<receiptId>` or
  `g/<galleryId>/<photoId>/p` or `.../t`). Most OpenAPI tooling assumes one path segment per `{param}`; treat
  this one as "everything after `/api/media/`", documented here in prose because the YAML's native expressivity
  for this is weak.
- `key` must match `^(r|g)/[0-9a-f-]{36}/[0-9a-f-]{36}(/(p|t))?$`, or `400 INVALID_MEDIA_KEY`.
- `e` must be in the future and ≤2h ahead of now, or `403 SIGNATURE_INVALID`.
- `s` is verified with `crypto.subtle.verify` (constant-time); any mismatch → `403 SIGNATURE_INVALID`.
- **No `Authorization` header is read.** Authorization already happened once, at mint time, inside the
  endpoint that returned this URL (§3.B.3, §3.E.6/12, or the gallery/receipt list endpoints) — never here.
- Lifetimes: gallery links 60–120 min (`e = (floor(now/3600)+2)*3600`, stable for the whole clock hour so the
  browser cache gets hits); receipt links 10 min.
- Response headers on success: `Content-Type` (sniffed/stored type), `Cache-Control: private,
  max-age=<e-now>, immutable`, `ETag` (from R2 `httpEtag`, with `304` support), `X-Content-Type-Options:
  nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy:
  same-origin`, `Referrer-Policy: no-referrer`, `Content-Disposition: inline` for images / `attachment` for
  PDFs. Nothing is cached at Cloudflare's edge.
- Errors: `400 INVALID_MEDIA_KEY`, `403 SIGNATURE_INVALID`, `404 MEDIA_NOT_FOUND`, `405`, `500 INTERNAL_ERROR`.
- Idempotent: pure read.

---

### 3.D Pre-event questionnaire (`event_profiles`)

#### 3.D.1 `GET /api/bookings/{bookingId}/event-profile` (CO) — NEW
`200` always (given the booking exists and is hers): `{"ok": true, "eventProfile": null}` if she has never
submitted one, or the full object otherwise. A `null` result for "not submitted yet" (not a 404) — this is
her **own booking's** optional sub-resource, and "not yet" is a normal, expected state, not an error.
Errors: `401 UNAUTHORIZED`, `403 EMAIL_NOT_VERIFIED`, `404 BOOKING_NOT_FOUND`, `405`, `500 INTERNAL_ERROR`.

#### 3.D.2 `PUT /api/bookings/{bookingId}/event-profile` (CO) — NEW
PUT, not PATCH — deliberately, because full-replace-of-a-1:1-resource is naturally idempotent (rule-2's
"natural idempotent design" case): identical repeated requests always produce identical stored state, safe to
retry unconditionally, no special-casing needed.

- Request body (exact keys):
  ```json
  { "venueName": "قاعة …", "venueArea": "حي …", "startTime": "16:30", "specialRequests": "…", "publishingConsent": false }
  ```
  `venueName`/`venueArea`/`specialRequests` are nullable strings; `startTime` is nullable `"HH:MM"` (24h);
  `publishingConsent` is a **required** boolean on every PUT (never silently defaulted beyond the DB's initial
  `0`). Proposed caps (final lengths are `database-architect`'s call — ADR §2.8 explicitly deferred them):
  `venueName` ≤200, `venueArea` ≤200, `specialRequests` ≤1000.
- Precondition: `booking.status = 'confirmed'`. No time-based edit cutoff in v1 (`EVT-06`'s 3-day cutoff is
  `LATER`, not committed by product-spec) — editable any time the booking is `confirmed`, including after the
  event.
- `consent_updated_at` is stamped only when the value actually *changes* from its previously stored value; a
  consent change is also written to `booking_events` (ADR §2.7: "every change is written").
- Response `200`: the saved `eventProfile`, same shape as §3.D.1.
- Errors: `400 INVALID_REQUEST_BODY`, `400 FIELD_TOO_LONG` (with `details[]`, e.g.
  `[{"field":"venueName","issue":"TOO_LONG"}]` — this is the endpoint that demonstrates the optional `details`
  array earning its keep, §1.2), `400 INVALID_TIME_FORMAT`, `401 UNAUTHORIZED`, `403 EMAIL_NOT_VERIFIED`,
  `404 BOOKING_NOT_FOUND`, `405`, `409 BOOKING_NOT_CONFIRMED`, `500 INTERNAL_ERROR`.

---

### 3.E Gallery (admin create/upload/publish/delete; customer list/view/select/submit; admin export)

#### 3.E.1 `POST /api/admin/bookings/{bookingId}/gallery` (AD) — NEW
Body: `{"quotaOverride": 40}` (optional, exact keys — only key allowed). When present it always wins
(`quota_source='admin'`); otherwise the server computes from `packageSnapshot.album.photoCount`
(`quota_source='package'`) or the coverage-only default (`quota_source='coverage_default'`, proposed 30,
`U11` unresolved) or, if the snapshot cannot be parsed and no override was given, `409 QUOTA_REQUIRED`.
Preconditions: `status='confirmed'`, today (Riyadh) ≥ `eventDate`, no existing gallery for this booking.
Response `201`: `{"ok": true, "gallery": {"id": "…", "status": "draft", "quota": 30, "quotaSource": "package", "createdAt": "…Z"}}`.
Errors: `400 INVALID_REQUEST_BODY`, `401/403` (admin chain), `404 BOOKING_NOT_FOUND`, `405`,
`409 GALLERY_ALREADY_EXISTS`, `409 BOOKING_NOT_CONFIRMED`, `409 EVENT_NOT_YET_HELD`, `409 QUOTA_REQUIRED`,
`500`. Idempotent: `UNIQUE(booking_id)` on `galleries` makes a second create `409 GALLERY_ALREADY_EXISTS` —
client should treat that as "already exists" and `GET` it instead of retrying blindly.

#### 3.E.2 `DELETE /api/admin/bookings/{bookingId}/gallery` (AD) — NEW
Only while `status='draft'`. Response `200` always: `{"ok": true, "deleted": true|false}` — `false` when no
gallery exists (or it was already deleted), matching the **existing** `DELETE /api/admin/blocked-dates/{date}`
convention of "200 with a boolean, never 404 on a no-op delete" exactly. If a gallery exists but is **not**
`draft`, that is a genuine error, not a no-op: `409 GALLERY_NOT_DRAFT`. R2 objects are not deleted
synchronously; the weekly orphan-sweep (ADR §2.2) reclaims them once the D1 rows are gone.
Errors: `401/403`, `405`, `409 GALLERY_NOT_DRAFT`, `500`.

#### 3.E.3 `PATCH /api/admin/bookings/{bookingId}/gallery` (AD) — NEW ("publish", extend deadline, reopen)
Body (exact keys, ≥1 required): `{"status": "open", "selectionDeadline": "2026-…Z", "reason": "…"}`.
- `status: "open"` from `draft` = **publish**: requires ≥1 photo (`409 GALLERY_EMPTY` otherwise), stamps
  `opened_at`, defaults `selectionDeadline` to `now + 14 days` (D5) if omitted.
- `status: "open"` from `locked` = **reopen for correction** (`GAL-11`, `LATER` — contract defined now):
  requires `reason` (`400 REASON_REQUIRED` otherwise), logged to `booking_events`.
- `status: "open"` from `open` (already open): idempotent no-op success, `200`, unless `selectionDeadline` is
  also supplied, in which case it is a normal deadline extension (re-arms selection reminders through the new
  anchor, ADR §2.2).
- Any other source/target combination: `409 INVALID_GALLERY_TRANSITION`.
Response `200`: the updated gallery (§3.E.10 shape). Errors as above + `401/403`, `404 GALLERY_NOT_FOUND`,
`405`, `500`.

#### 3.E.4 `POST /api/admin/bookings/{bookingId}/gallery/photos` (AD) — NEW, one file per call
Multipart parts: `preview` (binary, required, ≤1.5 MiB, sniffed JPEG/WebP), `thumbnail` (binary, required,
≤256 KiB, sniffed JPEG/WebP), `originalFilename` (text, required, 1–200 chars), `width`/`height` (text
integers, required, >0) — both images and dimensions are already produced client-side by the admin's browser
resize worker (ADR §2.3); the Worker never resizes. `Content-Length` required, capped generously above
1.5 MiB + 256 KiB + multipart overhead.
Preconditions: `gallery.status IN ('draft','open')`, photo count < 1,000 (`409 PHOTO_LIMIT_REACHED`).
**Idempotency (natural, filename-keyed):** `UNIQUE(gallery_id, original_filename)` — a repeat upload of the
same `originalFilename` is caught and returns the **existing** row unchanged, `200` (not `201`); a genuinely
new filename returns `201`. This exactly matches ADR §2.3: "a re-upload is a no-op," letting a bulk upload
resume cleanly after an interruption.
Response: `{"ok": true, "photo": {"id": "…", "originalFilename": "…", "width": 4032, "height": 3024, "sortOrder": 12, "createdAt": "…Z"}}`.
Errors: `400/401/403/404`, `405`, `409 GALLERY_NOT_ACCEPTING_PHOTOS` (locked/purged), `409
PHOTO_LIMIT_REACHED`, `411`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `415
UNSUPPORTED_FILE_TYPE`, `500`.

#### 3.E.5 `GET /api/admin/bookings/{bookingId}/gallery/photos` (AD) — NEW
Cursor list (§1.7: default 60, max 200), admin management view. Each item includes her **live** selection
state so the admin can "see her live favourite/selection count" (product-spec `3.7`) without a second call:
```json
{ "id": "…", "originalFilename": "IMG_2845.webp", "previewUrl": "/api/media/g/…/p?e=…&s=…", "thumbUrl": "/api/media/g/…/t?e=…&s=…", "width": 4032, "height": 3024, "isSelected": true, "isFavourite": false }
```
Response wrapper: `{"ok": true, "photos": [...], "nextCursor": "…" | null}`. Errors: `401/403`, `404
GALLERY_NOT_FOUND`, `405`, `500`.

#### 3.E.6 `DELETE /api/admin/bookings/{bookingId}/gallery/photos/{photoId}` (AD) — NEW
Only while `gallery.status='draft'` (ADR §2.4: "delete them only while draft"). Same `deleted:boolean`,
never-404 pattern as §3.E.2: not found → `200 {"deleted": false}`; found but gallery not `draft` →
`409 GALLERY_NOT_DRAFT`; found and draft → delete, `200 {"deleted": true}`.

#### 3.E.7 `GET /api/admin/bookings/{bookingId}/gallery/selection` (AD) — NEW, the Lightroom export
Only once `gallery.status = 'locked'` (else `409 GALLERY_NOT_LOCKED`). Response `200`:
`{"ok": true, "filenames": ["IMG_2845.webp", "2M4A4068.avif", …]}`, ordered by `sort_order`. Not paginated
(§1.7 — bounded ≤500, must be complete for the admin's offline matching workflow). Filenames are for the
admin's eyes only — never used in a URL or a log anywhere in this system.

#### 3.E.8 `GET /api/bookings/{bookingId}/gallery` (CO) — NEW
`200` always (booking exists and is hers): `{"ok": true, "gallery": null | {...}, "serverTime": "…Z"}`.
`gallery` is `null` whenever there is nothing to show her yet — **no gallery row at all, or one that is still
`draft`, are indistinguishable to her on purpose** (she should never learn a gallery exists before it is
published — a deliberate privacy property, not an oversight). Once published:
```json
{ "id": "…", "status": "open", "quota": 30, "quotaSource": "package", "selectionDeadline": "…Z", "selectedCount": 12, "favouriteCount": 27 }
```
After the retention window purges it (`HND-10`, "no silent 404"): `{"status": "purged", "purgedAt": "…Z"}` —
so the `privacy_cleanup` stage view can render the explanation copy instead of a blank error.
Errors: `401 UNAUTHORIZED`, `403 EMAIL_NOT_VERIFIED`, `404 BOOKING_NOT_FOUND`, `405`, `500`.

#### 3.E.9 `GET /api/bookings/{bookingId}/gallery/photos` (CO) — NEW
Cursor list (§1.7). Always `200`, given the booking is hers — returns `{"photos": [], "nextCursor": null}`
when the gallery does not exist, is `draft`, or is `purged` (the client already knows this from §3.E.8 and
should not call this endpoint in that state, but a defensive empty list keeps this endpoint simple and safe
regardless). Each item (no `originalFilename` — never shown to the customer, minimisation):
```json
{ "id": "…", "previewUrl": "/api/media/g/…/p?e=…&s=…", "thumbUrl": "/api/media/g/…/t?e=…&s=…", "isSelected": false, "isFavourite": true }
```

#### 3.E.10 `POST /api/bookings/{bookingId}/gallery/selection` (CO) — NEW, the auto-save endpoint
Request: `{"ops": [{"photoId": "…", "field": "selected", "value": true}, …]}`, 1–50 ops per call (ADR §2.4).
Every op is a **"set," not a "toggle"** — inherently idempotent; re-sending the same op array twice produces
the same end state. Preconditions checked once for the whole request: `gallery.status = 'open'`, else
`409 GALLERY_NOT_OPEN` for the entire call (not per-op — every op would fail identically, so one clear code is
better than 50 repeated ones). `gallery` not found at all → `404 GALLERY_NOT_FOUND`.
Each op is then applied with its own conditional SQL statement (an `INSERT OR IGNORE` base row + a quota-bound
`UPDATE`), so two open tabs can never jointly push her over quota (ADR §2.4 — this is enforced at the SQL
level, not by this endpoint's request validation). Response is always `200` with **per-op results**, never a
top-level error for a refused individual op:
```json
{
  "ok": true,
  "results": [
    { "photoId": "…", "field": "selected", "applied": true, "reason": "applied" },
    { "photoId": "…", "field": "selected", "applied": false, "reason": "quota_reached" }
  ],
  "counts": { "selected": 30, "favourite": 41, "quota": 30 }
}
```
`reason` is one of `applied` (including a harmless no-op re-set), `quota_reached`, `not_found` (photo does not
belong to this gallery). These are **machine-readable tokens** — the frontend maps them to the Arabic copy
already written in `08-copy-ar.md` §5.2 (*"وصلتِ إلى العدد المتاح…"*), so the response body stays compact
across up to 50 ops rather than repeating Arabic prose per op.
Errors (request-shape/state level only): `400 INVALID_REQUEST_BODY` (0 or >50 ops, malformed op), `401/403`,
`404 BOOKING_NOT_FOUND` / `404 GALLERY_NOT_FOUND`, `405`, `409 GALLERY_NOT_OPEN`, `500`.

#### 3.E.11 `POST /api/bookings/{bookingId}/gallery/submit` (CO) — NEW
Body must be exactly `{}` (`Content-Type: application/json` required — kept strict, consistent with every
other endpoint here, rather than a bodyless POST). Requires `selectedCount === quota` exactly (`GAL-07`).
`UPDATE galleries SET status='locked' WHERE status='open' AND … AND selected_count = quota`, guarded the same
way every status transition in this app is guarded.
Response `200`: `{"ok": true, "gallery": {"id": "…", "status": "locked", "submittedAt": "…Z", "selectedCount": 30, "quota": 30}}`.
**Idempotent:** if already `locked` (her own earlier successful submit), responds `200` with the same shape —
not an error — so a retry after a lost response is silently safe.
Errors: `400 INVALID_REQUEST_BODY` (non-empty body), `401/403`, `404 BOOKING_NOT_FOUND` / `GALLERY_NOT_FOUND`,
`405`, `409 GALLERY_NOT_OPEN` (still `draft`), `409 SELECTION_INCOMPLETE` (open but count ≠ quota — response
includes `details: [{"field":"selectedCount","issue":"…"}]` style info via the message, e.g. *"لم يكتمل عدد
الصور المختارة بعد. اختاري 30 صورة بالضبط لتأكيد اختياركِ."*), `500`.

---

### 3.F Album production status

#### 3.F.1 `PATCH /api/admin/bookings/{bookingId}/album` (AD) — NEW
Body (exact keys, one required): `{"stage": "printing"}`, one of `design`/`printing`/`ready`. Upserts
`album_production` (first call creates the row). No monotonicity enforced — admin may correct a typo backward;
inventing a strict forward-only rule the spec never states would be adding an un-asked-for business rule.
Response `200`: `{"ok": true, "album": {"bookingId": "…", "stage": "printing", "stageUpdatedAt": "…Z"}}`.
Idempotent: setting the same stage again is a harmless no-op, still `200`.
Errors: `400 INVALID_REQUEST_BODY`, `401/403`, `404 BOOKING_NOT_FOUND`, `405`, `409 BOOKING_NOT_CONFIRMED`,
`500`. **Customer view:** no separate endpoint — the journey `stage`/`stageLabel` fields on
`GET /api/bookings/me` (§3.A) already distinguish `album_design`/`album_printing`/`album_ready` as three of
the 15 stage ids; a second, separate field would be redundant with the value the frontend's `stage-views`
registry (ADR §2.6) already keys off of.

---

### 3.G Handover: admin-managed slots, customer booking/reschedule, and the WhatsApp payload

#### 3.G.1 `POST /api/admin/handover-slots` (AD) — NEW
Body (exact keys): `{"slotDate": "2026-11-02", "startsAt": "…Z", "endsAt": "…Z", "method": "pickup", "capacity": 2}`.
`method` ∈ `pickup`/`delivery`/`both`; `capacity` optional, default 1, range 1–20 (ADR §2.8). Validates
`endsAt > startsAt` (`400 INVALID_TIME_RANGE`) and that `slotDate` matches `startsAt`'s Riyadh calendar date.
No past-date restriction on **creation** (an admin data-entry tool should not block backdated record-keeping;
the customer-facing listing already excludes past slots by construction, §3.G.5).
Response `201`: the created slot. **Idempotent** via `UNIQUE(starts_at, method)`: an identical retry gets
`409 SLOT_ALREADY_EXISTS` — treat as "already created," `GET` the list instead of retrying.
Errors: `400 INVALID_REQUEST_BODY`, `400 INVALID_TIME_RANGE`, `401/403`, `405`, `409 SLOT_ALREADY_EXISTS`,
`500`.

#### 3.G.2 `GET /api/admin/handover-slots` (AD) — NEW
`from`/`to` **required** (§1.7 — mirrors the exact existing `/api/admin/blocked-dates` behaviour, including
reusing `400 MISSING_DATE_RANGE` verbatim for consistency), max range 90 days.
Response: `{"ok": true, "range": {"from": "…", "to": "…"}, "slots": [{"id": "…", "slotDate": "…", "startsAt": "…Z", "endsAt": "…Z", "method": "pickup", "capacity": 2, "isActive": true, "bookedCount": 1, "createdAt": "…Z"}]}`.
`bookedCount` (admin-only) = count of `status='scheduled'` handovers referencing this slot, so the admin sees
fill-rate at a glance without a second call. Errors: `400 MISSING_DATE_RANGE`, `400 INVALID_DATE`,
`400 INVALID_DATE_RANGE`, `400 DATE_RANGE_TOO_LARGE`, `401/403`, `405`, `500`.

#### 3.G.3 `PATCH /api/admin/handover-slots/{slotId}` (AD) — NEW
Body (exact keys, ≥1 required): `{"startsAt", "endsAt", "method", "capacity", "isActive"}`, all optional.
Lowering `capacity` below the current `bookedCount` → `409 CAPACITY_BELOW_BOOKED`. Response `200`: updated
slot. Idempotent: re-sending the same values is a harmless no-op.
Errors: `400 INVALID_REQUEST_BODY`, `400 INVALID_TIME_RANGE`, `401/403`, `404 SLOT_NOT_FOUND`, `405`,
`409 CAPACITY_BELOW_BOOKED`, `500`.

#### 3.G.4 `DELETE /api/admin/handover-slots/{slotId}` (AD) — NEW
Same `deleted:boolean`/never-404 pattern (§3.E.2). Not found (or already deleted) → `200 {"deleted": false}`.
Found with **zero** handover rows ever referencing it → hard delete, `200 {"deleted": true}`. Found with **any**
handover reference (any status) → `409 SLOT_HAS_BOOKINGS` (*"لا يمكن حذف موعد لديه حجوزات. يمكنكِ إلغاء
تفعيله بدلاً من ذلك."*) — matches ADR §2.5 exactly: "a slot that has bookings cannot be deleted; it can only be
deactivated" (via `PATCH … {"isActive": false}`, §3.G.3).

#### 3.G.5 `GET /api/bookings/{bookingId}/handover/slots` (CO) — NEW
Query: `method` (optional filter, `pickup`/`delivery`), `from`/`to` (optional, default today..+30d, max range
90 days — same shape as §3.G.2). Precondition: `booking.status='confirmed'` and `album_production.stage='ready'`,
else `409 NOT_READY_FOR_HANDOVER`. Only `isActive`, future (`startsAt > now`), method-compatible
(slot `method='both'` matches either query), **and not full** slots are returned — full slots are **excluded
entirely**, not shown with `remainingCapacity: 0` (simpler UX, and does not expose internal capacity numbers).
Response: `{"ok": true, "range": {...}, "slots": [{"id": "…", "slotDate": "…", "startsAt": "…Z", "endsAt": "…Z", "method": "pickup", "remainingCapacity": 1}]}`.
Errors: `400` (date-range family, same codes as §3.G.2), `401/403`, `404 BOOKING_NOT_FOUND`, `405`,
`409 NOT_READY_FOR_HANDOVER`, `500`.

#### 3.G.6 `GET /api/bookings/{bookingId}/handover` (CO) — NEW
`200` always (booking exists, hers): `{"ok": true, "handover": null | {...}}` — same "`null` = not booked yet,
not an error" pattern as §3.D.1/§3.E.8. Once booked:
```json
{ "method": "delivery", "slot": { "id": "…", "slotDate": "2026-11-02", "startsAt": "…Z", "endsAt": "…Z" }, "deliveryAddress": "…", "status": "scheduled", "bookedAt": "…Z", "completedAt": null }
```
This is also the endpoint the WhatsApp button reads (§3.G.9). Errors: `401 UNAUTHORIZED`,
`403 EMAIL_NOT_VERIFIED`, `404 BOOKING_NOT_FOUND`, `405`, `500`.

#### 3.G.7 `POST /api/bookings/{bookingId}/handover` (CO) — NEW, book a slot
Body (exact keys): `{"slotId": "…", "method": "delivery", "deliveryAddress": "…"}`. `deliveryAddress`
required (≤500 chars) iff `method='delivery'` (`400 DELIVERY_ADDRESS_REQUIRED` if missing); must be
omitted/`null` when `method='pickup'` (a non-null value there is `400 INVALID_REQUEST_BODY`).
Preconditions: `status='confirmed'`, `album_production.stage='ready'`, target slot exists/`isActive`/future/
method-compatible with capacity remaining.
**Idempotency (natural, via `handovers.booking_id` as primary key):** conditional
`INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM handovers WHERE booking_id=?) AND …capacity check…`. A
retry that lands after an earlier success finds the PK already taken (0 rows inserted); the handler then reads
the current row: if `slotId` matches the request → `200` idempotent success (same shape as `201`); if it does
**not** match → `409 ALREADY_BOOKED` with the current slot info, directing the client to
`PATCH .../handover` (§3.G.8) instead.
Response `201` (first booking) / `200` (idempotent retry): same shape as §3.G.6's non-null case.
Errors: `400 INVALID_REQUEST_BODY`, `400 DELIVERY_ADDRESS_REQUIRED`, `401/403`, `404 BOOKING_NOT_FOUND`,
`404 SLOT_NOT_FOUND`, `405`, `409 NOT_READY_FOR_HANDOVER`, `409 SLOT_UNAVAILABLE`
(*"هذا الموعد لم يعد متاحًا، يرجى اختيار موعد آخر."* — reused verbatim from `08-copy-ar.md` §6.5), `409
SLOT_FULL`, `409 ALREADY_BOOKED`, `500`.

#### 3.G.8 `PATCH /api/bookings/{bookingId}/handover` (CO) — NEW, reschedule
**Ships with `HND-07`, marked `LATER` by product-spec — contract defined now, per this run's explicit brief,
so the endpoint exists on paper before a later run builds it.** Body: `{"toSlotId": "…"}`. Precondition:
`handover.status='scheduled'`, today (Riyadh) < the **current** slot's `slotDate` ("before the original
passes," `HND-07`), new slot valid/active/future/capacity-available and **same method as already chosen** —
switching `pickup`↔`delivery` is out of scope for this endpoint in v1; she is directed to WhatsApp for that
edge case rather than this contract inventing a method-switch+new-address flow no spec asked for.
Idempotent: retry with the same `toSlotId` when it is already her current slot → `200` no-op success.
Errors: `400 INVALID_REQUEST_BODY`, `401/403`, `404 BOOKING_NOT_FOUND`, `404 HANDOVER_NOT_FOUND`,
`404 SLOT_NOT_FOUND`, `405`, `409 RESCHEDULE_WINDOW_CLOSED`, `409 SLOT_UNAVAILABLE`, `409 SLOT_FULL`,
`409 HANDOVER_ALREADY_COMPLETED`, `500`.

#### 3.G.9 `PATCH /api/admin/bookings/{bookingId}/handover` (AD) — NEW, complete / reassign
Body (exact keys, ≥1 required): `{"status": "completed", "slotId": "…"}`. `slotId` lets the admin reassign
without the customer-side window restriction (full discretion) but still checks the target slot is
active/future/has capacity. `status: "completed"` stamps **both** `handovers.completed_at` and
`booking_requests.completed_at` (ADR §2.5) and starts the retention clock (§7.6). Marking an already-completed
handover `completed` again is a harmless idempotent no-op (`completed_at` is not overwritten), `200`.
Errors: `400 INVALID_REQUEST_BODY`, `401/403`, `404 BOOKING_NOT_FOUND`/`HANDOVER_NOT_FOUND`/`SLOT_NOT_FOUND`,
`405`, `409 SLOT_UNAVAILABLE`, `409 SLOT_FULL`, `409 HANDOVER_ALREADY_COMPLETED` (attempting to change
`slotId` on a completed handover), `500`.

#### 3.G.10 The final WhatsApp payload — fields, not an endpoint
Per the architecture (ADR §2.5) the message is built **client-side** in `src/lib/whatsapp.ts` and opened via
`wa.me`, never sent through this API — there is no server-side "send WhatsApp" endpoint, matching the existing
pattern used everywhere else in the app. What this contract guarantees is that every field either template
needs is available from data the client already has after calling §3.G.6 and §3.A:

| Field | Source |
|---|---|
| Booking reference | `booking.id` (already returned by every booking endpoint) |
| Customer first name | Already available client-side from the auth/profile context |
| Method (pickup/delivery) label | `handover.method` (§3.G.6) |
| Slot date + start/end time, formatted to Riyadh local | `handover.slot.slotDate`/`startsAt`/`endsAt` (§3.G.6) |
| Delivery address (delivery only) | `handover.deliveryAddress` (§3.G.6) |

**Note for the frontend team, not a decision made here:** `05-adr-architecture.md` §2.5 and `08-copy-ar.md` §7
(rows 12–13) propose two *different* exact wordings for this message. Resolving which wording ships is a copy
decision, not an API contract decision — this document only guarantees the fields above exist and are typed
consistently; either template can be built from them without a further backend change.

---

### 3.H Feedback

#### 3.H.1 `POST /api/bookings/{bookingId}/feedback` (CO) — NEW
Body (exact keys): `{"rating": 5, "comment": "…"}` — `rating` integer 1–5 required, `comment` optional
≤1000 chars. Precondition: `handover.status='completed'`, else `409 NOT_YET_HANDED_OVER`.
**Idempotency (compare-on-retry, since this is a genuinely one-time submission, not a "set"):** first
submission → `201`. A retry with **identical** `rating`/`comment` → `200`, unchanged, idempotent success. A
retry with **different** values (a genuine second, different opinion) → `409 FEEDBACK_ALREADY_SUBMITTED` —
by design she cannot silently overwrite her rating after the fact; nothing in the spec asks for editable
feedback.
Response: `{"ok": true, "feedback": {"rating": 5, "comment": "…", "submittedAt": "…Z"}}`.
Errors: `400 INVALID_REQUEST_BODY`, `401/403`, `404 BOOKING_NOT_FOUND`, `405`, `409 NOT_YET_HANDED_OVER`,
`409 FEEDBACK_ALREADY_SUBMITTED`, `500`. Never auto-published anywhere (`D7`, `HND-09`) — admin-read-only, no
publish endpoint exists in this contract.

#### 3.H.2 `GET /api/bookings/{bookingId}/feedback` (CO) — NEW
`200` always: `{"ok": true, "feedback": null | {...}}`. Errors: `401 UNAUTHORIZED`, `403 EMAIL_NOT_VERIFIED`,
`404 BOOKING_NOT_FOUND`, `405`, `500`.

---

### 3.I `GET /api/admin/bookings/{bookingId}` and `GET /api/admin/bookings` — CHANGED, additive only

Both keep their exact existing path, method, auth, query parameters (for the list endpoint: `status`, `from`,
`to`, `limit` — all unchanged), and every existing field. `src/api/admin.ts`'s `isAdminBookingDetail`/
`isAdminBookingSummary` guards check only that known fields are present and typed correctly — no
`Object.keys().length` check — so, exactly as in §3.A, extra fields are structurally invisible to the current
client and safe to add (verified by direct read of `app/src/api/admin.ts`).

**New fields on `AdminBookingSummary`** (list view — kept lean): `flowVersion`, `stage`, `stageDeadline` (same
meaning as §3.A).

**New fields on `AdminBookingDetail`** (single-booking view — the "new sections inside the existing booking
detail panel" the ADR's touchpoint table calls for): `flowVersion`, `depositAmount`, `termsVersion`,
`termsAcceptedAt`, `completedAt`, `stage`, `stageLabel`, `stageDeadline`, and four convenience summary objects
so the admin's one-page detail view needs no further round-trips for a quick glance (full detail still comes
from each feature's own dedicated endpoint when the admin opens that section):
- `latestReceipt`: `{id, status, uploadedAt, byteSize, contentType, reviewedAt, reviewedBy, rejectionReason} | null`
- `eventProfile`: same shape as §3.D.1's `eventProfile`, or `null`
- `gallery`: `{id, status, quota, quotaSource, selectedCount, favouriteCount, selectionDeadline} | null`
- `handover`: same shape as §3.G.6's `handover`, or `null`
- `feedback`: same shape as §3.H.2's `feedback`, or `null`

No new query filters on the list endpoint (e.g. filter-by-`stage`) are added by this contract — flagged as a
possible future additive enhancement, not built here (§7.9).

---

## 4. Existing `app/src/api/` clients — confirmed impact

Only two files exist under `app/src/api/` today (verified by direct listing): `bookings.ts` and `admin.ts`.

| File | Endpoints it calls that changed | Why it keeps working, unmodified |
|---|---|---|
| `app/src/api/bookings.ts` | `GET /api/bookings/me` (§3.A) | `isMyBookingsResponse`/`isCustomerBooking` validate only known fields, never reject extra ones (confirmed by direct read). It will not see `flowVersion`/`stage`/etc. until a later run's client update, but it will not *break* either. |
| `app/src/api/admin.ts` | `GET /api/admin/bookings` and `GET /api/admin/bookings/{bookingId}` (§3.I); `POST /api/admin/bookings/{bookingId}/actions` (§3.B.4) | Same non-exact-key response validation as above. `isAdminBookingAction` is checked against `adminBookingActions` **imported directly from `shared/admin.ts`** (not a duplicated list) — so the two new action values are recognised automatically with **zero edits to this file**. The request-body type `AdminBookingActionRequest` gains the optional `extendHours` field; existing call sites that never set it are unaffected (TypeScript structural typing — an unset optional field is valid). |

**No existing `app/src/api/` file calls any of the 27 brand-new endpoints** — those need new client wrappers,
which per `05-adr-architecture.md` §2.6 belong under `app/src/features/<feature>/` (component + CSS + API
wrapper + helpers, one folder per feature: `receipt/`, `event-profile/`, `gallery/`, `admin-gallery/`,
`handover/`, `admin-handover/`, `feedback/`, `admin-receipt/`), **not** under `app/src/api/` — noted here so a
later run does not accidentally split the convention.

**Breaking changes in this document: none.**

---

## 5. Three example request/response pairs

### 5.1 Success — uploading a deposit receipt
```http
POST /api/bookings/8f14e45f-ceea-4c9a-b1a2-3e9c1d9e0a11/receipt HTTP/1.1
Authorization: Bearer eyJhbGciOi...
Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryAbc123
Content-Length: 812441

------WebKitFormBoundaryAbc123
Content-Disposition: form-data; name="file"; filename="receipt.jpg"
Content-Type: image/jpeg

<binary JPEG bytes>
------WebKitFormBoundaryAbc123
Content-Disposition: form-data; name="termsVersion"

2026-09-1
------WebKitFormBoundaryAbc123
Content-Disposition: form-data; name="termsAccepted"

true
------WebKitFormBoundaryAbc123--
```
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "ok": true,
  "booking": {
    "id": "8f14e45f-ceea-4c9a-b1a2-3e9c1d9e0a11",
    "status": "payment_pending",
    "holdExpiresAt": "2026-11-05T09:00:00.000Z"
  },
  "receipt": {
    "id": "b2b7b7e2-2e2b-4a6a-9b5e-1c2d3e4f5061",
    "status": "pending",
    "uploadedAt": "2026-11-03T09:12:44.000Z"
  }
}
```

### 5.2 Validation error — questionnaire field too long
```http
PUT /api/bookings/8f14e45f-ceea-4c9a-b1a2-3e9c1d9e0a11/event-profile HTTP/1.1
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{
  "venueName": "قاعة الأفراح الكبرى في حي النخيل بالقرب من التقاطع الرئيسي خلف مجمع المحلات التجارية الجديد والمواقف العامة المخصصة للزوار في المدينة المنورة، طريق الأمير عبدالمجيد",
  "venueArea": "المدينة المنورة",
  "startTime": "16:30",
  "specialRequests": null,
  "publishingConsent": false
}
```
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "ok": false,
  "error": {
    "code": "FIELD_TOO_LONG",
    "message": "أحد الحقول يتجاوز الحد الأقصى المسموح به لعدد الأحرف.",
    "details": [
      { "field": "venueName", "issue": "TOO_LONG" }
    ]
  }
}
```

### 5.3 Auth error — expired/missing token on a customer-owner endpoint
```http
POST /api/bookings/8f14e45f-ceea-4c9a-b1a2-3e9c1d9e0a11/gallery/selection HTTP/1.1
Content-Type: application/json

{ "ops": [{ "photoId": "c2f1...", "field": "selected", "value": true }] }
```
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
WWW-Authenticate: Bearer

{
  "ok": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "تعذر التحقق من تسجيل الدخول."
  }
}
```
(The admin-surface equivalent for the same failure returns the same status with `code: "UNAUTHENTICATED"` and
the same `WWW-Authenticate` header — the two codes are kept distinct on purpose, matching the pre-existing
split between `worker/bookings.ts` and `worker/admin-auth.ts`, see §1.5.)

---

## 6. Master error-code reference
Every code below maps to exactly one HTTP status, everywhere it is used in this document. Codes not listed
here (`UNAUTHORIZED`, `UNAUTHENTICATED`, `EMAIL_NOT_VERIFIED`, `FORBIDDEN`, `BOOKING_NOT_FOUND`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `INVALID_STATUS_TRANSITION`, `INVALID_REQUEST_BODY`, `INTERNAL_ERROR`) are **reused
unchanged** from the existing API for the same meaning.

| Code | Status | Arabic message (customer-facing, feminine singular) |
|---|---|---|
| `TERMS_VERSION_MISMATCH` | 400 | تم تحديث شروط الحجز. يرجى مراجعتها والموافقة عليها مرة أخرى قبل المتابعة. |
| `NOTE_REQUIRED` | 400 | يجب إدخال سبب لهذا الإجراء. |
| `FIELD_TOO_LONG` | 400 | أحد الحقول يتجاوز الحد الأقصى المسموح به لعدد الأحرف. |
| `INVALID_TIME_FORMAT` | 400 | صيغة الوقت غير صحيحة. الرجاء استخدام الصيغة HH:MM. |
| `DELIVERY_ADDRESS_REQUIRED` | 400 | يجب إدخال عنوان التوصيل. |
| `INVALID_TIME_RANGE` | 400 | يجب أن يكون وقت النهاية بعد وقت البداية. |
| `INVALID_MEDIA_KEY` | 400 | رابط الملف غير صحيح. |
| `LENGTH_REQUIRED` | 411 | يجب أن يتضمّن الطلب حجم الملف. أعيدي المحاولة. |
| `FILE_TOO_LARGE` | 413 | حجم الملف أكبر من الحد المسموح به. |
| `UNSUPPORTED_FILE_TYPE` | 415 | صيغة الملف غير مدعومة. |
| `SIGNATURE_INVALID` | 403 | انتهت صلاحية هذا الرابط أو أنه غير صالح. |
| `MEDIA_NOT_FOUND` | 404 | تعذر العثور على هذا الملف. |
| `HOLD_EXPIRED` | 409 | انتهت مهلة الحجز المؤقت لهذا التاريخ. تواصلي معنا عبر واتساب إن رغبتِ في المتابعة. |
| `RECEIPT_ALREADY_PENDING` | 409 | لديكِ إيصال قيد المراجعة بالفعل لهذا الحجز. |
| `NO_PENDING_RECEIPT` | 409 | لا يوجد إيصال قيد المراجعة حاليًا لرفضه. |
| `LEGACY_FLOW_NOT_SUPPORTED` | 409 | هذا الحجز يتبع مسارًا سابقًا، ويُدار عبر التواصل المباشر معكِ. |
| `BOOKING_NOT_CONFIRMED` | 409 | هذا الإجراء متاح فقط للحجوزات المؤكدة. |
| `GALLERY_NOT_FOUND` | 404 | لم يتم العثور على معرض الصور. |
| `GALLERY_ALREADY_EXISTS` | 409 | يوجد معرض صور لهذا الحجز بالفعل. |
| `EVENT_NOT_YET_HELD` | 409 | لا يمكن إنشاء معرض الصور قبل موعد المناسبة. |
| `QUOTA_REQUIRED` | 409 | يلزم تحديد عدد الصور المسموح به يدويًا لهذا الحجز. |
| `GALLERY_NOT_DRAFT` | 409 | لا يمكن حذف هذا العنصر بعد نشر المعرض للعميلة. |
| `GALLERY_EMPTY` | 409 | لا يمكن نشر معرض لا يحتوي على أي صور. |
| `INVALID_GALLERY_TRANSITION` | 409 | لا يمكن تنفيذ هذا التغيير على حالة المعرض الحالية. |
| `REASON_REQUIRED` | 400 | يجب إدخال سبب لإعادة فتح المعرض. |
| `PHOTO_LIMIT_REACHED` | 409 | تم الوصول إلى الحد الأقصى لعدد الصور في هذا المعرض. |
| `GALLERY_NOT_ACCEPTING_PHOTOS` | 409 | لا يمكن إضافة صور لهذا المعرض في حالته الحالية. |
| `GALLERY_NOT_OPEN` | 409 | معرض صوركِ غير متاح للاختيار في الوقت الحالي. |
| `GALLERY_NOT_LOCKED` | 409 | لا يمكن تصدير الاختيار قبل قفل المعرض. |
| `SELECTION_INCOMPLETE` | 409 | لم يكتمل عدد الصور المختارة بعد. اختاري {quota} صورة بالضبط لتأكيد اختياركِ. |
| `NOT_READY_FOR_HANDOVER` | 409 | لم يصبح ألبومكِ جاهزًا للاستلام بعد. |
| `SLOT_NOT_FOUND` | 404 | لم يتم العثور على الموعد المطلوب. |
| `SLOT_UNAVAILABLE` | 409 | هذا الموعد لم يعد متاحًا، يرجى اختيار موعد آخر. |
| `SLOT_FULL` | 409 | اكتمل عدد الحجوزات لهذا الموعد. يرجى اختيار موعد آخر. |
| `SLOT_ALREADY_EXISTS` | 409 | يوجد موعد مطابق لنفس التوقيت والطريقة بالفعل. |
| `SLOT_HAS_BOOKINGS` | 409 | لا يمكن حذف موعد لديه حجوزات. يمكنكِ إلغاء تفعيله بدلاً من ذلك. |
| `CAPACITY_BELOW_BOOKED` | 409 | لا يمكن تخفيض عدد المقاعد إلى أقل من عدد الحجوزات الحالية على هذا الموعد. |
| `ALREADY_BOOKED` | 409 | لديكِ موعد استلام محجوز بالفعل لهذا الحجز. |
| `RESCHEDULE_WINDOW_CLOSED` | 409 | لم يعد بالإمكان تعديل هذا الموعد. تواصلي معنا عبر واتساب. |
| `HANDOVER_NOT_FOUND` | 404 | لم يتم العثور على موعد استلام لهذا الحجز. |
| `HANDOVER_ALREADY_COMPLETED` | 409 | تم تسليم الألبوم بالفعل، ولا يمكن تعديل هذا الموعد. |
| `NOT_YET_HANDED_OVER` | 409 | يمكن إرسال التقييم بعد استلام الألبوم فقط. |
| `FEEDBACK_ALREADY_SUBMITTED` | 409 | تم إرسال تقييمكِ لهذا الحجز بالفعل. |

Admin-facing messages for the same codes (e.g. `SLOT_HAS_BOOKINGS`, `GALLERY_EMPTY`) are neutral/instructional
rather than bride-addressed, matching the existing tone split between customer- and admin-surface strings.

---

## 7. Unresolved — for the owner or another agent, each with a proposed default

1. **D4 — deposit amount rule + bank details** (owner). Blocks `deposit.amount`/`deposit.bankDetails` in
   §3.B.1 from ever being populated with a real value. *Proposed default:* the figure already proposed in
   `01-product-spec.md` §12.1 (20% of the total, rounded up to the next SAR 50) — **I am not re-proposing a
   number of my own**, only citing the existing proposal; bank details have no safe default and must come from
   the owner before `POST /api/bookings/{bookingId}/receipt` can go live.
2. **U6 — terms text** (owner or counsel), for `terms.text` in §3.B.1. *Proposed default:* the plain
   operational summary already drafted in `08-copy-ar.md` §3.5, explicitly not a substitute for lawyer-drafted
   text.
3. **U11 — coverage-only gallery quota** (owner), for `quotaSource: 'coverage_default'` in §3.E.1.
   *Proposed default:* 30, per product-spec §12.6/ADR `U11` (not yet formally approved).
4. **U19 — hard vs. soft selection deadline** (owner), affects whether §3.E.11 ever hard-blocks past the
   deadline. *Proposed default:* soft — matches the ADR's own default; `POST .../gallery/submit` never blocks
   on the deadline in this contract, only on the quota match.
5. **U13 — pickup location, delivery fee** (owner). No `fee` field exists anywhere in this contract because no
   delivery fee exists in `packages.ts` today; inventing one would violate the no-invented-prices rule.
   *Proposed default:* keep it that way (no fee field) until the owner adds one, matching `08-copy-ar.md` §6.3's
   explicit "no free-delivery promise, no invented fee" stance.
6. **U8 — `extendHours` default/bounds** (owner). *Proposed default:* 24h default, 1–168h admin-editable range,
   unlimited uses, exactly as ADR `U8` and `08-copy-ar.md` §9.2 already propose.
7. **HND-07 shipping priority** (owner/PM). §3.G.8 (`PATCH .../handover`) is contract-complete but
   product-spec marks the underlying feature `LATER`. *Proposed default:* ship the contract now (already
   done, here), implement whenever the feature is prioritized — no API change needed at that point.
8. **Admin daily queue** (`ADM-01`, `GET /api/admin/queue`) is intentionally not designed in this document
   (§0) — it is Run 8 / `W8-3` scope. *Proposed default:* a follow-up API-contracts addendum alongside that
   run, not retrofitted here.
9. **U1 — PDPL / data residency** (compliance-officer). This is an ADR-level gate (§2.7), re-flagged here
   because it directly blocks every endpoint in §3.B/§3.C/§3.E from being implementable at all (no R2 bucket
   until it is answered). *Proposed default:* unchanged from the ADR — do not build the media/receipt/gallery
   endpoints until U1 is answered.
10. **New admin-list filters** (`flowVersion`/`stage` query params on `GET /api/admin/bookings`, §3.I) —
    not added here, flagged as a possible low-priority future additive enhancement, owner/PM call.

---

## 8. OpenAPI 3.1 document

Self-contained; `description` fields point back to the §3 subsection with the full business-rule prose rather
than repeating it, so this stays a schema-correctness artifact rather than a second copy of the document above.

```yaml
openapi: 3.1.0
info:
  title: Sundus Yar — Client Portal API (redo-v2 additions)
  version: "2026-09-23-run1"
  summary: >
    New and changed /api/* contracts for online confirmation, receipts, gallery selection, album production,
    handover scheduling and feedback. Existing endpoints not listed here (/api/health, /api/availability,
    POST /api/bookings, /api/profile, the three admin blocked-dates endpoints) are unchanged.
  description: >
    See runs/redo-v2/07-api-contracts.md for full business-rule prose, the master error table, Arabic copy,
    and rationale. This document defines shapes; the Markdown defines behaviour.
servers:
  - url: /
    description: >
      Same-origin only. No Access-Control-* headers are set anywhere in this API (verified against
      worker/http.ts and every handler), which makes it same-origin-only via browser same-origin policy by
      default — preserved, not newly added, by every endpoint in this document. Production base URL is
      APP_BASE_URL (not yet configured — 00-inspection-report.md §7).
security:
  - firebaseBearer: []
components:
  securitySchemes:
    firebaseBearer:
      type: http
      scheme: bearer
      bearerFormat: "Firebase ID Token (JWT, RS256)"
      description: >
        Verified against Firebase's JWKS (jose, worker/auth.ts). customer-owner endpoints additionally scope
        every query to user_id = uid inside the SQL; admin endpoints additionally require D1 users.role='admin'.
        See §1.5 for the exact 401/403 chain per surface.
    signedMediaUrl:
      type: apiKey
      in: query
      name: s
      description: >
        NOT a static API key. `s` is a per-request HMAC-SHA256 signature over "v1\n<key>\n<e>", paired with the
        `e` (expiry) query parameter. Minted server-side only after an ownership/admin check at mint time. See
        §3.C for the exact construction. No Authorization header is read on this endpoint.
  parameters:
    bookingIdPath:
      name: bookingId
      in: path
      required: true
      schema: { type: string, minLength: 1, maxLength: 128 }
    photoIdPath:
      name: photoId
      in: path
      required: true
      schema: { type: string, format: uuid }
    slotIdPath:
      name: slotId
      in: path
      required: true
      schema: { type: string, format: uuid }
    cursorQuery:
      name: cursor
      in: query
      required: false
      schema: { type: string, description: "Opaque; pass back exactly what nextCursor returned." }
    galleryLimitQuery:
      name: limit
      in: query
      required: false
      schema: { type: integer, minimum: 1, maximum: 200, default: 60 }
    receiptLimitQuery:
      name: limit
      in: query
      required: false
      schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
    fromDateQuery:
      name: from
      in: query
      required: false
      schema: { type: string, format: date }
    toDateQuery:
      name: to
      in: query
      required: false
      schema: { type: string, format: date }
  responses:
    BadRequest:
      description: "400 — see §1.3/§6 for the exact code catalogue per endpoint."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    Unauthorized:
      description: "401 UNAUTHORIZED (customer-owner surface)."
      headers: { WWW-Authenticate: { schema: { type: string, enum: ["Bearer"] } } }
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    Unauthenticated:
      description: "401 UNAUTHENTICATED (admin surface)."
      headers: { WWW-Authenticate: { schema: { type: string, enum: ["Bearer"] } } }
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    EmailNotVerified:
      description: "403 EMAIL_NOT_VERIFIED — both surfaces."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    Forbidden:
      description: "403 FORBIDDEN — admin-role check failed."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    NotFound:
      description: "404 — booking not found/not owned, or a specific missing sub-resource; see §1.3/§6."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    MethodNotAllowed:
      description: "405 METHOD_NOT_ALLOWED."
      headers: { Allow: { schema: { type: string }, description: "Comma-separated allowed methods." } }
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    Conflict:
      description: "409 — current state forbids the action; see the endpoint's own code list in §3/§6."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    LengthRequired:
      description: "411 LENGTH_REQUIRED — Content-Length missing on a binary upload."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    PayloadTooLarge:
      description: "413 FILE_TOO_LARGE."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    UnsupportedMediaType:
      description: "415 — wrong envelope Content-Type or disallowed sniffed file type; see §1.4."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    InternalError:
      description: "500 INTERNAL_ERROR."
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  schemas:
    Error:
      type: object
      required: [ok, error]
      properties:
        ok: { type: boolean, enum: [false] }
        error:
          type: object
          required: [code, message]
          properties:
            code: { type: string }
            message: { type: string, description: "Arabic, human-readable." }
            details:
              type: array
              description: "Additive, optional. Present only where more than one field can fail at once."
              items:
                type: object
                required: [field, issue]
                properties:
                  field: { type: string }
                  issue: { type: string }

    BookingStage:
      type: [string, "null"]
      enum:
        - pending_review
        - approved_hold
        - terms_and_receipt_pending
        - receipt_review
        - confirmed
        - pre_event_engagement
        - gallery_open
        - gallery_locked
        - album_design
        - album_printing
        - album_ready
        - handover_scheduling
        - handover_day
        - completed_feedback
        - privacy_cleanup
        - null

    PackageSnapshot:
      type: [object, "null"]
      additionalProperties: true
      description: >
        Unchanged, existing, deep shape from shared/booking.ts — out of scope for this contract (prices and
        the booking-creation contract are explicitly preserved). Abbreviated here; see shared/booking.ts for
        the full nested shape.

    CustomerBooking:
      type: object
      description: "GET /api/bookings/me item — §3.A. Fields marked NEW are the only additive change."
      required: [id, eventDate, status, estimatedTotal, packageSnapshot, holdExpiresAt, confirmedAt, createdAt, updatedAt]
      properties:
        id: { type: string }
        eventDate: { type: string, format: date }
        status: { type: string, enum: [pending_review, approved_hold, contract_pending, contract_signed, payment_pending, confirmed, rejected, cancelled, expired] }
        estimatedTotal: { type: integer, minimum: 0 }
        packageSnapshot: { $ref: "#/components/schemas/PackageSnapshot" }
        holdExpiresAt: { type: [string, "null"], format: date-time }
        confirmedAt: { type: [string, "null"], format: date-time }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
        flowVersion: { type: integer, enum: [1, 2], description: "NEW" }
        stage: { allOf: [{ $ref: "#/components/schemas/BookingStage" }], description: "NEW" }
        stageLabel: { type: [string, "null"], description: "NEW" }
        stageDeadline: { type: [string, "null"], format: date-time, description: "NEW" }
        depositAmount: { type: [integer, "null"], description: "NEW" }

    MyBookingsResponse:
      type: object
      required: [ok, bookings, serverTime]
      properties:
        ok: { type: boolean, enum: [true] }
        bookings: { type: array, maxItems: 50, items: { $ref: "#/components/schemas/CustomerBooking" } }
        serverTime: { type: string, format: date-time, description: "NEW, top-level sibling field." }

    ReceiptSummary:
      type: object
      required: [id, status, uploadedAt, reviewedAt, rejectionReason]
      properties:
        id: { type: string, format: uuid }
        status: { type: string, enum: [pending, verified, rejected] }
        uploadedAt: { type: string, format: date-time }
        reviewedAt: { type: [string, "null"], format: date-time }
        rejectionReason: { type: [string, "null"], maxLength: 500 }

    AdminReceipt:
      allOf:
        - $ref: "#/components/schemas/ReceiptSummary"
        - type: object
          required: [contentType, byteSize, reviewedBy, viewUrl]
          properties:
            contentType: { type: string, enum: [image/jpeg, image/png, image/webp, application/pdf] }
            byteSize: { type: integer, minimum: 1, maximum: 5242880 }
            reviewedBy: { type: [string, "null"] }
            viewUrl: { type: [string, "null"], description: "10-minute signed /api/media/... URL." }

    BankDetails:
      type: [object, "null"]
      properties:
        bankName: { type: string }
        accountName: { type: string }
        iban: { type: string }

    ConfirmationResponse:
      type: object
      required: [ok, booking, terms, deposit, receipts, serverTime]
      properties:
        ok: { type: boolean, enum: [true] }
        booking:
          type: object
          required: [id, status, flowVersion, holdExpiresAt]
          properties:
            id: { type: string }
            status: { type: string }
            flowVersion: { type: integer, enum: [2] }
            holdExpiresAt: { type: [string, "null"], format: date-time }
        terms:
          type: object
          required: [version, text]
          properties: { version: { type: string }, text: { type: string } }
        deposit:
          type: object
          required: [amount, currency, bankDetails]
          properties:
            amount: { type: integer, minimum: 0 }
            currency: { type: string, enum: [SAR] }
            bankDetails: { $ref: "#/components/schemas/BankDetails" }
        receipts: { type: array, items: { $ref: "#/components/schemas/ReceiptSummary" } }
        serverTime: { type: string, format: date-time }

    ReceiptUploadResponse:
      type: object
      required: [ok, booking, receipt]
      properties:
        ok: { type: boolean, enum: [true] }
        booking:
          type: object
          required: [id, status, holdExpiresAt]
          properties:
            id: { type: string }
            status: { type: string, enum: [payment_pending] }
            holdExpiresAt: { type: [string, "null"], format: date-time }
        receipt: { $ref: "#/components/schemas/ReceiptSummary" }

    AdminBookingActionRequest:
      type: object
      required: [action]
      additionalProperties: false
      properties:
        action:
          type: string
          enum: [approve, reject, mark_contract_sent, mark_contract_signed, request_payment, confirm_payment, cancel, reject_receipt, extend_hold]
        note: { type: string, maxLength: 500, description: "Conditionally required — see §3.B.4." }
        extendHours: { type: integer, minimum: 1, maximum: 168, description: "NEW. Only valid with reject_receipt/extend_hold." }
      allOf:
        - if: { properties: { action: { const: reject_receipt } } }
          then: { required: [action, note] }

    AdminCustomer:
      type: object
      required: [id, firstName, lastName, email, phone]
      properties:
        id: { type: string }
        firstName: { type: string }
        lastName: { type: string }
        email: { type: string }
        phone: { type: string }

    EventProfile:
      type: [object, "null"]
      properties:
        venueName: { type: [string, "null"], maxLength: 200 }
        venueArea: { type: [string, "null"], maxLength: 200 }
        startTime: { type: [string, "null"], pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }
        specialRequests: { type: [string, "null"], maxLength: 1000 }
        publishingConsent: { type: boolean }
        consentUpdatedAt: { type: [string, "null"], format: date-time }
        submittedAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    EventProfileInput:
      type: object
      required: [publishingConsent]
      additionalProperties: false
      properties:
        venueName: { type: [string, "null"], maxLength: 200 }
        venueArea: { type: [string, "null"], maxLength: 200 }
        startTime: { type: [string, "null"], pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }
        specialRequests: { type: [string, "null"], maxLength: 1000 }
        publishingConsent: { type: boolean }

    Gallery:
      type: [object, "null"]
      properties:
        id: { type: string, format: uuid }
        status: { type: string, enum: [draft, open, locked, purged] }
        quota: { type: integer, minimum: 1, maximum: 500 }
        quotaSource: { type: string, enum: [package, coverage_default, admin] }
        selectionDeadline: { type: [string, "null"], format: date-time }
        selectedCount: { type: integer, minimum: 0 }
        favouriteCount: { type: integer, minimum: 0 }
        purgedAt: { type: [string, "null"], format: date-time }

    GalleryPhoto:
      type: object
      required: [id, previewUrl, thumbUrl, isSelected, isFavourite]
      properties:
        id: { type: string, format: uuid }
        previewUrl: { type: string }
        thumbUrl: { type: string }
        isSelected: { type: boolean }
        isFavourite: { type: boolean }

    AdminGalleryPhoto:
      allOf:
        - $ref: "#/components/schemas/GalleryPhoto"
        - type: object
          required: [originalFilename, width, height]
          properties:
            originalFilename: { type: string, maxLength: 200 }
            width: { type: integer, minimum: 1 }
            height: { type: integer, minimum: 1 }

    GalleryPhotoPage:
      type: object
      required: [ok, photos, nextCursor]
      properties:
        ok: { type: boolean, enum: [true] }
        photos: { type: array, items: { $ref: "#/components/schemas/GalleryPhoto" } }
        nextCursor: { type: [string, "null"] }

    AdminGalleryPhotoPage:
      type: object
      required: [ok, photos, nextCursor]
      properties:
        ok: { type: boolean, enum: [true] }
        photos: { type: array, items: { $ref: "#/components/schemas/AdminGalleryPhoto" } }
        nextCursor: { type: [string, "null"] }

    GallerySelectionOp:
      type: object
      required: [photoId, field, value]
      properties:
        photoId: { type: string, format: uuid }
        field: { type: string, enum: [selected, favourite] }
        value: { type: boolean }

    GallerySelectionRequest:
      type: object
      required: [ops]
      additionalProperties: false
      properties:
        ops: { type: array, minItems: 1, maxItems: 50, items: { $ref: "#/components/schemas/GallerySelectionOp" } }

    GallerySelectionResponse:
      type: object
      required: [ok, results, counts]
      properties:
        ok: { type: boolean, enum: [true] }
        results:
          type: array
          items:
            type: object
            required: [photoId, field, applied, reason]
            properties:
              photoId: { type: string }
              field: { type: string, enum: [selected, favourite] }
              applied: { type: boolean }
              reason: { type: string, enum: [applied, quota_reached, not_found] }
        counts:
          type: object
          required: [selected, favourite, quota]
          properties:
            selected: { type: integer }
            favourite: { type: integer }
            quota: { type: integer }

    HandoverSlotMethod:
      type: string
      enum: [pickup, delivery, both]

    AdminHandoverSlot:
      type: object
      required: [id, slotDate, startsAt, endsAt, method, capacity, isActive, bookedCount, createdAt]
      properties:
        id: { type: string, format: uuid }
        slotDate: { type: string, format: date }
        startsAt: { type: string, format: date-time }
        endsAt: { type: string, format: date-time }
        method: { $ref: "#/components/schemas/HandoverSlotMethod" }
        capacity: { type: integer, minimum: 1, maximum: 20 }
        isActive: { type: boolean }
        bookedCount: { type: integer, minimum: 0 }
        createdAt: { type: string, format: date-time }

    HandoverSlotAvailability:
      type: object
      required: [id, slotDate, startsAt, endsAt, method, remainingCapacity]
      properties:
        id: { type: string, format: uuid }
        slotDate: { type: string, format: date }
        startsAt: { type: string, format: date-time }
        endsAt: { type: string, format: date-time }
        method: { type: string, enum: [pickup, delivery] }
        remainingCapacity: { type: integer, minimum: 1 }

    Handover:
      type: [object, "null"]
      properties:
        method: { type: string, enum: [pickup, delivery] }
        slot:
          type: object
          properties:
            id: { type: string, format: uuid }
            slotDate: { type: string, format: date }
            startsAt: { type: string, format: date-time }
            endsAt: { type: string, format: date-time }
        deliveryAddress: { type: [string, "null"], maxLength: 500 }
        status: { type: string, enum: [scheduled, completed] }
        bookedAt: { type: string, format: date-time }
        completedAt: { type: [string, "null"], format: date-time }

    Feedback:
      type: [object, "null"]
      properties:
        rating: { type: integer, minimum: 1, maximum: 5 }
        comment: { type: [string, "null"], maxLength: 1000 }
        submittedAt: { type: string, format: date-time }

    AdminBookingSummary:
      type: object
      description: "List item for GET /api/admin/bookings — §3.I. NEW fields noted inline."
      required: [id, eventDate, status, packageName, estimatedTotal, customer, createdAt, updatedAt]
      properties:
        id: { type: string }
        eventDate: { type: string, format: date }
        status: { type: string }
        packageName: { type: [string, "null"] }
        estimatedTotal: { type: integer }
        customer: { $ref: "#/components/schemas/AdminCustomer" }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
        flowVersion: { type: integer, enum: [1, 2], description: "NEW" }
        stage: { allOf: [{ $ref: "#/components/schemas/BookingStage" }], description: "NEW" }
        stageDeadline: { type: [string, "null"], format: date-time, description: "NEW" }

    AdminBookingDetail:
      type: object
      description: "GET /api/admin/bookings/{bookingId} — §3.I. NEW fields noted inline."
      required: [id, eventDate, status, allowedActions, packageName, estimatedTotal, packageSnapshot, adminNotes, holdExpiresAt, confirmedAt, createdAt, updatedAt, customer, statusHistory]
      properties:
        id: { type: string }
        eventDate: { type: string, format: date }
        status: { type: string }
        allowedActions: { type: array, items: { type: string } }
        packageName: { type: [string, "null"] }
        estimatedTotal: { type: integer }
        packageSnapshot: { $ref: "#/components/schemas/PackageSnapshot" }
        adminNotes: { type: [string, "null"] }
        holdExpiresAt: { type: [string, "null"], format: date-time }
        confirmedAt: { type: [string, "null"], format: date-time }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
        customer: { $ref: "#/components/schemas/AdminCustomer" }
        statusHistory: { type: array, items: { type: object } }
        flowVersion: { type: integer, enum: [1, 2], description: "NEW" }
        depositAmount: { type: [integer, "null"], description: "NEW" }
        termsVersion: { type: [string, "null"], description: "NEW" }
        termsAcceptedAt: { type: [string, "null"], format: date-time, description: "NEW" }
        completedAt: { type: [string, "null"], format: date-time, description: "NEW" }
        stage: { allOf: [{ $ref: "#/components/schemas/BookingStage" }], description: "NEW" }
        stageLabel: { type: [string, "null"], description: "NEW" }
        stageDeadline: { type: [string, "null"], format: date-time, description: "NEW" }
        latestReceipt: { allOf: [{ $ref: "#/components/schemas/AdminReceipt" }], description: "NEW" }
        eventProfile: { allOf: [{ $ref: "#/components/schemas/EventProfile" }], description: "NEW" }
        gallery: { allOf: [{ $ref: "#/components/schemas/Gallery" }], description: "NEW" }
        handover: { allOf: [{ $ref: "#/components/schemas/Handover" }], description: "NEW" }
        feedback: { allOf: [{ $ref: "#/components/schemas/Feedback" }], description: "NEW" }

paths:
  /api/bookings/me:
    get:
      summary: "CHANGED — additive fields only. §3.A"
      security: [{ firebaseBearer: [] }]
      x-access: customer-owner
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/MyBookingsResponse" } } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/confirmation:
    get:
      summary: "NEW — §3.B.1"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/ConfirmationResponse" } } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/receipt:
    post:
      summary: "NEW — multipart upload. §3.B.2"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file, termsVersion, termsAccepted]
              additionalProperties: false
              properties:
                file: { type: string, format: binary, description: "<= 5 MiB; JPEG/PNG/WebP/PDF by magic bytes." }
                termsVersion: { type: string }
                termsAccepted: { type: string, enum: ["true"] }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/ReceiptUploadResponse" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "411": { $ref: "#/components/responses/LengthRequired" }
        "413": { $ref: "#/components/responses/PayloadTooLarge" }
        "415": { $ref: "#/components/responses/UnsupportedMediaType" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/receipts:
    get:
      summary: "NEW — §3.B.3"
      x-access: admin
      parameters:
        - { $ref: "#/components/parameters/bookingIdPath" }
        - { $ref: "#/components/parameters/receiptLimitQuery" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, receipts]
                properties:
                  ok: { type: boolean, enum: [true] }
                  receipts: { type: array, items: { $ref: "#/components/schemas/AdminReceipt" } }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/actions:
    post:
      summary: "CHANGED — new action enum members + extendHours field. §3.B.4"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/AdminBookingActionRequest" } } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, booking, allowedActions]
                properties:
                  ok: { type: boolean, enum: [true] }
                  booking: { $ref: "#/components/schemas/AdminBookingDetail" }
                  allowedActions: { type: array, items: { type: string } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/media/{key}:
    get:
      summary: "NEW — signed URL media serving. §3.C. NOTE: {key} contains internal '/' — see prose."
      security: []
      x-access: signed-url
      parameters:
        - name: key
          in: path
          required: true
          schema: { type: string, pattern: "^(r|g)/[0-9a-f-]{36}/[0-9a-f-]{36}(/(p|t))?$" }
        - name: e
          in: query
          required: true
          schema: { type: integer, description: "Unix seconds expiry." }
        - name: s
          in: query
          required: true
          schema: { type: string, description: "base64url HMAC-SHA256 signature." }
      responses:
        "200": { description: "Binary file, headers per §3.C." }
        "400": { $ref: "#/components/responses/BadRequest" }
        "403": { description: "SIGNATURE_INVALID.", content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/event-profile:
    get:
      summary: "NEW — §3.D.1"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, eventProfile]
                properties: { ok: { type: boolean, enum: [true] }, eventProfile: { $ref: "#/components/schemas/EventProfile" } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }
    put:
      summary: "NEW — full-replace, naturally idempotent. §3.D.2"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/EventProfileInput" } } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, eventProfile]
                properties: { ok: { type: boolean, enum: [true] }, eventProfile: { $ref: "#/components/schemas/EventProfile" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/gallery:
    post:
      summary: "NEW — create (draft). §3.E.1"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties: { quotaOverride: { type: integer, minimum: 1, maximum: 500 } }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                type: object
                required: [ok, gallery]
                properties: { ok: { type: boolean, enum: [true] }, gallery: { $ref: "#/components/schemas/Gallery" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }
    delete:
      summary: "NEW — draft-only, deleted:boolean never 404. §3.E.2"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, deleted], properties: { ok: { type: boolean, enum: [true] }, deleted: { type: boolean } } }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }
    patch:
      summary: "NEW — publish / extend deadline / reopen. §3.E.3"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                status: { type: string, enum: [open] }
                selectionDeadline: { type: [string, "null"], format: date-time }
                reason: { type: string, maxLength: 500 }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, gallery]
                properties: { ok: { type: boolean, enum: [true] }, gallery: { $ref: "#/components/schemas/Gallery" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/gallery/photos:
    post:
      summary: "NEW — one file per call, filename-idempotent. §3.E.4"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [preview, thumbnail, originalFilename, width, height]
              additionalProperties: false
              properties:
                preview: { type: string, format: binary, description: "<= 1.5 MiB, JPEG/WebP." }
                thumbnail: { type: string, format: binary, description: "<= 256 KiB, JPEG/WebP." }
                originalFilename: { type: string, minLength: 1, maxLength: 200 }
                width: { type: integer, minimum: 1 }
                height: { type: integer, minimum: 1 }
      responses:
        "200": { description: "Idempotent no-op (filename already existed).", content: { application/json: { schema: { type: object } } } }
        "201":
          description: Created
          content:
            application/json:
              schema:
                type: object
                required: [ok, photo]
                properties:
                  ok: { type: boolean, enum: [true] }
                  photo:
                    type: object
                    properties:
                      id: { type: string, format: uuid }
                      originalFilename: { type: string }
                      width: { type: integer }
                      height: { type: integer }
                      sortOrder: { type: integer }
                      createdAt: { type: string, format: date-time }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "411": { $ref: "#/components/responses/LengthRequired" }
        "413": { $ref: "#/components/responses/PayloadTooLarge" }
        "415": { $ref: "#/components/responses/UnsupportedMediaType" }
        "500": { $ref: "#/components/responses/InternalError" }
    get:
      summary: "NEW — admin management view, cursor paginated. §3.E.5"
      x-access: admin
      parameters:
        - { $ref: "#/components/parameters/bookingIdPath" }
        - { $ref: "#/components/parameters/cursorQuery" }
        - { $ref: "#/components/parameters/galleryLimitQuery" }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/AdminGalleryPhotoPage" } } } }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/gallery/photos/{photoId}:
    delete:
      summary: "NEW — draft-only, deleted:boolean never 404. §3.E.6"
      x-access: admin
      parameters:
        - { $ref: "#/components/parameters/bookingIdPath" }
        - { $ref: "#/components/parameters/photoIdPath" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, deleted], properties: { ok: { type: boolean, enum: [true] }, deleted: { type: boolean } } }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/gallery/selection:
    get:
      summary: "NEW — Lightroom filename export, locked-only, not paginated. §3.E.7"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, filenames], properties: { ok: { type: boolean, enum: [true] }, filenames: { type: array, items: { type: string }, maxItems: 500 } } }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/gallery:
    get:
      summary: "NEW — 200 always, gallery:null when not published. §3.E.8"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, gallery, serverTime]
                properties: { ok: { type: boolean, enum: [true] }, gallery: { $ref: "#/components/schemas/Gallery" }, serverTime: { type: string, format: date-time } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/gallery/photos:
    get:
      summary: "NEW — cursor paginated, empty list rather than error when not ready. §3.E.9"
      x-access: customer-owner
      parameters:
        - { $ref: "#/components/parameters/bookingIdPath" }
        - { $ref: "#/components/parameters/cursorQuery" }
        - { $ref: "#/components/parameters/galleryLimitQuery" }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/GalleryPhotoPage" } } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/gallery/selection:
    post:
      summary: "NEW — auto-save, idempotent set-ops, always 200 with per-op results. §3.E.10"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/GallerySelectionRequest" } } }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/GallerySelectionResponse" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/gallery/submit:
    post:
      summary: "NEW — lock, requires exact quota, idempotent on repeat lock. §3.E.11"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: false, properties: {} } } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, gallery]
                properties: { ok: { type: boolean, enum: [true] }, gallery: { $ref: "#/components/schemas/Gallery" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/album:
    patch:
      summary: "NEW — three-stage status, upsert, idempotent. §3.F.1"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [stage]
              additionalProperties: false
              properties: { stage: { type: string, enum: [design, printing, ready] } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, album]
                properties:
                  ok: { type: boolean, enum: [true] }
                  album:
                    type: object
                    properties: { bookingId: { type: string }, stage: { type: string }, stageUpdatedAt: { type: string, format: date-time } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/handover-slots:
    post:
      summary: "NEW — create, unique(startsAt,method) idempotency. §3.G.1"
      x-access: admin
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [slotDate, startsAt, endsAt, method]
              additionalProperties: false
              properties:
                slotDate: { type: string, format: date }
                startsAt: { type: string, format: date-time }
                endsAt: { type: string, format: date-time }
                method: { $ref: "#/components/schemas/HandoverSlotMethod" }
                capacity: { type: integer, minimum: 1, maximum: 20, default: 1 }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { type: object, required: [ok, slot], properties: { ok: { type: boolean, enum: [true] }, slot: { $ref: "#/components/schemas/AdminHandoverSlot" } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }
    get:
      summary: "NEW — date-range paginated, mirrors /api/admin/blocked-dates. §3.G.2"
      x-access: admin
      parameters:
        - { $ref: "#/components/parameters/fromDateQuery" }
        - { $ref: "#/components/parameters/toDateQuery" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, range, slots]
                properties:
                  ok: { type: boolean, enum: [true] }
                  range: { type: object, properties: { from: { type: string }, to: { type: string } } }
                  slots: { type: array, items: { $ref: "#/components/schemas/AdminHandoverSlot" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/handover-slots/{slotId}:
    patch:
      summary: "NEW — §3.G.3"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/slotIdPath" }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                startsAt: { type: string, format: date-time }
                endsAt: { type: string, format: date-time }
                method: { $ref: "#/components/schemas/HandoverSlotMethod" }
                capacity: { type: integer, minimum: 1, maximum: 20 }
                isActive: { type: boolean }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, slot], properties: { ok: { type: boolean, enum: [true] }, slot: { $ref: "#/components/schemas/AdminHandoverSlot" } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }
    delete:
      summary: "NEW — hard-delete-if-unused, else 409; deleted:boolean never 404. §3.G.4"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/slotIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, deleted], properties: { ok: { type: boolean, enum: [true] }, deleted: { type: boolean } } }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/handover/slots:
    get:
      summary: "NEW — customer availability view, full slots excluded entirely. §3.G.5"
      x-access: customer-owner
      parameters:
        - { $ref: "#/components/parameters/bookingIdPath" }
        - { $ref: "#/components/parameters/fromDateQuery" }
        - { $ref: "#/components/parameters/toDateQuery" }
        - name: method
          in: query
          required: false
          schema: { type: string, enum: [pickup, delivery] }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, range, slots]
                properties:
                  ok: { type: boolean, enum: [true] }
                  range: { type: object, properties: { from: { type: string }, to: { type: string } } }
                  slots: { type: array, items: { $ref: "#/components/schemas/HandoverSlotAvailability" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/handover:
    get:
      summary: "NEW — 200 always, handover:null when not booked. §3.G.6"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, handover], properties: { ok: { type: boolean, enum: [true] }, handover: { $ref: "#/components/schemas/Handover" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }
    post:
      summary: "NEW — book a slot, PK-based idempotency. §3.G.7"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [slotId, method]
              additionalProperties: false
              properties:
                slotId: { type: string, format: uuid }
                method: { type: string, enum: [pickup, delivery] }
                deliveryAddress: { type: [string, "null"], maxLength: 500 }
      responses:
        "200": { description: "Idempotent retry of an already-successful booking.", content: { application/json: { schema: { type: object } } } }
        "201":
          description: Created
          content:
            application/json:
              schema: { type: object, required: [ok, handover], properties: { ok: { type: boolean, enum: [true] }, handover: { $ref: "#/components/schemas/Handover" } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }
    patch:
      summary: "NEW — reschedule; ships with HND-07 (LATER). §3.G.8"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, required: [toSlotId], additionalProperties: false, properties: { toSlotId: { type: string, format: uuid } } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, handover], properties: { ok: { type: boolean, enum: [true] }, handover: { $ref: "#/components/schemas/Handover" } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}/handover:
    patch:
      summary: "NEW — complete / reassign, admin discretion. §3.G.9"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                status: { type: string, enum: [completed] }
                slotId: { type: string, format: uuid }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, handover], properties: { ok: { type: boolean, enum: [true] }, handover: { $ref: "#/components/schemas/Handover" } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/bookings/{bookingId}/feedback:
    post:
      summary: "NEW — one-time, compare-on-retry idempotency. §3.H.1"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [rating]
              additionalProperties: false
              properties:
                rating: { type: integer, minimum: 1, maximum: 5 }
                comment: { type: [string, "null"], maxLength: 1000 }
      responses:
        "200": { description: "Idempotent retry with identical values.", content: { application/json: { schema: { type: object } } } }
        "201":
          description: Created
          content:
            application/json:
              schema: { type: object, required: [ok, feedback], properties: { ok: { type: boolean, enum: [true] }, feedback: { $ref: "#/components/schemas/Feedback" } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "409": { $ref: "#/components/responses/Conflict" }
        "500": { $ref: "#/components/responses/InternalError" }
    get:
      summary: "NEW — 200 always, feedback:null when not yet submitted. §3.H.2"
      x-access: customer-owner
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, feedback], properties: { ok: { type: boolean, enum: [true] }, feedback: { $ref: "#/components/schemas/Feedback" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/EmailNotVerified" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings/{bookingId}:
    get:
      summary: "CHANGED — additive fields only. §3.I"
      x-access: admin
      parameters: [{ $ref: "#/components/parameters/bookingIdPath" }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, required: [ok, booking], properties: { ok: { type: boolean, enum: [true] }, booking: { $ref: "#/components/schemas/AdminBookingDetail" } } }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }

  /api/admin/bookings:
    get:
      summary: "CHANGED — additive fields only, query params unchanged. §3.I"
      x-access: admin
      parameters:
        - name: status
          in: query
          required: false
          schema: { type: string }
        - { $ref: "#/components/parameters/fromDateQuery" }
        - { $ref: "#/components/parameters/toDateQuery" }
        - name: limit
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, filters, bookings]
                properties:
                  ok: { type: boolean, enum: [true] }
                  filters: { type: object }
                  bookings: { type: array, items: { $ref: "#/components/schemas/AdminBookingSummary" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthenticated" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "405": { $ref: "#/components/responses/MethodNotAllowed" }
        "500": { $ref: "#/components/responses/InternalError" }
```

---

## Summary for the next runs

Every endpoint above is additive to the existing API; §4 confirms both files under `app/src/api/` keep working
unmodified. Implementation is gated exactly where the ADR already gates it: `U1` (PDPL/residency) before any
`R2`/media/receipt/gallery endpoint is built; `D4` and `U6` before the receipt/confirmation endpoints show real
money figures or real terms text; `U11`/`U13`/`U19` are UX defaults, safe to build against now and correct
later without a contract change. Runs 3–8 should treat §3 and §8 as the shared source of truth for request/
response shapes; §6 is the single place error codes and their Arabic strings are defined.
