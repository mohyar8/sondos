import type { BookingStatus } from '../../../shared/admin'

/** Badge tints from components.css (.badge--*); never the only signal. */
export type AdminStatusTone = 'info' | 'warning' | 'success' | 'danger' | 'neutral'

export type AdminStatusIconName =
  | 'clock'
  | 'hourglass'
  | 'document'
  | 'receipt'
  | 'check'
  | 'cross'
  | 'slash'
  | 'clock-off'

export interface AdminStatusPresentation {
  readonly label: string
  readonly tone: AdminStatusTone
  readonly icon: AdminStatusIconName
}

/**
 * How each status reads in the admin (03-design-system §4.4: tint + icon +
 * a coloured inline-start border + the label, so colour is never alone).
 * The statuses and their meaning are unchanged in Run 3.
 */
export const adminStatusPresentation: Readonly<
  Record<BookingStatus, AdminStatusPresentation>
> = {
  pending_review: { label: 'قيد المراجعة', tone: 'info', icon: 'clock' },
  approved_hold: {
    label: 'مقبول — التاريخ محجوز مؤقتًا',
    tone: 'warning',
    icon: 'hourglass',
  },
  contract_pending: {
    label: 'بانتظار توقيع العقد',
    tone: 'info',
    icon: 'document',
  },
  contract_signed: {
    label: 'تم توقيع العقد',
    tone: 'info',
    icon: 'document',
  },
  payment_pending: {
    label: 'بانتظار العربون',
    tone: 'info',
    icon: 'receipt',
  },
  confirmed: { label: 'الحجز مؤكد', tone: 'success', icon: 'check' },
  rejected: { label: 'مرفوض', tone: 'danger', icon: 'cross' },
  cancelled: { label: 'ملغي', tone: 'neutral', icon: 'slash' },
  expired: { label: 'انتهت المهلة', tone: 'neutral', icon: 'clock-off' },
}

export function getAdminStatusLabel(status: BookingStatus): string {
  return adminStatusPresentation[status].label
}
