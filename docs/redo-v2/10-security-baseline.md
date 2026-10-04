# 10 — Security baseline (redo-v2)

| | |
|---|---|
| Repository | `sundus-yar/app`, branch `master`, HEAD `c80f4c2` ("Add a browse-only preview environment for owner review"), clean working tree, no git remote configured |
| Date | 2026-09-28 |
| Method | Seven independent audit lenses: six read-only source reviews plus one non-destructive live probe of the preview deployment. One to three skeptic reviewers re-traced every candidate finding, tried to refute it and looked for a mitigation elsewhere. The audit lead merged duplicates, set the final severity and spot-checked the quoted lines at HEAD. |
| Scope | React 19 SPA (`src/`), Cloudflare Worker API (`worker/`), `shared/`, D1 migrations, `public/_headers`, `wrangler.jsonc`, build output (`dist/`), git history, npm dependency tree |
| Data at stake | Customer names, emails, phones, event dates, booking and deposit records. Later: deposit receipts and private bridal photos. Saudi PDPL applies. |
| Severity rubric | CRITICAL: remote unauthenticated compromise or data breach. HIGH: authz bypass, cross-customer data access, stored XSS, booking or payment fraud. MEDIUM: a defense-in-depth gap with a plausible attack path. LOW / INFO: hardening. |
| Severity resolution | Final severity is the most common adjusted severity among all confirming skeptics across the merged lens reports. A tie resolves to the higher of the tied values. Findings that no skeptic confirmed are listed in Appendix A. |

---

## 1. Summary

**No CRITICAL or HIGH finding survived verification.** The core controls hold up (details in section 4):
- JWT verification is strict (RS256 pinned; iss, aud, exp, iat, auth_time and kid all checked).
- Every `/api/admin/*` path is guarded, with the role read from D1 on each request.
- Customer queries are owner-scoped in SQL, and all SQL is parameterized.
- Prices are recomputed on the server.
- The double-booking invariant is atomic.
- There are no XSS sinks in the SPA, no CORS or CSRF surface, and email HTML is escaped.
- The PDPL gate keeps receipts, galleries and media unreachable.

The weak spots fall into five themes:

1. **Identity data trusts an unverified token claim.** `PUT /api/profile` stores the token's email even when it is unverified, and never re-syncs it. This feeds two paths:
   - an admin-takeover path through the email-keyed promotion runbook (SEC-01);
   - permanent email squatting and misdirected notifications (SEC-04).
2. **The only admin account is password-only**, with no maximum session age (SEC-02). TOTP MFA is a documented hard precondition (R1) that the code cannot yet meet.
3. **The public write API has no abuse limits.** Booking creation is unbounded per account (SEC-03), and legacy handlers buffer request bodies with no byte cap (SEC-05).
4. **Browser and platform hardening is staged but not enforced.**
   - The CSP is Report-Only (SEC-07).
   - There is no HSTS or COOP header (SEC-12).
   - The "browse-only" preview is really a fully writable API (SEC-08).
   - Version Preview URLs are on by default (SEC-13).
5. **Repository hygiene.** Git history still holds the full-resolution original wedding photos with camera metadata (SEC-06). This must be fixed before the first push.

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 6 |
| LOW | 9 |
| INFO | 5 |
| Refuted (Appendix A) | 2 |

**Must land before production go-live:** SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-07, SEC-08, SEC-12, SEC-13 and SEC-15 (PDPL notice). **Before the first `git push`:** SEC-06. **Before Run 4/6 opens receipts and galleries:** SEC-16, SEC-19 and SEC-20, and SEC-02 becomes HIGH if it is still open by then. The ordered commit plan is in section 6.

---

## 2. Findings index

| ID | Sev | Title | Primary location | Lenses (confirms/votes) | Gate |
|---|---|---|---|---|---|
| SEC-01 | MEDIUM | Admin role is granted by email; an unverified, never re-synced `users.email` lets an attacker's uid be promoted | `README.md:179`, `worker/profile.ts:367` | authn-authz (3/3) | Go-live |
| SEC-02 | MEDIUM | Admin authentication is single-factor with no session-age bound; the SPA cannot complete MFA | `worker/admin-auth.ts:88`, `src/auth/AuthContext.tsx:715` | authn-authz, client-side ×2 (5/5) | Go-live (R1) |
| SEC-03 | MEDIUM | Unbounded booking-request creation per account (no rate limit, no open-request cap, no date horizon) | `worker/bookings.ts:684` | authn-authz, injection, config, business-logic (8/8) | Go-live |
| SEC-04 | MEDIUM | `PUT /api/profile` trusts the unverified token email: UNIQUE-email squatting blocks the real owner from booking, and notifications can be redirected | `worker/profile.ts:367` | authn-authz, data-protection, dynamic-probe, injection (7/7) | Go-live |
| SEC-05 | MEDIUM | Request bodies are buffered without a byte cap (profile always; bookings and blocked-dates when chunked) | `worker/profile.ts:276` | injection, business-logic (3/3) | Go-live |
| SEC-06 | MEDIUM | Git history retains full-resolution original wedding photos with camera metadata | git objects from `d6b7cb2` / `c4c7c53` | config-headers (2/2) | Before first push |
| SEC-07 | LOW | CSP ships Report-Only with no reporting endpoint | `public/_headers:27` | injection, config, client-side, dynamic-probe (7/7) | Go-live |
| SEC-08 | LOW | The "browse-only" preview Worker exposes the full write API on the production Firebase project; its noindex exists only in hand-edited `dist/` | `wrangler.jsonc:27`, `worker/index.ts:265` | authn-authz, config, client-side (4/4) | Before next preview rebuild |
| SEC-09 | LOW | Item quantities have no upper bound (totals up to about 9×10^15 SAR are accepted) | `shared/booking.ts:495` | injection, business-logic (2/2) | Recommended |
| SEC-10 | LOW | Customer names accept bidi controls, line separators and URLs; legacy email templates and the admin UI render them without isolation | `worker/profile.ts:60`, `worker/email-templates.ts:384` | injection, client-side (2/2) | Recommended |
| SEC-11 | LOW | No token revocation or disabled-account check, so access continues for about 60 minutes after an incident | `worker/auth.ts:84` | authn-authz (1/1) | Recommended |
| SEC-12 | LOW | No Strict-Transport-Security or Cross-Origin-Opener-Policy header | `public/_headers:26` | config, client-side, dynamic-probe (3/3) | Go-live (HSTS at custom-domain cut-over) |
| SEC-13 | LOW | Worker version Preview URLs are left at Cloudflare's default (on) | `wrangler.jsonc:1` | config (1/1) | Go-live |
| SEC-14 | LOW | Pseudonymisation can be undone by `PUT /api/profile` | `worker/profile.ts:317` | data-protection (1/1) | Before the first DSR |
| SEC-15 | LOW | Registration collects PII and sends it abroad with no privacy notice | `src/components/AuthDialog.tsx:1091` | data-protection (1/1) | Go-live (PDPL) |
| SEC-16 | INFO | Portal dispatchers leave booking-ownership and signed-URL checks to each future handler | `worker/portal/portal-routes.ts:94` | authn-authz (1/1) | Before Run 4/6 routes |
| SEC-17 | INFO | No retention or erasure implementation; the daily cron runs only the heartbeat | `worker/jobs/registry.ts:19` | data-protection (1/1) | Within first retention window |
| SEC-18 | INFO | Full name is copied into Firebase Auth `displayName` but never used | `src/auth/AuthContext.tsx:776` | data-protection (1/1) | Anytime |
| SEC-19 | INFO | The approve path sets a 24 h hold that nothing enforces; past-dated requests can be approved | `worker/admin-workflow.ts:601` | business-logic (1/1) | Before flow 2 |
| SEC-20 | INFO | No recent-authentication requirement for future private-media customer routes | `worker/auth.ts:111` | data-protection (1/1) | Before Run 6 |

---

## 3. Findings

### SEC-01 — Admin role is granted by email; an unverified, never re-synced `users.email` lets an attacker's uid be promoted to admin

**Severity:** MEDIUM (reported HIGH) · **CWE:** CWE-639, CWE-863
**Location:** `README.md:179`, `README.md:564`, `worker/profile.ts:367-377`, `worker/profile.ts:316-318`, `worker/admin-auth.ts:88-92`

**Evidence**
```text
README.md:179  (the documented promotion step)
  npx wrangler d1 execute sundus-yar-bookings --local --command "UPDATE users SET role = 'admin' WHERE email = 'you@example.com'"
README.md:564
  **Admin role in production:** use the same `UPDATE users SET role = 'admin' …` as locally, with `--remote`.

worker/profile.ts:367-377  (authentication only; no requireVerifiedEmail before the write)
  const identity = await authenticateFirebaseRequest(request, env)
  if (!identity) {
    return unauthorizedResponse()
  }
  if (request.method === 'GET') {
    return handleGetProfile(env, identity)
  }
  return handlePutProfile(request, env, identity)

worker/profile.ts:316-318
        VALUES (?, ?, ?, ?, ?, 'customer')
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,

worker/admin-auth.ts:88-92  (checks uid, role and email_verified; never compares the row's email with the token's)
  if (
    !user ||
    user.id !== identity.uid ||
    user.role !== 'admin'
  ) {
```
`profile.ts:308` is the only writer of `users` anywhere in `worker/`, `shared/`, `src/` and `scripts/`, so nothing re-syncs `users.email` after the Firebase account's email changes.

