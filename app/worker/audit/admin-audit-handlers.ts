import { describeAdminSession } from '../../shared/admin-session.js'
import { adminSessionsRevokedAudit, isAuditInstant } from '../../shared/audit.js'
import { errorResponse, jsonResponse } from '../http.js'
import type { AdminPortalContext } from '../portal/admin-portal-routes.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import { reauthAtFromToken, requireRecentSignIn } from '../recent-auth.js'
import { auditAfterWrite } from './admin-audit.js'

/**
 * The admin's own account routes (plan 11 §3.2 #39, #40, #44; §3.3; TM-07,
 * SB-2, SB-7, SB-10, SB-18). All three sit behind the admin guard of
 * worker/portal/admin-portal-routes.ts (AD): a verified token of the one
 * admin, bound to her uid and proven email, signed in at most 12 hours ago
 * and not before users.tokens_valid_after. Nothing here logs anything.
 *
 * - GET `audit-log?cursor=&limit=`: admin_audit_log newest first, keyset
 *   paginated on the row id (AUTOINCREMENT, so it never repeats or goes
 *   back). The cursor is the last id of the previous page as plain digits;
 *   anything else, and a limit outside 1–100, is a 400 before any SQL runs.
 *   actor_uid is not returned (there is one admin, and the uid is no use to
 *   the page); details are the JSON the shared/audit.ts builders wrote, ids,
 *   counts and codes only.
 * - GET `session`: shared/admin-session.ts describeAdminSession over the
 *   verified claims: authTime, reauthFreshUntil, sessionFreshUntil,
 *   secondFactor, idleMinutes and serverTime. It reads no database row; the
 *   SPA uses it to ask for the password before a sensitive form opens, never
 *   as a control.
 * - POST `session/revoke-all` (AD+R): «تسجيل الخروج من كل الأجهزة». One batch:
 *   the UPDATE of this admin's users.tokens_valid_after, then the
 *   admin_sessions_revoked audit row through auditAfterWrite (reauth_at from
 *   the token's auth_time), so the row exists exactly when the stamp was
 *   written. The stamp is the database's clock, unixepoch(), never lowered,
 *   and at least one second after this token's auth_time, so every token of
 *   every earlier sign-in, the caller's own included, is refused with 403
 *   REAUTH_REQUIRED from the next request on, even when D1's clock trails
 *   Firebase's; only a new sign-in passes (worker/admin-auth.ts).
 */

/** #39 page sizes. */
export const AUDIT_LOG_DEFAULT_LIMIT = 50
export const AUDIT_LOG_MAX_LIMIT = 100

/** The cursor: a positive row id, at most 15 digits (a safe integer). */
const AUDIT_CURSOR_PATTERN = /^[1-9][0-9]{0,14}$/
const AUDIT_LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/
const auditLogQueryKeys: ReadonlySet<string> = new Set(['cursor', 'limit'])

/** Every SQL text of this module, fixed; every value is bound (SB-4). */
export const ADMIN_ACCOUNT_SQL = Object.freeze({
  /** Binds: cursor id (or NULL for the first page), page size + 1. */
  auditLogPage: `
    SELECT
      id,
      action,
      target_id AS targetId,
      details,
      reauth_at AS reauthAt,
      created_at AS createdAt
    FROM admin_audit_log
    WHERE ?1 IS NULL OR id < ?1
    ORDER BY id DESC
    LIMIT ?2
  `,
  /**
   * The revocation mark in Unix seconds, never moved back (the promote and
   * revoke scripts stamp it the same way). Binds: this token's auth_time + 1,
   * admin uid.
   */
  revokeAllSessions: `
    UPDATE users
    SET tokens_valid_after = MAX(
      COALESCE(tokens_valid_after, 0),
      unixepoch(),
      CAST(?1 AS INTEGER)
    )
    WHERE id = ?2
      AND role = 'admin'
      AND erased_at IS NULL
  `,
})

type StoredRow = Readonly<Record<string, unknown>>

export interface AdminAuditLogEntry {
  readonly id: number
  readonly action: string
  readonly targetId: string | null
  readonly details: Readonly<Record<string, unknown>> | null
  readonly reauthAt: string | null
  readonly createdAt: string
}

interface AuditLogQuery {
  readonly cursor: number | null
  readonly limit: number
}

function invalidCursorResponse(): Response {
  return errorResponse(
    400,
    'INVALID_CURSOR',
    'رابط الصفحة التالية من القائمة غير صالح. حدّثي القائمة ثم أعيدي المحاولة.',
  )
}

