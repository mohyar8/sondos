import { outboxDrainJob } from '../notify/outbox.js'
import { holdExpiryJob } from './hold-expiry.js'
import { holdRemindersJob } from './hold-reminders.js'
import type { ScheduledJob } from './job-types.js'

/**
 * Every cron job, in run order (ADR-001 §2.2, §6.2).
 *
 * worker/scheduled.ts runs the jobs whose `schedule` matches the tick, one
 * after another in this array's order, each isolated from the others and
 * recorded in job_runs. Never edit worker/scheduled.ts to add a job.
 *
 * Each workstream adds ONE import and ONE entry (ADR §6.2 order: W3-3 outbox
 * drain → W3-4 hold jobs → W5-1 → W6-1 → W7-1 → W8-1 → W8-2). Place the entry
 * by run order, not simply at the end: jobs that change state or queue emails
 * (hold expiry, reminders) come BEFORE `outbox-drain`, which stays last in the
 * quarter-hourly group so one tick sends what it has just queued.
 */
export const scheduledJobs: readonly ScheduledJob[] = [
  // quarter-hourly: expire first (it supersedes the expiring holds' pending
  // reminders), then queue reminders, and keep outbox-drain last.
  holdExpiryJob,
  holdRemindersJob,
  outboxDrainJob,
]