**Attack.** Precondition: the owner has not yet created a Firebase account in the production project. Her business email is public (Instagram, WhatsApp, the site).
1. The attacker uses the public Firebase web API key to call REST `accounts:signUp` with `email = owner@…`. Firebase does not verify ownership at sign-up, so the attacker gets uid A with `email_verified=false`.
2. The attacker sends `PUT /api/profile {firstName,lastName,phone}`. The Worker writes `users(id=A, email='owner@…', role='customer')`.
3. The attacker moves account A to an address they control with `verifyBeforeUpdateEmail` and clicks the link. Account A is now verified under that address, but the D1 row still says `owner@…`.
4. The owner signs up as uid O. Her profile save returns `409 EMAIL_ALREADY_IN_USE`, or she skips it.
5. The operator follows README step 2. The email-keyed `UPDATE` changes one row, and that row is A.
6. The attacker's token (`sub=A`, `email_verified=true`) now passes `authorizeAdminRequest`. The attacker can read every customer's name, email, phone and event date through `GET /api/admin/bookings`, run approve/reject/cancel, and manage blocked dates. Once Run 4/6 ships, receipts and galleries are exposed too.

If the attacker deletes account A instead of moving it, the promotion goes to a dead uid and the owner is locked out of admin.

**Fix**
- **(a) Runbook.** Promote by Firebase UID, never by email. Replace README.md:179 and :564 with `UPDATE users SET role='admin' WHERE id='<uid from the Firebase console for the verified owner account>' AND email='<owner email>'`. Require `changes()==1`, then confirm with `SELECT id,email,role FROM users WHERE role='admin'`.
- **(b) Code, in-band.** In `authorizeAdminRequest`, also require that the stored `users.email` equals the token's `email` (case-insensitive). In the attack above the stored email and the token email differ, so the attacker gets 403 even if the runbook is run wrongly.
- **(c) Root cause.** Stop writing unverified email into `users.email`. This is shared with SEC-04 and lands in commit C-2.

**Verification.** authn-authz lens: 3 of 3 skeptics confirmed. All three lowered the severity to MEDIUM, for these reasons:
- Exploitation needs a one-time launch window: the owner must not yet be registered.
- It also needs operator error despite several warning signs:
  - the owner's own profile save fails with 409, and README step 1 requires that save;
  - Firebase normally emails an "email changed" notice to the old address;
  - after promotion the owner gets 403 on `/admin`, which fails the documented smoke test.

No code control prevents it. The production D1 state (whether the owner is already registered or promoted) was not checked; see operational check O-1.

---

### SEC-02 — Admin authentication is single-factor with no session-age bound; the SPA cannot complete MFA

**Severity:** MEDIUM · **CWE:** CWE-308, CWE-613
**Location:** `worker/admin-auth.ts:86-97`, `worker/auth.ts:111-112`, `worker/auth.ts:131-135`, `src/auth/AuthContext.tsx:715-719`, `src/auth/AuthContext.tsx:185-186`, `src/lib/firebase.ts:150`

**Evidence**
```text
worker/auth.ts:111-112  (auth_time: only "valid" and "not in the future"; no maximum age)
      !isValidNumericDate(authTime) ||
      authTime > currentTime ||

worker/auth.ts:131-135  (the firebase.sign_in_second_factor claim is dropped)
    return {
      uid: payload.sub,
      email,
      emailVerified: payload.email_verified === true,
    }

worker/admin-auth.ts:88-92  (role is the only admin criterion)
    !user ||
    user.id !== identity.uid ||
    user.role !== 'admin'

src/auth/AuthContext.tsx:715-719  (email and password only)
        await resources.sdk.signInWithEmailAndPassword(
          resources.auth,
          normalizedEmail,
          password,
        )
src/auth/AuthContext.tsx:185-186  (no auth/multi-factor-auth-required case in mapFirebaseError)
    default:
      return createAuthError('UNEXPECTED_ERROR')

src/lib/firebase.ts:150
    const ready = setPersistence(auth, browserLocalPersistence)

decisions.md:104: "TOTP MFA on the sole admin account is a HARD precondition"
```
A grep of `src/`, `worker/` and `shared/` for `MultiFactor`, `getMultiFactorResolver`, `Totp`, `mfa`, `second_factor` and `reauth` finds nothing in code. No Cloudflare Access, IP allowlist or `cf-access` check exists in front of `/api/admin`.

**Attack**
- **Stolen password.** The single admin account unlocks all customer PII and every booking transition. Its login email is public. With a phished, reused or credential-stuffed password, an attacker can skip the SPA entirely: they get an ID token from Identity Toolkit `signInWithPassword` and call:
  - `GET /api/admin/bookings` and `GET /api/admin/bookings/{id}`, which return names, phones, emails and notes;
  - `POST /api/admin/bookings/{id}/actions`.
- **Stolen refresh token.** Firebase refresh tokens do not expire unless revoked. A refresh token taken from the admin's browser storage (lost device, malware, or a future XSS; see SEC-07) keeps producing admin ID tokens indefinitely, because any past `auth_time` is accepted.
- **Shared device.** On a shared studio laptop, anyone who opens `/admin` weeks later is signed in silently.
- **The owner cannot fix this from the console alone.** If she turns on TOTP in Identity Platform today, every admin sign-in fails with `UNEXPECTED_ERROR`, because the SPA never handles the MFA resolver.

**Fix.** Order matters.
1. **SPA (commit C-6).**
   - Handle `auth/multi-factor-auth-required` with `getMultiFactorResolver(auth, error)` and `TotpMultiFactorGenerator.assertionForSignIn(...)`.
   - Add an admin enrollment flow: `multiFactor(user).enroll(TotpMultiFactorGenerator.assertionForEnrollment(secret, code))`.
   - Add a re-auth prompt using `reauthenticateWithCredential`.
2. **Console.** Enable TOTP MFA in Identity Platform, then enroll the owner.
3. **Worker (commit C-7).**
   - `authenticateFirebaseRequest` returns `firebase.sign_in_second_factor` and `auth_time`.
   - `authorizeAdminRequest` rejects the request unless the second factor is `'totp'` and `nowSeconds - auth_time <= 12*3600`. It answers `403 ADMIN_REAUTH_REQUIRED`, which the SPA turns into a fresh sign-in.

**Verification.** Merged from three reports:
- authn-authz ("admin guard does not enforce MFA or session age"): 2/2 confirmed, both MEDIUM.
- client-side ("admin account is password-only"): 2/2 confirmed, both MEDIUM.
- client-side ("admin sessions never expire on a device"): 1/1 confirmed, LOW.

Overall 5 of 5 confirmed, final MEDIUM. It stays below HIGH because receipts, galleries and media are closed today by the R2 gate: `worker/portal/gates.ts` needs `ONLINE_CONFIRMATION='on'` plus `PDPL_SIGNOFF_REF`, and `wrangler.jsonc` sets `"off"`. **It becomes HIGH if Run 4/6 opens that gate before this fix lands.**

---

### SEC-03 — Unbounded booking-request creation per account: floods the admin inbox, exhausts the email quota and marks every public date "pending"

**Severity:** MEDIUM · **CWE:** CWE-770, CWE-799
**Location:** `worker/bookings.ts:684-687`, `worker/bookings.ts:537-550`, `worker/bookings.ts:394-433`, `worker/index.ts:163-171`, `wrangler.jsonc` (no `ratelimits`)

**Evidence**
```text
worker/bookings.ts:684-687  (lower bound only; isValidCalendarDate accepts up to 9999-12-31)
  if (
    !isValidCalendarDate(requestBody.eventDate) ||
    requestBody.eventDate < getRiyadhCalendarDate(new Date())
  ) {

worker/bookings.ts:537-550  (the only per-user guard is per (user, date); 'rejected' is not listed)
        AND NOT EXISTS (
          SELECT 1
          FROM booking_requests
          WHERE user_id = ?
            AND event_date = ?
            AND status IN (
              'pending_review', 'approved_hold', 'contract_pending',
              'contract_signed', 'payment_pending', 'confirmed'
            )
        )

worker/bookings.ts:409-433  (two direct Resend sends per booking, not paced by the outbox)
        sendEmail(env, {
          to: adminRecipient,
          ...adminTemplate,
          idempotencyKey: `booking-created-admin:${bookingId}`,
        }),
      ...
      sendEmail(env, {
        to: identity.email,
        ...customerTemplate,
        idempotencyKey: `booking-created-customer:${bookingId}`,
      }),

worker/index.ts:163-171  (public availability shows every pending_review date)
      SELECT DISTINCT event_date
      FROM booking_requests
      WHERE event_date BETWEEN ? AND ?
        AND status = 'pending_review'

05-adr-architecture.md:355: "Rate limiting: none is added, because every write is authenticated and bounded by its state."
```
Migration 0004's unique index is also keyed on `(user_id, event_date)`. `wrangler.jsonc` declares no `ratelimits` binding. The design says there is no WAF, Turnstile or App Check, and 07-api-contracts §1.9 confirms that no limiter exists.

**Attack**
1. An attacker signs up one free Firebase email/password account, verifies it with a throwaway inbox, and calls `PUT /api/profile` once.
2. A script sends `POST /api/bookings {"eventDate":"<D>","selection":{<cheapest valid selection>}}` for D = tomorrow through one year out: 366 requests, each returning 201.
3. The effects:
   - **(a) Admin inbox and queue.** The owner's `ADMIN_NOTIFICATION_EMAIL` gets 366 "new booking" emails, and 366 junk `pending_review` rows bury real requests.
   - **(b) Email quota.** 732 Resend sends are used up. Once the plan returns 429, real booking and status emails fail. The portal outbox stops on `RATE_LIMITED` (`notify/outbox.ts:551-552`), and after 24 h `GIVE_UP_SQL` drops the queued hold and expiry notices.
   - **(c) Public calendar.** Every date shows the «يوجد طلب سابق» (earlier request exists) warning to real brides during peak season.
