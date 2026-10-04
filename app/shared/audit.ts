import { bookingStatuses, type BookingStatus } from './admin.js'
import { isValidDateKey } from './timing.js'

/**
 * The admin audit log's vocabulary and its details allowlist (plan 11 W1-09;
 * SB-10, SB-13). admin_audit_log (migration 0008, table 6) records the admin
 * actions that are not tied to one booking; per-booking actions stay in
 * booking_status_history and booking_events.
 *
 * - Actions: exactly the admin_audit_actions rows of migrations 0008 and 0009
 *   (tests/admin-audit.test.mjs compares the two). A new action is a new
 *   migration row AND a new entry here.
 * - Details: one builder per action copies only the fields listed for it
 *   (ids, counts, dates and instants, section names and other fixed codes).
 *   No builder takes free text, so a name, phone number, email, address,
 *   note, IBAN or account holder cannot reach the log (SB-13). Every value is
 *   checked when the entry is built, and the serialised details are capped
 *   at ADMIN_AUDIT_DETAILS_MAX_LENGTH before any SQL runs.
 * - Entries: an AdminAuditEntry can only come from these builders. Its
 *   constructor demands a token this module never exports, and
 *   isAdminAuditEntry recognises only the objects the builders made, so a
 *   look-alike, a Proxy or Reflect.construct on entry.constructor is
 *   refused. worker/audit/admin-audit.ts, the one writer, accepts nothing
 *   else, and never the two promotion actions of scripts/promote-admin.mjs.
 * - Placement: each action is written by exactly one writer function
 *   (adminAuditPlacements), fixed in the entry's type and re-checked at
 *   run time, so a row can never outlive a write that changed nothing.
 *
 * A builder refuses a bad value with a TypeError that names the field and
 * never the value, which may be anything the caller held.
 */

/** admin_audit_actions, in migration order (0008, then 0009). */
export const adminAuditActions = [
  'settings_deposit_updated',
  'settings_bank_updated',
  'settings_contact_updated',
  'settings_pickup_updated',
  'terms_published',
  'delivery_area_created',
  'delivery_area_updated',
  'handover_slot_created',
  'handover_slots_generated',
  'handover_slot_updated',
  'handover_slot_deleted',
  'blocked_date_created',
  'blocked_date_deleted',
  'bookings_exported',
  'receipt_viewed',
  'gallery_selection_exported',
  'admin_promoted',
  'admin_demoted',
  'admin_sessions_revoked',
  'online_confirmation_switched',
] as const

export type AdminAuditAction = (typeof adminAuditActions)[number]

/**
 * Written only by scripts/promote-admin.mjs, in the batch that changes
 * users.role (L2, W1-12). No API writes users.role, so the Worker has no
 * builder for them.
 */
export const adminAuditScriptActions = [
  'admin_promoted',
  'admin_demoted',
] as const satisfies readonly AdminAuditAction[]

export type AdminAuditScriptAction = (typeof adminAuditScriptActions)[number]

/** The actions the Worker records. */
export type AdminAuditWorkerAction = Exclude<
  AdminAuditAction,
  AdminAuditScriptAction
>

const adminAuditActionSet: ReadonlySet<string> = new Set(adminAuditActions)
const adminAuditScriptActionSet: ReadonlySet<string> = new Set(
  adminAuditScriptActions,
)

export function isAdminAuditAction(value: unknown): value is AdminAuditAction {
  return typeof value === 'string' && adminAuditActionSet.has(value)
}

/** True for an action the Worker may record: never a promotion row. */
export function isAdminAuditWorkerAction(
  value: unknown,
): value is AdminAuditWorkerAction {
  return isAdminAuditAction(value) && !adminAuditScriptActionSet.has(value)
}

