// Type-only imports: erased at build time, so the Firebase SDK stays out of
// the entry chunk. The SDK itself is loaded on demand by loadAuthModules().
import type {
  ActionCodeSettings,
  Auth,
  MultiFactorError,
  MultiFactorResolver,
  TotpSecret,
  User,
} from 'firebase/auth'
import type * as FirebaseAuthSdk from 'firebase/auth'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type * as FirebaseSetup from '../lib/firebase'
import type { FirebaseAuthInitialization } from '../lib/firebase'
import { getTopmostModal } from '../lib/modal-stack'
import {
  ACCOUNT_ERASED_CODE,
  ACCOUNT_ERASED_MESSAGE,
  SESSION_ENDED_MESSAGE,
  isServerLimitCode,
  serverLimitCodeForStatus,
  serverLimitMessages,
} from '../lib/server-error-messages'
import {
  AuthContext,
  answerReauthentication,
  decideIdleSignOut,
  startIdleTimer,
  type AuthActionResult,
  type AuthContextValue,
  type AuthError,
  type AuthErrorCode,
  type CustomerProfile,
  type CustomerRole,
  type EmailVerificationCheckResult,
  type EnrolledSecondFactor,
  type IdleSession,
  type IdleTimer,
  type ProfileInput,
  type ReauthenticationClose,
  type ReauthenticationRequest,
  type RegistrationInput,
  type SecondFactorChallenge,
  type TotpEnrollmentStartResult,
  type VerificationEmailState,
} from './auth-context'
import { normalizePersonName } from './person-name'

type NormalizedProfileInput = ProfileInput

type ProfileRequestResult =
  | { kind: 'success'; profile: CustomerProfile }
  | { kind: 'missing' }
  | { kind: 'aborted' }
  | {
      kind: 'error'
      error: AuthError
      /** A Worker limit (rate, size, preview): its own words are shown. */
      isServerLimit?: boolean
    }

interface CachedProfile {
  uid: string
  profile: CustomerProfile
}

/** A code step in progress; the resolver never leaves the provider. */
interface PendingSecondFactor {
  challenge: SecondFactorChallenge
  resolver: MultiFactorResolver
}

/**
 * The open password prompt and how to answer whoever asked for it. The
 * answer waits for the prompt to close, so she reads «التحقق صالح حتى …»
 * and chooses «متابعة» before the action she started runs again.
 */
interface PendingReauthentication {
  request: ReauthenticationRequest
  promise: Promise<boolean>
  resolve: (confirmed: boolean) => void
}

/** An authenticator-app enrollment waiting for its first code. */
interface PendingTotpEnrollment {
  id: number
  uid: string
  secret: TotpSecret
}

type RecentLoginResult<T> = { ok: true; value: T } | { ok: false }

interface AuthModules {
  setup: typeof FirebaseSetup
  sdk: typeof FirebaseAuthSdk
}

type AuthResources =
  | {
      ok: true
      auth: Auth
      ready: Promise<void>
      sdk: typeof FirebaseAuthSdk
    }
  | { ok: false; error: AuthError }

const INITIALIZATION_FAILED_MESSAGE =
  'تعذّر تهيئة خدمة تسجيل الدخول. أعيدي تحميل الصفحة ثم حاولي مرة أخرى.'

// Shared, stable objects for the states that carry no data.
const VERIFICATION_EMAIL_IDLE: VerificationEmailState = { status: 'idle' }
const VERIFICATION_EMAIL_SENDING: VerificationEmailState = {
  status: 'sending',
}
const VERIFICATION_EMAIL_SENT: VerificationEmailState = { status: 'sent' }
const NO_SECOND_FACTORS: readonly EnrolledSecondFactor[] = []

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SAUDI_MOBILE_PATTERN = /^(?:\+?966|0)?5\d{8}$/

/** Authenticator codes at sign-in; enrollment uses the secret's own length. */
const TOTP_SIGN_IN_CODE_PATTERN = /^\d{6}$/
const DIGITS_PATTERN = /^\d+$/
/** How the account is labelled in her authenticator app. */
const TOTP_ISSUER = 'Sundus Yar'
/** The factor's name in Firebase and in the sign-in code step. */
const TOTP_FACTOR_NAME = 'تطبيق المصادقة'
const TOTP_ENROLLMENT_EXPIRED_MESSAGE =
  'انتهت مهلة التفعيل قبل تأكيده. ابدئي التفعيل من جديد.'
const ENROLLMENT_REAUTH_DECLINED_MESSAGE =
  'لم يكتمل تأكيد كلمة المرور، لذلك لم يكتمل التفعيل. أعيدي المحاولة عندما تكونين مستعدة.'
/** startIdleSignOut accepts whole minutes up to the 12 h admin session. */
const MAXIMUM_IDLE_SIGN_OUT_MINUTES = 12 * 60
const MINUTE_MS = 60_000

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  INVALID_INPUT: 'يرجى التحقق من البيانات المدخلة والمحاولة مرة أخرى.',
  INVALID_CREDENTIALS: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  EMAIL_ALREADY_IN_USE:
    'يتعذر إنشاء حساب جديد بهذا البريد الإلكتروني. يمكنكِ تسجيل الدخول أو استعادة كلمة المرور.',
  WEAK_PASSWORD: 'كلمة المرور لا تستوفي متطلبات الأمان.',
  NETWORK_ERROR:
    'تعذر الاتصال بالخدمة. تحققي من اتصالكِ ثم حاولي مرة أخرى.',
  TOO_MANY_ATTEMPTS:
    'تم إجراء محاولات كثيرة. يرجى الانتظار قليلًا ثم المحاولة مرة أخرى.',
  PROFILE_REQUIRED: 'يلزم استكمال بيانات الملف الشخصي للمتابعة.',
  UNAUTHORIZED: SESSION_ENDED_MESSAGE,
  UNEXPECTED_ERROR: 'حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.',
  MFA_REQUIRED:
    'أدخلي رمز التحقق الظاهر في تطبيق المصادقة لإكمال تسجيل الدخول.',
  INVALID_VERIFICATION_CODE:
    'رمز التحقق غير صحيح أو انتهت صلاحيته. أدخلي الرمز الظاهر الآن في تطبيق المصادقة.',
  MFA_SESSION_EXPIRED:
    'انتهت مهلة التحقق. أعيدي إدخال كلمة المرور للمتابعة.',
  MFA_UNSUPPORTED:
    'طريقة التحقق الإضافية المسجلة لهذا الحساب غير مدعومة في الموقع؛ يدعم الموقع تطبيقات المصادقة فقط.',
  MFA_NOT_ENABLED:
    'التحقق بخطوتين عبر تطبيق المصادقة غير مفعّل في إعدادات Firebase لهذا الموقع بعد. فعّليه من لوحة Firebase ضمن إعدادات المصادقة متعددة العوامل (TOTP)، ثم أعيدي المحاولة.',
  // One wording per code across the app (R-05): the API client's table.
  REAUTH_REQUIRED: serverLimitMessages.REAUTH_REQUIRED,
  ACCOUNT_ERASED: ACCOUNT_ERASED_MESSAGE,
}

function createAuthError(
  code: AuthErrorCode,
  message = AUTH_ERROR_MESSAGES[code],
): AuthError {
  return {
    code,
    message,
  }
}

function createInitializationError(
  initialization: Extract<FirebaseAuthInitialization, { ok: false }>,
): AuthError {
  if (initialization.error.code === 'CONFIGURATION_UNAVAILABLE') {
    return {
      code: 'UNEXPECTED_ERROR',
      message: initialization.error.message,
    }
  }

  return createAuthError('UNEXPECTED_ERROR', INITIALIZATION_FAILED_MESSAGE)
}