4. The attacker can keep going to 9999-12-31. When the admin rejects the rows, the attacker re-submits them right away, because `'rejected'` is excluded from the guard. More accounts multiply the effect.

**Fix**
1. **Per-user cap, atomic.** Add `AND (SELECT COUNT(*) FROM booking_requests WHERE user_id = ? AND status IN ('pending_review','approved_hold','contract_pending','contract_signed','payment_pending')) < 3` to the INSERT's `WHERE`, and return `409 TOO_MANY_OPEN_REQUESTS`.
2. **Booking horizon.** Reject an `eventDate` later than `addDaysToDateKey(riyadhToday, 730)` (a constant in `shared/timing.ts`) with `400 INVALID_EVENT_DATE`. Mirror the limit in the calendar.
3. **Rate limit.** Add a Rate Limiting binding (`"ratelimits": [{ "name": "BOOKING_RL", "namespace_id": "…", "simple": { "limit": 5, "period": 3600 } }]`, in both prod and `env.preview`). Key it on `identity.uid`, call it in `handleCreateBooking` and `handleProfile` before any D1 work, and return 429.
4. **Admin email digest.** Send the admin "new request" email through the outbox as a digest (one dedupe key per hour) instead of one direct send per request.
5. **Docs.** Correct ADR §2.7 and API §1.9.

**Verification.** Reported independently by four lenses (authn-authz, injection-validation, config-headers-supplychain, business-logic). All 8 skeptic votes confirmed it, all at MEDIUM. Skeptic corrections:
- `pending` dates stay selectable in the SPA (`SelectableDateStatus = 'available' | 'pending'`), so effect (c) deters bookings rather than blocking them.
- Far-future dates are not visible through the 93-day availability window, but they still flood the queue, D1 and email.
- The size of the Resend quota depends on the plan and was not checked.

---

### SEC-04 — `PUT /api/profile` trusts the unverified token email: UNIQUE-email squatting permanently blocks the real owner from booking, and later notifications can be redirected

**Severity:** MEDIUM · **CWE:** CWE-345, CWE-841, CWE-287
**Location:** `worker/profile.ts:367-377`, `worker/profile.ts:295-303`, `worker/profile.ts:316-318`, `migrations/0001_initial.sql:5`, `worker/bookings.ts:705-709`, `worker/admin.ts:1168-1169`

**Evidence**
```text
worker/profile.ts:367-377  (no requireVerifiedEmail, unlike bookings.ts:660/736, portal/request.ts:402, admin-auth.ts:77)
  const identity = await authenticateFirebaseRequest(request, env)
  ...
  return handlePutProfile(request, env, identity)

migrations/0001_initial.sql:5
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,

worker/profile.ts:295-303
  const emailConflict = await findConflictingEmailOwner(
    env,
    identity.email,
    identity.uid,
  )
  if (emailConflict) {
    return emailConflictResponse()        // 409 EMAIL_ALREADY_IN_USE
  }

worker/profile.ts:316-318  (every PUT re-points the stored address to whatever the token says)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,

worker/bookings.ts:705-709
  const profile = await loadCustomerNotificationProfile(env, identity.uid)
  if (!profile) {
    return profileRequiredResponse()
  }

worker/admin.ts:1168-1169  (the recipient is read live from users.email; same in jobs/hold-reminders.ts:284 and hold-expiry.ts:86)
    const deliveryResult = await sendEmail(env, {
      to: booking.customer.email,
```
The unverified PUT is intentional. `src/auth/AuthContext.tsx:768-785` calls `requestProfile(createdUser,'PUT',…)` right after `createUserWithEmailAndPassword` and before `sendVerificationMessage`. **Simply adding `requireVerifiedEmail` would break registration.** Nothing ever deletes or re-syncs a `users` row: no `DELETE FROM users` or `UPDATE users` exists in `worker/`, and no retention job is registered.

**Attack**
- **Squatting (targeted, permanent booking denial).**
  1. A competitor or harasser who knows a bride's email (from DMs) signs up in Firebase with that email before she does, and never verifies it.
  2. They call `PUT /api/profile`, which creates `users(id=A, email=bride@…)`.
  3. They delete account A (self-service `accounts:delete`) or move it to another address.
  4. The bride registers normally (uid V) and verifies her email. Every PUT she makes now returns 409, so every `POST /api/bookings` returns `PROFILE_REQUIRED`. Recovery needs a manual D1 edit. A script can pre-squat many addresses.
- **Misdirection.** This only works if Firebase allows an unverified email change, that is, Email Enumeration Protection is off. The ADR lists that setting as unconfirmed (U15).
  1. A customer with a verified booking changes their Firebase email to `victim@example.com` through `accounts:update`.
  2. They re-PUT the profile with `firstName` = an 80-character lure such as `"راجعي https://evil.tld/refund"` ("check https://evil.tld/refund").
  3. The studio's DKIM-signed status, reminder and expiry emails now go to the victim and open with the lure. The content is HTML-escaped, so this is plain text only.
- **Compliance.** In both cases the controller stores PII against an address nobody proved they own, which conflicts with the PDPL accuracy duty.

**Fix.** Commit C-2. Do not add `requireVerifiedEmail` to the PUT as-is.
1. Add `users.email_verified_at TEXT NULL` in migration 0007, and set it only when `identity.emailVerified === true`.
2. Upsert with `email = CASE WHEN ?verified = 1 THEN excluded.email ELSE users.email END`. A first insert from an unverified token stores the email with `email_verified_at = NULL`.
3. On an email conflict, reclaim the address if the conflicting row has `email_verified_at IS NULL` and no `booking_requests`, and the caller's token is verified: clear or delete that row in the same batch, then insert. An unverified row must never win a UNIQUE conflict against a verified identity. An equivalent alternative is to drop UNIQUE and use `CREATE UNIQUE INDEX … ON users(email) WHERE email_verified_at IS NOT NULL`.
4. Re-sync `users.email` from the verified token in `handleCreateBooking`, and send notifications only to verified addresses.
5. In the Firebase console, confirm that Email Enumeration Protection is on (check O-2).

**Verification.** Merged from four reports. 7 of 7 votes confirmed; adjusted to MEDIUM ×5 and LOW ×2, final MEDIUM.
- authn-authz ("unverified profile writes squat on UNIQUE users.email"): 2/2, both MEDIUM.
- data-protection ("PUT /api/profile accepts unverified identities"): 2/2, both MEDIUM.
- dynamic-probe ("profile skips email verification"): 1/1, LOW.
- injection-validation ("unverified email stored as notification recipient"): 2/2, LOW and MEDIUM.

Skeptic corrections:
- The squat only needs the delete-or-move step because Firebase allows one account per email. If the attacker keeps account A, the victim can take it over with a password reset.
- The misdirection variant is blocked when Email Enumeration Protection is on (the default for projects created after Sept 2023).

---

### SEC-05 — Request bodies are buffered without a byte cap (profile always; bookings and blocked-dates when chunked)

**Severity:** MEDIUM · **CWE:** CWE-400, CWE-770
**Location:** `worker/profile.ts:273-283`, `worker/bookings.ts:165-192`, `worker/admin.ts:883-903`

**Evidence**
```text
worker/profile.ts:273-283  (no Content-Type, Content-Length or streaming cap; reachable with an unverified token)
  let requestBody: unknown
  try {
    requestBody = await request.json()
  } catch {

worker/bookings.ts:165-192  (the length check runs only if the header is present, then everything is buffered)
  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength) {
    ...
  }
  let bodyText: string
  try {
    bodyText = await request.text()
  } catch {
    return null
  }
  if (
    bodyText.length === 0 ||
    bodyText.length > MAXIMUM_REQUEST_BODY_LENGTH
  ) {
```
`worker/admin.ts:883-903` (parseBlockedDateBody) uses the same pattern but is admin-only. The project already has the correct bounded reader, which counts bytes while reading and cancels the stream, in `worker/portal/request.ts:286-322` (`readBoundedBytes`) and `worker/admin-workflow.ts:218-269`. Its comment says: "an absent or understated Content-Length (a chunked request) cannot get more than the cap through".

**Attack**
1. The attacker creates an unverified Firebase email/password account.
2. They send `PUT /api/profile` with `Authorization: Bearer <token>` and a chunked body of about 90–100 MB (e.g. `{"firstName":"aaaa…"}`). The Free/Pro plan's edge body limit is 100 MB.
3. `request.json()` buffers the body and builds a string of about the same size, which pushes past the 128 MB isolate limit. The isolate is killed, together with any customer or admin requests it was serving, and the CPU and duration are billed to the owner.
4. A verified account can do the same to `POST /api/bookings` by leaving out `Content-Length`.

**Fix.** Commit C-5.
1. Move the bounded reader into `worker/http.ts`.
2. Route every JSON handler through it:
   - profile: `maxBytes: 4096`, require `application/json` (415 otherwise);
   - bookings: `maxBytes: 20_000`;
   - admin blocked-dates: `maxBytes: 2_000`.
3. Remove the bare `request.json()` and `request.text()` calls.

**Verification.**
- injection-validation: 2/2 confirmed, both MEDIUM.
- business-logic: 1/1 confirmed, LOW.

Final MEDIUM. The actual isolate OOM was not reproduced. What is confirmed is that the lines are reachable with the privileges described. The dynamic probe reported "bodies are size-bounded". That does not contradict this finding: the probe was unauthenticated, and authentication runs before body parsing (its 2 MB POST got 401).