/**
 * Which writer function (worker/audit/admin-audit.ts) records an action:
 * - after_write: auditAfterWrite only. The action is one single-row write
 *   that may change no row by design (a conditional or optimistic UPDATE,
 *   an INSERT that may conflict, a DELETE of an unreferenced row, a
 *   revision INSERT skipped when nothing changed), so its row must exist
 *   only when that write changed exactly one row.
 * - standalone: auditStatement only. The action writes nothing else (an
 *   export, a viewed list) or records the counts its own writes produced
 *   (a generated batch), so the row is unconditional.
 */
export type AdminAuditPlacement = 'after_write' | 'standalone'

/** The one placement of each Worker action (plan 11 §3.3). */
export const adminAuditPlacements = Object.freeze({
  settings_deposit_updated: 'after_write',
  settings_bank_updated: 'after_write',
  settings_contact_updated: 'after_write',
  settings_pickup_updated: 'after_write',
  terms_published: 'after_write',
  delivery_area_created: 'after_write',
  delivery_area_updated: 'after_write',
  handover_slot_created: 'after_write',
  handover_slots_generated: 'standalone',
  handover_slot_updated: 'after_write',
  handover_slot_deleted: 'after_write',
  blocked_date_created: 'after_write',
  blocked_date_deleted: 'after_write',
  bookings_exported: 'standalone',
  receipt_viewed: 'standalone',
  gallery_selection_exported: 'standalone',
  admin_sessions_revoked: 'after_write',
  online_confirmation_switched: 'after_write',
} as const satisfies Record<AdminAuditWorkerAction, AdminAuditPlacement>)

type PlacementOf<Action extends AdminAuditWorkerAction> =
  (typeof adminAuditPlacements)[Action]

/**
 * The CHECK on admin_audit_log.details. The builders' shapes stay far below
 * it; the serialiser still refuses anything longer before the database sees
 * it. Counted in UTF-16 code units, which is never fewer than SQLite's
 * length() in characters.
 */
export const ADMIN_AUDIT_DETAILS_MAX_LENGTH = 2_000

export type SettingsSection = 'deposit' | 'bank' | 'contact' | 'pickup'
export type HandoverSlotMethod = 'pickup' | 'delivery' | 'both'
export type OnlineConfirmationState = 'on' | 'off'
export type DeliveryAreaField = 'name' | 'fee' | 'isActive' | 'sortOrder'

const handoverSlotMethods: readonly HandoverSlotMethod[] = [
  'pickup',
  'delivery',
  'both',
]
const onlineConfirmationStates: readonly OnlineConfirmationState[] = [
  'on',
  'off',
]

/**
 * The allowlist: the complete details object of each Worker action, as
 * stored and as GET /api/admin/audit-log returns it. Text never appears in
 * it; a changed delivery-area name is recorded as the field name 'name'.
 */
export type AdminAuditDetailsByAction = {
  readonly settings_deposit_updated: { readonly section: 'deposit' }
  readonly settings_bank_updated: { readonly section: 'bank' }
  readonly settings_contact_updated: { readonly section: 'contact' }
  readonly settings_pickup_updated: { readonly section: 'pickup' }
  readonly terms_published: { readonly bodySha256: string }
  readonly delivery_area_created: {
    readonly fee: number
    readonly isActive: boolean
    readonly sortOrder: number
  }
  readonly delivery_area_updated: {
    readonly changed: readonly DeliveryAreaField[]
    readonly fee?: number
    readonly isActive?: boolean
    readonly sortOrder?: number
  }
  readonly handover_slot_created: {
    readonly startsAt: string
    readonly endsAt: string
    readonly method: HandoverSlotMethod
    readonly capacity: number
  }
  readonly handover_slots_generated: {
    readonly fromDate: string
    readonly toDate: string
    readonly method: HandoverSlotMethod
    readonly capacity: number
    readonly created: number
    readonly skipped: number
  }
  readonly handover_slot_updated: {
    readonly capacity?: number
    readonly isActive?: boolean
  }
  readonly handover_slot_deleted: {
    readonly startsAt: string
    readonly method: HandoverSlotMethod
  }
  readonly blocked_date_created: null
  readonly blocked_date_deleted: null
  readonly bookings_exported: {
    readonly from: string
    readonly to: string
    readonly status: BookingStatus | null
    readonly rows: number
  }
  readonly receipt_viewed: { readonly receipts: number }
  readonly gallery_selection_exported: {
    readonly galleryId: string
    readonly photos: number
  }
  readonly admin_sessions_revoked: null
  readonly online_confirmation_switched: {
    readonly state: OnlineConfirmationState
  }
}

