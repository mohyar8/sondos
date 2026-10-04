# W0-03 — Old database and account inventory (2026-09-28)

Read-only. No rows copied, no personal data.

| Check | Result |
|---|---|
| Deploying Cloudflare account | "Lofe1122@gmail.com's Account" (`52c34fa9a7afb30c9db795d42b13df68`), wrangler OAuth login |
| Old production D1 `sundus-yar-bookings` (`6fda2ba7-508d-4972-93b6-5735e1fa7da4`, from the handoff `wrangler.jsonc`) | **Not present in this account** (`wrangler d1 list` shows only `sundus-yar-preview`). Its owner and contents are unknown; nothing can be counted or migrated from here. |
| Worker `sundus-yar-website` in this account | **Not deployed** (no pre-launch version id exists; the launch floor is the first release). |
| Workers in this account | `sundus-yar-preview` only (browse-only preview, empty D1 `8349c6ba-…`). |
| workers.dev subdomain | `sundusyar` (registered 2026-09-24 with the owner's approval). |
| R2 | Not enabled on the account (API code 10042) — consistent with D17 (private media gated off). |
| Firebase | New project under the owner's Google account (D16); blocked until the owner turns on Google 2-Step Verification. The handoff project `sundus-yar-website` exists (its `/__/auth/handler` answers) but its owner and web config are unknown. |
| 2FA on owner accounts (TM-23) | Google: being enabled by the owner (Firebase requires it). Cloudflare: not verified — owner to enable in the dashboard. |

**Decision (D19c):** production starts on a fresh D1 in this account; nothing is migrated. If the old database is later found to hold future bookings or blocked dates, the owner re-enters those dates as blocked dates in the admin portal.