---

### SEC-06 — Git history retains the full-resolution original wedding photos with camera metadata

**Severity:** MEDIUM (skeptics tied MEDIUM/LOW; tie resolves to the higher value) · **CWE:** CWE-212, CWE-359
**Location:** git objects: `public/images/portfolio/wedding-01..08.jpeg`, `public/images/brand-logo.jpeg` and `public/images/products/*` (added by `d6b7cb2`, deleted in `4bfb3b5`/`c4c7c53`); pre-`fa72b36` `public/images/site/*` variants

**Evidence**
```text
$ git rev-list --all --objects | grep -cE 'portfolio/wedding-0[1-8]\.jpeg'
8                                   (lead re-ran at HEAD c80f4c2)
$ git for-each-ref
refs/heads/master
refs/tags/design-classic-v1         (a second ref that keeps old objects reachable)

git show d6b7cb2:public/images/portfolio/wedding-0N.jpeg  ->  6.3-23.4 MB each, up to 8192 px.
EXIF tag names present (values not printed): Make, Model, DateTimeOriginal, BodySerialNumber,
LensSerialNumber on all 8; XMP and IPTC blocks on all 8. c4c7c53 added 31 site/*.webp|avif variants
with Exif/XMP; site/phone-bouquet-1600.avif carries an OwnerName field.

README.md:299-301
  **Camera metadata is stripped for you.** Every published size, including the full-size one, is re-encoded by
  sharp, which writes no EXIF/XMP/IPTC (camera serials, capture date, owner name). Keep the originals you export
  private anyway: `assets-incoming/` is outside the repo and is never served.
```
All 273 files currently in `public/images` are clean (0 with EXIF/XMP/IPTC). `git remote -v` is empty.

**Attack.** There is no exposure today. Once the repo reaches GitHub, a CI provider or a contractor, anyone with read access can run `git show d6b7cb2:public/images/portfolio/wedding-08.jpeg`. That returns full-size bridal originals together with:
- capture timestamps, which are the wedding dates;
- the photographer's camera and lens serial numbers.

This is exactly what the redo meant to keep out of published files.

**Fix.** Branch H-1. This is a history rewrite: it needs the owner's explicit approval and a backup first.
1. Before the first push, re-root the repo on a single fresh commit made from HEAD. That is the simplest option and covers every path. Alternatively, run `git filter-repo --invert-paths` over `public/images/portfolio/`, `public/images/brand-logo.jpeg` and each `public/images/products/*` original, **plus** the pre-`fa72b36` `public/images/site/` blobs.
2. Recreate or delete tag `design-classic-v1`.
3. Verify that `git rev-list --all --objects | grep -E 'portfolio/|brand-logo.jpeg'` prints nothing, and repeat the marker scan on `site/`.
4. Keep originals only in `../assets-originals/`.

**Verification.** config-headers-supplychain lens: 2 of 2 confirmed, one at MEDIUM and one at LOW. The MEDIUM skeptic found the leak is wider than reported (site/ variants, the tag ref). The LOW skeptic noted two limits:
- The same photos were publicly served by the old live site, so history adds little beyond what was already public.
- wedding-08's `CameraOwnerName` tag is empty, and no GPS coordinates are present.

---

### SEC-07 — CSP ships Report-Only with no reporting endpoint

**Severity:** LOW · **CWE:** CWE-693, CWE-79 (defense-in-depth)
**Location:** `public/_headers:27`, `src/lib/firebase.ts:149-150`

**Evidence**
```text
public/_headers:26-27
/*
  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'sha256-jNVT6TGjVN4dSmYJXmdcf7bMRJ0Iim1BVq+0kU6A4Lo=' https://apis.google.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; ... connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; ... frame-ancestors 'none'
(no report-uri / report-to / Reporting-Endpoints anywhere in the repo)

src/lib/firebase.ts:149-150
    const auth = getAuth(app)
    const ready = setPersistence(auth, browserLocalPersistence)
```
`wrangler.jsonc` sets `"run_worker_first": ["/api/*"]`, so `_headers` is the only source of headers for the SPA, and `index.html` has no meta CSP. The dynamic probe confirmed live on the preview host that `/` and `/admin` return `content-security-policy-report-only` and no enforcing header. The inline-script hash is correct; it was recomputed.

**Attack.** This is a backstop gap only. No HTML/script injection sink exists today: there is no `dangerouslySetInnerHTML`, `innerHTML` or `eval`, and React escapes all output. If one is ever introduced (for example a future receipt or gallery caption, or an admin view that renders customer text unsafely), injected script on the admin's `/admin` tab could:
1. read the persisted Firebase user record, including the refresh token;
2. send it with `fetch()` to an attacker host, which an enforced `connect-src` would block;
3. mint admin ID tokens at will from then on.

Without `report-to`, no violation ever reaches anyone, so the plan to "enforce once clean" has no production data behind it.

**Fix.** Commit C-10.
1. After the documented sign-in, registration and reset smoke test, rename the header to `Content-Security-Policy` and append `; upgrade-insecure-requests`.
2. Add `report-to csp` with `Reporting-Endpoints: csp="/api/csp-report"`, plus a small Worker route that stores only violated-directive and blocked-uri counts, rate-limited through the SEC-03 binding.
3. Consider `require-trusted-types-for 'script'`, since `src/` has no DOM-string sinks.
4. Optionally, the app only uses email/password, so switch to `initializeAuth(app, { persistence: [browserLocalPersistence] })` with no popup/redirect resolver. That lets you drop `https://apis.google.com` from `script-src` and the `firebaseapp.com` entry from `frame-src`. Verify reCAPTCHA flows first.
5. Keep the inline-script hash in sync with `index.html` through a CI check.

**Verification.** Merged from four lenses (injection-validation, config-headers, client-side, dynamic-probe). 7 of 7 votes confirmed; adjusted to LOW ×5, MEDIUM ×1 and INFO ×1, final LOW. Skeptic corrections:
- A compromised *first-party* bundle would pass `script-src 'self'` even under enforcement.
- Top-level-navigation exfiltration is not blocked by CSP.
- Clickjacking is already covered by `X-Frame-Options: DENY`.

Even at LOW this is a go-live gate: ADR §2.7 lists the CSP as a required control.

---

### SEC-08 — The "browse-only" preview Worker exposes the full write API on the production Firebase project; its noindex exists only in hand-edited `dist/`

**Severity:** LOW · **CWE:** CWE-668, CWE-1188
**Location:** `wrangler.jsonc:24-43`, `worker/index.ts:265-275`, `public/robots.txt:2`, `dist/client/_headers:51-53`

**Evidence**
```text
wrangler.jsonc:24-36
  // Preview for the owner and the photographer to review before launch
  // (build: CLOUDFLARE_ENV=preview npm run build, then npx wrangler deploy).
  // Its own empty database, no scheduled jobs, never the production data.
  "env": {
    "preview": {
      "name": "sundus-yar-preview",
      ...
      "vars": {
        "ONLINE_CONFIRMATION": "off",
        "FIREBASE_PROJECT_ID": "sundus-yar-website"
      },

worker/index.ts:265-275  (identical routing in every environment; no preview/read-only check anywhere)
      if (url.pathname === '/api/profile') {
        return await handleProfile(request, env)
      }
      if (url.pathname === '/api/bookings') {
        return await handleCreateBooking(request, env, ctx)
      }

public/robots.txt:2   Allow: /
dist/client/_headers:51-53 (not in public/_headers; no script or vite setting generates it)
  # Preview deployment only: keep this review copy out of search engines.
  /*
    X-Robots-Tag: noindex, nofollow
```
**Current state.** The preview is deployed on the account's public `workers.dev` subdomain, as the dynamic probe confirmed. The current preview bundle was compiled without Firebase config: the lead confirmed `` VITE_FIREBASE_API_KEY`,void 0 `` in `dist/client/assets/firebase-ZwDPWec7.js`. So **UI sign-in is impossible on the preview today.** That protection is accidental: README §Deploy says the build machine uses `.env.local` with the **production** Firebase values.

**Attack.** This is latent and becomes live on the next preview build made the documented way.
1. `CLOUDFLARE_ENV=preview npm run build` bakes in production Firebase sign-in and regenerates `dist/client/_headers` from `public/_headers`, which silently drops the noindex.
2. A real customer who reaches the preview (through a forwarded review link or search indexing) signs in with her production account. The aud is the same project, so her token is valid.
3. She submits her name, phone and wedding date into the unmonitored `sundus-yar-preview` D1. There are no crons and no email secrets there, so nobody ever sees the booking, and her PII sits outside PDPL records, retention and DSR.

No attacker gains privileges from this: the preview D1 is empty, and the admin check needs a role that nothing assigns there.

**Fix.** Commit C-8.
1. Add `"PREVIEW_READ_ONLY": "on"` to `env.preview.vars`. In `worker/index.ts`, before routing, return `503 PREVIEW_READ_ONLY` for any non-GET `/api/*` request and for `/api/profile`, `/api/bookings*` and `/api/admin*`.
2. Generate the preview noindex reproducibly (a Vite plugin or post-build step keyed on `CLOUDFLARE_ENV=preview`), or set it in source.
3. Put the preview host behind Cloudflare Access, limited to the owner's and photographer's emails.
4. If an authenticated preview is ever needed, give it a separate Firebase project.
5. Run `wrangler delete --env preview` once the review is over.

