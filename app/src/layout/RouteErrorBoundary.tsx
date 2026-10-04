import { Component, type ReactNode } from 'react'
import type { RouteFeedbackVariant } from './RouteFallback'
import { resetFailedLazyComponents } from './retryable-lazy'
import './RouteFeedback.css'

interface RouteErrorBoundaryProps {
  children: ReactNode
  variant?: RouteFeedbackVariant
  /** What failed, e.g. «تعذّر فتح نافذة تسجيل الدخول». */
  title?: string
  /** Inline and screen variants: shows a close button (e.g. to drop the dialog). */
  onDismiss?: () => void
}

interface RouteErrorBoundaryState {
  hasError: boolean
  /** Retries already attempted; once one has failed, retry reloads the page. */
  retryCount: number
}

const DEFAULT_TITLE = 'تعذّر عرض هذه الصفحة'
const RETRY_MESSAGE =
  'قد يكون الاتصال بالإنترنت ضعيفًا، أو أن الموقع حُدِّث للتو. أعيدي المحاولة، وإن تكررت المشكلة فأعيدي تحميل الصفحة.'
const RELOAD_MESSAGE =
  'ما زال التحميل متعذرًا. أعيدي تحميل الصفحة لجلب أحدث نسخة من الموقع.'

/**
 * Catches a failed chunk download (a flaky network, or a stale tab after a
 * new deploy removed the old chunk files) and any render error below it.
 *
 * «إعادة المحاولة» downloads the failed chunk again in place: the header, the
 * sign-in state and the rest of the page stay as they are. If that retry
 * fails too, the button reloads the whole page instead, which also fetches
 * the new index.html and chunk names after a deploy.
 */
export default class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  override state: RouteErrorBoundaryState = { hasError: false, retryCount: 0 }

  static getDerivedStateFromError(): Partial<RouteErrorBoundaryState> {
    return { hasError: true }
  }

  private readonly handleRetry = () => {
    if (this.state.retryCount > 0) {
      window.location.reload()
      return
    }

    resetFailedLazyComponents()
    this.setState((currentState) => ({
      hasError: false,
      retryCount: currentState.retryCount + 1,
    }))
  }

  override render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    const { variant = 'page', title = DEFAULT_TITLE, onDismiss } = this.props
    const hasRetried = this.state.retryCount > 0
    const TitleTag = variant === 'inline' ? 'p' : 'h1'

    const panel = (
      <div className="route-feedback__panel" role="alert">
        <TitleTag className="route-feedback__title">{title}</TitleTag>
        <p className="route-feedback__message">
          {hasRetried ? RELOAD_MESSAGE : RETRY_MESSAGE}
        </p>
        <div className="route-feedback__actions">
          <button
            className="btn btn--primary"
            type="button"
            onClick={this.handleRetry}
          >
            {hasRetried ? 'إعادة تحميل الصفحة' : 'إعادة المحاولة'}
          </button>
          {variant !== 'page' && onDismiss && (
            <button className="btn btn--ghost" type="button" onClick={onDismiss}>
              إغلاق
            </button>
          )}
        </div>
      </div>
    )

    if (variant === 'page') {
      return (
        <main
          className="route-feedback route-feedback--page"
          id="main-content"
          tabIndex={-1}
        >
          {panel}
        </main>
      )
    }

    return (
      <div className={`route-feedback route-feedback--${variant}`}>{panel}</div>
    )
  }
}
