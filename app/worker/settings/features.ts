import type {
  CurrentTermsVersion,
  EffectiveSettings,
  KillSwitchState,
  OnlineConfirmationRequirement,
} from '../../shared/settings.js'
import {
  getPrivateMediaBlockers,
  isOnlineConfirmationOn,
  isPrivateMediaAllowed,
  type PrivateMediaBlocker,
} from '../portal/gates.js'
import { readKillSwitch, readSettingsSnapshot } from './settings-read.js'

/**
 * Feature flags as the server computes them (plan 11 §4.1 conditions, §4.2
 * matrix, §3.3 #29 `features`; H3, B1, TM-03, TM-21, M3). The one place the
 * Worker combines vars, the D1 kill switch and the settings into:
 * - OC   ONLINE_CONFIRMATION is exactly "on" (worker/portal/gates.ts);
 * - KS   the D1 kill switch is on (no row: never pulled);
 * - OCe  effective online confirmation = OC ∧ KS;
 * - SET  settings complete: an effective deposit rule, an effective bank
 *        revision and a published terms version;
 * - offered = OCe ∧ SET: flow 2 for new approvals (the approve UPDATE
 *        re-checks each part in its own SQL, E4);
 * - PM   private media, from gates.ts, whose blockers include
 *        ADMIN_MFA_DISABLED (TM-21);
 * - EM   email configured: the Resend settings pass every check sendEmail
 *        makes before sending; AX automatic flow-2 hold expiry = EM ∧ OCe
 *        (B1);
 * - 2S   ADMIN_SETTINGS_2F is exactly "required";
 * - RP   RETENTION_PURGE is exactly "on".
 * Fail closed: a missing, misspelt or differently cased var means off,
 * except the kill switch, whose absence means "not pulled".
 *
 * Presentation and gating inputs only: sections and views read `features`
 * but never trust it (E8); every write re-checks its own conditions.
 */

const ENABLED_VALUE = 'on'
/** The only value of ADMIN_SETTINGS_2F that requires the second factor. */
const SETTINGS_SECOND_FACTOR_REQUIRED_VALUE = 'required'

export interface OnlineConfirmationFeature {
  /** OC: the ONLINE_CONFIRMATION var. */
  readonly switchOn: boolean
  /** KS: the D1 kill switch (H3). */
  readonly killSwitch: KillSwitchState
  /** SET. */
  readonly settingsComplete: boolean
  /** What SET still lacks, in this order: deposit, bank, terms. */
  readonly missing: readonly OnlineConfirmationRequirement[]
  /** OC ∧ KS ∧ SET: flow 2 is offered to new approvals. */
  readonly offered: boolean
}

export interface PrivateMediaFeature {
  readonly allowed: boolean
  /** Codes only (gates.ts order); empty exactly when `allowed`. */
  readonly blockers: readonly PrivateMediaBlocker[]
}

/** The `features` object of GET /api/admin/settings (§3.3 #29). */
export interface Features {
  readonly onlineConfirmation: OnlineConfirmationFeature
  readonly privateMedia: PrivateMediaFeature
  readonly email: { readonly configured: boolean }
  /** AX = EM ∧ OCe: the cron may expire unprotected flow-2 holds. */
  readonly holdAutoExpiry: boolean
  readonly settings2f: { readonly required: boolean }
  readonly retentionPurge: { readonly enabled: boolean }
}

/** The settings facts the flags depend on (a SettingsSnapshot has them). */
export interface FeatureSettingsFacts {
  readonly effective: Pick<EffectiveSettings, 'deposit' | 'bank'>
  readonly terms: CurrentTermsVersion | null
  readonly killSwitch: { readonly state: KillSwitchState }
}

/** Why flow 2 is not offered, first cause first (§3.3 #17 approvalPreview). */
export type OnlineConfirmationUnavailableReason =
  | 'SWITCH_OFF'
  | 'KILL_SWITCH'
  | 'SETTINGS_INCOMPLETE'

/** Where the bride sends her deposit receipt (§4.2): upload only behind PM. */
export type ReceiptChannel = 'upload' | 'whatsapp'

