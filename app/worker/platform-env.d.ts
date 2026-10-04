export {}

/*
 * Worker env names that wrangler.jsonc does NOT declare: secrets, and vars
 * that are unset in every committed environment on purpose. Their absence is
 * the safe default, so each one is optional here.
 *
 * Everything wrangler.jsonc declares (the vars ONLINE_CONFIRMATION,
 * FIREBASE_PROJECT_ID, ADMIN_MEDIA_MFA, ADMIN_SETTINGS_2F, PREVIEW_READ_ONLY,
 * the D1 binding DB and the ratelimits bindings RL_*) is typed by the
 * generated worker-configuration.d.ts only (`npx wrangler types
 * --strict-vars=false`), never repeated here: two declarations with
 * different modifiers do not merge (plan 11 §1.3 D13).
 *
 * The R2 binding MEDIA exists only in the local env.mediatest, but the
 * generated types merge it into every env. Nothing may trust that type: the
 * only door to it is worker/portal/gates.ts getMediaBucket(), a runtime
 * shape check behind the whole private-media gate (TM-10).
 *
 * Never put any of these in a VITE_* variable (they would ship to browsers)
 * or in wrangler.jsonc vars; the release preflight (plan 11 §7.0) refuses
 * them there.
 */
declare global {
  interface Env {
    /**
     * Reference to the dated PDPL sign-off record (red-team R2). While it is
     * missing or blank, receipts, galleries and media stay closed whatever
     * else is configured (worker/portal/gates.ts).
     */
    PDPL_SIGNOFF_REF?: string
    /**
     * HMAC key for signed /api/media URLs (API contract §3.C). A Worker
     * secret of at least 32 characters (32+ random bytes as base64url, 43+
     * characters), never a var. While it is missing or shorter, leading and
     * trailing whitespace not counted, private media stays closed. The
     * previous key is accepted during a rotation while it is set (remove it
     * 2 hours after rotating, when every link signed with it has expired).
     */
    MEDIA_SIGNING_KEY?: string
    MEDIA_SIGNING_KEY_PREVIOUS?: string
    /**
     * Retention purge (plan 11 §4.1 RP). Only the exact value "on" lets the
     * retention job run; unset means off. Not set in production until the
     * owner's accountant confirms the minimum retention periods (D11).
     */
    RETENTION_PURGE?: string
  }
}