function invalidLimitResponse(): Response {
  return errorResponse(
    400,
    'INVALID_LIMIT',
    'يجب أن يكون الحد عددًا صحيحًا بين 1 و100.',
  )
}

function invalidQueryResponse(): Response {
  return errorResponse(
    400,
    'INVALID_QUERY',
    'معايير الطلب غير صحيحة.',
  )
}

/**
 * The #39 query: only `cursor` and `limit`, each at most once. Returns the
 * finished 400 for anything else.
 */
export function parseAuditLogQuery(
  url: URL,
): { ok: true; query: AuditLogQuery } | { ok: false; response: Response } {
  const keys = [...url.searchParams.keys()]

  if (
    keys.some((key) => !auditLogQueryKeys.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    return { ok: false, response: invalidQueryResponse() }
  }

  const cursorValue = url.searchParams.get('cursor')
  const limitValue = url.searchParams.get('limit')
  let cursor: number | null = null
  let limit = AUDIT_LOG_DEFAULT_LIMIT

  if (cursorValue !== null) {
    cursor = AUDIT_CURSOR_PATTERN.test(cursorValue) ? Number(cursorValue) : NaN

    if (!Number.isSafeInteger(cursor)) {
      return { ok: false, response: invalidCursorResponse() }
    }
  }

  if (limitValue !== null) {
    limit = AUDIT_LIMIT_PATTERN.test(limitValue) ? Number(limitValue) : NaN

    if (!Number.isSafeInteger(limit) || limit > AUDIT_LOG_MAX_LIMIT) {
      return { ok: false, response: invalidLimitResponse() }
    }
  }

  return { ok: true, query: { cursor, limit } }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored details object (the DB CHECK keeps it one), else null. */
function parseStoredDetails(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'string') {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }

  return isPlainObject(parsed) ? parsed : null
}

function toAuditLogEntry(row: StoredRow): AdminAuditLogEntry {
  const { id, action, targetId, reauthAt, createdAt } = row

  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    typeof action !== 'string' ||
    (targetId !== null && typeof targetId !== 'string') ||
    (reauthAt !== null && !isAuditInstant(reauthAt)) ||
    !isAuditInstant(createdAt)
  ) {
    // The table's CHECKs make this unreachable; never answer with a row
    // whose shape the page does not expect.
    throw new Error('ADMIN_AUDIT_ROW_INVALID')
  }

  return {
    id,
    action,
    targetId,
    details: parseStoredDetails(row.details),
    reauthAt,
    createdAt,
  }
}

/** GET /api/admin/audit-log (#39; AD). */
export async function handleAdminAuditLog(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin, url } = context

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const parsed = parseAuditLogQuery(url)

  if (!parsed.ok) {
    return parsed.response
  }

  const { cursor, limit } = parsed.query
  // One row more than the page tells whether another page follows.
  const result = await env.DB.prepare(ADMIN_ACCOUNT_SQL.auditLogPage)
    .bind(cursor, limit + 1)
    .all<StoredRow>()
  const rows = result.results.map(toAuditLogEntry)
  const entries = rows.slice(0, limit)
  const last = entries.at(-1)
  const nextCursor =
    rows.length > limit && last !== undefined ? String(last.id) : null

  return jsonResponse({ ok: true, entries, nextCursor })
}

/** GET /api/admin/session (#40; AD). */
export async function handleAdminSession(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin } = context

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  return jsonResponse({
    ok: true,
    ...describeAdminSession(admin, Date.now() / 1000),
  })
}

/** POST /api/admin/session/revoke-all (#44; AD+R). No body is read. */
export async function handleRevokeAllSessions(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin } = context
  const reauthRefusal = requireRecentSignIn(admin)

  if (reauthRefusal) {
    return reauthRefusal
  }

  const write = env.DB.prepare(ADMIN_ACCOUNT_SQL.revokeAllSessions).bind(
    Math.floor(admin.authTime) + 1,
    admin.uid,
  )
  const [stamped, audited] = await env.DB.batch([
    ...auditAfterWrite(
      env.DB,
      write,
      { uid: admin.uid, reauthAt: reauthAtFromToken(admin) },
      adminSessionsRevokedAudit(),
    ),
  ])

  if (stamped?.meta.changes !== 1 || audited?.meta.changes !== 1) {
    // The row stopped being this admin's between the guard and the write
    // (a demotion by the promote script); nothing was stamped or recorded.
    return errorResponse(
      403,
      'FORBIDDEN',
      'لا يملك هذا الحساب صلاحية الوصول إلى لوحة الإدارة.',
    )
  }

  return jsonResponse({ ok: true, revoked: true })
}
