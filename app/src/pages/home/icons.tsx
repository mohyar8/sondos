import type { ReactNode } from 'react'

/**
 * Small decorative line icons for the Home sections (design-system §5.2:
 * "small line-icon per card"). Every icon is aria-hidden: the card or control
 * around it always carries its own visible text. Colour comes from
 * `currentColor`.
 */

interface IconProps {
  className?: string
}

interface LineIconFrameProps extends IconProps {
  children: ReactNode
}

function LineIconFrame({ className, children }: LineIconFrameProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Coverage on the day. */
export function CameraIcon({ className }: IconProps) {
  return (
    <LineIconFrame className={className}>
      <path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.2" r="3.4" />
    </LineIconFrame>
  )
}

/** Albums and prints. */
export function AlbumIcon({ className }: IconProps) {
  return (
    <LineIconFrame className={className}>
      <path d="M12 6.5C10.2 5.2 7.6 4.7 4 5v13c3.6-.3 6.2.2 8 1.5 1.8-1.3 4.4-1.8 8-1.5V5c-3.6-.3-6.2.2-8 1.5Z" />
      <path d="M12 6.5v13" />
    </LineIconFrame>
  )
}

/** A clear, trackable booking request. */
export function ChecklistIcon({ className }: IconProps) {
  return (
    <LineIconFrame className={className}>
      <rect x="5" y="4.5" width="14" height="16" rx="2" />
      <path d="M9 4.5v-1h6v1" />
      <path d="m8.5 11 1.5 1.5 3-3" />
      <path d="M8.5 16h7" />
    </LineIconFrame>
  )
}

/** Licensed by the Ministry of Labour. */
export function ShieldCheckIcon({ className }: IconProps) {
  return (
    <LineIconFrame className={className}>
      <path d="M12 3 5 5.8v5.4c0 4.3 2.9 8 7 9.8 4.1-1.8 7-5.5 7-9.8V5.8L12 3Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </LineIconFrame>
  )
}

/** Nothing is published without the bride's consent. */
export function LockIcon({ className }: IconProps) {
  return (
    <LineIconFrame className={className}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <path d="M12 14.5V17" />
    </LineIconFrame>
  )
}

/**
 * FAQ disclosure mark: a plus while closed, a minus while open. The shape
 * change (not colour) shows the state; the native <details> element exposes
 * the expanded state to assistive technology.
 */
export function DisclosureIcon({ className }: IconProps) {
  return (
    <LineIconFrame className={className}>
      <path d="M5 12h14" />
      <path className="disclosure-icon__vertical" d="M12 5v14" />
    </LineIconFrame>
  )
}
