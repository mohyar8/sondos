import {
  JOURNEY_STAGE_COUNT,
  getJourneyStageNumber,
  journeyStageIds,
  journeyStageLabels,
  type JourneyStageId,
  type JourneySubState,
} from '../../../shared/journey'

/**
 * The journey tracker's phases (red-team R3, which supersedes the 8-step
 * stepper of 03-design-system §4.8). The 15 derived stages of ADR-001 §2.1
 * are grouped into 7 named phases so the stepper stays readable on a phone,
 * while every stage — including the two after the handover — still has a
 * place and a name.
 */
export const journeyPhaseIds = [
  'request',
  'confirmation',
  'before_event',
  'photos',
  'album',
  'handover',
  'after_handover',
] as const

export type JourneyPhaseId = (typeof journeyPhaseIds)[number]

export const journeyPhaseLabels: Readonly<Record<JourneyPhaseId, string>> = {
  request: 'الطلب',
  confirmation: 'تأكيد الحجز',
  before_event: 'قبل المناسبة',
  photos: 'الصور',
  album: 'الألبوم',
  handover: 'الاستلام',
  after_handover: 'بعد التسليم',
}

/**
 * Which phase each stage belongs to. A `Record` over every stage id, so a
 * stage added to shared/journey.ts fails to compile here until it is placed.
 */
export const journeyStagePhases = {
  pending_review: 'request',
  approved_hold: 'confirmation',
  terms_and_receipt_pending: 'confirmation',
  receipt_review: 'confirmation',
  confirmed: 'before_event',
  pre_event_engagement: 'before_event',
  gallery_open: 'photos',
  gallery_locked: 'photos',
  album_design: 'album',
  album_printing: 'album',
  album_ready: 'album',
  handover_scheduling: 'handover',
  handover_day: 'handover',
  completed_feedback: 'after_handover',
  privacy_cleanup: 'after_handover',
} as const satisfies Record<JourneyStageId, JourneyPhaseId>

/**
 * A short note shown beside the current stage when a sub-state changes what
 * she sees (ADR-001 §2.1; «مسار سابق» from 08-copy-ar §4.1).
 */
export const journeySubStateNotes: Readonly<Record<JourneySubState, string>> = {
  legacy_flow: 'مسار سابق: نتابع معكِ الخطوات التالية مباشرة.',
  receipt_rejected: 'نحتاج إيصالًا آخر لإكمال حجزكِ.',
  awaiting_previews: 'نجهّز معاينات صوركِ.',
  handover_missed: 'لم يتم الاستلام في الموعد السابق. اختاري موعدًا جديدًا.',
}

export type JourneyStepState = 'complete' | 'current' | 'upcoming'

export interface JourneyStageStep {
  readonly id: JourneyStageId
  readonly label: string
  /** 1–15. */
  readonly number: number
  readonly state: JourneyStepState
}

export interface JourneyPhaseStep {
  readonly id: JourneyPhaseId
  readonly label: string
  /** 1–7. */
  readonly number: number
  readonly state: JourneyStepState
  readonly stages: readonly JourneyStageStep[]
}

export interface JourneyProgress {
  readonly stage: JourneyStageStep
  readonly stageCount: number
  readonly phase: JourneyPhaseStep
  readonly phaseCount: number
  readonly phases: readonly JourneyPhaseStep[]
  /** 0–100: how far along the 15 stages she is (stage 1 = 0, stage 15 = 100). */
  readonly percent: number
}

function stepState(position: number, currentPosition: number): JourneyStepState {
  if (position < currentPosition) {
    return 'complete'
  }

  return position === currentPosition ? 'current' : 'upcoming'
}

function buildPhaseStep(
  phaseId: JourneyPhaseId,
  currentStageNumber: number,
  currentPhaseNumber: number,
): JourneyPhaseStep {
  const number = journeyPhaseIds.indexOf(phaseId) + 1
  const stages = journeyStageIds
    .filter((stageId) => journeyStagePhases[stageId] === phaseId)
    .map((stageId): JourneyStageStep => {
      const stageNumber = getJourneyStageNumber(stageId)
      return {
        id: stageId,
        label: journeyStageLabels[stageId],
        number: stageNumber,
        state: stepState(stageNumber, currentStageNumber),
      }
    })

  return {
    id: phaseId,
    label: journeyPhaseLabels[phaseId],
    number,
    state: stepState(number, currentPhaseNumber),
    stages,
  }
}

/** Everything the tracker renders for her current stage. Pure. */
export function getJourneyProgress(currentStage: JourneyStageId): JourneyProgress {
  const currentNumber = getJourneyStageNumber(currentStage)
  const currentPhaseId = journeyStagePhases[currentStage]
  const currentPhaseNumber = journeyPhaseIds.indexOf(currentPhaseId) + 1

  return {
    stage: {
      id: currentStage,
      label: journeyStageLabels[currentStage],
      number: currentNumber,
      state: 'current',
    },
    stageCount: JOURNEY_STAGE_COUNT,
    phase: buildPhaseStep(currentPhaseId, currentNumber, currentPhaseNumber),
    phaseCount: journeyPhaseIds.length,
    phases: journeyPhaseIds.map((phaseId) =>
      buildPhaseStep(phaseId, currentNumber, currentPhaseNumber),
    ),
    percent: Math.round(((currentNumber - 1) / (JOURNEY_STAGE_COUNT - 1)) * 100),
  }
}
