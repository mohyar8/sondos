import type { StageViewEntry } from '../journey/stage-views'

/**
 * Slot for the hub's `details` view: her event details, publishing consent
 * and the calendar file (W3-13). The hub's registry
 * (../journey/stage-views.ts) reads this slot; this feature never edits the
 * registry. Null keeps the booking card.
 */
export const eventProfileStageView: StageViewEntry | null = null
