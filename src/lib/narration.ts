/**
 * Plain-language narration for the live aria-live region.
 *
 * The narration is derived from aggregate snapshot state rather than from
 * individual request events, so a run at 30,000 requests per second reads the
 * same way as a run at 5. Environment identifiers are only mentioned when a
 * single environment genuinely is the whole story, which keeps the polite
 * announcement free of identifier spam.
 *
 * This module is pure. It reads no clock and touches no browser global, so the
 * simulation worker and the main thread can both use it.
 */

export type NarrationThrottleCause =
  | 'RPS_CEILING'
  | 'RESERVED_CONCURRENCY'
  | 'ACCOUNT_CONCURRENCY'
  | 'SCALING_RATE'

/** Announce at most once per this many milliseconds of real, wall clock time. */
export const NARRATION_MIN_INTERVAL_MS = 1200

export const INITIAL_NARRATION =
  'Set a workload, then start traffic to watch Lambda capacity respond.'

const CAUSE_PRECEDENCE: readonly NarrationThrottleCause[] = [
  'RPS_CEILING',
  'RESERVED_CONCURRENCY',
  'ACCOUNT_CONCURRENCY',
  'SCALING_RATE',
]

const CAUSE_PHRASES: Record<NarrationThrottleCause, string> = {
  RPS_CEILING: 'the synchronous request-rate ceiling has been reached',
  RESERVED_CONCURRENCY: 'the function reached its reserved concurrency',
  ACCOUNT_CONCURRENCY: 'the account concurrency quota is fully in use',
  SCALING_RATE: 'the function cannot add on-demand capacity any faster right now',
}

/**
 * Everything the narration needs, flattened. The caller derives this from a
 * simulation snapshot so this module stays independent of the engine types.
 */
export interface NarrationInput {
  timeMs: number
  trafficRunning: boolean
  clockRunning: boolean
  totalEnvironments: number
  initialising: number
  running: number
  warmIdle: number
  provisionedIdle: number
  provisionedStatus: string
  /** Allocation progress from 0 to 1 while PREPARING. */
  provisionedProgress: number
  provisionedRequested: number
  provisionedAllocated: number
  /** Throttles counted in the recent throttle window. */
  recentThrottleTotal: number
  /** Primary causes in the recent window, keyed by cause. */
  recentThrottlesByCause: Record<NarrationThrottleCause, number>
  invocations: number
  provisionedInvocations: number
  spilloverInvocations: number
  coldStarts: number
}

/** Group thousands without relying on a host locale, so tests stay stable. */
function groupThousands(value: number): string {
  const rounded = Math.round(value)
  const sign = rounded < 0 ? '-' : ''
  const digits = String(Math.abs(rounded))
  let out = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ','
    out += digits[index]
  }
  return sign + out
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${groupThousands(count)} ${count === 1 ? singular : plural}`
}

/**
 * The dominant primary cause is the most frequent one in the recent window.
 * Ties resolve through the documented primary-cause precedence, so the same
 * simulation always produces the same sentence.
 */
export function dominantThrottleCause(
  byCause: Partial<Record<NarrationThrottleCause, number>>,
): NarrationThrottleCause | null {
  let winner: NarrationThrottleCause | null = null
  let best = 0
  for (const cause of CAUSE_PRECEDENCE) {
    const count = byCause[cause] ?? 0
    if (count > best) {
      best = count
      winner = cause
    }
  }
  return winner
}

function delta(current: number, previous: NarrationInput | null, pick: (input: NarrationInput) => number): number {
  if (!previous) return 0
  return Math.max(0, current - pick(previous))
}

/**
 * Build one narration sentence pair for the current snapshot. `previous` is the
 * input used for the last announcement, which lets counter-based situations such
 * as spillover be described only while they are actually happening.
 */
export function buildNarration(input: NarrationInput, previous: NarrationInput | null = null): string {
  const earlier = previous && previous.timeMs <= input.timeMs ? previous : null
  const spilloverDelta = delta(input.spilloverInvocations, earlier, (item) => item.spilloverInvocations)
  const provisionedDelta = delta(input.provisionedInvocations, earlier, (item) => item.provisionedInvocations)
  const coldStartDelta = delta(input.coldStarts, earlier, (item) => item.coldStarts)
  const invocationDelta = delta(input.invocations, earlier, (item) => item.invocations)

  const cause = dominantThrottleCause(input.recentThrottlesByCause)
  if (input.recentThrottleTotal > 0 && cause) {
    const detail = `Rejected with 429: ${CAUSE_PHRASES[cause]}.`
    const scale = `That is the dominant cause of ${pluralize(input.recentThrottleTotal, 'rejection', 'rejections')} in the recent window.`
    return `${detail} ${scale}`
  }

  if (spilloverDelta > 0) {
    return 'Provisioned capacity is full, so requests spilled into on-demand capacity and can cold start.'
  }

  if (input.provisionedStatus === 'PREPARING') {
    const percent = Math.max(0, Math.min(100, Math.round(input.provisionedProgress * 100)))
    return `Provisioned allocation is PREPARING, about ${percent} percent through. None of the ${groupThousands(input.provisionedRequested)} requested environments can serve traffic until the whole allocation is READY, so traffic uses on-demand capacity.`
  }

  if (provisionedDelta > 0 && coldStartDelta === 0) {
    return `Provisioned capacity handled ${pluralize(provisionedDelta, 'request', 'requests')} with no cold start.`
  }

  if (coldStartDelta > 0 || input.initialising > 0) {
    return 'All environments were busy, so Lambda created another one. It must finish Init before running the request.'
  }

  if (invocationDelta > 0 && input.warmIdle + input.running > 0) {
    return 'A warm environment was free, so these requests skipped Init.'
  }

  if (!input.trafficRunning && input.totalEnvironments > 0) {
    return 'Traffic is stopped. In-flight requests finish, then warm environments stay reusable until the illustrative idle timeout retires them.'
  }

  if (input.trafficRunning && input.totalEnvironments === 0) {
    return 'Traffic is running at zero offered requests per second, so no environment is needed yet.'
  }

  if (!input.clockRunning && input.timeMs === 0) return INITIAL_NARRATION

  if (input.provisionedIdle > 0 && input.running === 0) {
    return `Provisioned capacity is READY with ${pluralize(input.provisionedIdle, 'idle environment', 'idle environments')} waiting. It is billed while allocated, even at zero traffic.`
  }

  return INITIAL_NARRATION
}

/**
 * Real time rate limiter for the polite announcement. At 4x speed the engine
 * produces four simulated seconds per real second, so limiting by simulated
 * time would still flood a screen reader. This limits by wall clock instead.
 */
export class NarrationLimiter {
  private announced: string
  private announcedAtMs: number | null = null

  constructor(
    private readonly minIntervalMs: number = NARRATION_MIN_INTERVAL_MS,
    initial: string = INITIAL_NARRATION,
  ) {
    this.announced = initial
  }

  get current(): string {
    return this.announced
  }

  /** Return the text that should be live right now, given the real clock. */
  next(candidate: string, nowMs: number): string {
    if (candidate === this.announced) return this.announced
    if (this.announcedAtMs !== null && nowMs - this.announcedAtMs < this.minIntervalMs) {
      return this.announced
    }
    this.announced = candidate
    this.announcedAtMs = nowMs
    return this.announced
  }

  reset(initial: string = INITIAL_NARRATION): void {
    this.announced = initial
    this.announcedAtMs = null
  }
}