**Verification.** Merged from three reports. 4 of 4 votes confirmed; adjusted to LOW ×3 and INFO ×1, final LOW.
- authn-authz ("preview has the full authenticated write API"): 1/1, LOW.
- config-headers ("fully writable public copy of the API"): 2/2, both LOW.
- client-side ("noindex only in a hand-edited dist file"): 1/1, INFO.

A related data-protection report rated MEDIUM was refuted (Appendix A, R-1), because it assumed sign-in works on today's preview build.

---

### SEC-09 — Item quantities have no upper bound (totals up to about 9×10^15 SAR are accepted)

**Severity:** LOW · **CWE:** CWE-1284
**Location:** `shared/booking.ts:495-504`, `shared/booking.ts:202-208`

**Evidence**
```text
shared/booking.ts:495-498
  if (
    !isPrintQuantities(value.printQuantities) ||
    !isNonNegativeSafeInteger(value.magazineQuantity) ||
    !isNonNegativeSafeInteger(value.woodenEnlargementQuantity)
  ) {

shared/booking.ts:202-208
function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}
```
A scratch run of `validateBookingSelection({…, printQuantities:{a6:100000000000,a5:0,a4:0}, woodenEnlargementQuantity:1000000000})` returned `ok=true, estimatedTotal=1380000001600`. The only ceiling is `Number.isSafeInteger(estimatedTotal)` (line 606). The DB CHECKs only require an integer ≥ 0, and the configurator has no maximum.

**Attack.** A verified customer posts `"printQuantities":{"a6":692000000000000,…}`. The server stores `estimated_total ≈ 9.0×10^15`. The admin list, the detail view, and both new-booking emails then show that absurd total, which could be used to dispute a quote. The price cannot be *lowered*, so this is an integrity issue, not fraud.

**Fix.** Commit C-12.
1. Add per-item maximums to the catalog, for example prints ≤ 200 per size, magazines ≤ 20, wooden ≤ 10.
2. Enforce them in `validateBookingSelection` (`INVALID_QUANTITY`).
3. Mirror them as `max=` on the configurator inputs.
4. Optionally add `CHECK (estimated_total <= 1000000)` in the next migration.

**Verification.** injection-validation 1/1 LOW, business-logic 1/1 LOW, final LOW. Skeptic correction: only the admin sets `deposit_amount`, and the worker has no revenue aggregation, so the deposit-ceiling and reporting impacts are speculative.

---

### SEC-10 — Customer names accept bidi controls, line separators and URLs; legacy email templates and the admin UI render them without isolation

**Severity:** LOW (tie LOW/INFO resolves to the higher value) · **CWE:** CWE-116, CWE-451
**Location:** `worker/profile.ts:60-73`, `worker/email-templates.ts:384-385`, `worker/email-templates.ts:395`, `worker/email-templates.ts:417`, `src/components/AdminDashboard.tsx:300-302`

**Evidence**
```text
worker/profile.ts:64-67  (rejects C0/C1 only; U+061C, U+200B-200F, U+202A-202E, U+2066-2069, U+2028, U+2029 pass)
    if (
      characterCode <= 0x1f ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {

worker/email-templates.ts:384-385, 395, 417  (admin new-booking email; the name never passes stripBidiControls)
  const customerName =
    `${input.customerFirstName.trim()} ${input.customerLastName.trim()}`.trim()
    `اسم العميلة: ${customerName}`,
        ['اسم العميلة', customerName],

src/components/AdminDashboard.tsx:300-302  (no <bdi>; same at :627-629 and BookingActions.tsx:404-406)
        <span>
          {booking.customer.firstName} {booking.customer.lastName}
        </span>
```
The correct helpers already exist but are not applied here: `stripBidiControls` at `worker/email-templates.ts:133`, and `sanitizeFirstName` at `worker/emails/hold.ts:95-96`.

**Attack.** A customer sets `firstName = "https://evil.example/admin-login"` and puts U+202E or U+2029 in `lastName`, then submits a booking. The owner's "new booking" email, the most trusted email the single admin receives, shows a URL in the customer-name row that mail clients auto-link. The plain-text line is split into a fake line, and the admin UI shows the name reordered. HTML escaping prevents script injection, so the impact is content spoofing aimed at the admin. The customer-facing templates only reach the customer's own inbox, so they have no victim.

**Fix.** Commit C-13.
1. In `normalizeName` (worker) and `normalizeProfileInput` (SPA), NFC-normalize names and reject categories Cc, Cf, Zl and Zp. Optionally allow only `/^[\p{L}\p{M}][\p{L}\p{M} '\-]{0,79}$/u`, which also rules out URLs.
2. Pass names through `sanitizeFirstName`/`stripBidiControls` in `renderAdminNewBookingTemplate`, `renderCustomerBookingReceivedTemplate` and `renderCustomerBookingStatusTemplate`.
3. Wrap rendered names in `<bdi>` in the admin UI.

**Verification.** injection-validation 1/1 LOW, client-side 1/1 INFO; tie, final LOW.

---

### SEC-11 — No token revocation or disabled-account check; access continues for up to about 60 minutes after incident response

**Severity:** LOW · **CWE:** CWE-613
**Location:** `worker/auth.ts:84-98`

**Evidence**
```text
worker/auth.ts:84-98  (signature and claims only; no tokens-valid-after comparison, no disabled check)
    const { payload, protectedHeader } = await jwtVerify(
      token,
      firebasePublicKeys,
      {
        algorithms: ['RS256'],
        audience: projectId,
        issuer,
        requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
      },
    )
```

**Attack.** After a suspected admin compromise, the owner resets the password or disables the Firebase account. The attacker's already-issued ID token, valid for up to 1 h, still passes. Because the stolen account is the owner's own, its D1 role is still `admin`, so the attacker keeps reading and changing bookings until the token expires.

**Fix.** Commit C-14.
1. Add a `users.tokens_valid_after` column, and reject any token with `payload.iat < tokens_valid_after`.
2. Set that column from the incident runbook, together with a password reset.
3. Document that demoting the D1 role is the immediate kill switch. That requires a second admin, or accepting a temporary lockout.

**Verification.** authn-authz 1/1 confirmed, LOW.

---

### SEC-12 — No Strict-Transport-Security or Cross-Origin-Opener-Policy header

**Severity:** LOW · **CWE:** CWE-319, CWE-1021
**Location:** `public/_headers:26-31`, `worker/http.ts:16-18`

**Evidence**
```text
public/_headers:26-31  (the /* block)
/*
  Content-Security-Policy-Report-Only: ...
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()

worker/http.ts:16-18  (jsonResponse)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', 'no-store')
```
The dynamic probe found no `Strict-Transport-Security` on `GET /` or `GET /api/health`. The README's custom-domain checklist (around line 567) does not mention HSTS.

**Attack**
- **COOP (reachable today).** An attacker page calls `w = window.open('https://<site>/admin')` and keeps the handle. After the admin signs in, the page sets `w.location` to a pixel-identical phishing clone that asks her to sign in again (reverse tabnabbing). X-Frame-Options does not help against `window.open`.
- **HSTS (latent).** `*.workers.dev` sits under the HSTS-preloaded `.dev` TLD, so there is no exposure today. Once the custom `.com`/`.sa` domain is attached, a bride or the admin on hostile Wi-Fi who types the bare domain can be SSL-stripped and served a look-alike sign-in dialog.

**Fix**
- **Commit C-9.**
  1. Add `Cross-Origin-Opener-Policy: same-origin` to the `/*` rule. It does not break auth, because the app has no `signInWithPopup` or `signInWithRedirect`.
  2. Add `Strict-Transport-Security: max-age=63072000; includeSubDomains` to `jsonResponse`.
- **At custom-domain cut-over.**
  1. Add the same HSTS header to `/*` in `_headers`, and add `; preload` plus a preload-list submission once the domain is final (a non-preloaded header does not protect the first visit).
  2. Enable "Always Use HTTPS" on the zone.
  3. Add HSTS to the README checklist.

**Verification.** Merged from three reports. 3 of 3 confirmed; adjusted to LOW ×2 and INFO ×1, final LOW.
- config-headers ("no HSTS"): 1/1, INFO.
- client-side ("no HSTS or COOP"): 1/1, LOW.
- dynamic-probe ("no HSTS"): 1/1, LOW.

---

### SEC-13 — Worker version Preview URLs are left at Cloudflare's default (on)

**Severity:** LOW · **CWE:** CWE-1188
**Location:** `wrangler.jsonc:1-9`

**Evidence**
```text
wrangler.jsonc:1-9  (no "workers_dev", no "preview_urls", no "routes")
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "sundus-yar-website",
  "compatibility_date": "2026-08-19",
  "main": "./worker/index.ts",
  "assets": { ... },

node_modules/wrangler/wrangler-dist/cli.js:142697-142701 (wrangler 4.124.0)
  const defaultWorkersDev = routes.length === 0;
  const defaultPreviewUrls = void 0;
  const preview_urls = config_preview_urls ?? defaultPreviewUrls;
```

**Attack.** Each deployed version stays callable at `<8-hex>-sundus-yar-website.<subdomain>.workers.dev`, running *that version's code* against the production D1 binding. After a fix from this report is deployed, anyone holding an older version URL can still call the unfixed code against production data. Those URLs appear in wrangler output, the dashboard, CI logs and review screenshots. The prefix cannot be brute-forced, so exploitation needs a leaked URL.

**Fix.** Commit C-8.
1. Add `"preview_urls": false` at the top level of `wrangler.jsonc`; it is inheritable.
2. When the custom domain is attached, add `"routes": [{ "pattern": "<domain>", "custom_domain": true }]` and `"workers_dev": false`.
3. Check the dashboard state as well (check O-3).

