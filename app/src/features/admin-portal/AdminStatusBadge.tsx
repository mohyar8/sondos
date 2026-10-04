import type { BookingStatus } from '../../../shared/admin'
import AdminIcon from './AdminIcon'
import { adminStatusPresentation } from './booking-status'

/** A booking-status chip: tint, icon, inline-start border and the label. */
export default function AdminStatusBadge({
  status,
}: {
  status: BookingStatus
}) {
  const presentation = adminStatusPresentation[status]

  return (
    <span className={`badge badge--${presentation.tone} admin-status-badge`}>
      <AdminIcon className="badge__icon" name={presentation.icon} />
      <span>{presentation.label}</span>
    </span>
  )
}
