import { createContext, useContext } from 'react'
import type { User } from 'firebase/auth'

export type CustomerRole = 'customer' | 'admin'

export interface CustomerProfile {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string
  role: CustomerRole
}

export interface ProfileInput {
  firstName: string
  lastName: string
  phone: string
}

export interface RegistrationInput extends ProfileInput {
  email: string
  password: string
}

export type AuthErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_ALREADY_IN_USE'
  | 'WEAK_PASSWORD'
  | 'NETWORK_ERROR'
  | 'TOO_MANY_ATTEMPTS'
  | 'PROFILE_REQUIRED'
  | 'UNAUTHORIZED'
  | 'UNEXPECTED_ERROR'
  /** Password accepted; the code from her authenticator app is still needed. */
  | 'MFA_REQUIRED'
  /** The authenticator code was wrong or is no longer current. */
  | 'INVALID_VERIFICATION_CODE'
  /** The second-factor or enrollment session ended; start again. */
  | 'MFA_SESSION_EXPIRED'
  /** Her account's second factor is not an authenticator app (TOTP). */
  | 'MFA_UNSUPPORTED'
  /** TOTP multi-factor is not enabled for this Firebase project. */
  | 'MFA_NOT_ENABLED'
  /** The action needs her password again and she did not confirm it. */
  | 'REAUTH_REQUIRED'
  /** 410: the account's data was erased at her request (final). */
  | 'ACCOUNT_ERASED'

export interface AuthError {
  code: AuthErrorCode
  message: string
}

/**
 * One authenticator app (TOTP factor) she can use to finish a sign-in. `uid`
 * is Firebase's enrollment id; `label` is the name given at enrollment.
 */
export interface SecondFactorOption {
  uid: string
  label: string | null
}

/**
 * A sign-in (or re-authentication) waiting for the code from her
 * authenticator app. The resolver itself stays inside the AuthProvider; the
 * dialog only holds this handle and passes its `id` back.
 */
export interface SecondFactorChallenge {
  id: number
  purpose: 'sign-in' | 'reauthenticate'
  factors: readonly SecondFactorOption[]
}

export type AuthActionResult =
  | { ok: true }
  | {
      ok: false
      error: AuthError
      /** Present with MFA_REQUIRED: the code step to show next. */
      secondFactor?: SecondFactorChallenge
    }

/** A second factor enrolled on the signed-in account. */
export interface EnrolledSecondFactor {
  uid: string
  /** 'totp' for an authenticator app; other Firebase factor ids are listed as-is. */
  factorId: string
  displayName: string | null
  /** UTC string from Firebase. */
  enrollmentTime: string
}

/**
 * An authenticator-app enrollment in progress. `secretKey` and `otpauthUrl`
 * are shown to her once so she can add the account to her app; they are
 * never stored or logged.
 */
export interface TotpEnrollment {
  id: number
  secretKey: string
  otpauthUrl: string
  codeLength: number
  codeIntervalSeconds: number
  /** UTC string: the enrollment must be confirmed before this moment. */
  completeBy: string
}

export type TotpEnrollmentStartResult =
  | { ok: true; enrollment: TotpEnrollment }
  | { ok: false; error: AuthError }

/**
 * The open «confirm your password» prompt (see requestReauthentication),
 * rendered by ReauthenticationHost as the app's one ReauthDialog.
 */
export interface ReauthenticationRequest {
  id: number
  /**
   * The signed-in account the prompt confirms: shown read-only and offered
   * to password managers as the username (UX-16).
   */
  email: string
  /** Where focus goes back when the prompt closes, if it still exists. */
  returnFocus: HTMLElement | null
  /**
   * Null until she has re-authenticated; then the sign-in time of her fresh
   * token (`auth_time`, epoch ms), from which the prompt shows «التحقق صالح
   * حتى …» until she continues or cancels.
   */
  confirmedAt: number | null
}

/**
 * How the prompt was closed: «متابعة» on the success view, or any other
 * way (Escape, the backdrop, «إغلاق», «إلغاء الإجراء», a failed download).
 */
export type ReauthenticationClose = 'continue' | 'cancel'