type AuditDetailValue = string | number | boolean | null | readonly string[]

type AuditDetailsInput = {
  readonly [key: string]: AuditDetailValue | undefined
}

/**
 * JSON for admin_audit_log.details, or null. Refuses output longer than
 * ADMIN_AUDIT_DETAILS_MAX_LENGTH, so an oversized row never reaches D1.
 */
export function serializeAdminAuditDetails(
  details: AuditDetailsInput | null,
): string | null {
  if (details === null) {
    return null
  }

  const json = JSON.stringify(details)

  if (json.length > ADMIN_AUDIT_DETAILS_MAX_LENGTH) {
    throw new RangeError(
      `Admin audit: details must be at most ${ADMIN_AUDIT_DETAILS_MAX_LENGTH} characters.`,
    )
  }

  return json
}

/**
 * What the row is about:
 * - none: nothing beyond the details (an export, a generated batch);
 * - id: a known id (a slot, an area, a booking, a date, a terms version);
 * - settings_revision / switch_revision: the settings_revisions or
 *   ops_switch_revisions row that the write right before the audit
 *   statement inserted, whose AUTOINCREMENT id only SQLite knows. Written
 *   only through auditAfterWrite, which checks in SQL that this row is of
 *   that table, section or state, and actor.
 */
export type AdminAuditTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'settings_revision'; readonly section: SettingsSection }
  | {
      readonly kind: 'switch_revision'
      readonly state: OnlineConfirmationState
    }

export type InsertedRowAuditTarget = Extract<
  AdminAuditTarget,
  { readonly kind: 'settings_revision' | 'switch_revision' }
>

export type StandaloneAuditTarget = Exclude<
  AdminAuditTarget,
  InsertedRowAuditTarget
>

type IdAuditTarget = Extract<AdminAuditTarget, { readonly kind: 'id' }>
type NoAuditTarget = Extract<AdminAuditTarget, { readonly kind: 'none' }>
type SettingsRevisionAuditTarget = Extract<
  AdminAuditTarget,
  { readonly kind: 'settings_revision' }
>
type SwitchRevisionAuditTarget = Extract<
  AdminAuditTarget,
  { readonly kind: 'switch_revision' }
>

const NO_TARGET: NoAuditTarget = Object.freeze({ kind: 'none' })

/**
 * required: the route is behind the recent-sign-in guard (AD+R or AD+S), so
 * the row must carry reauth_at; optional: stored only when the caller has it.
 */
type ReauthRule = 'required' | 'optional'

/**
 * The constructor's first argument. Only createEntry holds it, so `new`,
 * a subclass or Reflect.construct on an entry's .constructor throws outside
 * this module.
 */
const CONSTRUCT_TOKEN: unique symbol = Symbol('AdminAuditEntry')

/**
 * Every entry createEntry returned, and nothing else: the set the writer's
 * check reads, which no code outside this module can add to.
 */
const builtEntries = new WeakSet<object>()

/**
 * One audit row, minus the actor and time. Only createEntry constructs it
 * (the class is exported as a type only). The private field makes the type
 * nominal: an object literal of the same shape is not an AdminAuditEntry,
 * and neither is one whose placement differs.
 */
class AdminAuditEntry<
  Target extends AdminAuditTarget = AdminAuditTarget,
  Placement extends AdminAuditPlacement = AdminAuditPlacement,
