import { Suspense, useEffect, useId, useRef, type ReactNode } from 'react'
import type { CustomerBooking } from '../../api/bookings'
import RouteErrorBoundary from '../../layout/RouteErrorBoundary'
import RouteFallback from '../../layout/RouteFallback'
import JourneyIcon from './JourneyIcon'
import {
  resolveStageView,
  stageViews,
  type ResolvedStageView,
  type StageViewRegistry,
} from './stage-views'
import './journey.css'

interface StageViewHostProps {
  booking: CustomerBooking
  /** The raw `?view=` value (readSearchParam('view')), or null. */
  requestedView: string | null
  /** The booking card, shown whenever no registered view applies. */
  fallback: ReactNode
  clockOffsetMs: number | null
  /** Returns to the booking card (the hub drops `view` from the address). */
  onClose: () => void
  onBookingChanged: () => void
  /** The registered views; only tests pass anything but the default. */
  registry?: StageViewRegistry
}

interface StageViewPanelProps
  extends Omit<StageViewHostProps, 'requestedView' | 'fallback' | 'registry'> {
  view: ResolvedStageView
}

function StageViewPanel({
  view,
  booking,
  clockOffsetMs,
  onClose,
  onBookingChanged,
}: StageViewPanelProps) {
  const titleId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const { entry } = view
  const ViewComponent = entry.Component

  // Opening a view replaces the card in place: move focus to its heading so
  // keyboard and screen-reader users land at the start of the new content.
  useEffect(() => {
    headingRef.current?.focus()
  }, [view.id, booking.id])

  return (
    <section className="journey-stage-view" aria-labelledby={titleId}>
      <div className="journey-stage-view__header">
        <h3
          className="journey-stage-view__title"
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
        >
          {entry.title}
        </h3>
        <button className="btn btn--ghost" type="button" onClick={onClose}>
          <JourneyIcon className="journey-stage-view__close-icon" name="close" />
          العودة إلى تفاصيل الحجز
        </button>
      </div>
      <RouteErrorBoundary variant="inline" title={`تعذّر عرض «${entry.title}».`}>
        <Suspense
          fallback={<RouteFallback variant="inline" label="جارٍ تحميل القسم…" />}
        >
          <ViewComponent
            booking={booking}
            clockOffsetMs={clockOffsetMs}
            onBookingChanged={onBookingChanged}
            onClose={onClose}
          />
        </Suspense>
      </RouteErrorBoundary>
    </section>
  )
}

/**
 * Shows the stage view named by `?view=` for this booking (ADR-001 §2.6),
 * each lazily loaded behind its own error boundary. Anything else — no view,
 * an unknown or unregistered view, or one not allowed at her current stage —
 * falls back to the booking card; a view that was asked for but cannot open
 * also gets a short notice, so a link from an email never lands on a blank
 * or broken panel. In Run 3 no view is registered, so this always shows the
 * card.
 */
export default function StageViewHost({
  booking,
  requestedView,
  fallback,
  clockOffsetMs,
  onClose,
  onBookingChanged,
  registry = stageViews,
}: StageViewHostProps) {
  const view = resolveStageView(requestedView, booking, registry)

  if (view === null) {
    return (
      <>
        {requestedView !== null && (
          <p className="notice notice--info journey-stage-view__unavailable">
            <JourneyIcon className="notice__icon" name="info" />
            <span>
              هذا القسم غير متاح لهذا الحجز حاليًا، وهذه تفاصيل حجزكِ.
            </span>
          </p>
        )}
        {fallback}
      </>
    )
  }

  return (
    <StageViewPanel
      booking={booking}
      clockOffsetMs={clockOffsetMs}
      key={`${booking.id}:${view.id}`}
      view={view}
      onBookingChanged={onBookingChanged}
      onClose={onClose}
    />
  )
}
