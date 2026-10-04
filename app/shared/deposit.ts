/**
 * The deposit rule and its arithmetic (plan 11 §2.2 settings_revisions,
 * §3.3 #30 PUT deposit; decision D4). Shared by the Worker, which snapshots
 * the result into booking_requests.deposit_amount when the admin approves a
 * flow-2 request, and the SPA, which shows the same number as a live example
 * next to the rule. Pure functions: no I/O, no logging.
 *
 * Money is whole Saudi riyals held in safe integers from end to end: no
 * value is ever divided into a fraction, so no floating-point rounding can
 * move a riyal.
 */

export const DEPOSIT_KINDS = ['fixed', 'percent'] as const

export type DepositKind = (typeof DEPOSIT_KINDS)[number]

/** The rounding steps settings_revisions.deposit_round_to accepts. */
export const DEPOSIT_ROUND_TO_VALUES = [1, 5, 10, 50, 100] as const

export type DepositRoundTo = (typeof DEPOSIT_ROUND_TO_VALUES)[number]

/** settings_revisions.deposit_fixed_amount: BETWEEN 1 AND 1000000. */
export const MINIMUM_DEPOSIT_FIXED_AMOUNT = 1
export const MAXIMUM_DEPOSIT_FIXED_AMOUNT = 1_000_000

/** settings_revisions.deposit_percent: BETWEEN 1 AND 100. */
export const MINIMUM_DEPOSIT_PERCENT = 1
export const MAXIMUM_DEPOSIT_PERCENT = 100

/**
 * The largest booking total computeDeposit accepts, in riyals. Far above any
 * package total, and small enough that total × 100 stays an exact integer.
 */
export const MAXIMUM_DEPOSIT_BASE_TOTAL = 10_000_000

export type DepositRule =
  | {
      readonly kind: 'fixed'
      readonly fixedAmount: number
      readonly roundTo: DepositRoundTo
    }
  | {
      readonly kind: 'percent'
      readonly percent: number
      readonly roundTo: DepositRoundTo
    }

function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

export function isDepositRoundTo(value: unknown): value is DepositRoundTo {
  return DEPOSIT_ROUND_TO_VALUES.some((step) => step === value)
}

/**
 * True for a rule within the bounds of the settings_revisions CHECKs. Also
 * re-checks a value typed as a rule, since one built from a D1 row or a
 * request body is only as good as the guard that built it.
 */
export function isDepositRule(value: DepositRule): boolean {
  if (!isDepositRoundTo(value.roundTo)) {
    return false
  }

  if (value.kind === 'fixed') {
    return isIntegerBetween(
      value.fixedAmount,
      MINIMUM_DEPOSIT_FIXED_AMOUNT,
      MAXIMUM_DEPOSIT_FIXED_AMOUNT,
    )
  }

  if (value.kind === 'percent') {
    return isIntegerBetween(
      value.percent,
      MINIMUM_DEPOSIT_PERCENT,
      MAXIMUM_DEPOSIT_PERCENT,
    )
  }

  return false
}

/**
 * ⌈dividend / divisor⌉ for a non-negative safe-integer dividend and a
 * positive divisor. The one division is exact: `dividend - remainder` is a
 * multiple of `divisor`.
 */
function ceilDivide(dividend: number, divisor: number): number {
  const remainder = dividend % divisor

  return (dividend - remainder) / divisor + (remainder === 0 ? 0 : 1)
}

/** The smallest multiple of `step` that is at least `amount`. */
function roundUpToStep(amount: number, step: number): number {
  return ceilDivide(amount, step) * step
}

/**
 * The deposit, in riyals, that `rule` asks for on a booking whose estimated
 * total is `estimatedTotal`:
 * 1. the fixed amount, or the percentage of the total rounded up to a whole
 *    riyal;
 * 2. rounded up to the next multiple of `roundTo` (the spec's default is
 *    "20% rounded up to the next SAR 50");
 * 3. never more than the total (booking_requests.deposit_amount is BETWEEN 0
 *    AND estimated_total).
 *
 * Worked examples:
 * - 20% of 6,500, roundTo 50: 1,300 → 1,300.
 * - 20% of 4,800, roundTo 50: 960 → 1,000.
 * - 15% of 3,333, roundTo 1: 499.95 → 500.
 * - 30% of 2,850, roundTo 100: 855 → 900.
 * - fixed 1,000 on a total of 6,500: 1,000; on a total of 800: 800.
 * - fixed 1,025, roundTo 50: 1,050.
 * - 100% of 1,020, roundTo 50: 1,050 → capped at 1,020.
 * - any rule on a total of 0: 0.
 *
 * Throws a RangeError for a rule outside the CHECK bounds or a total that
 * is not an integer in [0, MAXIMUM_DEPOSIT_BASE_TOTAL]: a corrupt rule or
 * total must fail the request, never produce a deposit.
 */
export function computeDeposit(
  rule: DepositRule,
  estimatedTotal: number,
): number {
  if (!isDepositRule(rule)) {
    throw new RangeError('Invalid deposit rule')
  }

  if (!isIntegerBetween(estimatedTotal, 0, MAXIMUM_DEPOSIT_BASE_TOTAL)) {
    throw new RangeError('Invalid deposit base total')
  }

  const baseAmount =
    rule.kind === 'fixed'
      ? rule.fixedAmount
      : ceilDivide(estimatedTotal * rule.percent, 100)

  return Math.min(roundUpToStep(baseAmount, rule.roundTo), estimatedTotal)
}