/**
 * What a closed prompt answers whoever asked for it: true only when she
 * re-authenticated AND chose «متابعة». Every other close cancels, before or
 * after success, so the action she started is sent again only on her word.
 */
export function answerReauthentication(
  request: ReauthenticationRequest,
  close: ReauthenticationClose,
): boolean {
  return close === 'continue' && request.confirmedAt !== null
}

export type EmailVerificationCheckResult =
  | { ok: true; verified: boolean }
  | { ok: false; error: AuthError }

/**
 * The verification email this session last tried to send for the signed-in
 * account — the one registration sends automatically, or a resend.
 * - `idle`: none in this session (e.g. a returning account that is still
 *   unverified), so nothing is known about delivery.
 * - `sending`: a send is in flight (registration starts in this state).
 * - `sent` / `failed`: the outcome of the latest send; `failed` keeps its
 *   error until another send starts or the account changes.
 */
export type VerificationEmailState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent' }
  | { status: 'failed'; error: AuthError }

export interface AuthContextValue {
  firebaseUser: User | null
  profile: CustomerProfile | null
  isInitializing: boolean
  isAuthenticated: boolean
  isAuthAvailable: boolean
  isEmailVerified: boolean
  profileRequired: boolean
  authError: AuthError | null
  verificationEmail: VerificationEmailState
  /** Second factors enrolled on the signed-in account (empty when none). */
  secondFactors: readonly EnrolledSecondFactor[]
  /** The open password prompt, or null. Rendered by ReauthenticationHost. */
  reauthentication: ReauthenticationRequest | null
  /**
   * The idle limit, in minutes, when startIdleSignOut signed her out; null
   * otherwise. Cleared by the next sign-in, so a sign-in screen can say why
   * she was signed out.
   */
  idleSignOutMinutes: number | null
  /** May resolve with MFA_REQUIRED and a `secondFactor` challenge. */
  signIn: (email: string, password: string) => Promise<AuthActionResult>
  register: (input: RegistrationInput) => Promise<AuthActionResult>
  completeProfile: (input: ProfileInput) => Promise<AuthActionResult>
  sendPasswordReset: (email: string) => Promise<AuthActionResult>
  sendVerificationEmail: () => Promise<AuthActionResult>
  reloadFirebaseUser: () => Promise<AuthActionResult>
  refreshIdToken: () => Promise<AuthActionResult>
  checkEmailVerification: () => Promise<EmailVerificationCheckResult>
  signOutUser: () => Promise<AuthActionResult>
  getIdToken: () => Promise<string | null>
  clearAuthError: () => void
  /** Finishes a sign-in or re-authentication with her authenticator code. */
  completeSecondFactor: (
    challengeId: number,
    factorUid: string,
    code: string,
  ) => Promise<AuthActionResult>
  /** Drops a challenge she walked away from. */
  cancelSecondFactor: (challengeId: number) => void
  /**
   * Opens the «confirm your password» prompt (one at a time; concurrent
   * callers share it). Resolves when the prompt closes: true when she
   * re-authenticated and chose «متابعة», false when she cancelled (before
   * or after re-authenticating), the account changed or nobody is signed
   * in. Never rejects.
   */
  requestReauthentication: () => Promise<boolean>
  /**
   * The prompt's submit: her current password, checked by Firebase for the
   * signed-in account. On success the open request gets its `confirmedAt`;
   * an account with an authenticator app gets a code step first
   * (MFA_REQUIRED with `secondFactor`, finished by completeSecondFactor).
   * The password is used for this call only, never kept or logged.
   */
  reauthenticateWithPassword: (password: string) => Promise<AuthActionResult>
  /**
   * @deprecated Same function as reauthenticateWithPassword. Kept only for
   * AuthDialog's former re-authentication view, which nothing opens since
   * ReauthDialog replaced it (W1-08); removed with that view (W5-01).
   */
  reauthenticate: (password: string) => Promise<AuthActionResult>
  /**
   * Every close of the prompt except «متابعة» (Escape, the backdrop,
   * «إغلاق», «إلغاء الإجراء», a failed download of the dialog): resolves
   * the pending request with false, even after she re-authenticated.
   */
  cancelReauthentication: () => void
  /**
   * «متابعة» on the success view: resolves the pending request with true,
   * so the action she started is sent once more. Before success it cancels.
   */
  continueReauthentication: () => void
  /**
   * TM-07: signs her out after `minutes` (a whole number, 1–720) without a
   * press or key stroke in this tab or another tab running it. It ends
   * only the session that stayed idle: every sign-in (here or from another
   * tab, the same account included) starts a new quiet period, so a new
   * session is never ended for the quiet time before it (decideIdleSignOut).
   * Returns the stop function, for an effect's cleanup:
   * `useEffect(() => startIdleSignOut(30), [startIdleSignOut])`.
   *
   * Only an open page is covered: the quiet period lives in memory (SB-12
   * allows no storage key for it) and starts again whenever the page loads,
   * so a tab that was closed, reloaded or discarded does not carry its idle
   * time over, and a session restored from Firebase's persistence gets a
   * fresh period. Until the owner decides, only the Worker's 12 h
   * `auth_time` cap (AD) bounds that case, so no caller may rely on this
   * for a closed tab. Her options: an SB-12 exception for the last-activity
   * instant (a bare number, checked before the timer is armed; covers all
   * three cases), or browserSessionPersistence for /admin sign-ins (W5-01;
   * a closed tab or browser only, since a reload, a discarded tab and a
   * reopened tab keep their sessionStorage).
   */
  startIdleSignOut: (minutes: number) => () => void
  /** Starts adding an authenticator app to the signed-in account. */
  startTotpEnrollment: () => Promise<TotpEnrollmentStartResult>
  /** Confirms the enrollment with the first code her app shows. */
  finishTotpEnrollment: (
    enrollmentId: number,
    code: string,
  ) => Promise<AuthActionResult>
  cancelTotpEnrollment: (enrollmentId: number) => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider.')
  }

  return context
}

