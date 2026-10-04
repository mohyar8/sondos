import type { StageViewEntry } from '../journey/stage-views'

/**
 * Slot for the hub's `feedback` view: her optional rating and comment
 * (W3-14). The hub's registry (../journey/stage-views.ts) reads this slot;
 * this feature never edits the registry. Null keeps the booking card.
 */
export const feedbackStageView: StageViewEntry | null = null
