import {
  recordJobFinish,
  recordJobStart,
  type JobRunOutcome,
} from './jobs/heartbeat.js'
import {
  CRON_SCHEDULES,
  cronScheduleIds,
  isValidJobName,
  JobFailure,
  type CronScheduleId,
  type ScheduledJob,
} from './jobs/job-types.js'
import { scheduledJobs } from './jobs/registry.js'

/**
 * The Worker's `scheduled()` handler (ADR-001 §2.2).
 *
 * One tick = one Cron Trigger firing. The tick:
 * 1. maps `controller.cron` to a schedule in CRON_SCHEDULES (an unknown
 *    expression runs nothing);
 * 2. records the tick itself in job_runs under the schedule's heartbeat name,
 *    so a stale heartbeat means cron stopped firing, whatever jobs exist;
 * 3. runs that schedule's jobs one after another, in registry order. Each job
 *    is isolated: its failure is recorded in its own job_runs row and logged
 *    as a fixed code, and the next job still runs;
 * 4. stops starting jobs once the tick budget is spent. Deferred jobs catch
 *    up on the next tick because every job selects by state.
 * The tick never throws.
 *
 * Logs carry fixed codes and registry job names only: never tokens, names,
 * phone numbers, emails, signed URLs or error messages.
 */

/** The schedule for a cron expression, or null when it is not one of ours. */
export function resolveCronSchedule(cron: string): CronScheduleId | null {
  return cronScheduleIds.find((id) => CRON_SCHEDULES[id].cron === cron) ?? null
}

function hasErrorName(error: unknown, names: readonly string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    names.includes(error.name)
  )
}

/**
 * Maps a thrown value to a fixed code for job_runs and the logs. The message
 * is inspected only to pick a code; it is never stored or logged.
 */
export function classifyJobFailure(error: unknown): string {
  if (error instanceof JobFailure) {
    return error.code
  }

  if (hasErrorName(error, ['TimeoutError', 'AbortError'])) {
    return 'JOB_ABORTED'
  }

  if (error instanceof Error) {
    if (error.message.includes('no such table')) {
      return 'D1_SCHEMA_MISSING'
    }

    if (error.message.startsWith('D1_')) {
      return 'D1_ERROR'
    }
  }

  return 'JOB_FAILED'
}

/**
 * Heartbeat writes are best effort: a failed write (for example, migration
 * 0005 not yet applied) is logged as a fixed code and never stops a job.
 */
async function writeHeartbeat(
  job: string,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write()
  } catch (error) {
    console.error(
      `SCHEDULED_HEARTBEAT_FAILED job=${job} code=${classifyJobFailure(error)}`,
    )
  }
}

async function runIsolatedJob(
  job: ScheduledJob,
  env: Env,
  ctx: ExecutionContext,
  scheduledTime: number,
  signal: AbortSignal,
): Promise<void> {
  const now = new Date()
  const nowIso = now.toISOString()

  await writeHeartbeat(job.name, () => recordJobStart(env, job.name, nowIso))

  let outcome: JobRunOutcome

  try {
    await job.run({
      env,
      ctx,
      now,
      nowIso,
      scheduledTime,
      signal,
    })

    outcome = { status: 'ok' }
  } catch (error) {
    // Isolation boundary (ADR §2.2): whatever one job throws is recorded as a
    // fixed code, and the remaining jobs of the tick still run.
    const code = classifyJobFailure(error)

    console.error(`SCHEDULED_JOB_FAILED job=${job.name} code=${code}`)
    outcome = {
      status: 'error',
      code,
    }
  }

  await writeHeartbeat(job.name, () =>
    recordJobFinish(
      env,
      job.name,
      nowIso,
      new Date().toISOString(),
      outcome,
    ),
  )
}

export async function runScheduledTick(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  jobs: readonly ScheduledJob[] = scheduledJobs,
): Promise<void> {
  const scheduleId = resolveCronSchedule(controller.cron)

  if (scheduleId === null) {
    console.error('SCHEDULED_UNKNOWN_CRON')
    return
  }

  const schedule = CRON_SCHEDULES[scheduleId]
  const signal = AbortSignal.timeout(schedule.tickBudgetMs)
  const tickStartedAt = new Date().toISOString()
  // Heartbeat names are reserved: a job may never share a job_runs row.
  const claimedJobNames = new Set<string>(
    cronScheduleIds.map((id) => CRON_SCHEDULES[id].heartbeatJob),
  )
  let deferredJobs = false

  await writeHeartbeat(schedule.heartbeatJob, () =>
    recordJobStart(env, schedule.heartbeatJob, tickStartedAt),
  )

  for (const job of jobs) {
    if (job.schedule !== scheduleId) {
      continue
    }

    if (!isValidJobName(job.name) || claimedJobNames.has(job.name)) {
      console.error('SCHEDULED_JOB_INVALID_NAME')
      continue
    }

    claimedJobNames.add(job.name)

    if (signal.aborted) {
      deferredJobs = true
      console.error(`SCHEDULED_JOB_DEFERRED job=${job.name}`)
      continue
    }

    await runIsolatedJob(
      job,
      env,
      ctx,
      controller.scheduledTime,
      signal,
    )
  }

  const outcome: JobRunOutcome = deferredJobs
    ? {
        status: 'error',
        code: 'TICK_BUDGET_EXHAUSTED',
      }
    : { status: 'ok' }

  await writeHeartbeat(schedule.heartbeatJob, () =>
    recordJobFinish(
      env,
      schedule.heartbeatJob,
      tickStartedAt,
      new Date().toISOString(),
      outcome,
    ),
  )
}
