import type { MouseEvent } from 'react'

interface NavigationAuthControlsProps {
  variant: 'desktop' | 'mobile'
  isInitializing: boolean
  isAuthenticated: boolean
  isSigningOut: boolean
  onOpenLogin: (event: MouseEvent<HTMLButtonElement>) => void
  /** Hover/focus on the sign-in button: preload the dialog's chunk. */
  onLoginIntent?: () => void
  onSignOut: () => Promise<void>
}

export default function NavigationAuthControls({
  variant,
  isInitializing,
  isAuthenticated,
  isSigningOut,
  onOpenLogin,
  onLoginIntent,
  onSignOut,
}: NavigationAuthControlsProps) {
  const groupClassName = `nav-auth nav-auth--${variant}`
  const actionClassName = `btn ${
    variant === 'mobile' ? 'btn--secondary' : 'btn--ghost'
  } nav-auth__action`

  if (isInitializing) {
    return (
      <div
        className={groupClassName}
        role="group"
        aria-label="جارٍ التحقق من حالة تسجيل الدخول"
      >
        <button
          className={`${actionClassName} nav-auth__action--placeholder`}
          type="button"
          disabled
        >
          جارٍ التحقق…
        </button>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className={groupClassName} role="group" aria-label="حساب العميلة">
        <button
          className={actionClassName}
          type="button"
          onClick={onOpenLogin}
          onPointerEnter={onLoginIntent}
          onFocus={onLoginIntent}
        >
          تسجيل الدخول
        </button>
      </div>
    )
  }

  return (
    <div
      className={groupClassName}
      role="group"
      aria-label="خيارات حساب العميلة"
    >
      <button
        className={`${actionClassName} nav-auth__action--sign-out`}
        type="button"
        onClick={() => {
          void onSignOut()
        }}
        disabled={isSigningOut}
      >
        {isSigningOut ? 'جارٍ تسجيل الخروج…' : 'تسجيل الخروج'}
      </button>
    </div>
  )
}