/**
 * Structural check for the SDK's FirebaseError (name 'FirebaseError' plus a
 * string `code`). Importing the class itself would pull firebase/app into
 * the entry chunk.
 */
function isFirebaseError(
  error: unknown,
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    error.name === 'FirebaseError' &&
    'code' in error &&
    typeof error.code === 'string'
  )
}

/**
 * The error a password sign-in or re-authentication rejects with when the
 * account has a second factor: getMultiFactorResolver() turns it into the
 * code step (it re-validates the error and throws auth/argument-error if the
 * shape is not what it expects).
 */
function isMultiFactorError(error: unknown): error is MultiFactorError {
  return (
    isFirebaseError(error) &&
    error.code === 'auth/multi-factor-auth-required' &&
    'customData' in error &&
    isRecord(error.customData)
  )
}

function isRecentLoginRequired(error: unknown): boolean {
  return (
    isFirebaseError(error) && error.code === 'auth/requires-recent-login'
  )
}

function mapFirebaseError(error: unknown): AuthError {
  if (!isFirebaseError(error)) {
    return createAuthError('UNEXPECTED_ERROR')
  }

  switch (error.code) {
    // auth/user-mismatch: a re-authentication credential for another account.
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/user-mismatch':
      return createAuthError('INVALID_CREDENTIALS')

    case 'auth/invalid-verification-code':
    case 'auth/missing-verification-code':
      return createAuthError('INVALID_VERIFICATION_CODE')

    case 'auth/invalid-multi-factor-session':
    case 'auth/missing-multi-factor-session':
    case 'auth/multi-factor-info-not-found':
    case 'auth/missing-multi-factor-info':
    case 'auth/code-expired':
      return createAuthError('MFA_SESSION_EXPIRED')

    case 'auth/unverified-email':
      return createAuthError(
        'UNAUTHORIZED',
        'أكّدي بريدكِ الإلكتروني أولًا، ثم أعيدي المحاولة.',
      )

    case 'auth/second-factor-already-in-use':
      return createAuthError(
        'UNEXPECTED_ERROR',
        'تطبيق المصادقة هذا مسجّل لحسابكِ بالفعل.',
      )

    case 'auth/maximum-second-factor-count-exceeded':
      return createAuthError(
        'UNEXPECTED_ERROR',
        'وصل حسابكِ إلى الحد الأقصى لطرق التحقق الإضافية.',
      )

    case 'auth/invalid-email':
      return createAuthError(
        'INVALID_INPUT',
        'صيغة البريد الإلكتروني غير صحيحة.',
      )

    case 'auth/user-disabled':
      return createAuthError(
        'INVALID_CREDENTIALS',
        'تم تعطيل هذا الحساب. تواصلي معنا إذا كنتِ بحاجة إلى المساعدة.',
      )

    case 'auth/email-already-in-use':
    case 'auth/account-exists-with-different-credential':
      return createAuthError('EMAIL_ALREADY_IN_USE')

    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return createAuthError('WEAK_PASSWORD')

    case 'auth/network-request-failed':
      return createAuthError('NETWORK_ERROR')

    case 'auth/too-many-requests':
      return createAuthError('TOO_MANY_ATTEMPTS')

    case 'auth/id-token-expired':
    case 'auth/user-token-expired':
      return createAuthError('UNAUTHORIZED')

    case 'auth/requires-recent-login':
      return createAuthError(
        'UNAUTHORIZED',
        'انتهت صلاحية جلسة التحقق. سجّلي الخروج ثم ادخلي إلى حسابكِ مرة أخرى.',
      )

    case 'auth/invalid-continue-uri':
    case 'auth/missing-continue-uri':
    case 'auth/unauthorized-continue-uri':
      return createAuthError(
        'UNEXPECTED_ERROR',
        'تعذر تجهيز رابط تأكيد البريد حاليًا. تواصلي معنا إذا استمرت المشكلة.',
      )

    case 'auth/operation-not-allowed':
      return createAuthError(
        'UNEXPECTED_ERROR',
        'تسجيل الدخول بالبريد الإلكتروني وكلمة المرور غير مفعّل حاليًا.',
      )

    default:
      return createAuthError('UNEXPECTED_ERROR')
  }
}

/** Enrollment failures, where a few codes mean something more specific. */
function mapEnrollmentError(error: unknown): AuthError {
  if (isFirebaseError(error)) {
    switch (error.code) {
      // Identity Platform answers OPERATION_NOT_ALLOWED while TOTP is off.
      case 'auth/operation-not-allowed':
        return createAuthError('MFA_NOT_ENABLED')

      case 'auth/code-expired':
      case 'auth/invalid-multi-factor-session':
      case 'auth/missing-multi-factor-session':
        return createAuthError(
          'MFA_SESSION_EXPIRED',
          TOTP_ENROLLMENT_EXPIRED_MESSAGE,
        )

      case 'auth/requires-recent-login':
        return createAuthError('REAUTH_REQUIRED')
    }
  }

  return mapFirebaseError(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCustomerRole(value: unknown): value is CustomerRole {
  return value === 'customer' || value === 'admin'
}

function isCustomerProfile(value: unknown): value is CustomerProfile {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.email === 'string' &&
    value.email.length > 0 &&
    typeof value.firstName === 'string' &&
    typeof value.lastName === 'string' &&
    typeof value.phone === 'string' &&
    isCustomerRole(value.role)
  )
}

function getApiErrorCode(value: unknown): string | null {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) {
    return null
  }

  return typeof value.error.code === 'string'
    ? value.error.code
    : null
}

function getProfileFromResponse(
  value: unknown,
): CustomerProfile | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isCustomerProfile(value.profile)
  ) {
    return null
  }

  return value.profile
}

function mapApiError(
  status: number,
  code: string | null,
): Extract<ProfileRequestResult, { kind: 'error' }> {
  if (code === 'REAUTH_REQUIRED') {
    return { kind: 'error', error: createAuthError('REAUTH_REQUIRED') }
  }

  // Final: the dialog and the pages show it without a way to retry.
  if (status === 410 || code === ACCOUNT_ERASED_CODE) {
    return { kind: 'error', error: createAuthError('ACCOUNT_ERASED') }
  }

  if (status === 401 || code === 'UNAUTHORIZED') {
    return { kind: 'error', error: createAuthError('UNAUTHORIZED') }
  }

  if (status === 409 || code === 'EMAIL_ALREADY_IN_USE') {
    return { kind: 'error', error: createAuthError('EMAIL_ALREADY_IN_USE') }
  }

  // Rate limit, body cap, browse-only preview: shown in their own words.
  const limitCode = isServerLimitCode(code)
    ? code
    : serverLimitCodeForStatus(status)

  if (limitCode !== null) {
    return {
      kind: 'error',
      error: createAuthError(
        limitCode === 'RATE_LIMITED' ? 'TOO_MANY_ATTEMPTS' : 'UNEXPECTED_ERROR',
        serverLimitMessages[limitCode],
      ),
      isServerLimit: true,
    }
  }

  if (code === 'INVALID_PROFILE') {
    return { kind: 'error', error: createAuthError('INVALID_INPUT') }
  }

  return { kind: 'error', error: createAuthError('UNEXPECTED_ERROR') }
}

/**
 * Why a profile save failed, in the words the form shows: a Worker limit
 * keeps its own message, a network failure and anything else get the
 * caller's.
 */