**Verification.** config-headers 1/1 confirmed, LOW.

---

### SEC-14 — Pseudonymisation can be undone by `PUT /api/profile`

**Severity:** LOW · **CWE:** CWE-841
**Location:** `worker/profile.ts:317-322`

**Evidence**
```text
worker/profile.ts:317-322  (no `WHERE users.erased_at IS NULL`; erased_at is never read by profile.ts, bookings.ts or admin.ts)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          phone = excluded.phone,
          updated_at = CURRENT_TIMESTAMP
```

**Attack.** The owner runs the §6.5 pseudonymise procedure (email → `erased+<uid>@erased.invalid`, names and phone → `-`, `erased_at` set). Before the manual Firebase-deletion step, or with a cached ID token valid for up to 1 h after it, the subject's token can PUT the profile again. That rewrites the real email, name and phone while `erased_at` stays set. The retained bookings are re-linked to a named person in the admin dashboard, while the hold jobs still suppress her emails. The erasure record is now false.

**Fix.** Folded into commit C-2 because it is the same SQL statement.
1. Use `ON CONFLICT(id) DO UPDATE SET … WHERE users.erased_at IS NULL`, check `meta.changes`, and return `410 ACCOUNT_ERASED` when nothing changed.
2. Treat an erased uid as unauthenticated on every customer route.
3. Script the Firebase account deletion as part of the same procedure.

**Verification.** data-protection 1/1 confirmed, LOW. Only the data subject, or whoever controls her account, can do this.

---

### SEC-15 — Registration collects PII and transfers it abroad with no privacy notice

**Severity:** LOW · **CWE:** CWE-359
**Location:** `src/components/AuthDialog.tsx:1091-1166`

**Evidence**
```text
src/components/AuthDialog.tsx:1091-1166
  label="الاسم الأول" (first name), label="اسم العائلة" (family name), label="رقم الجوال" (1113, mobile number),
  label="البريد الإلكتروني" (email), password fields, then the submit button 'إنشاء الحساب' (1166, "create account").
  There is no notice text or link.
Routes: '/', '/portfolio', '/packages', '/my-bookings', '/admin' (src/layout/route-meta.ts); no privacy route.
```
`02-compliance.md` (around lines 54 and 157) lists the privacy notice as an unmet build requirement. The TrustSection «خصوصيتكِ أولًا» ("your privacy first") copy covers photo consent only.

**Attack.** This is a compliance exposure. Every registration sends identity and contact data to Firebase (US), Cloudflare D1 (outside KSA) and later Resend, without disclosing the controller, the purposes, the recipients or the transfer countries. Any data subject or SDAIA has a straightforward PDPL complaint for every account created.

**Fix.** Commit C-11.
1. Add a `/privacy` route naming the processors and their countries, the retention periods and the DSR contact.
2. Link it from `SiteFooter`, and add one line directly above the register and profile-completion submit buttons.
3. Record the notice version shown to each user.

**Verification.** data-protection 1/1 confirmed, LOW.

---

### SEC-16 — Portal dispatchers leave booking-ownership and signed-URL checks to each future handler

**Severity:** INFO · **CWE:** CWE-639
**Location:** `worker/portal/portal-routes.ts:94-95`, `worker/portal/portal-routes.ts:398-404`

**Evidence**
```text
worker/portal/portal-routes.ts:94-95
  /** Decoded booking id from the path. Ownership is NOT checked yet. */
  readonly bookingId: string

worker/portal/portal-routes.ts:398-404  (dispatchMediaRequest: no authentication or signature check before the handler)
  return handler({
    request,
    env,
    ctx,
    url,
    params: match.rawParams,
  })
```
All three registries (`customerPortalRoutes`, `mediaRoutes`, `adminPortalRoutes`) are empty at HEAD, so nothing is exposed today.

**Attack.** This is future risk. When W4-1 and later work registers a route such as `GET /api/bookings/:bookingId/confirmation`, one handler that forgets `AND user_id = ?` would let any verified customer read another customer's booking, deposit, bank details or receipt. Booking ids leak through email links and screenshots. Likewise, one media handler that skips the HMAC and expiry check would serve private bridal photos to anyone who has the path.

**Fix.** Commit C-16, which must land before any portal or media route is registered.
1. In `dispatchCustomerPortalRequest`, run `SELECT id FROM booking_requests WHERE id = ? AND user_id = ?` once, return `404 BOOKING_NOT_FOUND` if it fails, and pass an `OwnedBooking` to the handler.
2. In `dispatchMediaRequest`, verify the signed-URL HMAC and expiry before dispatching.
3. Keep the per-handler `user_id` filter as a second layer.

**Verification.** authn-authz 1/1 confirmed, INFO.

---

### SEC-17 — No retention or erasure implementation; the daily cron runs only the heartbeat

**Severity:** INFO (reported LOW) · **CWE:** CWE-359
**Location:** `worker/jobs/registry.ts:19-25`, `migrations/0005_portal_schema.sql:53`, `migrations/0001_initial.sql:61,69`

**Evidence**
```text
worker/jobs/registry.ts:19-25  (quarter-hourly jobs only; nothing has schedule 'daily')
export const scheduledJobs: readonly ScheduledJob[] = [
  holdExpiryJob,
  holdRemindersJob,
  outboxDrainJob,
]
migrations/0005_portal_schema.sql:53   ALTER TABLE users ADD COLUMN erased_at TEXT     (no writer anywhere)
migrations/0001_initial.sql:61          admin_notes TEXT,
migrations/0001_initial.sql:69          ON DELETE RESTRICT
```

**Attack.** Nothing prunes profiles that never book, nor `admin_notes` (up to 2,000 characters of free text about a bride), nor status-history notes, so they are kept forever. That includes the orphan and squatted rows from SEC-04. Any future D1 breach would therefore expose every profile ever created, not only those inside the retention window.

**Fix.** Commit C-19.
1. Implement the daily `retention_prune` and text-purge jobs already specified in 06-data-model §6.4 (W8-2): booking-less profiles after 12 months, terminal outbox rows after 180 days, and `admin_notes` NULLed 90 days after terminal status.
2. Register them with `schedule: 'daily'`.
3. Ship the §6.5 erase and pseudonymise procedure as an audited script instead of ad-hoc SQL.

**Verification.** data-protection 1/1 confirmed, adjusted to INFO. The skeptic noted that §6.5 already has erase SQL that handles the RESTRICT foreign key, and that the retention jobs are roadmap-tracked (W8-2, D11/R9). It is not attacker-exploitable, but it is a PDPL gap.

---

### SEC-18 — Full name is copied into Firebase Auth `displayName` but never used

**Severity:** INFO (reported LOW) · **CWE:** CWE-359
**Location:** `src/auth/AuthContext.tsx:776-779`, `src/auth/AuthContext.tsx:912-915`

**Evidence**
```text
src/auth/AuthContext.tsx:776-779  (registration; same at 912-915 in profile completion)
        await resources.sdk.updateProfile(createdUser, {
          displayName:
            `${normalizedProfile.firstName} ${normalizedProfile.lastName}`,
        })
```
No server code reads the `name` claim: `worker/auth.ts:131-135` returns only uid, email and emailVerified.

**Attack.** This keeps an unneeded second copy of every registrant's full name with a US processor. The name is also placed in the `name` claim of every ID token and in persisted browser storage. It is data minimisation only: an attacker with browser storage access can already get the name through `/api/profile`.

**Fix.** Commit C-15.
1. Delete both `updateProfile({ displayName })` calls.
2. Clear `displayName` once on next sign-in for existing accounts.

(Switching persistence to IndexedDB would not reduce the exposure.)

**Verification.** data-protection 1/1 confirmed, adjusted to INFO.

---

### SEC-19 — The approve path sets a 24 h hold that nothing enforces; past-dated requests can be approved

**Severity:** INFO · **CWE:** CWE-841
**Location:** `worker/admin-workflow.ts:28`, `worker/admin-workflow.ts:601-613`, `worker/jobs/hold-state.ts:29`

**Evidence**
```text
worker/admin-workflow.ts:28
const APPROVAL_HOLD_DURATION_MILLISECONDS = 24 * 60 * 60 * 1_000
worker/admin-workflow.ts:606-613  (never sets flow_version or deposit_amount; no event_date >= today guard)
      UPDATE booking_requests
      SET
        status = ?,
        hold_expires_at = CASE
          WHEN ? = 'approved_hold' THEN ?
worker/jobs/hold-state.ts:29   b.flow_version = 2      (both hold jobs select only flow 2)
shared/timing.ts:22            holdWindowMs: 48 * HOUR_MS   (unused by approve)
```

**Attack.** No external attacker gains anything: every transition is admin-only, and the double-booking invariant holds. The business effects are:
- An approved flow-1 request can stall indefinitely, blocking the date for other brides until the admin cancels it. This matches the documented "drain by hand" design for flow 1.
- Switching `ONLINE_CONFIRMATION` to `on` does not change approvals.
- An admin can approve a request whose event date has passed.

**Fix.** Commit C-17, before flow 2 goes live.
1. Under `isOnlineConfirmationOn(env)`, set `flow_version = 2`, `deposit_amount` and `hold_expires_at = now + TIMING.holdWindowMs` in the same guarded UPDATE.
2. Call `expireOverdueHolds` for the date before the `DATE_UNAVAILABLE` check.
3. Add `AND event_date >= ?riyadhToday`.

**Verification.** business-logic 1/1 confirmed, INFO. Most of this is planned work item W4-2. The only live gap is past-date approval.

---

### SEC-20 — No recent-authentication requirement for future private-media customer routes

