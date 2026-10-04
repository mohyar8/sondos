import { useCallback } from 'react'
import { useAuth } from '../../auth/auth-context'
import { retryAfterReauthentication } from '../../lib/api-client'

/**
 * Runs `send`; when `needsReauthentication(result)` says the Worker (or
 * Firebase) wants a recent sign-in, opens the re-auth dialog and, once she
 * has confirmed and pressed «متابعة», runs `send` ONE more time. Cancelled
 * (Escape or «إلغاء الإجراء», even after confirming), aborted, or another
 * account meanwhile: the first result comes back unchanged. `send` must read a fresh ID token on every call, so the retry
 * carries the new `auth_time`.
 */
export type ReauthRetry = <R>(
  send: () => Promise<R>,
  needsReauthentication: (result: R) => boolean,
  signal?: AbortSignal,
) => Promise<R>

/**
 * The retry-once flow of the app's one re-auth dialog (W1-08), for work the
 * API client does not already cover: requests built on `sendJsonWithToken`
 * or `apiRequest` without a session, and account-security steps. Requests
 * sent through useApiClient (or with an ApiSession) already retry once on
 * 403 REAUTH_REQUIRED; wrapping them here would ask twice.
 *
 * Same loop as the API client (lib/api-client.ts retryAfterReauthentication),
 * bound to the AuthProvider's requestReauthentication. Stable across
 * renders.
 */
export function useReauthRetry(): ReauthRetry {
  const { requestReauthentication } = useAuth()

  return useCallback<ReauthRetry>(
    (send, needsReauthentication, signal) =>
      retryAfterReauthentication(
        send,
        needsReauthentication,
        requestReauthentication,
        signal,
      ),
    [requestReauthentication],
  )
}
