import type { StageViewEntry } from '../journey/stage-views'

/**
 * Slot for the hub's `complete` view: terms, deposit instructions and the
 * receipt step (W4-01). The hub's registry (../journey/stage-views.ts) reads
 * this slot; this feature never edits the registry. Null keeps the booking
 * card. The Worker's confirmation routes decide what she may see or change.
 */
export const confirmationStageView: StageViewEntry | null = null
