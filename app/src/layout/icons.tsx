/**
 * Decorative inline icons for the site shell. Every icon is aria-hidden: the
 * control that holds it always carries its own text or accessible name.
 * Colour comes from `currentColor`, so icons follow the link/button colour.
 */

interface IconProps {
  className?: string
}

export function InstagramIcon({ className }: IconProps) {
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
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function TikTokIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M16.6 3c.3 2.3 1.9 4 4.4 4.2v3.1c-1.6.1-3-.4-4.4-1.3v6.1c0 3.9-3.2 6.4-6.4 6.4A6.1 6.1 0 0 1 4 15.4c0-3.8 3.4-6.6 7.2-6v3.3c-.4-.1-.8-.2-1.2-.2-1.6 0-2.9 1.3-2.9 2.9s1.3 2.9 2.9 2.9c1.7 0 3-1.2 3-3.2V3h3.6Z" />
    </svg>
  )
}

export function WhatsAppIcon({ className }: IconProps) {
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
      <path d="M20.5 11.7a8.6 8.6 0 0 1-12.7 7.5L3.5 20.5l1.3-4.1a8.6 8.6 0 1 1 15.7-4.7Z" />
      <path d="M9 8.6c.2-.4.5-.5.8-.5h.5c.2 0 .4.1.5.4l.6 1.5c.1.2 0 .5-.1.6l-.5.6c.6 1.2 1.5 2.1 2.7 2.7l.6-.5c.2-.1.4-.2.6-.1l1.5.6c.3.1.4.3.4.5v.5c0 .3-.2.6-.5.8-.6.4-1.4.5-2.1.2a8.4 8.4 0 0 1-4.7-4.7c-.3-.7-.2-1.5.2-2.1Z" />
    </svg>
  )
}

interface MenuIconProps extends IconProps {
  isOpen: boolean
}

/** Three lines when closed, a cross when open (state is also exposed via aria-expanded). */
export function MenuIcon({ className, isOpen }: MenuIconProps) {
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
      aria-hidden="true"
      focusable="false"
    >
      {isOpen ? (
        <path d="M6 6l12 12M18 6 6 18" />
      ) : (
        <path d="M4 7h16M4 12h16M4 17h16" />
      )}
    </svg>
  )
}
