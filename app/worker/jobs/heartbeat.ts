/**
 * Cron heartbeat writes to `job_runs` (migrations/0005, ADR-001 §2.2).
 *
 * One row per job name. A run writes `last_started_at` when it begins and the
 * outcome when it ends, so `last_started_at > last_finished_at` means a run
 * was cut off. `last_ok_at` only moves on success, which is what the admin
 * queue's stale-cron warning reads. Every instant is a bound
 * `toISOString()` value (never SQLite 'now').
 */

export type JobRunOutcome =
  | {
      readonly status: 'ok'
    }
  | {
      readonly status: 'error'
      readonly code: string
    }

const RECORD_START_SQL = `
  INSERT INTO job_runs (job, last_started_at)
  VALUES (?1, ?2)
  ON CONFLICT (job) DO UPDATE SET
    last_started_at = excluded.last_started_at
`

// The WHERE clause stops a late finish from an older run overwriting the
// state of a newer run that has already started.
const RECORD_FINISH_SQL = `
  INSERT INTO job_runs (
    job,
    last_started_at,
    last_finished_at,
    last_ok_at,
    last_status,
    last_error_code
  )
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (job) DO UPDATE SET
    last_started_at = excluded.last_started_at,
    last_finished_at = excluded.last_finished_at,
    last_ok_at = COALESCE(excluded.last_ok_at, job_runs.last_ok_at),
    last_status = excluded.last_status,
    last_error_code = excluded.last_error_code
  WHERE job_runs.last_started_at IS NULL
    OR job_runs.last_started_at <= excluded.last_started_at
`

export async function recordJobStart(
  env: Env,
  job: string,
  startedAt: string,
): Promise<void> {
  await env.DB.prepare(RECORD_START_SQL)
    .bind(job, startedAt)
    .run()
}

export async function recordJobFinish(
  env: Env,
  job: string,
  startedAt: string,
  finishedAt: string,
  outcome: JobRunOutcome,
): Promise<void> {
  const succeeded = outcome.status === 'ok'

  await env.DB.prepare(RECORD_FINISH_SQL)
    .bind(
      job,
      startedAt,
      finishedAt,
      succeeded ? finishedAt : null,
      outcome.status,
      succeeded ? null : outcome.code,
    )
    .run()
}