/** A press or a key stroke counts as her being active (TM-07). */
const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const
/**
 * The app's tabs share one session, so a tab running the idle timer tells
 * the others (over a BroadcastChannel, never storage) that she is active
 * there: a quiet tab must not sign out a session she is using in another.
 * The message is one fixed word; no account data crosses the channel.
 */
const IDLE_ACTIVITY_CHANNEL = 'sy:idle-activity'
const IDLE_ACTIVITY_MESSAGE = 'activity'
/** At most one activity message per 30 s (or per quarter of the limit). */
const IDLE_SHARE_INTERVAL_MS = 30_000
/** While she stays idle after onIdle, it is called again this often. */
const IDLE_RECHECK_MS = 60_000
/** Capture: a control that stops propagation still counts as activity. */
const ACTIVITY_LISTENER_OPTIONS = { capture: true, passive: true } as const
/**
 * setTimeout's largest delay (about 24.8 days); a longer one fires at once,
 * which would turn the re-check into a busy loop.
 */
const MAXIMUM_TIMER_DELAY_MS = 2 ** 31 - 1

/**
 * A signed-in session as the idle sign-out sees it: the account and when it
 * last signed in or confirmed its password (Firebase's `lastSignInTime`,
 * null when unknown).
 */
export interface IdleSession {
  uid: string
  signedInAt: string | null
}

/**
 * What an idle timer's onIdle does (TM-07). `reported` is the session the
 * auth-state listener last reported, which the quiet period belongs to;
 * `current` is the account signed in now.
 * - `skip`: nobody is signed in (already signed out, here or in another
 *   tab), or a sign-in the listener has not reported yet; its report starts
 *   a new quiet period.
 * - `restart`: the same account signed in (or confirmed its password) again
 *   since, which the listener does not report for an unchanged account: a
 *   new session, whose quiet period starts now.
 * - `sign-out`: the session that stayed idle is still the one signed in.
 */
export function decideIdleSignOut(
  current: IdleSession | null,
  reported: IdleSession | null,
): 'skip' | 'restart' | 'sign-out' {
  if (current === null || reported === null || current.uid !== reported.uid) {
    return 'skip'
  }

  return current.signedInAt === reported.signedInAt ? 'sign-out' : 'restart'
}