**Severity:** INFO · **CWE:** CWE-613
**Location:** `worker/auth.ts:111-112`, `src/lib/firebase.ts:150`

**Evidence**
```text
worker/auth.ts:111-112   !isValidNumericDate(authTime) || authTime > currentTime ||   (no maximum age)
src/lib/firebase.ts:150  const ready = setPersistence(auth, browserLocalPersistence)
```

**Attack.** On a shared family tablet, a relative who opens the site weeks later is still signed in as the bride and can read `/api/bookings/me` today. After Run 6, the same person could open her private gallery, because the private-media routes (currently closed by the R2 gate) have no re-authentication requirement.

**Fix.** Commit C-18.
1. On routes gated `private-media`, require `currentTime - auth_time <= 12h` and return `401 REAUTH_REQUIRED`, which the SPA turns into `reauthenticateWithCredential`. Reuse the helper from SEC-02.
2. Optionally use session persistence unless the user picks "remember me".

**Verification.** data-protection 1/1 confirmed, INFO.

---

## 4. Controls verified correct (baseline to preserve)

At least one lens verified each of these and found it correctly implemented. Future changes must not regress them.

- **Token verification** (`worker/auth.ts`):
  - `jose` `jwtVerify` with `algorithms:['RS256']`, plus an explicit header re-check for `kid`;
  - iss and aud pinned to the project; `exp`, `iat`, `auth_time` and `sub` required and range-checked;
  - `email_verified` must be exactly `true` wherever `requireVerifiedEmail` is called; tokens with no email claim are rejected;
  - the JWKS is cached.
  - The dynamic probe confirmed live that `alg=none`, HS256-empty-key, expired and garbage tokens all return 401.
- **No self-promotion.** `PUT /api/profile` has an exact key allowlist, always inserts role `'customer'`, and never updates the role.
- **Admin guard.** Every `/api/admin/*` path, legacy and portal, runs `authorizeAdminRequest` before any routing, with the role read from D1 on each request. Path-normalisation tricks did not bypass it in the live probe.
- **Owner scoping.** `/api/bookings/me` and `POST /api/bookings` bind `user_id` to the token uid in SQL. Customer responses never include admin notes or other users' data. No customer route takes a booking id today.
- **Injection.**
  - All D1 SQL uses `.bind()`; the only template-literal SQL is constant fragments.
  - No ReDoS. `__proto__` and duplicate JSON keys are rejected.
  - Email HTML is fully escaped; URLs are limited to http(s); subjects and idempotency keys reject control characters; recipients pass strict validation.
- **Pricing.** The server recomputes every amount from its own table and ignores any client total.
- **Booking integrity.**
  - Double-booking is prevented by an atomic `INSERT … WHERE NOT EXISTS` plus the partial UNIQUE index `ux_booking_requests_blocking_event_date`.
  - Transitions follow a strict allow-list with an optimistic `AND status = ?` lock and a history insert guarded by `changes()`.
  - Blocked dates are checked atomically on both sides.
  - "Today" is computed in the Asia/Riyadh timezone and fails closed.
  - Cron jobs are idempotent (dedupe keys, claim marks, stale-claim recovery).
- **Browser surface.**
  - No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `postMessage` listeners or `javascript:` URLs.
  - In-app navigation refuses cross-origin targets. WhatsApp links use a fixed `wa.me` host with an encoded message. All `target="_blank"` links carry `rel="noopener noreferrer"`.
  - Bearer tokens are sent only to relative `/api` paths.
- **Transport and caching.** No `Access-Control-*` headers anywhere, so there is no CORS or CSRF surface with bearer auth. API responses are `no-store` with nosniff. Errors come back in a uniform envelope with no stack traces. `X-Frame-Options: DENY`.
- **PDPL R2 gate.** `/api/media/*` returns 503 for the whole namespace, and receipt, gallery and media route templates are gated before auth. `PDPL_SIGNOFF_REF` is absent, and every portal registry is empty.
- **Logging and PII.**
  - Worker logs contain fixed codes only, and `src/` makes no console calls.
  - `notification_log` recipient and payload are NULLed at every terminal status (CHECK-enforced).
  - URLs carry no PII.
- **Secrets and build.**
  - No secrets in any `VITE_*` variable, the git history (all 11 commits scanned) or `dist/`.
  - No source maps. `.gitignore` covers env files, `.dev.vars*` and `.wrangler/`. `.assetsignore` excludes `wrangler.json` and `.dev.vars`.
  - The current `public/images` (273 files) carry no EXIF/XMP/IPTC.
- **Dependencies.**
  - `npm audit --omit=dev`: 0 vulnerabilities across 93 production dependencies.
  - Full audit: 4 high, all from GHSA-rgj7-g3m4-5g8c in the dev-only `miniflare/node_modules/sharp@0.35.2`. This is unreachable because no Images binding is declared.
  - The lockfile resolves every package from the npm registry with integrity hashes.

---

## 5. Coverage

All seven lenses completed and returned verified output. None failed.

