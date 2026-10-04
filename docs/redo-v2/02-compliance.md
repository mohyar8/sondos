# Compliance Review — Sundus Yar («المصورة سندس يار») Client Portal Additions

**THIS IS DRAFTING ASSISTANCE, NOT LEGAL ADVICE.** This report is produced by an AI compliance-review assistant, not a licensed Saudi lawyer, accountant, or SDAIA-registered DPO. Every item below needs a **named human sign-off** — the business owner for business decisions, and a licensed Saudi lawyer and/or accountant for every item marked "Needs licensed advisor: YES" — before any of it is relied upon or before the features it covers go live. Where a claim depends on a rule that can change (thresholds, deadlines, regulation text), a source URL is given; verify it is still current before acting.

**Documents reviewed** (all read-only, absolute paths):
`C:/Users/azooz/Desktop/sundus-yar/runs/redo-v2/decisions.md`, `C:/Users/azooz/Desktop/sundus-yar/runs/redo-v2/05-adr-architecture.md`, `C:/Users/azooz/Desktop/sundus-yar/runs/redo-v2/06-data-model.md`, `C:/Users/azooz/Desktop/sundus-yar/runs/redo-v2/09-red-team.md`.

**Web-lookup budget used:** 8/8. Claims beyond that budget are marked "not independently verified this pass" and should be re-checked before reliance.

**Top-line verdict:** **NEEDS CHANGES, with one LAWYER REQUIRED gate that blocks Runs 4 and 6.** The architecture's own privacy engineering (private-by-default storage, signed URLs, EXIF/GPS stripping, no card data, default-NO publishing consent, structural R2 deletion tracking) is genuinely strong and should be preserved. But the project cannot lawfully create the R2 bucket or switch on receipt/gallery features (`ONLINE_CONFIRMATION="on"`) until the cross-border data transfer question (§2) has a lawyer's answer — this is not a new finding, it is this review confirming the ADR's own gate (`05-adr-architecture.md` §2.7, §4.5) is correct and must hold.

---

## 1. Saudi PDPL + Implementing Regulations

