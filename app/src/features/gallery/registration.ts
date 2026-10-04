import type { StageViewEntry } from '../journey/stage-views'

/**
 * Slot for the hub's `gallery` view: choosing her photos (W11-03). The hub's
 * registry (../journey/stage-views.ts) reads this slot; this feature never
 * edits the registry. Null keeps the booking card. The gallery routes are
 * private media: the Worker answers 503 until the whole PM gate holds.
 */
export const galleryStageView: StageViewEntry | null = null