/*
 * The checks worker/email.ts sendEmail makes on the Resend settings before
 * it sends, mirrored here because EM must be on exactly when they pass
 * (§4.3: a malformed var means off). tests/settings-read.test.mjs runs
 * sendEmail over the same settings to keep the two in step.
 */
const MAXIMUM_EMAIL_API_KEY_LENGTH = 512
const MAXIMUM_EMAIL_SENDER_LENGTH = 320
const MAXIMUM_EMAIL_ADDRESS_LENGTH = 254
const MAXIMUM_EMAIL_LOCAL_PART_LENGTH = 64
const MAXIMUM_EMAIL_DOMAIN_LENGTH = 253
const MAXIMUM_EMAIL_DOMAIN_LABEL_LENGTH = 63
const EMAIL_LOCAL_PART = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i
const EMAIL_DOMAIN_LABEL = /^[A-Z0-9-]+$/i

/** A C0 or C1 control character, or DEL. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }

  return false
}

function isEmailAddress(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_EMAIL_ADDRESS_LENGTH ||
    hasControlCharacter(value)
  ) {
    return false
  }

  const atIndex = value.lastIndexOf('@')

  if (atIndex <= 0 || atIndex === value.length - 1) {
    return false
  }

  const localPart = value.slice(0, atIndex)
  const domain = value.slice(atIndex + 1)

  return (
    localPart.length <= MAXIMUM_EMAIL_LOCAL_PART_LENGTH &&
    !localPart.startsWith('.') &&
    !localPart.endsWith('.') &&
    !localPart.includes('..') &&
    EMAIL_LOCAL_PART.test(localPart) &&
    domain.length <= MAXIMUM_EMAIL_DOMAIN_LENGTH &&
    domain.includes('.') &&
    domain
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= MAXIMUM_EMAIL_DOMAIN_LABEL_LENGTH &&
          !label.startsWith('-') &&
          !label.endsWith('-') &&
          EMAIL_DOMAIN_LABEL.test(label),
      )
  )
}

/** EMAIL_FROM as a bare address or as `Name <address>`. */
function isEmailSender(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_EMAIL_SENDER_LENGTH ||
    hasControlCharacter(value)
  ) {
    return false
  }

  const openBracketIndex = value.lastIndexOf('<')
  const closeBracketIndex = value.lastIndexOf('>')

  if (openBracketIndex === -1 && closeBracketIndex === -1) {
    return isEmailAddress(value)
  }

  return (
    openBracketIndex > 0 &&
    closeBracketIndex === value.length - 1 &&
    value.indexOf('<') === openBracketIndex &&
    value.indexOf('>') === closeBracketIndex &&
    value.slice(0, openBracketIndex).trim().length > 0 &&
    isEmailAddress(value.slice(openBracketIndex + 1, closeBracketIndex).trim())
  )
}

/**
 * EM: the Resend settings are ones sendEmail sends with. The key and the
 * sender are present and well formed, and EMAIL_REPLY_TO is unset, blank
 * or an address (no caller passes its own reply-to, so a malformed one
 * fails every email). Anything else is off: a missing value makes sendEmail
 * skip, a malformed one makes it fail with INVALID_CONFIGURATION, and
 * either way no bride is reminded before her hold would expire (B1).
 */
export function isEmailConfigured(env: Env): boolean {
  const apiKey: unknown = env.RESEND_API_KEY
  const from: unknown = env.EMAIL_FROM
  const replyTo: unknown = env.EMAIL_REPLY_TO

  if (typeof apiKey !== 'string' || typeof from !== 'string') {
    return false
  }

  const key = apiKey.trim()
  let isReplyToUsable = replyTo === undefined

  if (typeof replyTo === 'string') {
    const configuredReplyTo = replyTo.trim()

    isReplyToUsable =
      configuredReplyTo.length === 0 || isEmailAddress(configuredReplyTo)
  }

  return (
    key.length > 0 &&
    key.length <= MAXIMUM_EMAIL_API_KEY_LENGTH &&
    !hasControlCharacter(key) &&
    isEmailSender(from.trim()) &&
    isReplyToUsable
  )
}

/** 2S: settings writes need the second-factor claim (TM-03). */
export function isSettingsSecondFactorRequired(env: Env): boolean {
  const value: unknown = env.ADMIN_SETTINGS_2F

  return value === SETTINGS_SECOND_FACTOR_REQUIRED_VALUE
}