| Lens | Examined | Notable gaps it declared |
|---|---|---|
| **authn-authz** | All of `worker/auth.ts`, `admin-auth.ts`, `http.ts`, `index.ts` (every route), `profile.ts`, `bookings.ts` and `admin.ts` (1324 lines); `admin-workflow.ts`; all `worker/portal/*`; migrations 0001, 0004, 0006 and parts of 0003/0005; `wrangler.jsonc`; `_headers`; the README admin-promotion sections; the relevant parts of 05/07/decisions/09-red-team; the AuthContext sign-up flow; jose JWKS cache defaults | Live Firebase console (enumeration protection, MFA, authorized domains); production D1 contents (decides whether the SEC-01 window is still open); `scheduled.ts` and the jobs only for recipient sourcing; `src/` beyond sign-up; `shared/booking.ts` beyond `validateBookingSelection` |
| **injection-validation** | Every worker module including `email*.ts`, `emails/hold.ts`, `scheduled.ts`, `notify/outbox.ts`, `jobs/*` and `portal/*`; `shared/booking.ts`, `admin.ts`, `timing.ts` and `notifications.ts`; migrations 0001/0003–0006; SPA sinks, name rendering, `whatsapp.ts`, `api/admin.ts` path building and configurator quantities; scratch-run probes of the validators | Runtime Firebase/Cloudflare behaviour (whether `updateEmail` is enabled, the plan's body limit); the rest of `shared/journey.ts`; most SPA components beyond sinks |
| **config-headers-supplychain** | `wrangler.jsonc` (prod and preview), `_headers`, `robots.txt`, `index.html` (CSP hash recomputed), package and lockfile, `vite.config.ts`, `.gitignore`, worker env typings, catch blocks, `src/lib/firebase.ts`, `dist/`, `.wrangler/deploy`, README deploy and security sections; git history secret scan; EXIF scan of current and historical images; `npm audit` (production and full); install scripts | Live deployed headers; Firebase console (API-key referrer restrictions, sign-up settings); Cloudflare dashboard (actual Preview URL state, Access, zone settings); Resend quota. Historical photo *content* was deliberately not viewed. |
| **data-protection** | Worker auth, profile, bookings, admin, email, notify, jobs and portal modules for PII flow; all migrations; `_headers`, `robots.txt`; SPA auth, storage, URL and egress points; `dist/` metadata; decisions, 05, 06 §6.4–6.5, 07, 02-compliance | Live Cloudflare/Firebase config (preview deployment status, Access, enumeration protection, Workers Logs, D1 Time Travel); the Resend account; test files; `.wrangler` local state. The PDPL gate is word-based, so a future route named with a synonym ("images", "deposit-proof", "files") and marked `open` would not be caught. This is noted for the Run 4/6 reviews. |
| **business-logic** | `bookings.ts`, `admin-workflow.ts`, the `shared/admin.ts` transition table, `shared/booking.ts` pricing, `index.ts` availability, `scheduled.ts`, all `jobs/*`, `notify/outbox.ts` SQL, `shared/timing.ts`, all migrations; relevant parts of `journey.ts`, `admin.ts`, the auth modules, calendar, configurator and packages; design docs 05/06/07 | Production D1 state (whether index 0004 is applied; the code-level guard covers it either way); Firebase settings; Resend quota. Flow-2 portal routes are empty and so could not be attacked. |
| **client-side** | The SPA router and navigation, `route-search.ts`, every WhatsApp link builder, the api-client and auth modules, sink grep across `src/` and `shared/`, `target=_blank` audit, admin UI gating versus server enforcement, `localStorage` contents, `dist/client` (source maps, secrets, image metadata), CSP hash, `npm audit` | Live `_headers` on SPA-fallback responses. **This gap is closed by the dynamic probe**, which observed the CSP-RO header on `/` and `/admin`. Firebase console settings; in-browser runtime (the app was not run). |
| **dynamic-probe** | About 46 non-destructive requests against the owner's preview deployment: every public and protected route with none, garbage, `alg=none`, HS256 and expired tokens; wrong methods; path-normalisation tricks; CORS preflight with a foreign Origin; a 2 MB and a malformed POST; availability range edge cases; live header inspection | **The production host was not probed.** Authenticated flows were not exercised because no test account was used, so body-size and business-logic behaviour behind auth rests on source review. It did not read the SPA code, email templates, `admin-workflow.ts`, jobs or migrations; the other lenses cover those. |

**Consolidated gaps.** These need an owner with console access; nobody in this audit had it.
1. **Firebase console:** Email Enumeration Protection (affects the SEC-04 misdirection variant), password policy, authorized domains (must not include the preview host), API-key HTTP-referrer restriction, and whether any MFA is enrolled.
2. **Production D1:** whether the owner is registered and promoted, and under which uid (SEC-01); whether migration 0004 is applied.
3. **Cloudflare dashboard:** whether version Preview URLs are currently enabled (SEC-13), Access policies, Workers Logs retention, zone HSTS and "Always Use HTTPS" (once a domain exists).
4. **Resend:** the plan's daily and monthly quota, which sizes the SEC-03 impact.
5. **Live production host:** its headers were not fetched; only the preview was probed.
6. **Runtime:** the SPA was not run in a browser. No authenticated end-to-end test was performed.

---

## 6. Fix plan

Each row is one small commit that can be reviewed and reverted on its own. **Gate** marks what must land before production go-live, meaning before real customer data is accepted on the production host. Per the team's working rule, each commit goes through the multi-agent review and attack pass before merge. The listed findings serve as that commit's regression test.

### 6.0 Operational checks — no code, do now

| # | Action | Finding |
|---|---|---|
| O-1 | Production D1: run `SELECT id, email, role FROM users WHERE role='admin'` and compare each `id` with the uid of the owner's **verified** account in the Firebase console. If the owner is not yet promoted, promote by uid only (the C-1 runbook). | SEC-01 |
| O-2 | Firebase console: confirm Email Enumeration Protection is **on**; record the password policy; make sure authorized domains do not include the preview host. | SEC-04, SEC-08 |
| O-3 | Cloudflare dashboard: disable version Preview URLs for `sundus-yar-website` now, ahead of C-8. | SEC-13 |
| O-4 | Do **not** rebuild or re-share the preview until C-8 lands. Do **not** add a git remote or push until H-1 is done. | SEC-08, SEC-06 |
| O-5 | Record the Resend plan quota to size the SEC-03 limits. | SEC-03 |

### 6.1 Go-live blockers (must land before production go-live)

| # | Commit | Findings | Files | Depends on / notes |
|---|---|---|---|---|
| C-1 | `admin: bind admin to uid + current verified email; promote by uid in runbook` | SEC-01 (a, b) | `worker/admin-auth.ts`, `README.md:179`, `README.md:564` | None. Very small. |
| C-2 | `profile: never let an unverified token own users.email; respect erased_at` | SEC-04, SEC-01 (c), SEC-14 | `migrations/0007_users_email_verified.sql` (add `email_verified_at`), `worker/profile.ts` (conditional upsert, reclaim of unverified conflicting rows with no bookings, `WHERE erased_at IS NULL` → 410), `worker/bookings.ts` (re-sync email from the verified token) | Apply the migration **before** deploying the Worker. Keep the unverified-PUT registration flow working; do not add `requireVerifiedEmail`. |
| C-3 | `bookings: per-user open-request cap and booking horizon` | SEC-03 | `worker/bookings.ts` (INSERT `WHERE` count, horizon check), `shared/timing.ts` (horizon constant), `src/components/BookingCalendar.tsx` (max date) | None |
| C-4 | `worker: rate-limit booking and profile writes` | SEC-03 | `wrangler.jsonc` (`ratelimits` in prod and `env.preview`), `worker/bookings.ts`, `worker/profile.ts`, `worker/platform-env.d.ts`; update 05-adr §2.7 and 07-api §1.9 | Create the Cloudflare rate-limit namespace first. |
| C-5 | `worker: bounded JSON body reader for all legacy handlers` | SEC-05 | `worker/http.ts` (shared reader moved from `admin-workflow.ts`), `worker/profile.ts`, `worker/bookings.ts`, `worker/admin.ts` | None |
| C-6 | `auth(spa): MFA sign-in resolver, TOTP enrollment, re-auth prompt` | SEC-02 (part 1) | `src/auth/AuthContext.tsx`, `src/components/AuthDialog.tsx`, admin enrollment UI | Must be **deployed before** TOTP is enabled in the console. |
| C-7 | `admin-auth: require TOTP second factor and 12 h auth_time` | SEC-02 (part 2), R1 | `worker/auth.ts` (return `sign_in_second_factor` and `auth_time`), `worker/admin-auth.ts` | After C-6 is live **and** the owner has enrolled TOTP. |
| C-8 | `preview: enforce browse-only; disable version preview URLs` | SEC-08, SEC-13 | `wrangler.jsonc` (`PREVIEW_READ_ONLY`, `"preview_urls": false`), `worker/index.ts` (read-only guard), build step or source for preview noindex | Also add Cloudflare Access on the preview host (dashboard). |
| C-9 | `headers: COOP on SPA; HSTS on API responses` | SEC-12 | `public/_headers`, `worker/http.ts`, README custom-domain checklist | Add HSTS to `_headers` `/*` in the custom-domain cut-over change, together with "Always Use HTTPS". |
| C-10 | `headers: enforce CSP with violation reporting` | SEC-07 | `public/_headers` (rename, `upgrade-insecure-requests`, `report-to`, `Reporting-Endpoints`), `worker/index.ts` plus a small `/api/csp-report` handler, CI hash check | After the documented sign-in, registration and reset smoke test; use the C-4 limiter on the report route. |
| C-11 | `site: privacy notice route and point-of-collection links` | SEC-15 | New `/privacy` page, `src/layout/route-meta.ts`, `SiteFooter`, `AuthDialog.tsx` | The text needs owner and legal sign-off (02-compliance). |
| H-1 | *History rewrite (not a normal commit)* | SEC-06 | Re-root on a fresh commit from HEAD, or `git filter-repo` over the listed paths including pre-`fa72b36` `site/` blobs; recreate tag `design-classic-v1` | **Before the first push.** Destructive, so it needs the owner's explicit approval and a backup. |

### 6.2 Recommended before go-live (small, low risk)

| # | Commit | Findings | Files |
|---|---|---|---|
| C-12 | `booking: per-item quantity ceilings` | SEC-09 | `shared/booking.ts`, `src/data/packages.ts`, `src/components/PackageConfigurator.tsx` |
| C-13 | `names: reject bidi and format characters; isolate names in the admin UI and legacy emails` | SEC-10 | `worker/profile.ts`, `src/auth/AuthContext.tsx`, `worker/email-templates.ts`, `src/components/AdminDashboard.tsx`, `src/components/BookingActions.tsx` |
| C-14 | `auth: tokens_valid_after revocation check and incident runbook` | SEC-11 | `migrations/0008_…`, `worker/auth.ts`, README incident section |
| C-15 | `auth(spa): stop copying the full name into Firebase displayName` | SEC-18 | `src/auth/AuthContext.tsx` |
| C-19 | `jobs: daily retention_prune and text purge; scripted erase` | SEC-17 | `worker/jobs/retention-*.ts`, `worker/jobs/registry.ts`, `scripts/erase-customer.*` (hard deadline: 90 days after the first booking reaches a terminal status, the first `admin_notes` purge window) |

### 6.3 Before Run 4/6 (flow 2, receipts, galleries) opens the PDPL gate

| # | Commit | Findings | Files |
|---|---|---|---|
| C-16 | `portal: central ownership and signed-URL verification in the dispatchers` | SEC-16 | `worker/portal/portal-routes.ts`. Must land **before** any customer, media or admin-portal route is registered. |
| C-17 | `admin-workflow: enter flow 2 on approve; targeted expiry; no past-date approval` | SEC-19 | `worker/admin-workflow.ts`, `worker/jobs/hold-expiry.ts` |
| C-18 | `portal: recent-auth requirement for private-media routes` | SEC-20 | `worker/portal/request.ts`, a shared auth-age helper from C-7, SPA re-auth prompt |
| — | Confirm C-6/C-7 (MFA) are live | SEC-02 | SEC-02 is re-rated **HIGH** if the gate opens without them. |

### 6.4 Housekeeping

- Bump `wrangler` and `@cloudflare/vite-plugin` to clear the dev-only `sharp` advisory GHSA-rgj7-g3m4-5g8c (not reachable, no runtime impact).
- For Run 4/6 route reviews: the PDPL gate matches route names by keyword. Any new private route must use the gated vocabulary (receipt, gallery, album, photo, media) or be explicitly declared `private-media`.

---

## Appendix A — Refuted

| # | Lens | Reported title (severity) | Votes | Why it was refuted |
|---|---|---|---|---|
| R-1 | data-protection | "The 'browse-only' preview Worker is a full sign-up and booking app on the production Firebase project, so real customer PII lands in an unmanaged database" (MEDIUM) | 0 of 2 confirmed | Both skeptics showed that the attack's premises are false for the build that actually exists. (1) The preview bundle was compiled with every `VITE_FIREBASE_*` value set to `void 0`, so `getFirebaseAuthInitialization()` returns `CONFIGURATION_UNAVAILABLE` and no one can sign up or sign in there. The "firebaseapp.com" string cited is a generic SDK message, not a configured authDomain. (2) `dist/client/_headers` does send `X-Robots-Tag: noindex, nofollow` for the preview. Someone who hand-crafts API calls with a production token only writes their own data, so there is no victim. **The residual latent risk (a future rebuild bakes in production config and drops the noindex, and no code-level browse-only guard exists) is kept as SEC-08 (LOW).** |
| R-2 | data-protection | "PDPL gate accepts any non-blank PDPL_SIGNOFF_REF, so a placeholder value opens receipts, galleries and media" (INFO) | 0 of 1 confirmed | The value can only be set by an operator with Worker deploy rights, who is already fully trusted and could deploy arbitrary code. A format regex cannot prove that a legal sign-off exists. At HEAD all three portal registries are empty, so opening the gate still yields 404 for every request, and future routes still enforce customer or admin authentication after the gate. It has no reachable impact and is a process-hygiene point only. |