> {
  readonly action: AdminAuditWorkerAction
  readonly target: Target
  readonly placement: Placement
  readonly reauthRequired: boolean
  readonly #detailsJson: string | null

  constructor(
    token: typeof CONSTRUCT_TOKEN,
    action: AdminAuditWorkerAction,
    target: Target,
    placement: Placement,
    detailsJson: string | null,
    reauthRequired: boolean,
  ) {
    if (token !== CONSTRUCT_TOKEN) {
      throw new TypeError(
        'Admin audit: entries come only from the shared/audit.ts builders.',
      )
    }

    this.action = action
    this.target = target
    this.placement = placement
    this.reauthRequired = reauthRequired
    this.#detailsJson = detailsJson
    Object.freeze(this)
  }

  /** Serialised details (≤ ADMIN_AUDIT_DETAILS_MAX_LENGTH), or null. */
  get detailsJson(): string | null {
    return this.#detailsJson
  }
}

// An entry exposes both through .constructor; neither may be patched (a
// replaced detailsJson getter would change what every entry reports).
Object.freeze(AdminAuditEntry.prototype)
Object.freeze(AdminAuditEntry)

export type { AdminAuditEntry }

/** An entry for auditAfterWrite: its row follows a write that may change nothing. */
export type AfterWriteAuditEntry = AdminAuditEntry<
  AdminAuditTarget,
  'after_write'
>

/** An entry for auditStatement: its row is unconditional. */
export type StandaloneAuditEntry = AdminAuditEntry<
  StandaloneAuditTarget,
  'standalone'
>

/** True only for an entry a builder of this module returned. */
export function isAdminAuditEntry(value: unknown): value is AdminAuditEntry {
  return typeof value === 'object' && value !== null && builtEntries.has(value)
}

function createEntry<
  Action extends AdminAuditWorkerAction,
  Target extends AdminAuditTarget,
>(
  action: Action,
  target: Target,
  details: AdminAuditDetailsByAction[Action],
  reauth: ReauthRule,
): AdminAuditEntry<Target, PlacementOf<Action>> {
  const entry = new AdminAuditEntry(
    CONSTRUCT_TOKEN,
    action,
    target,
    adminAuditPlacements[action],
    serializeAdminAuditDetails(details),
    reauth === 'required',
  )

  builtEntries.add(entry)

  return entry
}

// ---------------------------------------------------------------------------
// Value checks. Each returns the value it was given, or throws.
// ---------------------------------------------------------------------------

/** Largest count or amount a details field may hold. */
const MAXIMUM_DETAIL_NUMBER = 1_000_000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TERMS_VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const INSTANT_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/

/**
 * True for a `new Date().toISOString()` instant between years 0000 and 9999,
 * the only instant form the audit table's CHECKs accept.
 */
export function isAuditInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value)) {
    return false
  }

  const parsed = new Date(value)

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function invalid(field: string, rule: string): never {
  throw new TypeError(`Admin audit: ${field} must be ${rule}.`)
}

function requireUuid(value: unknown, field: string): string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value
    : invalid(field, 'a lowercase UUID')
}

function requireNumber(value: unknown, field: string, minimum = 0): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= MAXIMUM_DETAIL_NUMBER
    ? value
    : invalid(
        field,
        `an integer from ${minimum} to ${MAXIMUM_DETAIL_NUMBER}`,
      )
}

function requireBoolean(value: unknown, field: string): boolean {
  return typeof value === 'boolean' ? value : invalid(field, 'a boolean')
}

function requireDateKey(value: unknown, field: string): string {
  return typeof value === 'string' && isValidDateKey(value)
    ? value
    : invalid(field, 'a YYYY-MM-DD date')
}

function requireInstant(value: unknown, field: string): string {
  return isAuditInstant(value) ? value : invalid(field, 'an ISO-8601 instant')
}

