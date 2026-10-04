/**
 * Types and limits shared by every cron job (ADR-001 §2.2).
 *
 * The cron expressions below MUST equal `triggers.crons` in wrangler.jsonc.
 * Cron Triggers run on UTC, so the daily tick at 00:00 UTC is 03:00 Riyadh.
 */

interface CronScheduleConfig {
  /** The exact expression Cloudflare passes in `controller.cron`. */
  readonly cron: string
  /**
   * The job_runs row that records every tick of this schedule, whatever jobs
   * are registered. The admin queue (W8-3) reads its `last_ok_at` to warn
   * when cron has stopped firing.
   */
  readonly heartbeatJob: string
  /**
   * Wall-clock budget for one tick. No job starts after it is spent, and
   * `JobContext.signal` aborts when it runs out, so a job can stop its loop
   * and leave the rest to the next tick.
   */
  readonly tickBudgetMs: number
}

export const CRON_SCHEDULES = {
  'quarter-hourly': {
    cron: '*/15 * * * *',
    heartbeatJob: 'scheduler-quarter-hourly',
    tickBudgetMs: 20_000,
  },
  daily: {
    cron: '0 0 * * *',
    heartbeatJob: 'scheduler-daily',
    tickBudgetMs: 120_000,
  },
} as const satisfies Readonly<Record<string, CronScheduleConfig>>

export type CronScheduleId = keyof typeof CRON_SCHEDULES

export const cronScheduleIds: readonly CronScheduleId[] = [
  'quarter-hourly',
  'daily',
]

/**
 * Per-tick work caps from ADR §2.2. A job selects by state and processes at
 * most this many rows (or emails); whatever is left is picked up next tick.
 */
export const JOB_LIMITS = {
  maxRowsPerTick: 50,
  maxEmailsPerTick: 40,
} as const

export interface JobContext {
  readonly env: Env
  readonly ctx: ExecutionContext
  /** The instant this job started; bind `nowIso`, never SQLite 'now'. */
  readonly now: Date
  readonly nowIso: string
  /** `controller.scheduledTime` of this tick, in epoch milliseconds. */
  readonly scheduledTime: number
  /** Aborts when the tick budget is spent. Pass it to fetch and check it in loops. */
  readonly signal: AbortSignal
}

export interface ScheduledJob {
  /**
   * The job_runs primary key: 3–40 characters, lowercase a–z and '-' only
   * (the CHECK in migrations/0005). Must be unique across the registry.
   */
  readonly name: string
  readonly schedule: CronScheduleId
  /**
   * Does one bounded unit of work. Resolve when done; throw JobFailure with a
   * fixed code for a known failure. Anything else is recorded as JOB_FAILED.
   * Never log tokens, names, phone numbers, emails or signed URLs.
   */
  readonly run: (context: JobContext) => Promise<void>
}

const JOB_NAME_PATTERN = /^[a-z-]{3,40}$/
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/

export function isValidJobName(value: string): boolean {
  return JOB_NAME_PATTERN.test(value)
}

/** A fixed error code as stored in job_runs.last_error_code: A–Z, 0–9 and '_', 1–64 long. */
export function isValidJobErrorCode(value: string): boolean {
  return ERROR_CODE_PATTERN.test(value)
}

/** Thrown by a job to record a specific fixed error code in job_runs. */
export class JobFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'JobFailure'
    this.code = isValidJobErrorCode(code) ? code : 'JOB_FAILED'
  }
}
