import { describe, expect, it } from 'vitest'
import {
  INITIAL_NARRATION,
  NARRATION_MIN_INTERVAL_MS,
  NarrationLimiter,
  buildNarration,
  dominantThrottleCause,
  type NarrationInput,
} from './narration'

function input(patch: Partial<NarrationInput> = {}): NarrationInput {
  return {
    timeMs: 1_000,
    trafficRunning: true,
    clockRunning: true,
    totalEnvironments: 0,
    initialising: 0,
    running: 0,
    warmIdle: 0,
    provisionedIdle: 0,
    provisionedStatus: 'DISABLED',
    provisionedProgress: 0,
    provisionedRequested: 0,
    provisionedAllocated: 0,
    recentThrottleTotal: 0,
    recentThrottlesByCause: {
      RPS_CEILING: 0,
      RESERVED_CONCURRENCY: 0,
      ACCOUNT_CONCURRENCY: 0,
      SCALING_RATE: 0,
    },
    invocations: 0,
    provisionedInvocations: 0,
    spilloverInvocations: 0,
    coldStarts: 0,
    ...patch,
  }
}

describe('dominant throttle cause', () => {
  it('picks the most frequent primary cause', () => {
    const cause = dominantThrottleCause({ RPS_CEILING: 3, SCALING_RATE: 40 })
    expect(cause).toBe('SCALING_RATE')
  })

  it('breaks a tie with the documented precedence', () => {
    const cause = dominantThrottleCause({
      RPS_CEILING: 5,
      RESERVED_CONCURRENCY: 5,
      ACCOUNT_CONCURRENCY: 5,
      SCALING_RATE: 5,
    })
    expect(cause).toBe('RPS_CEILING')
  })

  it('returns null when nothing was rejected', () => {
    expect(dominantThrottleCause({})).toBeNull()
  })
})

describe('buildNarration', () => {
  it('leads with the dominant throttle cause and never names an environment', () => {
    const text = buildNarration(
      input({
        recentThrottleTotal: 12_345,
        recentThrottlesByCause: {
          RPS_CEILING: 12_000,
          RESERVED_CONCURRENCY: 0,
          ACCOUNT_CONCURRENCY: 300,
          SCALING_RATE: 45,
        },
      }),
    )
    expect(text).toContain('429')
    expect(text).toContain('request-rate ceiling')
    expect(text).toContain('12,345 rejections')
    expect(text).not.toMatch(/E-\d|P-\d/)
  })

  it('mentions spillover while provisioned capacity is overflowing', () => {
    const previous = input({ spilloverInvocations: 10, provisionedStatus: 'READY' })
    const text = buildNarration(
      input({ spilloverInvocations: 25, provisionedStatus: 'READY' }),
      previous,
    )
    expect(text).toContain('spilled into on-demand capacity')
  })

  it('explains that a preparing allocation cannot serve traffic yet', () => {
    const text = buildNarration(
      input({ provisionedStatus: 'PREPARING', provisionedProgress: 0.5, provisionedRequested: 400 }),
    )
    expect(text).toContain('PREPARING')
    expect(text).toContain('50 percent')
    expect(text).toContain('400')
  })

  it('credits provisioned capacity when it served requests with no cold start', () => {
    const previous = input({ provisionedStatus: 'READY', provisionedInvocations: 100 })
    const text = buildNarration(
      input({ provisionedStatus: 'READY', provisionedInvocations: 140, provisionedIdle: 260 }),
      previous,
    )
    expect(text).toContain('no cold start')
  })

  it('explains a cold start when an environment is initialising', () => {
    const text = buildNarration(input({ initialising: 3, totalEnvironments: 3 }))
    expect(text).toContain('Init')
  })

  it('explains warm reuse when invocations grow with no new cold start', () => {
    const previous = input({ invocations: 100, warmIdle: 5, totalEnvironments: 5 })
    const text = buildNarration(input({ invocations: 140, warmIdle: 5, totalEnvironments: 5 }), previous)
    expect(text).toContain('skipped Init')
  })

  it('describes the state after traffic stops', () => {
    const text = buildNarration(input({ trafficRunning: false, totalEnvironments: 6, warmIdle: 6 }))
    expect(text).toContain('Traffic is stopped')
    expect(text).toContain('idle timeout')
  })

  it('falls back to the opening line on a pristine run', () => {
    const text = buildNarration(input({ timeMs: 0, trafficRunning: false, clockRunning: false }))
    expect(text).toBe(INITIAL_NARRATION)
  })

  it('ignores a previous sample from the future, which a reset would produce', () => {
    const stale = input({ timeMs: 90_000, spilloverInvocations: 0 })
    const text = buildNarration(input({ timeMs: 0, trafficRunning: false, clockRunning: false }), stale)
    expect(text).toBe(INITIAL_NARRATION)
  })

  it('writes no em dash or en dash', () => {
    const samples = [
      buildNarration(input({ recentThrottleTotal: 5, recentThrottlesByCause: { RPS_CEILING: 0, RESERVED_CONCURRENCY: 5, ACCOUNT_CONCURRENCY: 0, SCALING_RATE: 0 } })),
      buildNarration(input({ provisionedStatus: 'PREPARING', provisionedRequested: 10 })),
      buildNarration(input({ trafficRunning: false, totalEnvironments: 2 })),
      INITIAL_NARRATION,
    ]
    for (const sample of samples) expect(sample).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('NarrationLimiter', () => {
  it('announces at most once per interval of real time', () => {
    const limiter = new NarrationLimiter(NARRATION_MIN_INTERVAL_MS, 'first')
    expect(limiter.next('second', 0)).toBe('second')
    expect(limiter.next('third', 500)).toBe('second')
    expect(limiter.next('third', 1_100)).toBe('second')
    expect(limiter.next('third', 1_200)).toBe('third')
  })

  it('does not spend the interval on an unchanged sentence', () => {
    const limiter = new NarrationLimiter(1_200, 'same')
    expect(limiter.next('same', 0)).toBe('same')
    expect(limiter.next('next', 10)).toBe('next')
  })

  it('clears its history on reset, so a new run announces at once', () => {
    const limiter = new NarrationLimiter(1_200, 'first')
    limiter.next('second', 0)
    limiter.reset('fresh')
    expect(limiter.current).toBe('fresh')
    expect(limiter.next('after reset', 10)).toBe('after reset')
  })
})