function requireOneOf<Option extends string>(
  value: unknown,
  options: readonly Option[],
  field: string,
): Option {
  const match = options.find((option) => option === value)

  return match ?? invalid(field, `one of ${options.join(', ')}`)
}

function idTarget(id: string): IdAuditTarget {
  return Object.freeze({ kind: 'id', id })
}

function settingsRevisionTarget(
  section: SettingsSection,
): SettingsRevisionAuditTarget {
  return Object.freeze({ kind: 'settings_revision', section })
}

function switchRevisionTarget(
  state: OnlineConfirmationState,
): SwitchRevisionAuditTarget {
  return Object.freeze({ kind: 'switch_revision', state })
}

// ---------------------------------------------------------------------------
// Builders, one per Worker action (plan 11 §3.3). Each reads only the fields
// its details allow, so extra properties on an input object are never copied.
// The return type names the one writer function that accepts the entry:
// 'after_write' for auditAfterWrite, 'standalone' for auditStatement.
// ---------------------------------------------------------------------------

/**
 * PUT /api/admin/settings/{section} (#30, #31; AD+S or AD+R). The target is
 * the settings_revisions row of this section just inserted: pass this entry
 * to auditAfterWrite with that INSERT as the write. The bank values are
 * never recorded, only the revision id.
 */
export function settingsUpdatedAudit(
  section: SettingsSection,
): AdminAuditEntry<SettingsRevisionAuditTarget, 'after_write'> {
  switch (section) {
    case 'deposit':
      return createEntry(
        'settings_deposit_updated',
        settingsRevisionTarget(section),
        { section },
        'required',
      )
    case 'bank':
      return createEntry(
        'settings_bank_updated',
        settingsRevisionTarget(section),
        { section },
        'required',
      )
    case 'contact':
      return createEntry(
        'settings_contact_updated',
        settingsRevisionTarget(section),
        { section },
        'required',
      )
    case 'pickup':
      return createEntry(
        'settings_pickup_updated',
        settingsRevisionTarget(section),
        { section },
        'required',
      )
    default:
      return invalid('section', 'deposit, bank, contact or pickup')
  }
}

/**
 * POST /api/admin/settings/terms (#32; AD+S). The target is the version;
 * the write is its optimistic INSERT (409 TERMS_VERSION_CONFLICT on 0 rows).
 */
export function termsPublishedAudit(input: {
  readonly version: string
  readonly bodySha256: string
}): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  const version =
    typeof input.version === 'string' &&
    TERMS_VERSION_PATTERN.test(input.version)
      ? input.version
      : invalid('version', 'v1 to v9999')
  const bodySha256 =
    typeof input.bodySha256 === 'string' &&
    SHA256_PATTERN.test(input.bodySha256)
      ? input.bodySha256
      : invalid('bodySha256', '64 lowercase hex digits')

  return createEntry(
    'terms_published',
    idTarget(version),
    { bodySha256 },
    'required',
  )
}

/** POST /api/admin/settings/delivery-areas (#34). The name is not recorded. */
export function deliveryAreaCreatedAudit(
  areaId: string,
  input: {
    readonly fee: number
    readonly isActive: boolean
    readonly sortOrder: number
  },
): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  return createEntry(
    'delivery_area_created',
    idTarget(requireUuid(areaId, 'areaId')),
    {
      fee: requireNumber(input.fee, 'fee'),
      isActive: requireBoolean(input.isActive, 'isActive'),
      sortOrder: requireNumber(input.sortOrder, 'sortOrder'),
    },
    'optional',
  )
}

/**
 * PATCH /api/admin/settings/delivery-areas/{areaId} (#34). A new name is
 * recorded only as `changed: ['name']`; at least one field must change.
 */
