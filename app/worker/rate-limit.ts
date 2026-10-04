import {
  BURST_PERIOD_SECONDS,
  LONGEST_LIMIT_WINDOW_SECONDS,
  type BurstLimitName,
} from '../shared/limits.js'
import { errorResponse } from './http.js'

/**
 * Burst limits (plan 11 §3.1, TM-11, audit SEC-03) on the Workers Rate
 * Limiting bindings RL_* that wrangler.jsonc declares as `ratelimits`, 60 s
 * each, with the limits of shared/limits.ts BURST_LIMITS (a test keeps the
 * two equal). The key is the
 * verified Firebase uid, or connectingIpKey() on a public route, never
 * anything the client chooses, and it is never logged.
 *
 * Callers check the token against the users row (users.ts
 * readAccountStanding: revocation, erasure) BEFORE the limiter, so a stolen
 * token that was revoked cannot use up its owner's allowance and lock her
 * out (SEC-11).
 *
 * The limiter is a burst brake, not the business rule: the SQL caps inside
 * the writing statements (shared/limits.ts) are the hard bound. So it is
 * fail-open by design: with no binding (an environment deployed without one)
 * or a failing limiter, the request is allowed and only a fixed code is
 * logged. The binding is checked by its runtime shape, never trusted from
 * the generated Env type.
 */

export type BurstDecision = 'allowed' | 'limited'

/** Firebase uids are at most 128 characters, IP keys shorter. */
const MAXIMUM_KEY_LENGTH = 256

function isRateLimitBinding(value: unknown): value is RateLimit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'limit' in value &&
    typeof value.limit === 'function'
  )
}

function isRateLimitOutcome(value: unknown): value is RateLimitOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof value.success === 'boolean'
  )
}

/**
 * One request against a `ratelimits` binding. 'limited' only when the
 * binding answers that the key has used up its allowance; a missing binding
 * (code=RL_BINDING_MISSING) or an unusable one (code=RL_UNAVAILABLE) allows.
 * An empty or oversized key is a programming error and throws.
 */
export async function limitBurst(
  binding: RateLimit | undefined,
  key: string,
): Promise<BurstDecision> {
  if (key.length === 0 || key.length > MAXIMUM_KEY_LENGTH) {
    throw new RangeError(
      `Rate-limit key must be 1 to ${MAXIMUM_KEY_LENGTH} characters.`,
    )
  }

  if (!isRateLimitBinding(binding)) {
    console.warn('RATE_LIMIT_SKIPPED code=RL_BINDING_MISSING')

    return 'allowed'
  }

  let outcome: unknown

  try {
    outcome = await binding.limit({ key })
  } catch (error) {
    if (error instanceof Error) {
      console.warn('RATE_LIMIT_SKIPPED code=RL_UNAVAILABLE')

      return 'allowed'
    }

    throw error
  }

  if (!isRateLimitOutcome(outcome)) {
    console.warn('RATE_LIMIT_SKIPPED code=RL_UNAVAILABLE')

    return 'allowed'
  }

  return outcome.success ? 'allowed' : 'limited'
}

/** The Wave 0 call sites (bookings.ts, profile.ts) and their bindings. */
const BINDING_BY_ACTION = {
  'booking-create': 'RL_BOOKING',
  'profile-write': 'RL_PROFILE',
} as const satisfies Record<string, BurstLimitName>

export type RateLimitedAction = keyof typeof BINDING_BY_ACTION

/**
 * True when this uid has used up its burst allowance for the action:
 * limitBurst on the action's binding, keyed by the uid alone (each binding
 * is its own counter namespace).
 */
export async function isRateLimited(
  env: Env,
  action: RateLimitedAction,
  uid: string,
): Promise<boolean> {
  return (await limitBurst(env[BINDING_BY_ACTION[action]], uid)) === 'limited'
}

const IPV4_ADDRESS =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_CHARACTERS = /^[0-9a-f:.]{2,45}$/
const HEXTET = /^[0-9a-f]{1,4}$/
const IPV6_GROUPS = 8