function describeProfileSaveFailure(
  result: Exclude<ProfileRequestResult, { kind: 'success' }>,
  messages: { network: string; limitPrefix: string; other: string },
): string {
  if (result.kind !== 'error') {
    return messages.other
  }

  if (result.isServerLimit === true) {
    return `${messages.limitPrefix}${result.error.message}`
  }

  // No prefix: «تم إنشاء الحساب، لكن…» would contradict it.
  if (result.error.code === 'ACCOUNT_ERASED') {
    return result.error.message
  }

  return result.error.code === 'NETWORK_ERROR'
    ? messages.network
    : messages.other
}

function normalizeProfileInput(
  input: ProfileInput,
): NormalizedProfileInput | null {
  const firstName = normalizePersonName(input.firstName)
  const lastName = normalizePersonName(input.lastName)
  const compactPhone = input.phone.trim().replace(/[\s()-]/g, '')

  if (
    firstName === null ||
    lastName === null ||
    !SAUDI_MOBILE_PATTERN.test(compactPhone)
  ) {
    return null
  }

  const localNumber = compactPhone
    .replace(/^\+966/, '')
    .replace(/^966/, '')
    .replace(/^0/, '')

  return {
    firstName,
    lastName,
    phone: `966${localNumber}`,
  }
}

function normalizeEmail(email: string): string | null {
  const normalizedEmail = email.trim()

  return EMAIL_PATTERN.test(normalizedEmail)
    ? normalizedEmail
    : null
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function requestProfile(
  user: User,
  method: 'GET' | 'PUT',
  profileInput?: NormalizedProfileInput,
  signal?: AbortSignal,
): Promise<ProfileRequestResult> {
  try {
    const token = await user.getIdToken(method === 'PUT')
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    })

    let body: string | undefined

    if (method === 'PUT') {
      if (!profileInput) {
        return {
          kind: 'error',
          error: createAuthError('INVALID_INPUT'),
        }
      }

      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(profileInput)
    }

    const response = await fetch('/api/profile', {
      method,
      headers,
      body,
      cache: 'no-store',
      signal,
    })
    const responseBody = await readJsonResponse(response)

    if (response.ok) {
      const profile = getProfileFromResponse(responseBody)

      return profile
        ? { kind: 'success', profile }
        : {
            kind: 'error',
            error: createAuthError('UNEXPECTED_ERROR'),
          }
    }

    const errorCode = getApiErrorCode(responseBody)

    if (
      response.status === 404 &&
      errorCode === 'PROFILE_NOT_FOUND'
    ) {
      return { kind: 'missing' }
    }

    return mapApiError(response.status, errorCode)
  } catch (error: unknown) {
    if (signal?.aborted) {
      return { kind: 'aborted' }
    }

    if (isFirebaseError(error)) {
      return {
        kind: 'error',
        error: mapFirebaseError(error),
      }
    }

    return {
      kind: 'error',
      error: createAuthError('NETWORK_ERROR'),
    }
  }
}

let authModulesPromise: Promise<AuthModules> | null = null

/**
 * Loads the Firebase setup module and the Auth SDK on first use (the one
 * listener in AuthProvider, or the first auth action), so they arrive in
 * their own chunk instead of on the home page's critical path. A failed
 * download is forgotten, so the next call tries again.
 */
function loadAuthModules(): Promise<AuthModules> {
  if (!authModulesPromise) {
    const pendingModules = Promise.all([
      import('../lib/firebase'),
      import('firebase/auth'),
    ]).then(([setup, sdk]) => ({ setup, sdk }))

    authModulesPromise = pendingModules
    pendingModules.catch(() => {
      if (authModulesPromise === pendingModules) {
        authModulesPromise = null
      }
    })
  }

  return authModulesPromise
}

async function getAuthResources(): Promise<AuthResources> {
  let modules: AuthModules

  try {
    modules = await loadAuthModules()
  } catch {
    return {
      ok: false,
      error: createAuthError(
        'UNEXPECTED_ERROR',
        INITIALIZATION_FAILED_MESSAGE,
      ),
    }
  }

  const initialization = modules.setup.getFirebaseAuthInitialization()

  if (!initialization.ok) {
    return { ok: false, error: createInitializationError(initialization) }
  }

  return {
    ok: true,
    auth: initialization.auth,
    ready: initialization.ready,
    sdk: modules.sdk,
  }
}

function getVerificationActionCodeSettings(): ActionCodeSettings {
  return {
    url: new URL(
      '/my-bookings',
      window.location.origin,
    ).toString(),
  }
}

async function sendVerificationMessage(user: User): Promise<void> {
  const resources = await getAuthResources()

  if (!resources.ok) {
    throw new Error('Firebase authentication is unavailable.')
  }

  await resources.ready
  resources.auth.languageCode = 'ar'

  await resources.sdk.sendEmailVerification(
    user,
    getVerificationActionCodeSettings(),
  )
}

function listSecondFactors(
  sdk: typeof FirebaseAuthSdk,
  user: User,
): readonly EnrolledSecondFactor[] {
  const factors = sdk.multiFactor(user).enrolledFactors

  return factors.length === 0
    ? NO_SECOND_FACTORS
    : factors.map((factor) => ({
        uid: factor.uid,
        factorId: factor.factorId,
        displayName: factor.displayName ?? null,
        enrollmentTime: factor.enrollmentTime,
      }))
}

/**
 * SEC-18: accounts registered before this change carry her full name in the
 * Firebase `displayName` (so in every ID token's `name` claim and in the
 * persisted session), and nothing reads it. It is cleared once, by the
 * first session that sees it. Best effort and never awaited by sign-in: a
 * failure leaves it for the next session.
 */
async function clearLegacyDisplayName(
  sdk: typeof FirebaseAuthSdk,
  user: User,
): Promise<void> {
  try {
    await sdk.updateProfile(user, { displayName: null })
  } catch (error: unknown) {
    // Offline, rate-limited or signed out meanwhile: the SDK rejects with a
    // FirebaseError and the next session retries. Anything else is a bug;
    // report it without turning this fire-and-forget call into an
    // unhandled rejection. Neither path logs account data.
    if (!isFirebaseError(error)) {
      reportError(error)
    }
  }
}

/**
 * When the signed-in account last proved who she is: the `auth_time` claim
 * of the token a re-authentication just renewed (epoch ms). The Worker times
 * its recent-sign-in guard from the same claim, so the prompt's «صالح حتى»
 * (this instant plus RECENT_SIGN_IN_GUARD_SECONDS) does not depend on this
 * device's clock. Falls back to now, which is when that renewal happened.
 */
async function readSignInTime(user: User): Promise<number> {
  try {
    const signedInAt = Date.parse((await user.getIdTokenResult()).authTime)

    if (Number.isFinite(signedInAt)) {
      return signedInAt
    }
  } catch (error: unknown) {
    // A token refresh that failed (offline): the fallback below is close
    // enough for a displayed time. Anything else is a bug, reported without
    // failing the re-authentication that already succeeded.
    if (!isFirebaseError(error)) {
      reportError(error)
    }
  }

  return Date.now()
}

function describeIdleSession(user: User): IdleSession {
  return { uid: user.uid, signedInAt: user.metadata.lastSignInTime ?? null }
}

/** A new session: every running idle timer starts a new quiet period. */
function restartIdleTimers(idleTimers: ReadonlySet<IdleTimer>) {
  for (const idleTimer of idleTimers) {
    idleTimer.restart()
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve: (value) => resolvePromise(value),
  }
}

/**
 * A failed step of the password prompt. Unlike the sign-in actions it
 * leaves the context's authError alone: that belongs to the screen under
 * the prompt, and the prompt shows its own result.
 */
function promptFailure(error: AuthError): AuthActionResult {
  return { ok: false, error }
}