/** RP: the retention purge may run (D11: off until the accountant confirms). */
export function isRetentionPurgeOn(env: Env): boolean {
  const value: unknown = env.RETENTION_PURGE

  return value === ENABLED_VALUE
}

/** OCe = OC ∧ KS (H3): the customer confirmation routes answer 503 otherwise. */
export function isOnlineConfirmationEffective(
  env: Env,
  killSwitch: KillSwitchState,
): boolean {
  return isOnlineConfirmationOn(env) && killSwitch === 'on'
}

/**
 * AX = EM ∧ OCe (B1 #4, H3): only then may the cron and the targeted sweep
 * expire a flow-2 hold (and never a notice-protected one). With no email
 * provider, or with the kill switch pulled, overdue holds wait for the admin.
 */
export function isHoldAutoExpiryOn(
  env: Env,
  killSwitch: KillSwitchState,
): boolean {
  return isEmailConfigured(env) && isOnlineConfirmationEffective(env, killSwitch)
}

/** 'upload' only while private media is open (PM), else 'whatsapp'. */
export function getReceiptChannel(env: Env): ReceiptChannel {
  return isPrivateMediaAllowed(env) ? 'upload' : 'whatsapp'
}

function missingRequirements(
  facts: FeatureSettingsFacts,
): OnlineConfirmationRequirement[] {
  const missing: OnlineConfirmationRequirement[] = []

  if (facts.effective.deposit === null) {
    missing.push('deposit')
  }

  if (facts.effective.bank === null) {
    missing.push('bank')
  }

  if (facts.terms === null) {
    missing.push('terms')
  }

  return missing
}

/** Every flag from the env and settings facts already read (no I/O). */
export function resolveFeatures(
  env: Env,
  facts: FeatureSettingsFacts,
): Features {
  const killSwitch = facts.killSwitch.state
  const switchOn = isOnlineConfirmationOn(env)
  const missing = missingRequirements(facts)
  const settingsComplete = missing.length === 0
  const blockers = getPrivateMediaBlockers(env)

  return {
    onlineConfirmation: {
      switchOn,
      killSwitch,
      settingsComplete,
      missing,
      offered: switchOn && killSwitch === 'on' && settingsComplete,
    },
    privateMedia: { allowed: blockers.length === 0, blockers },
    email: { configured: isEmailConfigured(env) },
    holdAutoExpiry: isHoldAutoExpiryOn(env, killSwitch),
    settings2f: { required: isSettingsSecondFactorRequired(env) },
    retentionPurge: { enabled: isRetentionPurgeOn(env) },
  }
}

/** Reads the settings facts (one D1 batch) and resolves every flag. */
export async function loadFeatures(
  env: Env,
  db: D1Database,
  now: Date,
): Promise<Features> {
  return resolveFeatures(env, await readSettingsSnapshot(db, now))
}

/**
 * OCe for one request (E7: the customer confirmation routes, the approve
 * path): the var first, then the D1 switch, which is read only while the
 * var is on.
 */
export async function readOnlineConfirmationEffective(
  env: Env,
  db: D1Database,
): Promise<boolean> {
  if (!isOnlineConfirmationOn(env)) {
    return false
  }

  const { state } = await readKillSwitch(db)

  return isOnlineConfirmationEffective(env, state)
}

/**
 * AX for one run of the cron or the targeted sweep (B1, H3): email first,
 * then OCe; D1 is read only when both vars allow it.
 */
export async function readHoldAutoExpiry(
  env: Env,
  db: D1Database,
): Promise<boolean> {
  if (!isEmailConfigured(env)) {
    return false
  }

  return readOnlineConfirmationEffective(env, db)
}

/** The first reason flow 2 is not offered, or null when it is. */
export function onlineConfirmationUnavailableReason(
  feature: OnlineConfirmationFeature,
): OnlineConfirmationUnavailableReason | null {
  if (!feature.switchOn) {
    return 'SWITCH_OFF'
  }

  if (feature.killSwitch !== 'on') {
    return 'KILL_SWITCH'
  }

  if (!feature.settingsComplete) {
    return 'SETTINGS_INCOMPLETE'
  }

  return null
}
