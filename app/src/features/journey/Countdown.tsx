import { useEffect, useState } from 'react'
import type { JourneyDeadline, JourneyStageId } from '../../../shared/journey'
import JourneyIcon, { type JourneyIconName } from './JourneyIcon'
import {
  advanceCountdownClock,
  computeCountdown,
  getCountdownPurpose,
  getNextCountdownTickMs,
  normalizeClockOffset,
  subscribeToCountdownClock,
  type CountdownClockState,
  type CountdownView,
} from './countdown-model'
import './journey.css'

interface CountdownProps {
  /** Her current stage: it decides what the deadline means (hold, event…). */
  stage: JourneyStageId
  /** CustomerBooking.stageDeadline (already typed by the stage). */
  deadline: JourneyDeadline
  /**
   * MyBookingsResponse.serverClockOffsetMs: the server's clock minus this
   * device's, or null (then the device clock is used as is).
   */
  clockOffsetMs: number | null
}

function iconFor(view: CountdownView): JourneyIconName {
  if (view.status === 'urgent' || view.status === 'expired') {
    return 'alert'
  }

  return view.purpose === 'event' || view.purpose === 'handover'
    ? 'calendar'
    : 'hourglass'
}

/**
 * Counts down to the deadline of her current stage (design §4.9, copy
 * §4.3). It reads the server-corrected clock, redraws at most every 30 s,
 * stops while the tab is hidden and catches up when it is shown again, and
 * clears its timer and listener on unmount. Urgency is written out in words;
 * the icon's gentle pulse is only added when reduced motion is not requested.
 * Renders nothing for a stage without a countdown or an unreadable deadline.
 */
export default function Countdown({
  stage,
  deadline,
  clockOffsetMs,
}: CountdownProps) {
  const purpose = getCountdownPurpose(stage)
  const offsetMs = normalizeClockOffset(clockOffsetMs)
  const [clock, setClock] = useState<CountdownClockState>(() => ({
    nowMs: Date.now(),
    announcement: '',
  }))

  useEffect(() => {
    if (purpose === null) {
      return undefined
    }

    return subscribeToCountdownClock({
      visibility: document,
      getDelayMs: () =>
        getNextCountdownTickMs(purpose, deadline, Date.now() + offsetMs),
      onTick: () => {
        const nowMs = Date.now()
        setClock((previous) =>
          advanceCountdownClock(previous, nowMs, purpose, deadline, offsetMs),
        )
      },
    })
  }, [purpose, deadline, offsetMs])

  if (purpose === null) {
    return null
  }

  const view = computeCountdown(purpose, deadline, clock.nowMs + offsetMs)

  if (view === null) {
    return null
  }

  return (
    <div
      className={`journey-countdown journey-countdown--${view.tone} journey-countdown--${view.status}`}
    >
      <JourneyIcon className="journey-countdown__icon" name={iconFor(view)} />
      <div className="journey-countdown__body">
        {view.label !== null && view.value !== null && (
          <p className="journey-countdown__remaining">
            <span className="journey-countdown__label">{view.label}</span>{' '}
            <strong className="journey-countdown__value">{view.value}</strong>
          </p>
        )}
        {view.message !== null && (
          <p className="journey-countdown__message">{view.message}</p>
        )}
        <p className="journey-countdown__deadline">
          {view.deadlineLabel}{' '}
          <time className="journey-countdown__time" dateTime={view.deadlineDateTime}>
            {view.deadlineText}
          </time>
        </p>
      </div>
      <p className="journey-visually-hidden" aria-live="polite" aria-atomic="true">
        {clock.announcement}
      </p>
    </div>
  )
}
