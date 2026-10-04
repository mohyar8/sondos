import type { ReactNode } from 'react'

export type JourneyIconName =
  | 'check'
  | 'current'
  | 'upcoming'
  | 'hourglass'
  | 'calendar'
  | 'alert'
  | 'info'
  | 'close'

interface JourneyIconProps {
  name: JourneyIconName
  className?: string
}

const iconPaths: Readonly<Record<JourneyIconName, ReactNode>> = {
  check: <path d="m6 12.5 4 4 8-9" />,
  current: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>
  ),
  upcoming: <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />,
  hourglass: (
    <>
      <path d="M7 3h10M7 21h10" />
      <path d="M8 3c0 4 4 5 4 9s-4 5-4 9M16 3c0 4-4 5-4 9s4 5 4 9" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  close: <path d="m7 7 10 10M17 7 7 17" />,
}

/**
 * Decorative icons for the journey UI. Always aria-hidden: every state an
 * icon shows is also written out as text next to it (never icon- or
 * colour-only). Colour follows `currentColor`.
 */
export default function JourneyIcon({ name, className }: JourneyIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name]}
    </svg>
  )
}