export function deliveryAreaUpdatedAudit(
  areaId: string,
  input: {
    readonly nameChanged?: boolean
    readonly fee?: number
    readonly isActive?: boolean
    readonly sortOrder?: number
  },
): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  const target = idTarget(requireUuid(areaId, 'areaId'))
  const nameChanged =
    input.nameChanged === undefined
      ? false
      : requireBoolean(input.nameChanged, 'nameChanged')
  const fee =
    input.fee === undefined ? undefined : requireNumber(input.fee, 'fee')
  const isActive =
    input.isActive === undefined
      ? undefined
      : requireBoolean(input.isActive, 'isActive')
  const sortOrder =
    input.sortOrder === undefined
      ? undefined
      : requireNumber(input.sortOrder, 'sortOrder')
  const changed: DeliveryAreaField[] = []

  if (nameChanged) {
    changed.push('name')
  }

  if (fee !== undefined) {
    changed.push('fee')
  }

  if (isActive !== undefined) {
    changed.push('isActive')
  }

  if (sortOrder !== undefined) {
    changed.push('sortOrder')
  }

  if (changed.length === 0) {
    return invalid('the update', 'a change to at least one field')
  }

  return createEntry(
    'delivery_area_updated',
    target,
    { changed, fee, isActive, sortOrder },
    'optional',
  )
}

/** POST /api/admin/handover-slots (#28). */
export function handoverSlotCreatedAudit(
  slotId: string,
  input: {
    readonly startsAt: string
    readonly endsAt: string
    readonly method: HandoverSlotMethod
    readonly capacity: number
  },
): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  return createEntry(
    'handover_slot_created',
    idTarget(requireUuid(slotId, 'slotId')),
    {
      startsAt: requireInstant(input.startsAt, 'startsAt'),
      endsAt: requireInstant(input.endsAt, 'endsAt'),
      method: requireOneOf(input.method, handoverSlotMethods, 'method'),
      capacity: requireNumber(input.capacity, 'capacity', 1),
    },
    'optional',
  )
}

/**
 * POST /api/admin/handover-slots/generate (#28): the range and the counts
 * the batch produced, recorded even when every slot already existed.
 */
export function handoverSlotsGeneratedAudit(input: {
  readonly fromDate: string
  readonly toDate: string
  readonly method: HandoverSlotMethod
  readonly capacity: number
  readonly created: number
  readonly skipped: number
}): AdminAuditEntry<NoAuditTarget, 'standalone'> {
  return createEntry(
    'handover_slots_generated',
    NO_TARGET,
    {
      fromDate: requireDateKey(input.fromDate, 'fromDate'),
      toDate: requireDateKey(input.toDate, 'toDate'),
      method: requireOneOf(input.method, handoverSlotMethods, 'method'),
      capacity: requireNumber(input.capacity, 'capacity', 1),
      created: requireNumber(input.created, 'created'),
      skipped: requireNumber(input.skipped, 'skipped'),
    },
    'optional',
  )
}

/**
 * PATCH /api/admin/handover-slots/{slotId} (#28): the new values. The write
 * is the conditional UPDATE (0 rows → 409 CAPACITY_BELOW_BOOKED).
 */
export function handoverSlotUpdatedAudit(
  slotId: string,
  input: { readonly capacity?: number; readonly isActive?: boolean },
): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  const target = idTarget(requireUuid(slotId, 'slotId'))
  const capacity =
    input.capacity === undefined
      ? undefined
      : requireNumber(input.capacity, 'capacity', 1)
  const isActive =
    input.isActive === undefined
      ? undefined
      : requireBoolean(input.isActive, 'isActive')

  if (capacity === undefined && isActive === undefined) {
    return invalid('the update', 'a change to capacity or isActive')
  }

  return createEntry(
    'handover_slot_updated',
    target,
    { capacity, isActive },
    'optional',
  )
}

/**
 * DELETE /api/admin/handover-slots/{slotId} (#28): what the slot was. The
 * write deletes only a slot never referenced (0 rows → 409).
 */
