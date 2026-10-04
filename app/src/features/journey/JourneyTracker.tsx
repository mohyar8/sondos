import { useId } from 'react'
import type { JourneyStageId, JourneySubState } from '../../../shared/journey'
import JourneyIcon, { type JourneyIconName } from './JourneyIcon'
import {
  getJourneyProgress,
  journeySubStateNotes,
  type JourneyStepState,
} from './journey-phases'
import './journey.css'

interface JourneyTrackerProps {
  /** Her current stage (CustomerBooking.stage). Legacy and terminal bookings have none: do not render the tracker for them. */
  stage: JourneyStageId
  subState?: JourneySubState | null
}

const stepIcons: Readonly<Record<JourneyStepState, JourneyIconName>> = {
  complete: 'check',
  current: 'current',
  upcoming: 'upcoming',
}

/** Written state for every step, so no state is shown by colour or icon alone. */
const stepStateLabels: Readonly<Record<JourneyStepState, string>> = {
  complete: 'مكتملة',
  current: 'الحالية',
  upcoming: 'قادمة',
}

/**
 * The journey stepper (ADR-001 W3-7 T2, red-team R3). Seven named phases —
 * horizontal from 48rem, vertical on phones — with her current stage named
 * inside its phase, and a disclosure listing all 15 stages grouped by phase.
 * States are carried by text and icons, the current phase and stage by
 * aria-current="step"; colour only reinforces them.
 */
export default function JourneyTracker({
  stage,
  subState = null,
}: JourneyTrackerProps) {
  const titleId = useId()
  const progress = getJourneyProgress(stage)
  const note = subState === null ? null : journeySubStateNotes[subState]

  return (
    <div className="journey-tracker" role="group" aria-labelledby={titleId}>
      <div className="journey-tracker__header">
        <p className="journey-tracker__title" id={titleId}>
          مراحل حجزكِ
        </p>
        <p className="journey-tracker__summary">
          <span className="journey-tracker__summary-phase">
            المرحلة {progress.phase.number} من {progress.phaseCount}:{' '}
            {progress.phase.label}
          </span>
          <span className="journey-tracker__summary-stage">
            الخطوة {progress.stage.number} من {progress.stageCount}:{' '}
            {progress.stage.label}
          </span>
        </p>
        {note !== null && (
          <p className="journey-tracker__note">
            <JourneyIcon className="journey-tracker__note-icon" name="info" />
            <span>{note}</span>
          </p>
        )}
        <div className="journey-tracker__bar" aria-hidden="true">
          <span
            className="journey-tracker__bar-fill"
            style={{ inlineSize: `${progress.percent}%` }}
          />
        </div>
      </div>

      <ol className="journey-tracker__phases">
        {progress.phases.map((phase) => (
          <li
            className={`journey-tracker__phase journey-tracker__phase--${phase.state}`}
            key={phase.id}
            aria-current={phase.state === 'current' ? 'step' : undefined}
          >
            <span className="journey-tracker__marker" aria-hidden="true">
              {phase.state === 'complete' ? (
                <JourneyIcon className="journey-tracker__marker-icon" name="check" />
              ) : (
                <span className="journey-tracker__marker-number">
                  {phase.number}
                </span>
              )}
            </span>
            <span className="journey-tracker__phase-body">
              <span className="journey-tracker__phase-label">{phase.label}</span>
              <span className="journey-tracker__phase-state">
                {phase.state === 'current'
                  ? `أنتِ هنا: ${progress.stage.label}`
                  : stepStateLabels[phase.state]}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <details className="journey-tracker__details">
        <summary className="journey-tracker__details-summary">
          عرض جميع الخطوات ({progress.stageCount})
        </summary>
        <ol className="journey-tracker__groups">
          {progress.phases.map((phase) => (
            <li className="journey-tracker__group" key={phase.id}>
              <p className="journey-tracker__group-title">
                {phase.label}
                <span className="journey-tracker__group-state">
                  {' — '}
                  {stepStateLabels[phase.state]}
                </span>
              </p>
              <ol className="journey-tracker__stages">
                {phase.stages.map((step) => (
                  <li
                    className={`journey-tracker__stage journey-tracker__stage--${step.state}`}
                    key={step.id}
                    aria-current={step.state === 'current' ? 'step' : undefined}
                  >
                    <JourneyIcon
                      className="journey-tracker__stage-icon"
                      name={stepIcons[step.state]}
                    />
                    <span className="journey-tracker__stage-number">
                      <span className="journey-visually-hidden">الخطوة </span>
                      {step.number}
                    </span>
                    <span className="journey-tracker__stage-label">
                      {step.label}
                    </span>
                    <span className="journey-tracker__stage-state">
                      {stepStateLabels[step.state]}
                    </span>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </details>
    </div>
  )
}
