import { Suspense } from 'react'
import RouteErrorBoundary from '../layout/RouteErrorBoundary'
import RouteFallback from '../layout/RouteFallback'
import { createRetryableLazy } from '../layout/retryable-lazy'
import { useAuth } from './auth-context'

/**
 * The re-auth dialog in its own chunk: it downloads the first time a
 * request asks for it, never with the home page. Not preloaded anywhere.
 */
const LazyReauthDialog = createRetryableLazy(
  () => import('../features/reauth/ReauthDialog'),
  'ReauthDialog',
)

/**
 * Mount point of the app's one «confirm your identity» dialog
 * (features/reauth/ReauthDialog), next to App in main.tsx so it works on
 * every route. It shows whenever the AuthProvider has a re-authentication
 * request open — from the API client or useReauthRetry after a 403
 * REAUTH_REQUIRED, or from the admin's authenticator-app enrollment.
 * Only «متابعة» after success answers the request with true. Every other
 * close, and a failed download of the dialog, cancels it; the caller then
 * shows its own REAUTH_REQUIRED message.
 */
export default function ReauthenticationHost() {
  const { reauthentication, cancelReauthentication, continueReauthentication } =
    useAuth()

  if (reauthentication === null) {
    return null
  }

  return (
    <RouteErrorBoundary
      key={reauthentication.id}
      variant="screen"
      title="تعذّر فتح نافذة تأكيد الهوية."
      onDismiss={cancelReauthentication}
    >
      <Suspense
        fallback={
          <RouteFallback
            variant="screen"
            label="جارٍ فتح نافذة تأكيد الهوية…"
          />
        }
      >
        <LazyReauthDialog
          request={reauthentication}
          onCancel={cancelReauthentication}
          onContinue={continueReauthentication}
        />
      </Suspense>
    </RouteErrorBoundary>
  )
}