export interface IdleTimerOptions {
  /** Where her presses and key strokes are observed (the document). */
  target: EventTarget
  /** Quiet time before onIdle, in milliseconds. */
  idleMs: number
  /**
   * Called once `idleMs` pass with no activity (here or in another tab
   * sharing it), then every minute while she stays idle, so a sign-out that
   * failed is tried again. Activity or restart() starts a new quiet period.
   */
  onIdle: () => void
  /** Share activity with the app's other tabs (default true). */
  shareAcrossTabs?: boolean
}

export interface IdleTimer {
  /**
   * Starts a new quiet period from now, without telling other tabs. The
   * provider calls it for every sign-in its auth-state listener reports,
   * and when onIdle finds the same account signed in again since: each tab
   * sees the sign-in itself, and a new session must never be ended for the
   * quiet time of the one before it.
   */
  restart: () => void
  /** Removes every listener, the timer and the channel. Safe to repeat. */
  stop: () => void
}

/**
 * The idle timer behind AuthContextValue.startIdleSignOut. Kept out of the
 * provider (and free of React) so node:test can drive it with mock timers.
 * Wall-clock time (Date.now) is compared on every check and whenever the
 * tab becomes visible again, so a device that slept past the limit is
 * treated as idle as soon as it wakes, as long as the page itself was kept.
 * The quiet period is held in memory only, so a page that loads again
 * (reloaded, reopened, or discarded by the browser while hidden) starts a
 * new one.
 */
export function startIdleTimer({
  target,
  idleMs,
  onIdle,
  shareAcrossTabs = true,
}: IdleTimerOptions): IdleTimer {
  if (!(idleMs > 0 && idleMs <= MAXIMUM_TIMER_DELAY_MS)) {
    throw new RangeError(
      `startIdleTimer: idleMs must be above 0 and at most ${MAXIMUM_TIMER_DELAY_MS}.`,
    )
  }

  const channel =
    shareAcrossTabs && typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(IDLE_ACTIVITY_CHANNEL)
      : null
  const shareIntervalMs = Math.min(IDLE_SHARE_INTERVAL_MS, idleMs / 4)
  let lastActivityAt = Date.now()
  let lastSharedAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  let isStopped = false

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function check() {
    clearTimer()

    if (isStopped) {
      return
    }

    const now = Date.now()

    // The clock was set back: the quiet period starts again from now.
    if (now < lastActivityAt) {
      lastActivityAt = now
    }

    const quietMs = now - lastActivityAt

    if (quietMs < idleMs) {
      timer = setTimeout(check, idleMs - quietMs)
      return
    }

    timer = setTimeout(check, Math.min(idleMs, IDLE_RECHECK_MS))
    onIdle()
  }

  function handleActivity() {
    const now = Date.now()

    lastActivityAt = now

    if (
      channel !== null &&
      (now - lastSharedAt >= shareIntervalMs || now < lastSharedAt)
    ) {
      lastSharedAt = now
      channel.postMessage(IDLE_ACTIVITY_MESSAGE)
    }
  }

  function handleSharedActivity(event: MessageEvent<unknown>) {
    if (event.data === IDLE_ACTIVITY_MESSAGE) {
      lastActivityAt = Date.now()
    }
  }

  function restart() {
    if (isStopped) {
      return
    }

    lastActivityAt = Date.now()
    check()
  }

  for (const type of IDLE_ACTIVITY_EVENTS) {
    target.addEventListener(type, handleActivity, ACTIVITY_LISTENER_OPTIONS)
  }

  target.addEventListener('visibilitychange', check)
  channel?.addEventListener('message', handleSharedActivity)
  timer = setTimeout(check, idleMs)

  function stop() {
    if (isStopped) {
      return
    }

    isStopped = true
    clearTimer()

    for (const type of IDLE_ACTIVITY_EVENTS) {
      target.removeEventListener(type, handleActivity, ACTIVITY_LISTENER_OPTIONS)
    }

    target.removeEventListener('visibilitychange', check)

    if (channel !== null) {
      channel.removeEventListener('message', handleSharedActivity)
      channel.close()
    }
  }

  return { restart, stop }
}
