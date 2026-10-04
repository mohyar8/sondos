import { Suspense, useCallback } from 'react'
import type { AdminBookingDetail } from '../../../shared/admin'
import RouteErrorBoundary from '../../layout/RouteErrorBoundary'
import RouteFallback from '../../layout/RouteFallback'
import {
  adminBookingSections,
  type AdminBookingSection,
} from './sections'

interface AdminBookingPortalProps {
  booking: AdminBookingDetail
  getIdToken: () => Promise<string | null>
  onRefreshBooking: () => void
  onRefreshList: () => void
  /** Aggregated by the dashboard: any busy source keeps the panel open. */
  onBusyChange: (sourceId: string, busy: boolean) => void
}

interface AdminBookingSectionSlotProps
  extends Omit<AdminBookingPortalProps, 'onBusyChange'> {
  section: AdminBookingSection
  onBusyChange: (sourceId: string, busy: boolean) => void
}

function AdminBookingSectionSlot({
  section,
  booking,
  getIdToken,
  onRefreshBooking,
  onRefreshList,
  onBusyChange,
}: AdminBookingSectionSlotProps) {
  const sectionId = section.id
  const reportBusy = useCallback(
    (busy: boolean) => onBusyChange(`portal-section:${sectionId}`, busy),
    [onBusyChange, sectionId],
  )
  const SectionComponent = section.Component
  const titleId = `admin-portal-${sectionId}-title`

  return (
    <section className="admin-portal__section" aria-labelledby={titleId}>
      <h3 className="admin-portal__title" id={titleId}>
        {section.title}
      </h3>
      <RouteErrorBoundary
        variant="inline"
        title={`تعذّر عرض قسم «${section.title}».`}
      >
        <Suspense
          fallback={
            <RouteFallback variant="inline" label="جارٍ تحميل القسم…" />
          }
        >
          <SectionComponent
            booking={booking}
            getIdToken={getIdToken}
            onBusyChange={reportBusy}
            onRefreshBooking={onRefreshBooking}
            onRefreshList={onRefreshList}
          />
        </Suspense>
      </RouteErrorBoundary>
    </section>
  )
}

/**
 * The booking detail panel's plug-in point (ADR-001 §2.6). It renders the
 * sections registered in ./sections.ts that apply to this booking, in order,
 * each lazily loaded behind its own error boundary so one failing section
 * never takes the panel down. With nothing registered (Run 3) it renders
 * nothing at all.
 */
export default function AdminBookingPortal({
  booking,
  getIdToken,
  onRefreshBooking,
  onRefreshList,
  onBusyChange,
}: AdminBookingPortalProps) {
  // filter() returns a fresh array, so sorting it never touches the registry.
  const sections = adminBookingSections
    .filter((section) => section.appliesTo(booking))
    .sort((first, second) => first.order - second.order)

  if (sections.length === 0) {
    return null
  }

  return (
    <div className="admin-portal">
      {sections.map((section) => (
        <AdminBookingSectionSlot
          booking={booking}
          getIdToken={getIdToken}
          key={section.id}
          section={section}
          onBusyChange={onBusyChange}
          onRefreshBooking={onRefreshBooking}
          onRefreshList={onRefreshList}
        />
      ))}
    </div>
  )
}