export function AuthProvider({
  children,
}: {
  children: ReactNode
}) {
  const [firebaseUser, setFirebaseUser] =
    useState<User | null>(null)
  const [profile, setProfile] =
    useState<CustomerProfile | null>(null)
  // The SDK loads after the first paint: the session is "initializing"
  // (the header shows its loading state) until the first auth state
  // arrives, and assumed available until loading proves otherwise.
  const [isInitializing, setIsInitializing] = useState(true)
  const [isAuthAvailable, setIsAuthAvailable] = useState(true)
  const [isEmailVerified, setIsEmailVerified] = useState(false)
  const [profileRequired, setProfileRequired] = useState(false)
  const [authError, setAuthError] = useState<AuthError | null>(null)
  const [verificationEmail, setVerificationEmail] =
    useState<VerificationEmailState>(VERIFICATION_EMAIL_IDLE)
  const [secondFactors, setSecondFactors] =
    useState<readonly EnrolledSecondFactor[]>(NO_SECOND_FACTORS)
  const [reauthentication, setReauthentication] =
    useState<ReauthenticationRequest | null>(null)
  const [idleSignOutMinutes, setIdleSignOutMinutes] = useState<number | null>(
    null,
  )

  // Ids for code challenges, password prompts and enrollments, so a stale
  // handle from a closed dialog can never act on a newer one.
  const sequenceRef = useRef(0)
  const secondFactorRef = useRef<PendingSecondFactor | null>(null)
  const reauthenticationRef = useRef<PendingReauthentication | null>(null)
  const totpEnrollmentRef = useRef<PendingTotpEnrollment | null>(null)
  const profileRequestVersionRef = useRef(0)
  const profileRequestAbortRef =
    useRef<AbortController | null>(null)
  const registrationInProgressRef = useRef(false)
  const registeredProfileRef =
    useRef<CachedProfile | null>(null)
  // Bumped by every verification-email send and every account change, so
  // only the latest send may report its outcome.
  const verificationSendVersionRef = useRef(0)
  // The session the auth-state listener last reported: the only one an
  // idle timer may end (TM-07).
  const idleSessionRef = useRef<IdleSession | null>(null)
  // The running idle timers (startIdleSignOut), restarted by every sign-in.
  const idleTimersRef = useRef(new Set<IdleTimer>())

  /** Closes the password prompt and answers everyone waiting on it. */
  const settleReauthentication = useCallback((confirmed: boolean) => {
    const pending = reauthenticationRef.current

    if (!pending) {
      return
    }

    reauthenticationRef.current = null

    if (secondFactorRef.current?.challenge.purpose === 'reauthenticate') {
      secondFactorRef.current = null
    }

    setReauthentication(null)
    pending.resolve(confirmed)
  }, [])

  /**
   * She re-authenticated: the open prompt switches to «التحقق صالح حتى …»
   * and stays open until she continues or cancels.
   */
  const confirmReauthentication = useCallback(async (user: User) => {
    const pending = reauthenticationRef.current

    if (!pending) {
      return
    }

    const confirmedAt = await readSignInTime(user)

    // Closed, or replaced by another account's prompt, meanwhile.
    if (reauthenticationRef.current !== pending) {
      return
    }

    const request: ReauthenticationRequest = { ...pending.request, confirmedAt }

    pending.request = request
    setReauthentication(request)
  }, [])

  useEffect(() => {
    let isActive = true
    let unsubscribe: (() => void) | undefined

    function markAuthUnavailable(error: AuthError) {
      setFirebaseUser(null)
      setIsEmailVerified(false)
      setProfile(null)
      setProfileRequired(false)
      setSecondFactors(NO_SECOND_FACTORS)
      setIsAuthAvailable(false)
      setAuthError(error)
      setIsInitializing(false)
      settleReauthentication(false)
    }

    void getAuthResources()
      .then(async (resources) => {
        if (!isActive) {
          return
        }

        if (!resources.ok) {
          markAuthUnavailable(resources.error)
          return
        }

        const { auth, ready, sdk } = resources

        await ready

        if (!isActive) {
          return
        }

        setIsAuthAvailable(true)

        // The app's one and only auth-state listener.
        unsubscribe = sdk.onAuthStateChanged(auth, (nextUser) => {
          const requestVersion =
            profileRequestVersionRef.current + 1

          profileRequestVersionRef.current = requestVersion
          profileRequestAbortRef.current?.abort()
          profileRequestAbortRef.current = null

          setFirebaseUser(nextUser)
          setIsEmailVerified(
            nextUser?.emailVerified ?? false,
          )
          setProfile(null)
          setProfileRequired(false)
          setAuthError(null)
          setSecondFactors(
            nextUser ? listSecondFactors(sdk, nextUser) : NO_SECOND_FACTORS,
          )

          // Another account (or none) now: a password prompt or an
          // enrollment started for the previous one no longer applies.
          settleReauthentication(false)
          totpEnrollmentRef.current = null

          idleSessionRef.current = nextUser
            ? describeIdleSession(nextUser)
            : null

          if (nextUser) {
            // A sign-in ends the «signed out after inactivity» notice (the
            // sign-out that set it must not). It is activity too, seen by
            // every tab: each idle timer starts a new quiet period, so this
            // session is never ended for the quiet time of the last one.
            setIdleSignOutMinutes(null)
            restartIdleTimers(idleTimersRef.current)
          }

          if (nextUser?.displayName) {
            void clearLegacyDisplayName(sdk, nextUser)
          }

          // A new account signs in while registration is still running;
          // registration owns the status of the email it is about to send.
          if (!registrationInProgressRef.current) {
            verificationSendVersionRef.current += 1
            setVerificationEmail(VERIFICATION_EMAIL_IDLE)
          }

          if (!nextUser) {
            registeredProfileRef.current = null
            setIsInitializing(false)
            return
          }

          const cachedProfile = registeredProfileRef.current

          if (cachedProfile?.uid === nextUser.uid) {
            registeredProfileRef.current = null
            setProfile(cachedProfile.profile)
            setIsInitializing(false)
            return
          }

          setIsInitializing(true)

          if (registrationInProgressRef.current) {
            return
          }

          const abortController = new AbortController()
          profileRequestAbortRef.current = abortController

          void requestProfile(
            nextUser,
            'GET',
            undefined,
            abortController.signal,
          ).then((result) => {
            if (
              !isActive ||
              profileRequestVersionRef.current !==
                requestVersion ||
              auth.currentUser?.uid !== nextUser.uid
            ) {
              return
            }

            if (
              profileRequestAbortRef.current ===
              abortController
            ) {
              profileRequestAbortRef.current = null
            }

            if (result.kind === 'aborted') {
              return
            }

            if (result.kind === 'success') {
              setProfile(result.profile)
              setProfileRequired(false)
              setAuthError(null)
            } else if (result.kind === 'missing') {
              setProfile(null)
              setProfileRequired(true)
              setAuthError(null)
            } else {
              setProfile(null)
              setProfileRequired(false)
              setAuthError(result.error)
            }

            setIsInitializing(false)
          })
        })
      })
      .catch(() => {
        if (!isActive) {
          return
        }

        markAuthUnavailable(
          createAuthError('UNEXPECTED_ERROR', INITIALIZATION_FAILED_MESSAGE),
        )
      })

    return () => {
      isActive = false
      unsubscribe?.()
      profileRequestVersionRef.current += 1
      profileRequestAbortRef.current?.abort()
      profileRequestAbortRef.current = null
      settleReauthentication(false)
    }
  }, [settleReauthentication])

  const setActionError = useCallback(
    (error: AuthError): AuthActionResult => {
      setAuthError(error)

      return {
        ok: false,
        error,
      }
    },
    [],
  )

  const clearAuthError = useCallback(() => {
    setAuthError(null)
  }, [])

  /** Marks a verification-email send as in flight; returns its version. */
  const beginVerificationSend = useCallback((): number => {
    const version = verificationSendVersionRef.current + 1

    verificationSendVersionRef.current = version
    setVerificationEmail(VERIFICATION_EMAIL_SENDING)

    return version
  }, [])

  /** Records a send's outcome unless a newer send or account superseded it. */
  const settleVerificationSend = useCallback(
    (version: number, outcome: VerificationEmailState) => {
      if (verificationSendVersionRef.current === version) {
        setVerificationEmail(outcome)
      }
    },
    [],
  )

  const nextSequence = useCallback((): number => {
    sequenceRef.current += 1
    return sequenceRef.current
  }, [])

  const requestReauthentication = useCallback(async (): Promise<boolean> => {
    const pending = reauthenticationRef.current

    if (pending) {
      return pending.promise
    }

    const resources = await getAuthResources()
    const email = resources.ok ? resources.auth.currentUser?.email : null

    // Only a password account that is signed in can confirm its password.
    if (!email) {
      return false
    }

    // Another caller may have opened the prompt while the SDK loaded.
    const openedMeanwhile = reauthenticationRef.current

    if (openedMeanwhile) {
      return openedMeanwhile.promise
    }

    const deferred = createDeferred<boolean>()
    const request: ReauthenticationRequest = {
      id: nextSequence(),
      email,
      // A dialog she was working in (whose busy button cannot take focus
      // back), else whatever had focus.
      returnFocus:
        getTopmostModal() ??
        (document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : null),
      confirmedAt: null,
    }

    reauthenticationRef.current = {
      request,
      promise: deferred.promise,
      resolve: deferred.resolve,
    }
    setReauthentication(request)

    return deferred.promise
  }, [nextSequence])

  /**
   * The password was right and the account has a second factor: keeps the
   * resolver here and hands the dialog a code-step challenge. Only
   * authenticator apps (TOTP) are offered; this site has no SMS flow.
   */
  const beginSecondFactor = useCallback(
    (
      resources: Extract<AuthResources, { ok: true }>,
      error: MultiFactorError,
      purpose: SecondFactorChallenge['purpose'],
    ): AuthActionResult => {
      const fail = purpose === 'sign-in' ? setActionError : promptFailure
      let resolver: MultiFactorResolver

      try {
        resolver = resources.sdk.getMultiFactorResolver(resources.auth, error)
      } catch (resolverError: unknown) {
        return fail(mapFirebaseError(resolverError))
      }

      const factors = resolver.hints
        .filter(
          (hint) =>
            hint.factorId === resources.sdk.TotpMultiFactorGenerator.FACTOR_ID,
        )
        .map((hint) => ({ uid: hint.uid, label: hint.displayName ?? null }))

      if (factors.length === 0) {
        return fail(createAuthError('MFA_UNSUPPORTED'))
      }

      const challenge: SecondFactorChallenge = {
        id: nextSequence(),
        purpose,
        factors,
      }

      secondFactorRef.current = { challenge, resolver }

      if (purpose === 'sign-in') {
        setAuthError(null)
      }

      return {
        ok: false,
        error: createAuthError('MFA_REQUIRED'),
        secondFactor: challenge,
      }
    },
    [nextSequence, setActionError],
  )

  const signIn = useCallback(
    async (
      email: string,
      password: string,
    ): Promise<AuthActionResult> => {
      const normalizedEmail = normalizeEmail(email)

      if (!normalizedEmail || password.length === 0) {
        return setActionError(
          createAuthError('INVALID_INPUT'),
        )
      }

      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      setAuthError(null)

      try {
        await resources.ready
        await resources.sdk.signInWithEmailAndPassword(
          resources.auth,
          normalizedEmail,
          password,
        )

        return { ok: true }
      } catch (error: unknown) {
        if (isMultiFactorError(error)) {
          return beginSecondFactor(resources, error, 'sign-in')
        }

        return setActionError(mapFirebaseError(error))
      }
    },
    [beginSecondFactor, setActionError],
  )

  const register = useCallback(
    async (
      input: RegistrationInput,
    ): Promise<AuthActionResult> => {
      const normalizedProfile = normalizeProfileInput(input)
      const normalizedEmail = normalizeEmail(input.email)

      if (
        !normalizedProfile ||
        !normalizedEmail ||
        input.password.length < 8
      ) {
        return setActionError(
          createAuthError('INVALID_INPUT'),
        )
      }

      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      setAuthError(null)
      registrationInProgressRef.current = true

      // Registration sends the verification email itself. The verification
      // gate mounts as soon as the new account signs in, before that send,
      // so it reads "sending" until the outcome is recorded (once, in
      // `finally`). It stays idle unless the send is actually attempted.
      const verificationSendVersion = beginVerificationSend()
      let verificationEmailOutcome: VerificationEmailState =
        VERIFICATION_EMAIL_IDLE
      let createdUser: User | null = null

      try {
        await resources.ready

        const credential =
          await resources.sdk.createUserWithEmailAndPassword(
            resources.auth,
            normalizedEmail,
            input.password,
          )

        createdUser = credential.user

        // SEC-18: her name lives only in the profile (D1), never in the
        // Firebase account's displayName.
        const result = await requestProfile(
          createdUser,
          'PUT',
          normalizedProfile,
        )

        // A failed send is reported through `verificationEmail` (the gate
        // shows it with a retry), not through `authError`.
        try {
          await sendVerificationMessage(createdUser)
          verificationEmailOutcome = VERIFICATION_EMAIL_SENT
        } catch (error: unknown) {
          verificationEmailOutcome = {
            status: 'failed',
            error: mapFirebaseError(error),
          }
        }

        if (
          resources.auth.currentUser?.uid !== createdUser.uid
        ) {
          // Another account (or none) is signed in now; the outcome is not
          // about it.
          verificationEmailOutcome = VERIFICATION_EMAIL_IDLE

          return {
            ok: false,
            error: createAuthError('UNAUTHORIZED'),
          }
        }

        if (result.kind === 'success') {
          registeredProfileRef.current = {
            uid: createdUser.uid,
            profile: result.profile,
          }
          profileRequestVersionRef.current += 1
          profileRequestAbortRef.current?.abort()
          profileRequestAbortRef.current = null
          setProfile(result.profile)
          setProfileRequired(false)
          setIsInitializing(false)
          setIsEmailVerified(createdUser.emailVerified)
          setAuthError(null)

          return { ok: true }
        }

        const error = createAuthError(
          'PROFILE_REQUIRED',
          describeProfileSaveFailure(result, {
            network:
              'تم إنشاء الحساب، لكن تعذر حفظ بيانات التواصل بسبب مشكلة في الاتصال. أعيدي المحاولة لإكمال ملفكِ.',
            limitPrefix: 'تم إنشاء الحساب، لكن تعذر حفظ بيانات التواصل الآن. ',
            other:
              'تم إنشاء الحساب، لكن تعذر حفظ بيانات التواصل. راجعي البيانات ثم أعيدي المحاولة.',
          }),
        )

        setProfile(null)
        setProfileRequired(true)
        setIsInitializing(false)

        return setActionError(error)
      } catch (error: unknown) {
        const mappedError = mapFirebaseError(error)

        if (createdUser) {
          if (
            resources.auth.currentUser?.uid !==
            createdUser.uid
          ) {
            return {
              ok: false,
              error: createAuthError('UNAUTHORIZED'),
            }
          }

          setProfile(null)
          setProfileRequired(true)
          setIsInitializing(false)

          return setActionError(
            createAuthError(
              'PROFILE_REQUIRED',
              mappedError.code === 'NETWORK_ERROR'
                ? 'تم إنشاء الحساب، لكن تعذر حفظ بيانات التواصل بسبب مشكلة في الاتصال. أعيدي المحاولة لإكمال ملفكِ.'
                : 'تم إنشاء الحساب، لكن تعذر استكمال بيانات الملف الشخصي. أعيدي المحاولة دون إنشاء حساب جديد.',
            ),
          )
        }

        return setActionError(mappedError)
      } finally {
        registrationInProgressRef.current = false
        settleVerificationSend(
          verificationSendVersion,
          verificationEmailOutcome,
        )
      }
    },
    [beginVerificationSend, setActionError, settleVerificationSend],
  )

  const completeProfile = useCallback(
    async (
      input: ProfileInput,
    ): Promise<AuthActionResult> => {
      const normalizedProfile = normalizeProfileInput(input)

      if (!normalizedProfile) {
        return setActionError(
          createAuthError('INVALID_INPUT'),
        )
      }

      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      const currentUser = resources.auth.currentUser

      if (!currentUser) {
        return setActionError(
          createAuthError('UNAUTHORIZED'),
        )
      }

      setAuthError(null)

      try {
        await resources.ready

        const result = await requestProfile(
          currentUser,
          'PUT',
          normalizedProfile,
        )

        if (
          resources.auth.currentUser?.uid !== currentUser.uid
        ) {
          return {
            ok: false,
            error: createAuthError('UNAUTHORIZED'),
          }
        }

        if (result.kind === 'success') {
          profileRequestVersionRef.current += 1
          profileRequestAbortRef.current?.abort()
          profileRequestAbortRef.current = null
          setProfile(result.profile)
          setProfileRequired(false)
          setIsInitializing(false)
          setAuthError(null)

          return { ok: true }
        }

        const error = createAuthError(
          'PROFILE_REQUIRED',
          describeProfileSaveFailure(result, {
            network:
              'تعذر حفظ بيانات التواصل بسبب مشكلة في الاتصال. تحققي من الاتصال ثم أعيدي المحاولة.',
            limitPrefix: 'تعذر حفظ بيانات التواصل الآن. ',
            other: 'تعذر حفظ بيانات التواصل. راجعي البيانات ثم أعيدي المحاولة.',
          }),
        )

        setProfile(null)
        setProfileRequired(true)
        setIsInitializing(false)

        return setActionError(error)
      } catch (error: unknown) {
        const mappedError = mapFirebaseError(error)

        if (
          resources.auth.currentUser?.uid === currentUser.uid
        ) {
          setProfileRequired(true)
          setIsInitializing(false)
          setAuthError(mappedError)
        }

        return {
          ok: false,
          error: mappedError,
        }
      }
    },
    [setActionError],
  )

  const sendPasswordReset = useCallback(
    async (
      email: string,
    ): Promise<AuthActionResult> => {
      const normalizedEmail = normalizeEmail(email)

      if (!normalizedEmail) {
        return setActionError(
          createAuthError('INVALID_INPUT'),
        )
      }

      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      setAuthError(null)

      try {
        await resources.ready
        await resources.sdk.sendPasswordResetEmail(
          resources.auth,
          normalizedEmail,
        )

        return { ok: true }
      } catch (error: unknown) {
        if (
          isFirebaseError(error) &&
          error.code === 'auth/user-not-found'
        ) {
          return { ok: true }
        }

        return setActionError(mapFirebaseError(error))
      }
    },
    [setActionError],
  )

  const sendVerificationEmail = useCallback(
    async (): Promise<AuthActionResult> => {
      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      const currentUser = resources.auth.currentUser

      if (!currentUser) {
        return setActionError(
          createAuthError('UNAUTHORIZED'),
        )
      }

      if (currentUser.emailVerified) {
        setIsEmailVerified(true)
        setAuthError(null)
        return { ok: true }
      }

      setAuthError(null)

      const sendVersion = beginVerificationSend()

      try {
        await sendVerificationMessage(currentUser)

        if (
          resources.auth.currentUser?.uid !== currentUser.uid
        ) {
          settleVerificationSend(sendVersion, VERIFICATION_EMAIL_IDLE)

          return setActionError(
            createAuthError('UNAUTHORIZED'),
          )
        }

        settleVerificationSend(sendVersion, VERIFICATION_EMAIL_SENT)

        return { ok: true }
      } catch (error: unknown) {
        const mappedError = mapFirebaseError(error)

        settleVerificationSend(sendVersion, {
          status: 'failed',
          error: mappedError,
        })

        return setActionError(mappedError)
      }
    },
    [beginVerificationSend, setActionError, settleVerificationSend],
  )

  const reloadFirebaseUser = useCallback(
    async (): Promise<AuthActionResult> => {
      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      const currentUser = resources.auth.currentUser

      if (!currentUser) {
        return setActionError(
          createAuthError('UNAUTHORIZED'),
        )
      }

      setAuthError(null)

      try {
        await resources.ready
        await currentUser.reload()

        const reloadedUser = resources.auth.currentUser

        if (
          !reloadedUser ||
          reloadedUser.uid !== currentUser.uid
        ) {
          return setActionError(
            createAuthError('UNAUTHORIZED'),
          )
        }

        setFirebaseUser(reloadedUser)
        setIsEmailVerified(reloadedUser.emailVerified)
        setSecondFactors(listSecondFactors(resources.sdk, reloadedUser))

        return { ok: true }
      } catch (error: unknown) {
        return setActionError(mapFirebaseError(error))
      }
    },
    [setActionError],
  )

  const refreshIdToken = useCallback(
    async (): Promise<AuthActionResult> => {
      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      const currentUser = resources.auth.currentUser

      if (!currentUser) {
        return setActionError(
          createAuthError('UNAUTHORIZED'),
        )
      }

      setAuthError(null)

      try {
        await resources.ready
        await currentUser.getIdToken(true)

        if (
          resources.auth.currentUser?.uid !== currentUser.uid
        ) {
          return setActionError(
            createAuthError('UNAUTHORIZED'),
          )
        }

        return { ok: true }
      } catch (error: unknown) {
        return setActionError(mapFirebaseError(error))
      }
    },
    [setActionError],
  )

  const checkEmailVerification = useCallback(
    async (): Promise<EmailVerificationCheckResult> => {
      const resources = await getAuthResources()

      if (!resources.ok) {
        const error = resources.error
        setAuthError(error)
        return { ok: false, error }
      }

      const currentUser = resources.auth.currentUser

      if (!currentUser) {
        const error = createAuthError('UNAUTHORIZED')
        setAuthError(error)
        return { ok: false, error }
      }

      setAuthError(null)

      try {
        await resources.ready
        await currentUser.reload()

        const reloadedUser = resources.auth.currentUser

        if (
          !reloadedUser ||
          reloadedUser.uid !== currentUser.uid
        ) {
          const error = createAuthError('UNAUTHORIZED')
          setAuthError(error)
          return { ok: false, error }
        }

        setFirebaseUser(reloadedUser)
        setIsEmailVerified(reloadedUser.emailVerified)
        setSecondFactors(listSecondFactors(resources.sdk, reloadedUser))

        if (reloadedUser.emailVerified) {
          await reloadedUser.getIdToken(true)

          if (
            resources.auth.currentUser?.uid !==
            reloadedUser.uid
          ) {
            const error = createAuthError('UNAUTHORIZED')
            setAuthError(error)
            return { ok: false, error }
          }
        }

        return {
          ok: true,
          verified: reloadedUser.emailVerified,
        }
      } catch (error: unknown) {
        const mappedError = mapFirebaseError(error)
        setAuthError(mappedError)
        return {
          ok: false,
          error: mappedError,
        }
      }
    },
    [],
  )

  const signOutUser =
    useCallback(async (): Promise<AuthActionResult> => {
      const resources = await getAuthResources()

      if (!resources.ok) {
        return setActionError(resources.error)
      }

      setAuthError(null)

      try {
        await resources.ready
        await resources.sdk.signOut(resources.auth)

        return { ok: true }
      } catch (error: unknown) {
        return setActionError(mapFirebaseError(error))
      }
    }, [setActionError])

  const getIdToken =
    useCallback(async (): Promise<string | null> => {
      const resources = await getAuthResources()

      if (!resources.ok) {
        setAuthError(resources.error)
        return null
      }

      const currentUser = resources.auth.currentUser

      if (!currentUser) {
        return null
      }

      if (!currentUser.emailVerified) {
        setIsEmailVerified(false)
        setAuthError(
          createAuthError(
            'UNAUTHORIZED',
            'يجب تأكيد البريد الإلكتروني قبل استخدام هذه الخدمة.',
          ),
        )
        return null
      }

      try {
        await resources.ready

        // Read the cached token's claims first (no network round-trip
        // unless the cached token already expired). A token minted before
        // Firebase marked the address as verified still carries a stale
        // `email_verified: false` claim, which the Worker rejects with 403
        // even though the client-side `currentUser.emailVerified` is true.
        const cachedResult = await currentUser.getIdTokenResult()

        if (resources.auth.currentUser?.uid !== currentUser.uid) {
          return null
        }

        const cachedEmailVerifiedClaim =
          cachedResult.claims.email_verified
        const cachedClaimIsStaleFalse =
          typeof cachedEmailVerifiedClaim === 'boolean' &&
          !cachedEmailVerifiedClaim

        // Force exactly one refresh when the cached claim is stale so the
        // customer is not locked out of حجوزاتي until the cached token
        // naturally expires (previously up to an hour).
        const token = cachedClaimIsStaleFalse
          ? await currentUser.getIdToken(true)
          : cachedResult.token

        return (
          resources.auth.currentUser?.uid === currentUser.uid
            ? token
            : null
        )
      } catch (error: unknown) {
        setAuthError(mapFirebaseError(error))
        return null
      }
    }, [])

  const completeSecondFactor = useCallback(
    async (
      challengeId: number,
      factorUid: string,
      code: string,
    ): Promise<AuthActionResult> => {
      const pending = secondFactorRef.current

      if (!pending || pending.challenge.id !== challengeId) {
        return promptFailure(createAuthError('MFA_SESSION_EXPIRED'))
      }

      const isSignIn = pending.challenge.purpose === 'sign-in'
      const fail = isSignIn ? setActionError : promptFailure
      const normalizedCode = code.trim()

      if (!TOTP_SIGN_IN_CODE_PATTERN.test(normalizedCode)) {
        return fail(
          createAuthError(
            'INVALID_VERIFICATION_CODE',
            'أدخلي الرمز المكوّن من 6 أرقام كما يظهر في تطبيق المصادقة.',
          ),
        )
      }

      if (!pending.challenge.factors.some((factor) => factor.uid === factorUid)) {
        return fail(createAuthError('INVALID_INPUT'))
      }

      const resources = await getAuthResources()

      if (!resources.ok) {
        return fail(resources.error)
      }

      if (isSignIn) {
        setAuthError(null)
      }

      try {
        await resources.ready
        await pending.resolver.resolveSignIn(
          resources.sdk.TotpMultiFactorGenerator.assertionForSignIn(
            factorUid,
            normalizedCode,
          ),
        )

        if (secondFactorRef.current === pending) {
          secondFactorRef.current = null
        }

        if (pending.challenge.purpose === 'reauthenticate') {
          const user = resources.auth.currentUser

          if (!user) {
            return fail(createAuthError('UNAUTHORIZED'))
          }

          await confirmReauthentication(user)
        }

        return { ok: true }
      } catch (error: unknown) {
        const mappedError = mapFirebaseError(error)

        if (
          mappedError.code === 'MFA_SESSION_EXPIRED' &&
          secondFactorRef.current === pending
        ) {
          secondFactorRef.current = null
        }

        return fail(mappedError)
      }
    },
    [confirmReauthentication, setActionError],
  )

  const cancelSecondFactor = useCallback((challengeId: number) => {
    if (secondFactorRef.current?.challenge.id === challengeId) {
      secondFactorRef.current = null
    }
  }, [])

  const reauthenticateWithPassword = useCallback(
    async (password: string): Promise<AuthActionResult> => {
      if (password.length === 0) {
        return promptFailure(createAuthError('INVALID_INPUT'))
      }

      const resources = await getAuthResources()

      if (!resources.ok) {
        return promptFailure(resources.error)
      }

      const currentUser = resources.auth.currentUser

      if (!currentUser?.email) {
        return promptFailure(createAuthError('UNAUTHORIZED'))
      }

      try {
        await resources.ready
        await resources.sdk.reauthenticateWithCredential(
          currentUser,
          resources.sdk.EmailAuthProvider.credential(
            currentUser.email,
            password,
          ),
        )
      } catch (error: unknown) {
        // A second factor on the account: the dialog's code step comes next
        // (the resolver stays here). Only an authenticator app can finish
        // it; any other factor answers MFA_UNSUPPORTED.
        if (isMultiFactorError(error)) {
          return beginSecondFactor(resources, error, 'reauthenticate')
        }

        return promptFailure(mapFirebaseError(error))
      }

      if (resources.auth.currentUser?.uid !== currentUser.uid) {
        return promptFailure(createAuthError('UNAUTHORIZED'))
      }

      await confirmReauthentication(currentUser)

      return { ok: true }
    },
    [beginSecondFactor, confirmReauthentication],
  )

  /**
   * Closes the prompt: only «متابعة» after success answers true; Escape, the
   * backdrop and every other close cancel, even after success.
   */
  const closeReauthentication = useCallback(
    (close: ReauthenticationClose) => {
      const pending = reauthenticationRef.current

      if (pending) {
        settleReauthentication(answerReauthentication(pending.request, close))
      }
    },
    [settleReauthentication],
  )

  const cancelReauthentication = useCallback(() => {
    closeReauthentication('cancel')
  }, [closeReauthentication])

  const continueReauthentication = useCallback(() => {
    closeReauthentication('continue')
  }, [closeReauthentication])

  /**
   * The idle timer's action (TM-07): ends only the session that stayed idle
   * (decideIdleSignOut). A failed sign-out is tried again by the timer a
   * minute later; so is a re-check after success, which finds nobody signed
   * in. A sign-in since the quiet period began, reported or not, is never
   * ended for it.
   */
  const signOutAfterInactivity = useCallback(async (minutes: number) => {
    const resources = await getAuthResources()

    if (!resources.ok) {
      return
    }

    try {
      await resources.ready

      const user = resources.auth.currentUser
      const current = user ? describeIdleSession(user) : null
      const decision = decideIdleSignOut(current, idleSessionRef.current)

      if (decision === 'restart') {
        idleSessionRef.current = current
        restartIdleTimers(idleTimersRef.current)
        return
      }

      if (decision === 'skip') {
        return
      }

      await resources.sdk.signOut(resources.auth)
      setIdleSignOutMinutes(minutes)
    } catch (error: unknown) {
      // The SDK rejects with a FirebaseError (the next check retries);
      // anything else is a bug, reported without an unhandled rejection
      // from the timer. Neither path logs account data.
      if (!isFirebaseError(error)) {
        reportError(error)
      }
    }
  }, [])

  const startIdleSignOut = useCallback(
    (minutes: number): (() => void) => {
      if (
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > MAXIMUM_IDLE_SIGN_OUT_MINUTES
      ) {
        throw new RangeError(
          `startIdleSignOut: minutes must be a whole number from 1 to ${MAXIMUM_IDLE_SIGN_OUT_MINUTES}.`,
        )
      }

      const idleTimers = idleTimersRef.current
      const idleTimer = startIdleTimer({
        target: document,
        idleMs: minutes * MINUTE_MS,
        onIdle: () => {
          void signOutAfterInactivity(minutes)
        },
      })

      idleTimers.add(idleTimer)

      return () => {
        idleTimers.delete(idleTimer)
        idleTimer.stop()
      }
    },
    [signOutAfterInactivity],
  )

  /**
   * Runs an account-security operation. When Firebase wants a recent sign-in
   * (auth/requires-recent-login) it asks for her password once and runs the
   * operation again; `{ ok: false }` when she closes the prompt. Any other
   * failure is rethrown to the caller, which maps it.
   */
  const runWithRecentLogin = useCallback(
    async <T,>(
      operation: () => Promise<T>,
    ): Promise<RecentLoginResult<T>> => {
      try {
        return { ok: true, value: await operation() }
      } catch (error: unknown) {
        if (!isRecentLoginRequired(error)) {
          throw error
        }
      }

      if (!(await requestReauthentication())) {
        return { ok: false }
      }

      return { ok: true, value: await operation() }
    },
    [requestReauthentication],
  )

  const startTotpEnrollment = useCallback(
    async (): Promise<TotpEnrollmentStartResult> => {
      const resources = await getAuthResources()

      if (!resources.ok) {
        return { ok: false, error: resources.error }
      }

      const { sdk } = resources
      const currentUser = resources.auth.currentUser

      if (!currentUser) {
        return { ok: false, error: createAuthError('UNAUTHORIZED') }
      }

      try {
        await resources.ready

        const attempt = await runWithRecentLogin(async () =>
          sdk.TotpMultiFactorGenerator.generateSecret(
            await sdk.multiFactor(currentUser).getSession(),
          ),
        )

        if (!attempt.ok) {
          return {
            ok: false,
            error: createAuthError(
              'REAUTH_REQUIRED',
              ENROLLMENT_REAUTH_DECLINED_MESSAGE,
            ),
          }
        }

        if (resources.auth.currentUser?.uid !== currentUser.uid) {
          return { ok: false, error: createAuthError('UNAUTHORIZED') }
        }

        const secret = attempt.value
        const id = nextSequence()

        totpEnrollmentRef.current = { id, uid: currentUser.uid, secret }

        return {
          ok: true,
          enrollment: {
            id,
            secretKey: secret.secretKey,
            // The SDK interpolates both parts into the URI as given, so they
            // are percent-encoded here (Key URI Format).
            otpauthUrl: secret.generateQrCodeUrl(
              encodeURIComponent(currentUser.email ?? currentUser.uid),
              encodeURIComponent(TOTP_ISSUER),
            ),
            codeLength: secret.codeLength,
            codeIntervalSeconds: secret.codeIntervalSeconds,
            completeBy: secret.enrollmentCompletionDeadline,
          },
        }
      } catch (error: unknown) {
        return { ok: false, error: mapEnrollmentError(error) }
      }
    },
    [nextSequence, runWithRecentLogin],
  )

  const finishTotpEnrollment = useCallback(
    async (
      enrollmentId: number,
      code: string,
    ): Promise<AuthActionResult> => {
      const pending = totpEnrollmentRef.current

      if (!pending || pending.id !== enrollmentId) {
        return {
          ok: false,
          error: createAuthError(
            'MFA_SESSION_EXPIRED',
            TOTP_ENROLLMENT_EXPIRED_MESSAGE,
          ),
        }
      }

      const normalizedCode = code.trim()

      if (
        normalizedCode.length !== pending.secret.codeLength ||
        !DIGITS_PATTERN.test(normalizedCode)
      ) {
        return {
          ok: false,
          error: createAuthError(
            'INVALID_VERIFICATION_CODE',
            `أدخلي الرمز المكوّن من ${pending.secret.codeLength} أرقام كما يظهر في تطبيق المصادقة.`,
          ),
        }
      }

      const resources = await getAuthResources()

      if (!resources.ok) {
        return { ok: false, error: resources.error }
      }

      const { sdk } = resources
      const currentUser = resources.auth.currentUser

      if (!currentUser || currentUser.uid !== pending.uid) {
        totpEnrollmentRef.current = null
        return { ok: false, error: createAuthError('UNAUTHORIZED') }
      }

      try {
        await resources.ready

        const assertion = sdk.TotpMultiFactorGenerator.assertionForEnrollment(
          pending.secret,
          normalizedCode,
        )
        const attempt = await runWithRecentLogin(() =>
          sdk.multiFactor(currentUser).enroll(assertion, TOTP_FACTOR_NAME),
        )

        if (!attempt.ok) {
          return {
            ok: false,
            error: createAuthError(
              'REAUTH_REQUIRED',
              ENROLLMENT_REAUTH_DECLINED_MESSAGE,
            ),
          }
        }

        if (totpEnrollmentRef.current === pending) {
          totpEnrollmentRef.current = null
        }

        if (resources.auth.currentUser?.uid === currentUser.uid) {
          setSecondFactors(listSecondFactors(sdk, currentUser))
        }

        return { ok: true }
      } catch (error: unknown) {
        const mappedError = mapEnrollmentError(error)

        if (
          mappedError.code === 'MFA_SESSION_EXPIRED' &&
          totpEnrollmentRef.current === pending
        ) {
          totpEnrollmentRef.current = null
        }

        return { ok: false, error: mappedError }
      }
    },
    [runWithRecentLogin],
  )

  const cancelTotpEnrollment = useCallback((enrollmentId: number) => {
    if (totpEnrollmentRef.current?.id === enrollmentId) {
      totpEnrollmentRef.current = null
    }
  }, [])

  const isAuthenticated = firebaseUser !== null

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      firebaseUser,
      profile,
      isInitializing,
      isAuthenticated,
      isAuthAvailable,
      isEmailVerified,
      profileRequired,
      authError,
      verificationEmail,
      secondFactors,
      reauthentication,
      idleSignOutMinutes,
      signIn,
      register,
      completeProfile,
      sendPasswordReset,
      sendVerificationEmail,
      reloadFirebaseUser,
      refreshIdToken,
      checkEmailVerification,
      signOutUser,
      getIdToken,
      clearAuthError,
      completeSecondFactor,
      cancelSecondFactor,
      requestReauthentication,
      reauthenticateWithPassword,
      reauthenticate: reauthenticateWithPassword,
      cancelReauthentication,
      continueReauthentication,
      startIdleSignOut,
      startTotpEnrollment,
      finishTotpEnrollment,
      cancelTotpEnrollment,
    }),
    [
      firebaseUser,
      profile,
      isInitializing,
      isAuthenticated,
      isAuthAvailable,
      isEmailVerified,
      profileRequired,
      authError,
      verificationEmail,
      secondFactors,
      reauthentication,
      idleSignOutMinutes,
      signIn,
      register,
      completeProfile,
      sendPasswordReset,
      sendVerificationEmail,
      reloadFirebaseUser,
      refreshIdToken,
      checkEmailVerification,
      signOutUser,
      getIdToken,
      clearAuthError,
      completeSecondFactor,
      cancelSecondFactor,
      requestReauthentication,
      reauthenticateWithPassword,
      cancelReauthentication,
      continueReauthentication,
      startIdleSignOut,
      startTotpEnrollment,
      finishTotpEnrollment,
      cancelTotpEnrollment,
    ],
  )

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  )
}