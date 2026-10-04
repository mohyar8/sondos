import type { StageViewEntry } from '../journey/stage-views'

/**
 * Slot for the hub's `handover` view: pickup or delivery and the time slot
 * (W4-02). The hub's registry (../journey/stage-views.ts) reads this slot;
 * this feature never edits the registry. Null keeps the booking card.
 */
export const handoverStageView: StageViewEntry | null = null