**Applies?** Yes, in full, and permanently — the site processes personal data of identifiable Saudi residents (name, phone, email today; financial receipts, home addresses, wedding photographs, questionnaire text tomorrow). PDPL applies to any controller processing personal data in the Kingdom regardless of business size or legal form; SDAIA is the regulator. [SDAIA Guide to the PDPL for controllers/processors](https://dgp.sdaia.gov.sa/wps/wcm/connect/f579bc32-fda8-47bd-bc6f-66b8cb77985c/ENG-Guide+to+the+saudi+PDP+law+for+controllersprocessors.pdf?MOD=AJPERES)

**Sensitive-data classification.** SDAIA's own categorisation of "sensitive data" covers health, genetic and biometric data, financial details, religious belief, political opinion and criminal-record data [Usercentrics PDPL overview](https://usercentrics.com/knowledge-hub/saudi-arabia-personal-data-protection-law-pdpl/). Under that statutory list:
- **Deposit receipts are financial data → sensitive, confirmed.** This matches the ADR's and data model's own treatment (`05-adr-architecture.md` §2.7; `06-data-model.md` §6.1 "special-category risk").
- **Wedding photographs of an adult bride are *not* a listed statutory category** (not biometric unless run through face-recognition/identification, which this design never does). However, given the specific Saudi cultural/religious sensitivity of an unveiled bride's image and the brand's own promise («جميع الصور تُنشر بموافقة العروس»), this review recommends **treating bride/guest photography as sensitive-by-context** even though it may not be sensitive-by-statute — i.e., apply the stricter consent and cross-border safeguards anyway. **This classification is not settled by anything found in this review and is the single most consequential open legal question — see the lawyer question at the end of this section.**

**Lawful basis.** Consent is PDPL's primary basis and must be clear, unambiguous, specific and given before/at collection [Usercentrics PDPL overview](https://usercentrics.com/knowledge-hub/saudi-arabia-personal-data-protection-law-pdpl/); contract-necessity can ground routine booking data (name, date, package). Photo publication must rest on explicit opt-in consent, not contract necessity — already correctly modelled as `booking_consents(purpose='publish_photos', granted default 0)` (`06-data-model.md` §3.6 item 10).

**Purpose limitation / minimisation — a genuine strength.** No national ID/Iqama/DOB collected; EXIF/GPS stripped on re-encode; originals never leave the admin's device; R2 keys are random UUIDs carrying no names (`05-adr-architecture.md` §2.3; `06-data-model.md` §1, §3.1). Preserve this design.

**Retention and deletion.** See the schedule below. **NEEDS CHANGES:** `booking_requests` currently has *no* retention ceiling — "no automatic deletion until [accountant/compliance] sets a period" (`06-data-model.md` §6.2) — an indefinite default is itself a minimisation gap under PDPL's "no longer than necessary" principle, even though leaving it open until confirmed is the safer interim choice over guessing wrong.

**Data-subject rights.** PDPL grants access, rectification, erasure and objection; access requests are commonly described as due within 30 days, extendable for documented exceptional effort [Securiti Saudi PDPL overview](https://securiti.ai/saudi-arabia-personal-data-protection-law/) (secondary summary — verify the exact SDAIA text with counsel). **NEEDS CHANGES:** there is currently **no channel at all** for a data subject to submit a request — the only path described is an internal SQL procedure the owner or a devops-engineer runs on demand (`06-data-model.md` §6.5), with no public-facing way to trigger it. Build a simple "request your data / correct it / delete it" contact point (even a form that emails the owner with a due-by date) before go-live.

**Guest (non-account) data-subject rights.** Correctly flagged by the project's own red-team review as unresolved: unblurred wedding guests appear in the private gallery with no account and no self-service path (`09-red-team.md` §6, point 2). PDPL rights are not limited to account holders. **NEEDS CHANGES:** publish a contact channel for "I appear in a photo on this site and want it removed" and give the owner a documented manual procedure to act on it.

**Breach notification duty and timeline.** Controllers must notify SDAIA **within 72 hours** of becoming aware of a breach, with no minimum-severity exception (unlike GDPR); the notification must describe the incident, the category/estimated number of affected individuals, an impact assessment, and mitigation steps [Baker McKenzie: Saudi Arabia breach-notification guidance](https://connectontech.bakermckenzie.com/saudi-arabia-publishes-guidance-on-data-breach-notification/); SDAIA's own e-service is here: [SDAIA Personal Data Breach Notification](https://dgp.sdaia.gov.sa/wps/portal/pdp/services/details/PersonalDataBreachNotification/). Affected data subjects must separately be told "without undue delay" if the breach could harm them. **If the E-Commerce Law also applies (§5), the Ministry of Commerce must be told within 3 days** [Gulf News coverage of the E-Commerce Law breach duty](https://gulfnews.com/amp/business/retail/saudi-arabia-tightens-up-ecommerce-law-with-stiff-penalties-1.73327592) — the *shorter* of the two deadlines (3 days) is the one that in practice governs. **Build/process requirement:** a one-page written incident-response runbook (who to call, in what order, inside 3 days) should exist before Run 4 goes live, given the sensitivity of what would be exposed (financial receipts, private photos).

**Records of processing.** The `06-data-model.md` §6.1–6.2 inventory is already close to a PDPL processing record in substance; formalise it as a standing document the owner keeps current, not just a one-time build artifact.

**Verdict: NEEDS CHANGES** (DSR contact channel, guest-removal channel, retention ceiling on `booking_requests`, breach runbook) **+ LAWYER REQUIRED** on classification.
**Questions for the lawyer:** (1) "Are wedding photographs of a bride and her guests, taken and stored by a photography business, 'sensitive data' under the PDPL given no facial-recognition processing occurs, or only sensitive-by-analogy — and does that change the required consent standard or cross-border safeguard?" (2) "Is a manual, owner-run procedure enough to satisfy PDPL's data-subject-rights and 30-day-type expectations for a sole-proprietor business, or must it be closer to self-service?"

---

## 2. Cross-border transfer

**Applies — this is the single highest-risk item in the project**, exactly as the ADR itself already recognised (`05-adr-architecture.md` §2.7, gating Runs 4 and 6) and as the project's own red-team independently identified as "the single assumption most worth testing cheaply first" (`09-red-team.md`). Every current or planned vendor stores data outside the Kingdom: Firebase Auth (Google, US, existing), Cloudflare D1 (no Middle East region, existing), Cloudflare R2 (location hints wnam/enam/weur/eeur/apac/oc — no KSA option, planned), Resend (US, planned).

**Why it applies.** SDAIA's Regulation on Personal Data Transfer Outside the Kingdom (issued August 2024, updated 1 September 2024, implementing PDPL Article 29) governs any transfer of a Saudi resident's personal data to a location outside the Kingdom, including transfers that happen as a side effect of a cloud vendor's server location [King & Spalding: International Personal Data Transfers under Saudi Arabia's PDPL](https://www.kslaw.com/news-and-insights/international-personal-data-transfers-under-saudi-arabias-data-protection-law); [Securiti: Regulation on Personal Data Transfer Outside the Kingdom](https://securiti.ai/regulation-on-personal-data-transfer-outside-the-kingdom/).

**What it requires.** A transfer is lawful only if grounded in one of: (a) the destination being on an SDAIA "adequate" list — **none has been published yet**, so this path is currently unavailable to anyone [ITIF: Saudi Arabia's Cross-Border Data Transfer Regulation](https://itif.org/publications/2025/06/09/saudi-arabia-cross-border-data-transfer-regulation/); (b) approved safeguards — SDAIA Standard Contractual Clauses, approved Binding Common Rules, or a Certificate of Accreditation; or (c) explicit data-subject consent to that specific transfer — together in every case with data minimisation, a mandatory risk assessment for continuous/large-scale sensitive-data transfers, and documented records of the transfer justification [Securiti overview](https://securiti.ai/regulation-on-personal-data-transfer-outside-the-kingdom/).

**Practical options for a solo business (none confirmed sufficient by a lawyer yet):**
1. **Consent-based transfer** — add an explicit, standalone consent (not bundled invisibly into "accept booking terms") naming the vendors and that data leaves the Kingdom. Cheapest, fastest, and an explicitly permitted ground — but a lawyer must confirm whether consent is "freely given" when there is no in-Kingdom alternative offered. The schema already has the right shape for this: extend the existing `booking_consents` pattern (`06-data-model.md` §3.6 item 10) with a `purpose='cross_border_transfer'` row instead of inventing a new mechanism.
2. **Rely on vendor-level SCCs/accreditation**, if Google/Cloudflare/Resend already publish SDAIA-recognised safeguards applicable to KSA customers — **not verified in this review** (outside the 8-lookup budget); check each vendor's current PDPL/KSA compliance page directly before relying on this.
3. **Move storage in-Kingdom** — the ADR explicitly rejected this as premature pending this very determination (`05-adr-architecture.md` §3, "Hosting" row); becomes the fallback if a lawyer says options 1–2 don't work for this data class.

**Build requirement:** (i) do not create the R2 bucket or set `ONLINE_CONFIRMATION="on"` until this is answered — reaffirming, not weakening, the ADR's existing gate; (ii) whichever basis is chosen, wire the specific transfer disclosure/consent into the `terms_version`/`terms_accepted_at` acceptance step that already exists (`06-data-model.md` §3.6 item 1); (iii) name the specific receiving vendors and (at least generally) their storage countries in the privacy notice.

**Verdict: LAWYER REQUIRED — this blocks Runs 4 and 6.**
**Question for the lawyer:** "Is consent alone (the Article 29 ground) enough for a solo/micro business to lawfully use Google Firebase Auth, Cloudflare D1/R2, and Resend — none with a Kingdom presence, no SDAIA adequacy decision existing for any of them — to store Saudi residents' wedding photographs and financial receipts? If not, what specific SCC or accreditation route is realistically available to a business this size, and from whom?"

---

## 3. Bank-transfer receipts

**Applies.** Receipts show the customer's name as it appears on the transfer, the sending/receiving bank, and possibly a partial account/IBAN number — financial personal data, already correctly treated as sensitive by the ADR (`05-adr-architecture.md` §2.7 table, "Access to receipts and photos" row).

**Storage/access control — largely sound.** Private R2 bucket reachable only through the Worker binding, no public URL ever created, magic-byte-verified upload, 5 MiB cap, images re-encoded (metadata stripped) while PDFs pass through unchanged, served through 10-minute HMAC-signed URLs minted only after an ownership/admin check, ownership enforced inside the SQL itself rather than at the route layer (`05-adr-architecture.md` §2.0, §2.3). This is a reasonable least-privilege design.

**NEEDS CHANGES — admin MFA.** The single admin account can read every bride's receipts and photos (`05-adr-architecture.md` §2.0, "single points of failure" item 7), and MFA for that account is currently only an open item (U15, `05-adr-architecture.md` §7 item 15), not a built requirement. Given what this one account can expose, TOTP MFA should be a hard go-live gate, not an optional hardening item.

**Retention.** Proposed defaults: 90 days after `event_date` for a verified receipt; 30 days after rejection/cancellation/expiry; hard ceiling 730 days; R2 lifecycle backstop 740 days (`06-data-model.md` §6.2, §6.4) — explicitly marked "proposed," pending confirmation that this doesn't undercut a statutory bookkeeping-record minimum (open item U-3). **This review did not verify a specific statutory minimum retention period for payment/financial records of a freelance-certificate holder** (outside the 8-lookup budget) — do not assume any figure; ask the accountant directly.

**Verdict: NEEDS CHANGES** (MFA before go-live) **+ partial advisor need.**
**Question for the accountant/lawyer:** "Is there a minimum period I am legally required to keep evidence of a customer's deposit payment (the bank-transfer receipt) for bookkeeping or tax purposes, and does the proposed 90-day/730-day-ceiling schedule in `06-data-model.md` §6.2 conflict with it?" Keep the automatic receipt-deletion job off (or set a deliberately long placeholder) until this is answered — never auto-delete a record before confirming it isn't a required financial record.

---

## 4. Marketing vs transactional messages

**Applies.** The planned email reminders (hold expiry, receipt status, event/selection/handover reminders, feedback request) are all transactional/service messages tied to a booking the customer actively initiated, correctly assigned an "agreement (service messages)" legal basis already (`06-data-model.md` §6.2). No separate marketing consent is needed for these **as long as their content stays strictly transactional** (no promotions/upsells mixed in).

**Build requirement, only if triggered later:** if the owner ever wants promotional emails (e.g., seasonal offers to past clients), that needs a separate, freely-given opt-in captured independently of the booking flow — follow the same `booking_consents` pattern already built for `publish_photos` (e.g., `purpose='marketing_email'`) plus an unsubscribe link in every such email. Not needed today; flagging so it isn't added later without the extra consent step.

**WhatsApp deep link.** The design uses only a user-initiated `wa.me` link (bride taps a button, a pre-filled message opens in her own WhatsApp, she chooses whether to send it) — Meta's own "Click to Chat" product, not the WhatsApp Business API and not an unofficial/reverse-engineered client. This pattern is understood to sit within WhatsApp's terms because the studio never sends anything programmatically — **not independently re-verified against the current WhatsApp Business Terms of Service in this pass** (budget exhausted; this is stable, low-churn territory but should be spot-checked periodically). **Build requirement:** never upgrade this to bulk/automated WhatsApp sending (unofficial libraries such as whatsapp-web.js/Baileys, or bulk-messaging resellers) without a fresh ToS review — that is a materially different, higher-risk feature (account-ban risk, and likely a fresh PDPL/consent question).

**Verdict: COMPLIANT as currently scoped** (transactional-only emails, user-initiated WhatsApp link). **NEEDS CHANGES only if/when** marketing sends or WhatsApp automation are introduced.

---

## 5. Saudi E-Commerce Law disclosure duties

**Applies, with one scope question unresolved.** The site sells a service online with displayed pricing and takes bookings/deposits through the site, which brings it within the general policy intent of the E-Commerce Law (Royal Decree M/126 and its Implementing Regulation). **Whether a booking-and-deposit-only service site (no card checkout, no shipped goods except an album handover) is squarely "in scope" the same way a shopping-cart e-store is was not confirmed against the primary Ministry of Commerce text in this review** — no official mc.gov.sa citation was retrieved within the 8-lookup budget; all sources below are secondary summaries and should be checked against the primary law/regulation text.

**What must be disclosed on the site, per secondary summaries:** trade/commercial identity; an address, or registration with an e-shop authentication entity if none is published; a working contact channel; total price including VAT status, with no fees added later; an accurate description of packages/deliverables; a written cancellation/refund policy shown *before* the deposit is paid, not after; delivery terms (relevant: album handover); all of the above available in Arabic [origami.sa: Saudi E-Commerce Law 2026 & Maroof compliance](https://origami.sa/en/blog/saudi-ecommerce-law-2026-maroof-compliance/); [Saudipedia: E-commerce Law in Saudi Arabia](https://saudipedia.com/en/e-commerce-law-in-saudi-arabia); [Gulf News: e-commerce law tightening](https://gulfnews.com/amp/business/retail/saudi-arabia-tightens-up-ecommerce-law-with-stiff-penalties-1.73327592).

**Maroof registration.** Several secondary sources describe online-store registration on the Ministry of Commerce's "Maroof" authentication platform as part of e-commerce compliance; whether a booking/deposit service (not a shopping-cart store) falls in scope was **not confirmed** — ask the lawyer/MCI helpdesk directly.

**Build requirement:** a dedicated, always-reachable (footer-linked) disclosure page/section distinct from the booking-flow terms: legal/trade identity, freelance-certificate or CR reference, contact channel, cancellation/refund terms, VAT status, link to the privacy notice. **This does not currently exist as a distinct artifact** in the reviewed documents — the "terms" tracked as open item U6 are the booking/payment terms shown during the receipt-upload step, not a general e-commerce identity/disclosure page. This is a gap independent of, and cheaper to close than, the cross-border question.

**Verdict: NEEDS CHANGES** (build the disclosure page) **+ LAWYER REQUIRED** on scope.
**Question for the lawyer:** "Does a deposit-only, no-online-card-checkout booking website for a photography service count as a 'service provider' under the E-Commerce Law and its Implementing Regulation, and does it need to register on the Maroof platform?"

---

## 6. VAT / ZATCA

**Applies conditionally on turnover. Owner's VAT registration status is UNKNOWN** — not stated anywhere in the reviewed documents. **This must be asked directly and is a first-priority action item**, independent of everything else in this report.

**Threshold (official, ZATCA):** mandatory VAT registration once taxable supplies exceed **SAR 375,000** in the trailing 12 months, or are expected to in the next 12 months, with **30 calendar days** to register once the threshold is crossed, and penalties (starting around SAR 10,000) for late registration; voluntary registration is available from **SAR 187,500** up to the mandatory threshold [ZATCA official FAQ](https://zatca.gov.sa/en/HelpCenter/FAQs/Pages/FAQ_026.aspx). Standard VAT rate: 15%.

**ZATCA e-invoicing (Fatoora) — triggered automatically by VAT registration, not by this project.** Phase 1 (Generation) requires a compliant e-invoicing system from the day of registration (structured, sequential, Arabic-capable invoices), effective since December 2021; Phase 2 (Integration with ZATCA's Fatoora platform via API — UUID, cryptographic stamp, digital signature) rolls out in turnover-based waves, with the most recent published wave (Wave 24) covering turnover over SAR 375,000 and an integration deadline of 30 June 2026 [ZATCA official e-invoicing FAQ (PDF)](https://zatca.gov.sa/en/E-Invoicing/Documents/Einvoicing_FAQ_EN.pdf) — **wave assignments and dates change; re-check at zatca.gov.sa before relying on this date.** Non-resident taxpayers are exempt; a KSA-resident freelancer is not. Below SAR 375,000 and not voluntarily registered, no VAT or Fatoora duty currently applies.

**Freelance Certificate (وثيقة العمل الحر) — official source.** Ministry of Human Resources and Social Development, "Issuance of documents for freelance work" [HRSD official service page](https://www.hrsd.gov.sa/en/ministry-services/services/1065686) — free, valid one year, renewed annually (described as an automatic/proactive renewal), open to Saudi citizens across 120+ approved professions including creative-services work; enables GOSI social-insurance contribution. This is a **separate legitimisation track from VAT** — it formalises the right to work as a freelancer and does not by itself create a VAT obligation, which is purely turnover-driven (above). The Instagram bio's «مصرحة من وزارة العمل» most likely refers to this document (the Ministry was formerly "Ministry of Labor," now HRSD) — **confirm it is current** (annual renewal) and that its listed profession(s) explicitly cover photography.

**When to flag registration as advisable:** the moment cumulative taxable revenue in any trailing 12 months looks likely to pass SAR 375,000, mandatory VAT registration and Fatoora e-invoicing apply within 30 days — this is a numeric trigger to monitor continuously, not a one-time decision. Below that, voluntary registration (from SAR 187,500) is a business choice, not a compliance requirement.

**Verdict: STATUS UNKNOWN — first confirm with the owner, then NEEDS CHANGES to pricing display and invoicing once a VAT status is known.**
**Question for the accountant:** "What is the business's trailing-12-month taxable revenue, is it near or over SAR 375,000, and if I register, what do I need for Fatoora Phase 1 compliance from day one?"

---

## 7. Publishing consent for portfolio/Instagram use and minors

**Applies.** This is the project's own stated brand differentiator and is already well-modelled: `booking_consents(purpose='publish_photos', granted, text_version)`, default NO (absence of a row = NO), every change logged as an event, pre-event questionnaire "publishing consent defaulting to NO" (`decisions.md` line 25; `06-data-model.md` §3.6 item 10). This is a genuine strength to preserve.

**NEEDS CHANGES — gaps:**
- **Revocation must have a real-world follow-through.** The schema supports toggling consent to withdrawn, but nothing describes a process step for checking whether a photo was already posted to Instagram (an external platform outside the site's control) and removing it there too. Build requirement: a documented admin runbook step — "on withdrawal, check and remove any already-published Instagram post from this booking within [X days]."
- **Guest consent in *public* photos is not modelled at all.** The consent record is keyed to the bride's booking, but a published portfolio/Instagram photo may show other identifiable guests who never separately consented to public posting — the same gap the red-team flagged for the *private* gallery (`09-red-team.md` §6, point 2) is more acute here because guests have no account and no way to know they're on a public page. The owner's existing photo style — described as "detail-driven and privacy-first (no identifiable bride faces)" (`decisions.md` line 47) — already mitigates this in practice; make it explicit *policy* for public-use selection, not just aesthetic preference.
- **Minors in photos (flower girls, young relatives) — correctly flagged by the project's own red-team and otherwise absent from every document reviewed** (`09-red-team.md` §6, point 1). PDPL treats children's data as requiring extra care, and controllers processing such data are described as needing to register on SDAIA's National Data Governance Platform [Usercentrics PDPL overview — Children's Data](https://usercentrics.com/knowledge-hub/saudi-arabia-personal-data-protection-law-pdpl/) — **whether incidental wedding-guest photography of children triggers this registration duty was not resolved in this review; ask a lawyer directly.** Build requirement regardless of that answer: default to **not** publishing any clearly identifiable child's photo to the public portfolio/Instagram even when the bride's general publishing consent is YES, unless a parent/guardian has separately agreed — stricter than what's currently modelled.

**Verdict: NEEDS CHANGES** (revocation runbook, public-use guest-photo policy, minors default-exclusion rule) **+ LAWYER REQUIRED** on the minors registration question.
**Question for the lawyer:** "Does incidentally photographing children who appear as wedding guests (not a children's-focused service) trigger PDPL's heightened children's-data obligations or SDAIA National Data Governance Platform registration for this business? Is the bride's consent alone sufficient to publish a photo showing other identifiable adult guests, or do I need theirs too?"

---

## Proposed retention schedule

Reproduces and reviews the architecture's own proposed defaults (`06-data-model.md` §6.2, §6.4) — **none of these periods are final**; two things must be confirmed first: the PDPL cross-border legal basis (§2) and any statutory financial-record minimum (accountant, §3/§6). **Until both are confirmed, the retention-purge cron job should not run against production for booking or receipt rows.**

| Data | Keep for | Then |
|---|---|---|
| Account profile (name, email, phone) — no booking ever made | 12 months after last update | Hard-delete the row |
| Account profile — with booking history | Same as the linked booking record (below) | Delete or pseudonymise per the booking outcome / a DSR |
| Booking record (dates, package, price, status history) | **UNSET — no automatic deletion until the accountant/compliance sets a statutory minimum** | Once set: retain that minimum, then delete or pseudonymise on request |
| Deposit receipt image (R2) | 90 days after event date (verified receipts); 30 days after rejection/cancellation/expiry; hard ceiling 730 days — **all pending accountant confirmation this doesn't undercut a bookkeeping duty** | Delete from R2; null the rejection-reason text; keep status + dates only |
| Pre-event questionnaire text (venue, timing, requests) | 90 days after event date, or 30 days after a terminal status | Null the text columns; keep the row as a stage marker |
| Publishing/marketing consent record (grant/withdraw + timestamp + version) | Life of the booking record — this *is* the proof of consent | Retain as evidence even after other data is purged, unless full erasure is requested |
| Cross-border-transfer consent record (recommended new item, §2) | Same as the booking record | Retain as evidence of the Article 29 transfer basis used |
| Delivery/pickup address | 30 days after handover completed, cancelled or no-show | Null the address columns; keep method + date |
| Gallery previews & thumbnails (R2) | 30 days after handover completion, or 30 days after a terminal status; hard ceiling 180 days after upload | Delete from R2; gallery row marked `purged` |
| Photo selections (chosen filenames, favourites) | Deleted with the gallery purge above | Cascade-deleted |
| Admin free-text notes on a booking | 90 days after completion or a terminal status | Null the notes column |
| Feedback (rating + comment) | 12 months after submission | Hard-delete the row |
| Email notification content (recipient + rendered text) | Until the send attempt finishes | Null immediately on completion; the log row itself deleted after 180 days |
| Blocked-dates admin entries | 12 months after the date | Hard-delete the row |

---

## Privacy notice — topics to cover (topics only)

1. Identity of the data controller (trade name, freelance-certificate/CR reference, contact channel)
2. Categories of personal data collected, per feature (account, booking, receipt, questionnaire, address, photos, feedback)
3. Purpose and legal basis for each category (contract necessity vs. explicit consent)
4. Special note on the sensitivity of financial receipts and wedding photography, and the extra care taken
5. Publishing consent: default NO, what granting it means, how and when to withdraw it, and its practical limits (an already-shared/printed/reposted photo may not be fully recallable)
6. Minors appearing in photos: a specific, separate statement
7. Recipients/processors used and where they are located (name Google Firebase, Cloudflare D1/R2, Resend; disclose non-Kingdom storage) and the legal basis relied on for the cross-border transfer
8. Retention periods (plain-language summary of the schedule above)
9. Data-subject rights (access, correction, deletion, objection/withdrawal) and how to exercise them, with an expected response time
10. A path for a non-account guest who appears in a photo to request its removal
11. Security measures, in plain language (private storage, no public links, restricted admin access, no card data collected)
12. Data-breach notification commitment
13. Cookies/analytics use, or an explicit "none" statement
14. Governing law and the regulator's (SDAIA) contact/complaint path
15. Languages the notice is available in, and which one governs in a conflict

## Booking terms — topics to cover (topics only)

1. Identity/licence reference of the service provider
2. Package description and total price, with an explicit VAT-inclusive / VAT-exclusive / not-VAT-registered statement
3. Deposit amount or percentage, paid by bank transfer only, with an explicit statement that no card data is collected on the site
4. Hold/reservation mechanics: hold duration, deadline, and what happens if it lapses
5. Receipt review process, possible rejection with a reason, and the resulting timeline effect
6. Cancellation and refund policy (who may initiate it, deposit refundability, timing)
7. Photo-selection process: quota, deadline (soft vs firm), and what happens if it is missed
8. Album production and handover: pickup vs delivery, scheduling, any delivery fee, and what happens on a no-show
9. Publishing-consent clause, cross-referenced to the privacy notice
10. Communication channels used (email reminders, the final WhatsApp step) and a note that WhatsApp is a third-party platform governed by its own terms
11. Complaint/dispute channel: the business contact first, then the relevant regulator (SDAIA for data issues; Ministry of Commerce for consumer/e-commerce issues)
12. Governing law and the language of the contract

---

## Top 5 build requirements, ranked by risk

1. **Resolve the PDPL cross-border transfer legal basis before creating the R2 bucket or enabling receipts/galleries (§2).** Highest risk: it gates the largest and most novel two-thirds of the whole build, touches the most sensitive data (financial receipts + wedding photos), and a wrong call is a direct hit to the brand's central promise. Already the ADR's own gate (`05-adr-architecture.md` §4.5) — this review reaffirms it must hold.
2. **Get a lawyer's answer on sensitive-data classification of bride/guest photos and on minors in photos, before finalising consent text and public-portfolio rules (§1, §7).** Changes what consent language and safeguards are legally required and directly affects the brand's core differentiator; the minors gap was independently flagged by the project's own red-team and remains unresolved.
3. **Mandate admin-account MFA and set (or deliberately defer) a retention ceiling on `booking_requests`/receipts before any auto-delete job runs against production (§1, §3).** The single admin account is the project's own documented single point of failure over every bride's receipts and photos; auto-deleting a financial record before confirming a bookkeeping duty is a compliance failure in the *opposite* direction from over-retention.
4. **Build a reachable data-subject-rights contact path, including for non-account guests, with a committed response time (§1, §7).** Currently zero — not even a manual-request intake exists. Cheap to build (a form/contact page), and its absence is a baseline PDPL gap independent of every harder question above.
5. **Confirm VAT/ZATCA status and build the E-Commerce Law disclosure page (identity, price/VAT status, cancellation/refund terms, complaint channel) before public launch of paid bookings (§5, §6).** Independent of the harder residency question, cheap to fix, and the VAT threshold (SAR 375,000) is a bright-line numeric trigger that is easy to miss without an owner/accountant monitoring commitment.

---

## Sources consulted

- [SDAIA — Guide to the PDPL for controllers/processors (PDF)](https://dgp.sdaia.gov.sa/wps/wcm/connect/f579bc32-fda8-47bd-bc6f-66b8cb77985c/ENG-Guide+to+the+saudi+PDP+law+for+controllersprocessors.pdf?MOD=AJPERES)
- [SDAIA — Personal Data Breach Notification service](https://dgp.sdaia.gov.sa/wps/portal/pdp/services/details/PersonalDataBreachNotification/)
- [Usercentrics — Saudi Arabia PDPL overview](https://usercentrics.com/knowledge-hub/saudi-arabia-personal-data-protection-law-pdpl/)
- [Securiti — Understanding Saudi Arabia's PDPL](https://securiti.ai/saudi-arabia-personal-data-protection-law/)
- [Securiti — Regulation on Personal Data Transfer Outside the Kingdom](https://securiti.ai/regulation-on-personal-data-transfer-outside-the-kingdom/)
- [King & Spalding — International Personal Data Transfers under Saudi Arabia's PDPL](https://www.kslaw.com/news-and-insights/international-personal-data-transfers-under-saudi-arabias-data-protection-law)
- [ITIF — Saudi Arabia's Cross-Border Data Transfer Regulation](https://itif.org/publications/2025/06/09/saudi-arabia-cross-border-data-transfer-regulation/)
- [Baker McKenzie — Saudi Arabia publishes guidance on data breach notification](https://connectontech.bakermckenzie.com/saudi-arabia-publishes-guidance-on-data-breach-notification/)
- [SAMA Rulebook — Payment Systems and Payment Services Providers](https://rulebook.sama.gov.sa/en/entiresection/1367)
- [SAMA — Payment Service Providers Regulations Update (PDF)](https://sama.gov.sa/en-US/payment/Documents/PSPs%20Regulations%20111.pdf)
- [ZATCA — Official FAQ on mandatory VAT registration threshold](https://zatca.gov.sa/en/HelpCenter/FAQs/Pages/FAQ_026.aspx)
- [ZATCA — E-Invoicing (FATOORA) Phase One requirements FAQ (PDF)](https://zatca.gov.sa/en/E-Invoicing/Documents/Einvoicing_FAQ_EN.pdf)
- [HRSD — Issuance of documents for freelance work (official service page)](https://www.hrsd.gov.sa/en/ministry-services/services/1065686)
- [origami.sa — Saudi E-commerce Law 2026 and Maroof compliance](https://origami.sa/en/blog/saudi-ecommerce-law-2026-maroof-compliance/)
- [Saudipedia — E-commerce Law in Saudi Arabia](https://saudipedia.com/en/e-commerce-law-in-saudi-arabia)
- [Gulf News — Saudi Arabia tightens up e-commerce law with stiff penalties](https://gulfnews.com/amp/business/retail/saudi-arabia-tightens-up-ecommerce-law-with-stiff-penalties-1.73327592)