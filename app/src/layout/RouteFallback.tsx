import './RouteFeedback.css'

/** Where a loading or error state sits (see RouteFeedback.css). */
export type RouteFeedbackVariant = 'page' | 'screen' | 'inline'

interface RouteFallbackProps {
  variant?: RouteFeedbackVariant
  label?: string
}

/**
 * The app's one Suspense fallback: an Arabic role="status" message that
 * reserves the page's space, so nothing shifts when the chunk arrives. The
 * page variant stands in for the page's own <main id="main-content">, so the
 * skip link keeps its target while the page loads.
 */
export default function RouteFallback({
  variant = 'page',
  label = 'جارٍ تحميل الصفحة…',
}: RouteFallbackProps) {
  const status = (
    <div className="route-feedback__status" role="status">
      <span className="route-feedback__spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )

  if (variant === 'page') {
    return (
      <main
        className="route-feedback route-feedback--page"
        id="main-content"
        aria-busy="true"
      >
        {status}
      </main>
    )
  }

  return (
    <div className={`route-feedback route-feedback--${variant}`}>{status}</div>
  )
}