/** The eight hextets of an IPv6 address as numbers, or null. */
function ipv6Hextets(address: string): number[] | null {
  let text = address.toLowerCase()

  if (!IPV6_CHARACTERS.test(text)) {
    return null
  }

  // An embedded IPv4 address (::ffff:192.0.2.1) is the last two hextets.
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    const embedded = text.slice(lastColon + 1)

    if (!IPV4_ADDRESS.test(embedded)) {
      return null
    }

    const [a = 0, b = 0, c = 0, d = 0] = embedded.split('.').map(Number)

    text = `${text.slice(0, lastColon + 1)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`
  }

  const halves = text.split('::')

  if (halves.length > 2) {
    return null
  }

  const [head = '', tail = ''] = halves
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  const missing = IPV6_GROUPS - headGroups.length - tailGroups.length

  // Without `::` there must be eight groups; `::` stands for at least one.
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null
  }

  const groups = [
    ...headGroups,
    ...Array.from({ length: missing }, () => '0'),
    ...tailGroups,
  ]

  if (!groups.every((group) => HEXTET.test(group))) {
    return null
  }

  return groups.map((group) => Number.parseInt(group, 16))
}

/**
 * The burst key of a public route: the address Cloudflare's edge sets in
 * CF-Connecting-IP (it overwrites any value the client sends), never
 * X-Forwarded-For or another header the client controls.
 *
 * - IPv4: the address.
 * - IPv6: its /64 prefix, because one subscriber usually holds a whole /64
 *   and could otherwise rotate through it; an IPv4-mapped address counts as
 *   its IPv4 address.
 * - Missing or malformed (only outside Cloudflare's edge): one shared key,
 *   so leaving the header out never earns a fresh allowance.
 */
export function connectingIpKey(request: Request): string {
  const address = request.headers.get('CF-Connecting-IP')?.trim() ?? ''

  if (IPV4_ADDRESS.test(address)) {
    return `ip4:${address}`
  }

  const hextets = ipv6Hextets(address)

  if (!hextets) {
    return 'ip:unknown'
  }

  const [h0, h1, h2, h3, h4, h5, h6 = 0, h7 = 0] = hextets

  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return `ip4:${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`
  }

  return `ip6:${hextets
    .slice(0, 4)
    .map((hextet) => hextet.toString(16))
    .join(':')}::/64`
}

/**
 * 429 for a burst (the default Retry-After, one binding period) or a
 * windowed cap (its windowSeconds). Retry-After is a whole number of
 * seconds from 1 to the longest window; anything else is a programming
 * error and throws.
 */
export function rateLimitedResponse(
  retryAfterSeconds: number = BURST_PERIOD_SECONDS,
): Response {
  if (
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    retryAfterSeconds > LONGEST_LIMIT_WINDOW_SECONDS
  ) {
    throw new RangeError(
      `Retry-After must be 1 to ${LONGEST_LIMIT_WINDOW_SECONDS} whole seconds.`,
    )
  }

  return errorResponse(
    429,
    'RATE_LIMITED',
    'طلبات كثيرة خلال وقت قصير. حاولي مرة أخرى بعد قليل.',
    {
      'Retry-After': String(retryAfterSeconds),
    },
  )
}

/**
 * The plan's 409 for the open-request cap (OPEN_BOOKING_REQUESTS_MAX in
 * shared/limits.ts, counted inside the booking INSERT). Not wired yet: until
 * W2-16 the Worker still answers Wave 0's 409 TOO_MANY_OPEN_REQUESTS
 * (tooManyOpenRequestsResponse in worker/bookings.ts), because the booking
 * form (src/api/bookings.ts) accepts only that code and reads any other as a
 * malformed answer. W2-16 switches worker/bookings.ts conflictResponse to
 * this helper and teaches src/api/bookings.ts OPEN_REQUEST_LIMIT in the same
 * change, never one without the other.
 */
export function openRequestLimitResponse(): Response {
  return errorResponse(
    409,
    'OPEN_REQUEST_LIMIT',
    'لديكِ ثلاثة طلبات مفتوحة. انتظري الرد عليها قبل إرسال طلب جديد.',
  )
}