export function handoverSlotDeletedAudit(
  slotId: string,
  input: { readonly startsAt: string; readonly method: HandoverSlotMethod },
): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  return createEntry(
    'handover_slot_deleted',
    idTarget(requireUuid(slotId, 'slotId')),
    {
      startsAt: requireInstant(input.startsAt, 'startsAt'),
      method: requireOneOf(input.method, handoverSlotMethods, 'method'),
    },
    'optional',
  )
}

/** A blocked date added (W3-02): the date is the target; no reason text. */
export function blockedDateCreatedAudit(
  eventDate: string,
): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  return createEntry(
    'blocked_date_created',
    idTarget(requireDateKey(eventDate, 'eventDate')),
    null,
    'optional',
  )
}

/** A blocked date removed (W3-02). The target is the date. */
export function blockedDateDeletedAudit(
  eventDate: string,
): AdminAuditEntry<IdAuditTarget, 'after_write'> {
  return createEntry(
    'blocked_date_deleted',
    idTarget(requireDateKey(eventDate, 'eventDate')),
    null,
    'optional',
  )
}

/** GET /api/admin/exports/bookings.csv (#38; AD+R): filter and row count. */
export function bookingsExportedAudit(input: {
  readonly from: string
  readonly to: string
  readonly status: BookingStatus | null
  readonly rows: number
}): AdminAuditEntry<NoAuditTarget, 'standalone'> {
  return createEntry(
    'bookings_exported',
    NO_TARGET,
    {
      from: requireDateKey(input.from, 'from'),
      to: requireDateKey(input.to, 'to'),
      status:
        input.status === null
          ? null
          : requireOneOf(input.status, bookingStatuses, 'status'),
      rows: requireNumber(input.rows, 'rows'),
    },
    'required',
  )
}

/** GET /api/admin/bookings/{id}/receipts (#26): one row per list call. */
export function receiptViewedAudit(
  bookingId: string,
  input: { readonly receipts: number },
): AdminAuditEntry<IdAuditTarget, 'standalone'> {
  return createEntry(
    'receipt_viewed',
    idTarget(requireUuid(bookingId, 'bookingId')),
    { receipts: requireNumber(input.receipts, 'receipts') },
    'optional',
  )
}

/** The admin gallery selection export (#27). The target is the booking. */
export function gallerySelectionExportedAudit(
  bookingId: string,
  input: { readonly galleryId: string; readonly photos: number },
): AdminAuditEntry<IdAuditTarget, 'standalone'> {
  return createEntry(
    'gallery_selection_exported',
    idTarget(requireUuid(bookingId, 'bookingId')),
    {
      galleryId: requireUuid(input.galleryId, 'galleryId'),
      photos: requireNumber(input.photos, 'photos'),
    },
    'optional',
  )
}

/**
 * POST /api/admin/session/revoke-all (#44; AD+R). The actor is the admin
 * whose sessions ended; there is no other target. The write is the UPDATE
 * of that admin's users.tokens_valid_after.
 */
export function adminSessionsRevokedAudit(): AdminAuditEntry<
  NoAuditTarget,
  'after_write'
> {
  return createEntry('admin_sessions_revoked', NO_TARGET, null, 'required')
}

/**
 * PUT /api/admin/settings/switch (#43): turning it off needs only the admin
 * guard, turning it on a recent sign-in. The target is the
 * online_confirmation row of ops_switch_revisions with this state just
 * inserted (auditAfterWrite); the note is not recorded.
 */
export function onlineConfirmationSwitchedAudit(
  state: OnlineConfirmationState,
): AdminAuditEntry<SwitchRevisionAuditTarget, 'after_write'> {
  const checkedState = requireOneOf(state, onlineConfirmationStates, 'state')

  return createEntry(
    'online_confirmation_switched',
    switchRevisionTarget(checkedState),
    { state: checkedState },
    checkedState === 'on' ? 'required' : 'optional',
  )
}
