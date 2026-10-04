import type { EmailTemplate } from '../../shared/notifications.js'
import {
  BRAND_NAME,
  formatEmailInstant,
  normalizeApplicationBaseUrl,
  plainTextLink,
  renderEmailLayout,
} from '../email-templates.js'
import { sendEmail } from '../email.js'
import { isEmailConfigured } from '../settings/features.js'

/**
 * The direct alert to the admin after a sensitive settings change (plan 11
 * §3.3 #30–#32, #43; H2, TM-03). One email per saved change of the bank
 * details, the studio WhatsApp number, the deposit rule, the booking terms
 * or the online-confirmation switch, to ADMIN_NOTIFICATION_EMAIL, so that a
 * change made with a stolen session reaches the owner's inbox even if she
 * does not open the admin panel.
 *
 * - Section and time only, never a value: no IBAN, account holder, bank
 *   name, number, deposit amount, terms text or switch state is ever a
 *   parameter of this module, so none can reach the email. The only other
 *   fact is when a delayed change reaches customers (TM-03, GAP-05), with
 *   the "if this was not you" steps.
 * - Sent directly (sendEmail), not through the outbox: it must not wait for
 *   the cron. Skipped when email is not configured (features.ts EM, the
 *   same checks sendEmail makes) or ADMIN_NOTIFICATION_EMAIL is unset; the
 *   change itself is already committed, so a failed alert costs only the
 *   email, and is logged as a fixed code.
 * - The idempotency key is the section and the saved row, so a retried
 *   request never sends the same alert twice.
 */

export type SettingsAlertSection =
  | 'deposit'
  | 'bank'
  | 'contact'
  | 'terms'
  | 'switch'

export interface SettingsChangeAlert {
  readonly section: SettingsAlertSection
  /**
   * The saved row: the settings or switch revision id, or the terms
   * version. Used only in the idempotency key, never shown.
   */
  readonly reference: string
  /** When it was saved (the row's SQL-stamped created_at). */
  readonly changedAt: string
  /** When a delayed bank or contact change reaches customers; else null. */
  readonly effectiveAt: string | null
}

export type SettingsAlertOutcome = 'sent' | 'skipped' | 'failed'

const REFERENCE_PATTERN = /^[0-9A-Za-z._:-]{1,64}$/

const sectionLabels: Readonly<Record<SettingsAlertSection, string>> = {
  deposit: 'قاعدة العربون',
  bank: 'بيانات الحساب البنكي',
  contact: 'رقم واتساب الاستوديو',
  terms: 'شروط الحجز',
  switch: 'مفتاح التأكيد الإلكتروني للحجوزات',
}

const INTRO =
  'حُفظ تغيير في إعدادات لوحة الإدارة. لا تتضمن هذه الرسالة القيم الجديدة حفاظًا على أمان الحساب.'
const IF_YOU_BODY =
  'إذا كنتِ أنتِ من أجرى هذا التغيير فلا حاجة لأي إجراء.'
const IF_NOT_YOU_BODY =
  'إذا لم تكوني أنتِ: غيّري كلمة مرور حساب الإدارة فورًا، ثم سجّلي الخروج من كل الأجهزة من لوحة الإدارة، وراجعي الإعدادات وأعيدي حفظ القيم الصحيحة.'
const DELAYED_BODY =
  'لن يظهر هذا التغيير للعميلات قبل الموعد المذكور، ويمكنكِ إلغاؤه قبل ذلك بإعادة حفظ القيم الحالية.'
const ACTION_LABEL = 'فتح لوحة الإدارة'
const LINK_FALLBACK_LABEL = 'إذا لم يعمل الزر، افتحي الرابط:'

function adminPanelUrl(appBaseUrl: string | undefined): string | null {
  const baseUrl = normalizeApplicationBaseUrl(appBaseUrl)

  return baseUrl === null ? null : new URL(`${baseUrl}/admin`).toString()
}

/**
 * The alert email, or null when an instant is not usable (nothing is sent
 * rather than an email with a wrong time).
 */
export function renderSettingsChangeAlertEmail(
  alert: SettingsChangeAlert,
  appBaseUrl: string | undefined,
): EmailTemplate | null {
  const label = sectionLabels[alert.section]
  const changedAt = formatEmailInstant(alert.changedAt)
  const effectiveAt =
    alert.effectiveAt === null ? null : formatEmailInstant(alert.effectiveAt)

  if (changedAt === null || (alert.effectiveAt !== null && effectiveAt === null)) {
    return null
  }

  const heading = `تم تغيير ${label}`
  const summaryRows: [string, string][] = [
    ['القسم', label],
    ['وقت الحفظ', changedAt],
  ]

  if (effectiveAt !== null) {
    summaryRows.push(['يظهر للعميلات ابتداءً من', effectiveAt])
  }

  const bodyLines = [
    ...(effectiveAt === null ? [] : [DELAYED_BODY]),
    IF_YOU_BODY,
    IF_NOT_YOU_BODY,
  ]
  const actionUrl = adminPanelUrl(appBaseUrl)
  const text = [
    BRAND_NAME,
    '',
    heading,
    INTRO,
    '',
    ...summaryRows.map(([rowLabel, value]) => `${rowLabel}: ${value}`),
    '',
    ...bodyLines,
    ...(actionUrl === null
      ? []
      : ['', LINK_FALLBACK_LABEL, plainTextLink(actionUrl)]),
  ].join('\n')

  return {
    subject: `تنبيه أمان: ${heading}`,
    text,
    html: renderEmailLayout({
      heading,
      intro: INTRO,
      summaryRows,
      body: bodyLines.join(' '),
      actionUrl,
      actionLabel: ACTION_LABEL,
      linkFallbackLabel: LINK_FALLBACK_LABEL,
    }),
  }
}

/**
 * Sends the alert when email is configured and ADMIN_NOTIFICATION_EMAIL is
 * set; 'skipped' otherwise. Never throws for a delivery problem (sendEmail
 * answers those as 'failed').
 */
export async function sendSettingsChangeAlert(
  env: Env,
  alert: SettingsChangeAlert,
): Promise<SettingsAlertOutcome> {
  const recipient = env.ADMIN_NOTIFICATION_EMAIL?.trim()

  if (!isEmailConfigured(env) || !recipient) {
    return 'skipped'
  }

  if (!REFERENCE_PATTERN.test(alert.reference)) {
    throw new TypeError('Settings alert: the reference is not a row id.')
  }

  const template = renderSettingsChangeAlertEmail(alert, env.APP_BASE_URL)

  if (template === null) {
    return 'failed'
  }

  const result = await sendEmail(env, {
    to: recipient,
    ...template,
    idempotencyKey: `settings-alert:${alert.section}:${alert.reference}`,
  })

  return result.status
}

/**
 * For ctx.waitUntil after the change has committed: sends the alert and
 * logs only a fixed code when it fails. The promise settles without a
 * rejection for any Error, so the response never waits on it and nothing
 * is left unhandled.
 */
export async function notifySettingsChange(
  env: Env,
  alert: SettingsChangeAlert,
): Promise<void> {
  try {
    if ((await sendSettingsChangeAlert(env, alert)) === 'failed') {
      console.error('SETTINGS_ALERT_FAILED')
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error('SETTINGS_ALERT_FAILED')

      return
    }

    throw error
  }
}
