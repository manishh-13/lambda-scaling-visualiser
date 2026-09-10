import { describe, expect, it } from 'vitest'
import {
  advanceSimulation, cloneSnapshotBytes, createSimulation, getSnapshot, setTrafficRate, startTraffic, stopTraffic,
  type SimulationState,
} from './engine'
import { capacityBlockers, rateOpportunity, refillScalingBucket, scalingExpansionCost } from './admission'
import { appendRing, createRing, EventQueue, IdlePool, readRing } from './collections'
import { createPrng, nextIntInclusive } from './prng'
import { normalizeConfig, type SimulationConfig } from './types'

function simulation(patch: Partial<SimulationConfig> = {}, seed = 17): SimulationState {
  return createSimulation({ idleTimeoutMs: 15_000, ...patch }, seed)
}

function run(patch: Partial<SimulationConfig>, milliseconds: number): SimulationState {
  const state = simulation(patch)
  startTraffic(state)
  advanceSimulation(state, milliseconds)
  return state
}

function ready(patch: Partial<SimulationConfig> = {}): SimulationState {
  const state = simulation({ provisionedConcurrencyEnabled: true, provisionedConcurrency: 400, ...patch })
  advanceSimulation(state, Math.ceil(state.provisioned.readyAtMs! / 50) * 50)
  return state
}

describe('steady concurrency and exact event timing', () => {
  it.each([[100, 1_000, 100], [100, 500, 50], [200, 250, 50]])(
    '%i RPS with a %i ms handler settles at exactly %i concurrent requests', (requestsPerSecond, handlerDurationMs, concurrency) => {
      const snapshot = getSnapshot(run({ requestsPerSecond, handlerDurationMs }, 5_000))
      expect(snapshot.demandedConcurrency).toBe(concurrency)
      expect(snapshot.metrics.concurrentExecutions).toBe(concurrency)
      expect(snapshot.metrics.throttles).toBe(0)
    },
  )

  it('5,000 RPS at 200 ms reaches and sustains the default example quota after cold startup', () => {
    const state = run({ requestsPerSecond: 5_000, handlerDurationMs: 200 }, 10_000)
    const before = getSnapshot(state)
    expect(before.demandedConcurrency).toBe(1_000)
    expect(before.metrics.concurrentExecutions).toBe(1_000)
    expect(before.acceptedRequestsPerSecond).toBe(5_000)
    advanceSimulation(state, 1_000)
    const after = getSnapshot(state)
    expect(after.metrics.concurrentExecutions).toBe(1_000)
    expect(after.metrics.acceptedRequests - before.metrics.acceptedRequests).toBe(5_000)
    for (const event of after.recentThrottleEvents) expect(event.primaryCause).toBe(event.blockers![0])
  })

  it('a 20 ms invocation completes at 45 ms after arrival at 25 ms, never at 50 ms', () => {
    const snapshot = getSnapshot(run({ requestsPerSecond: 40, handlerDurationMs: 20, initDurationMs: 0 }, 50))
    const done = snapshot.recentEvents.find(event => event.type === 'INVOKE_COMPLETED')!
    expect(done.timeMs).toBe(45)
    expect(done.durationMs).toBe(20)
    expect(snapshot.metrics.offeredRequests).toBe(2)
  })

  it('processes Invoke completion before arrival at an identical timestamp', () => {
    const snapshot = getSnapshot(run({ requestsPerSecond: 100, handlerDurationMs: 10, initDurationMs: 0 }, 50))
    const simultaneous = snapshot.recentEvents.filter(event => event.timeMs === 20)
    expect(simultaneous[0].type).toBe('INVOKE_COMPLETED')
    expect(simultaneous[1].type).toBe('REQUEST_ACCEPTED')
    expect(snapshot.onDemandEnvironmentsCreated).toBe(1)
    expect(snapshot.metrics.concurrentExecutions).toBe(1)
  })

  it.each([0.5, 1.25, 7, 123.5, 333.3])('generates fractional %f RPS without tick rounding or a duplicate first arrival', (requestsPerSecond) => {
    const state = run({ requestsPerSecond, handlerDurationMs: 1, initDurationMs: 0 }, 10_000)
    expect(getSnapshot(state).metrics.offeredRequests).toBe(Math.floor(requestsPerSecond * 10 + 1e-9))
  })

  it('rejects malformed elapsed time rather than silently losing partial ticks', () => {
    const state = simulation()
    for (const value of [-1, 20, 9_990, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => advanceSimulation(state, value)).toThrow(RangeError)
    }
    expect(advanceSimulation(state, 0)).toBe(state)
    expect(state.timeMs).toBe(0)
  })
})

describe('synchronous request-rate gates', () => {
  it('30,000 RPS at 20 ms demands 600 but admits 10,000 RPS and 200 concurrent after warmup', () => {
    const state = run({ requestsPerSecond: 30_000, handlerDurationMs: 20 }, 6_000)
    const before = getSnapshot(state)
    advanceSimulation(state, 1_000)
    const after = getSnapshot(state)
    expect(after.demandedConcurrency).toBe(600)
    expect(after.metrics.concurrentExecutions).toBe(200)
    expect(after.metrics.acceptedRequests - before.metrics.acceptedRequests).toBe(10_000)
    expect(after.metrics.throttles - before.metrics.throttles).toBe(20_000)
    expect(after.metrics.throttlesByCause.RPS_CEILING - before.metrics.throttlesByCause.RPS_CEILING).toBe(20_000)
    expect(after.metrics.invocations - before.metrics.invocations).toBe(10_000)
    expect(after.metrics.errors).toBe(0)
    expect(after.metrics.offeredRequests).toBe(after.metrics.acceptedRequests + after.metrics.throttles)
    expect(after.history.slice(-20).every(sample => sample.accepted === 500 && sample.throttled === 1_000)).toBe(true)
  })

  it('spreads admissions within each interval instead of admitting the first 500 together', () => {
    const state = run({ requestsPerSecond: 30_000, handlerDurationMs: 20, initDurationMs: 0 }, 1_000)
    expect(getSnapshot(state).history.slice(-10).map(sample => sample.concurrentExecutions)).toEqual(Array(10).fill(200))
  })

  it('fractional gate carries less than one rounding unit, not unused whole-request allowance', () => {
    const gate = { phase: 0 }
    let granted = 0
    for (let index = 0; index < 1_000; index += 1) {
      if (rateOpportunity(gate, 1_000, 10)) granted += 1
      expect(gate.phase).toBeLessThan(1)
    }
    expect(granted).toBe(10)
    const idle = { phase: 0 }
    expect(rateOpportunity(idle, 0, 10)).toBe(true)
    expect(idle.phase).toBe(0)
  })

  it('RC zero rejects all offers as RPS primary with reserved secondary', () => {
    const snapshot = getSnapshot(run({ requestsPerSecond: 100, reservedConcurrencyEnabled: true, reservedConcurrency: 0 }, 1_000))
    expect(snapshot.metrics.invocations).toBe(0)
    expect(snapshot.totalEnvironments).toBe(0)
    expect(snapshot.metrics.throttles).toBe(100)
    expect(snapshot.recentThrottleEvents.at(-1)?.blockers).toEqual(['RPS_CEILING', 'RESERVED_CONCURRENCY'])
  })
})

describe('shared continuously refilling scaling capacity', () => {
  it('uses max(environment delta, synchronous RPS delta / 10), never their sum', () => {
    expect(scalingExpansionCost(0, 500, 5_000)).toBe(500)
    expect(scalingExpansionCost(1_000, 1_100, 11_000)).toBe(100)
    expect(scalingExpansionCost(1_000, 600, 20_000)).toBe(1_000)
    expect(scalingExpansionCost(1_000, 900, 9_000)).toBe(0)
  })

  it('starts full, permits no more than 100 further units each additional second, and caps idle refill', () => {
    const bucket = { balance: 1_000, lastRefillMs: 0 }
    expect(bucket.balance).toBe(1_000)
    bucket.balance -= 1_000
    refillScalingBucket(bucket, 1_000)
    expect(bucket.balance).toBe(100)
    bucket.balance -= 100
    refillScalingBucket(bucket, 10_000)
    expect(bucket.balance).toBe(900)
    refillScalingBucket(bucket, 60_000)
    expect(bucket.balance).toBe(1_000)
  })

  it('tests exact 9.99 second and 10.01 second boundaries without a strict rolling window', () => {
    const before = { balance: 0, lastRefillMs: 0 }
    refillScalingBucket(before, 9_990)
    expect(before.balance).toBe(999)
    before.balance -= 999
    refillScalingBucket(before, 10_010)
    expect(before.balance).toBe(2)
    const unused = { balance: 0, lastRefillMs: 0 }
    refillScalingBucket(unused, 10_010)
    expect(unused.balance).toBe(1_000)
  })

  it('a 5,000 RPS cold spike remains below 1000 + 100t created environments', () => {
    const state = simulation({ requestsPerSecond: 5_000, handlerDurationMs: 1_000, accountConcurrencyQuota: 10_000 })
    startTraffic(state)
    expect(getSnapshot(state).onDemandEnvironmentsCreated).toBe(0)
    for (let index = 1; index <= 200; index += 1) {
      advanceSimulation(state, 50)
      expect(state.onDemandEnvironmentsCreated).toBeLessThanOrEqual(1_000 + Math.floor(state.timeMs / 10))
      expect(state.bucket.balance).toBeLessThanOrEqual(1_000)
      expect(state.bucket.balance).toBeGreaterThanOrEqual(0)
    }
    const snapshot = getSnapshot(state)
    expect(snapshot.onDemandEnvironmentsCreated).toBeLessThanOrEqual(2_000)
    expect(snapshot.metrics.throttlesByCause.SCALING_RATE).toBeGreaterThan(0)
    expect(snapshot.metrics.throttlesByCause.ACCOUNT_CONCURRENCY).toBe(0)
    expect(snapshot.metrics.throttlesByCause.RPS_CEILING).toBe(0)
  })

  it('retains authorized synchronous-RPS capacity across 50 ms interval boundaries', () => {
    const state = run({ requestsPerSecond: 30_000, handlerDurationMs: 20 }, 50)
    const authorized = state.capacityUnits
    const balance = state.bucket.balance
    advanceSimulation(state, 50)
    expect(state.capacityUnits).toBe(authorized)
    // Exactly five units refill in 50 ms; no duplicate expansion is charged at the new tick boundary.
    expect(state.bucket.balance).toBeCloseTo(Math.min(1_000, balance + 5), 8)
    expect(state.lastExpansionCost).toBe(0)
  })

  it('does not multiply scaling cost by inverse handler duration for every cold environment', () => {
    const state = run({ requestsPerSecond: 30_000, handlerDurationMs: 20 }, 100)
    const snapshot = getSnapshot(state)
    expect(snapshot.metrics.acceptedRequests).toBe(1_000)
    expect(snapshot.metrics.throttlesByCause.SCALING_RATE).toBe(0)
    expect(snapshot.onDemandEnvironmentsCreated).toBe(1_000)
    expect(snapshot.scaling.capacityUnits).toBe(1_000)
  })
})

describe('provisioned and reserved capacity accounting', () => {
  it('makes all provisioned environments ready atomically after seeded delay and exact allocation throughput', () => {
    const state = simulation({ provisionedConcurrencyEnabled: true, provisionedConcurrency: 400 })
    expect(state.provisioned.preparationDelayMs).toBeGreaterThanOrEqual(60_000)
    expect(state.provisioned.preparationDelayMs).toBeLessThanOrEqual(120_000)
    expect(state.provisioned.allocationDurationMs).toBe(4_000)
    const justBefore = Math.floor((state.provisioned.readyAtMs! - 1) / 50) * 50
    advanceSimulation(state, justBefore)
    expect(state.provisioned.status).toBe('PREPARING')
    expect(state.provisioned.allocated).toBeLessThan(400)
    expect(state.provisioned.ready).toBe(0)
    expect(getSnapshot(state).environments.filter(environment => environment.kind === 'PROVISIONED')).toHaveLength(0)
    advanceSimulation(state, 50)
    const snapshot = getSnapshot(state)
    expect(snapshot.provisioned.ready).toBe(400)
    expect(snapshot.provisioned.allocated).toBe(400)
    expect(snapshot.environmentCounts.provisionedIdle).toBe(400)
    expect(snapshot.metrics.concurrentExecutions).toBe(0)
    expect(snapshot.quotaOccupancy).toBe(400)
    expect(snapshot.recentEvents.find(event => event.type === 'PROVISIONED_READY')?.timeMs).toBe(snapshot.provisioned.readyAtMs)
  })

  it('counts allocated PC only once with concurrent OD, even while PC is idle', () => {
    const state = ready({ requestsPerSecond: 4_000, handlerDurationMs: 10_000 })
    startTraffic(state)
    advanceSimulation(state, 100)
    let snapshot = getSnapshot(state)
    expect(snapshot.metrics.concurrentExecutions).toBe(400)
    expect(snapshot.metrics.provisionedConcurrencyInvocations).toBe(400)
    expect(snapshot.metrics.coldStarts).toBe(0)
    advanceSimulation(state, 150)
    snapshot = getSnapshot(state)
    expect(snapshot.metrics.acceptedRequests).toBe(1_000)
    expect(snapshot.metrics.concurrentExecutions).toBe(1_000)
    expect(snapshot.totalEnvironments).toBe(1_000)
    expect(snapshot.onDemandConcurrentExecutions).toBe(600)
    expect(snapshot.metrics.coldStarts).toBe(600)
    expect(snapshot.quotaOccupancy).toBe(1_000)
    advanceSimulation(state, 50)
    snapshot = getSnapshot(state)
    expect(snapshot.metrics.throttlesByCause.ACCOUNT_CONCURRENCY).toBe(200)
    stopTraffic(state)
    advanceSimulation(state, 400)
    expect(getSnapshot(state).metrics.provisionedConcurrencySpilloverInvocations).toBe(600)
  })

  it('first 400 requests use PC and request 401 spills without altering arrival timestamps', () => {
    const state = ready({ requestsPerSecond: 4_000, handlerDurationMs: 1_000 })
    startTraffic(state)
    advanceSimulation(state, 100)
    expect(getSnapshot(state).metrics.provisionedConcurrencyInvocations).toBe(400)
    advanceSimulation(state, 50)
    const snapshot = getSnapshot(state)
    expect(snapshot.metrics.acceptedRequests).toBe(600)
    expect(snapshot.onDemandConcurrentExecutions).toBe(200)
    expect(snapshot.metrics.coldStarts).toBe(200)
  })

  it('serves PREPARING traffic on demand while reserving configured PC headroom', () => {
    const snapshot = getSnapshot(run({ requestsPerSecond: 1_000, handlerDurationMs: 10_000, provisionedConcurrencyEnabled: true, provisionedConcurrency: 400 }, 1_000))
    expect(snapshot.provisioned.status).toBe('PREPARING')
    expect(snapshot.metrics.concurrentExecutions).toBe(600)
    expect(snapshot.quotaOccupancy).toBe(1_000)
    expect(snapshot.metrics.provisionedConcurrencyInvocations).toBe(0)
    expect(snapshot.metrics.provisionedConcurrencySpilloverInvocations).toBe(0)
    expect(snapshot.metrics.throttlesByCause.ACCOUNT_CONCURRENCY).toBe(400)
  })

  it('spills at aggregate provisioned RPS even when PC has idle environments', () => {
    const state = ready({ requestsPerSecond: 8_000, handlerDurationMs: 20, initDurationMs: 0 })
    startTraffic(state)
    advanceSimulation(state, 1_000)
    const snapshot = getSnapshot(state)
    expect(snapshot.metrics.provisionedConcurrencyInvocations).toBe(4_000)
    expect(snapshot.metrics.provisionedConcurrencySpilloverInvocations).toBe(4_000)
    expect(snapshot.environmentCounts.provisionedIdle).toBe(320)
    expect(snapshot.metrics.concurrentExecutions).toBe(160)
    expect(snapshot.quotaOccupancy).toBe(480)
  })

  it('caps on-demand spill when unused PC still occupies account units', () => {
    const state = ready({ provisionedConcurrency: 900, requestsPerSecond: 10_000, handlerDurationMs: 1_000, initDurationMs: 0 })
    startTraffic(state)
    advanceSimulation(state, 200)
    const snapshot = getSnapshot(state)
    expect(snapshot.onDemandConcurrentExecutions).toBe(100)
    expect(snapshot.quotaOccupancy).toBe(1_000)
    expect(snapshot.metrics.concurrentExecutions).toBe(1_000)
  })

  it('reserved 400 rejects request 401 without borrowing the other 600 account units', () => {
    const state = run({ requestsPerSecond: 1_000, handlerDurationMs: 10_000, reservedConcurrencyEnabled: true, reservedConcurrency: 400 }, 400)
    expect(getSnapshot(state).metrics.concurrentExecutions).toBe(400)
    advanceSimulation(state, 50)
    const snapshot = getSnapshot(state)
    expect(snapshot.metrics.throttles).toBe(50)
    expect(snapshot.recentThrottleEvents.at(-1)?.primaryCause).toBe('RESERVED_CONCURRENCY')
    expect(snapshot.metrics.throttlesByCause.RPS_CEILING).toBe(0)
  })

  it('uses the same concurrency admission kernel for simultaneous capacity boundaries', () => {
    const base = { concurrent: 999, onDemandConcurrent: 599, provisionedAllocated: 400, usesProvisioned: false, accountQuota: 1_000, reserved: null, scalingCost: 1, scalingTokens: 100, rpsBlocked: false }
    expect(capacityBlockers(base)).toEqual([])
    expect(capacityBlockers({ ...base, concurrent: 1_000, onDemandConcurrent: 600 })).toEqual(['ACCOUNT_CONCURRENCY'])
    expect(capacityBlockers({ ...base, concurrent: 400, onDemandConcurrent: 400, provisionedAllocated: 0, reserved: 400 })).toEqual(['RESERVED_CONCURRENCY'])
  })

  it('applies all blockers and primary precedence without charging rejected requests', () => {
    expect(capacityBlockers({ concurrent: 1_000, onDemandConcurrent: 1_000, provisionedAllocated: 0, usesProvisioned: false, accountQuota: 1_000, reserved: 400, scalingCost: 1, scalingTokens: 0, rpsBlocked: true })).toEqual(['RPS_CEILING', 'RESERVED_CONCURRENCY', 'ACCOUNT_CONCURRENCY', 'SCALING_RATE'])
    const state = run({ requestsPerSecond: 30_000, handlerDurationMs: 10_000 }, 500)
    const snapshot = getSnapshot(state)
    expect(snapshot.recentThrottleEvents.some(event => event.blockers!.length > 1)).toBe(true)
    expect(snapshot.totalEnvironments).toBe(snapshot.metrics.acceptedRequests)
    expect(snapshot.metrics.errors).toBe(0)
  })
})

describe('metric timing, lifecycle, and bounded memory', () => {
  it('Init consumes concurrency, Invoke counts once, Duration is recorded only on completion', () => {
    const state = run({ requestsPerSecond: 20, handlerDurationMs: 20, initDurationMs: 400 }, 50)
    stopTraffic(state)
    let snapshot = getSnapshot(state)
    expect(snapshot.metrics.concurrentExecutions).toBe(1)
    expect(snapshot.metrics.acceptedRequests).toBe(1)
    expect(snapshot.metrics.invocations).toBe(0)
    expect(snapshot.metrics.durationSamples).toBe(0)
    advanceSimulation(state, 400)
    snapshot = getSnapshot(state)
    expect(snapshot.metrics.invocations).toBe(1)
    expect(snapshot.metrics.durationSamples).toBe(0)
    advanceSimulation(state, 50)
    snapshot = getSnapshot(state)
    expect(snapshot.metrics.concurrentExecutions).toBe(0)
    expect(snapshot.metrics.durationAverageMs).toBe(20)
    expect(snapshot.metrics.durationSamples).toBe(1)
  })

  it('Stop drains in-flight requests, restart reuses warm capacity, then retirement removes it', () => {
    const state = run({ requestsPerSecond: 20, handlerDurationMs: 20, initDurationMs: 0, idleTimeoutMs: 1_000, retiringDurationMs: 400 }, 50)
    stopTraffic(state)
    advanceSimulation(state, 50)
    expect(getSnapshot(state).warmIdleEnvironments).toBe(1)
    startTraffic(state)
    advanceSimulation(state, 50)
    stopTraffic(state)
    expect(getSnapshot(state).metrics.coldStarts).toBe(1)
    advanceSimulation(state, 1_050)
    expect(getSnapshot(state).environmentCounts.retiring).toBe(1)
    advanceSimulation(state, 400)
    expect(getSnapshot(state).totalEnvironments).toBe(0)
  })

  it('retiring capacity retires its proportional RPS footprint, not only one flat unit', () => {
    const state = run({ requestsPerSecond: 10_000, handlerDurationMs: 20, initDurationMs: 0, idleTimeoutMs: 1_000 }, 100)
    const unitsPerEnvironment = state.capacityUnits / state.onDemandUsable
    expect(unitsPerEnvironment).toBeGreaterThan(1)
    stopTraffic(state)
    advanceSimulation(state, 1_000)
    expect(state.onDemandUsable).toBeGreaterThan(0)
    expect(state.capacityUnits).toBeCloseTo(unitsPerEnvironment * state.onDemandUsable, 7)
    advanceSimulation(state, 100)
    expect(state.capacityUnits).toBe(0)
  })

  it('provisioned environments do not retire on the illustrative idle timeout', () => {
    const state = ready({ idleTimeoutMs: 1_000 })
    advanceSimulation(state, 10_000)
    const snapshot = getSnapshot(state)
    expect(snapshot.environmentCounts.provisionedIdle).toBe(400)
    expect(snapshot.metrics.concurrentExecutions).toBe(0)
  })

  it('purges throttles outside last 10 seconds while preserving lifetime totals', () => {
    const state = run({ requestsPerSecond: 1_000, reservedConcurrencyEnabled: true, reservedConcurrency: 0 }, 500)
    stopTraffic(state)
    advanceSimulation(state, 10_000)
    const snapshot = getSnapshot(state)
    expect(snapshot.metrics.throttles).toBe(500)
    expect(snapshot.recentThrottles.total).toBe(0)
    expect(snapshot.recentThrottleEvents).toEqual([])
  })

  it('bounds event history, timeline, environment histories and active idle timers under warm reuse', () => {
    const state = run({ requestsPerSecond: 1_000, handlerDurationMs: 10, initDurationMs: 0, idleTimeoutMs: 3_600_000 }, 35_000)
    const snapshot = getSnapshot(state)
    expect(snapshot.metrics.invocations).toBe(35_000)
    expect(snapshot.recentEvents.length).toBeLessThanOrEqual(200)
    expect(snapshot.history.length).toBe(600)
    expect(snapshot.environments.every(environment => environment.history.length <= 8)).toBe(true)
    expect(state.queue.size).toBeLessThanOrEqual(state.environments.size + 1)
  })

  it('snapshots cannot mutate the running simulation', () => {
    const state = run({ requestsPerSecond: 20 }, 100)
    const bytes = cloneSnapshotBytes(state)
    const snapshot = getSnapshot(state)
    snapshot.config.requestsPerSecond = 10_000
    snapshot.metrics.invocations = -100
    snapshot.environments[0].history.length = 0
    snapshot.history[0].environments.running = -1
    expect(cloneSnapshotBytes(state)).toBe(bytes)
  })
})

describe('seeded reproducibility and configuration validation', () => {
  it('identical seed, commands, and ticks produce identical snapshots and event streams at every tick', () => {
    const one = simulation({ requestsPerSecond: 123.5, provisionedConcurrencyEnabled: true, provisionedConcurrency: 20 }, 42)
    const two = simulation({ requestsPerSecond: 123.5, provisionedConcurrencyEnabled: true, provisionedConcurrency: 20 }, 42)
    startTraffic(one); startTraffic(two)
    for (let tick = 0; tick < 150; tick += 1) {
      if (tick === 50) { stopTraffic(one); stopTraffic(two) }
      if (tick === 100) { startTraffic(one); startTraffic(two) }
      advanceSimulation(one, 50); advanceSimulation(two, 50)
      expect(cloneSnapshotBytes(one)).toBe(cloneSnapshotBytes(two))
    }
  })

  it('batched fixed steps match individual tick advancement exactly', () => {
    const one = simulation({ requestsPerSecond: 77.5 })
    const two = simulation({ requestsPerSecond: 77.5 })
    startTraffic(one); startTraffic(two)
    advanceSimulation(one, 1_000)
    for (let index = 0; index < 20; index += 1) advanceSimulation(two, 50)
    expect(cloneSnapshotBytes(one)).toBe(cloneSnapshotBytes(two))
  })

  it('seed changes only the documented random preparation choice, not requests or lifecycle rules', () => {
    const one = simulation({ provisionedConcurrencyEnabled: true, provisionedConcurrency: 20 }, 1)
    const two = simulation({ provisionedConcurrencyEnabled: true, provisionedConcurrency: 20 }, 2)
    expect(one.provisioned.preparationDelayMs).not.toBe(two.provisioned.preparationDelayMs)
    startTraffic(one); startTraffic(two)
    advanceSimulation(one, 5_000); advanceSimulation(two, 5_000)
    expect(getSnapshot(one).metrics).toEqual(getSnapshot(two).metrics)
    expect(getSnapshot(one).environments).toEqual(getSnapshot(two).environments)
  })

  it('explicit rate changes reset arrival epoch, not request identities or counters', () => {
    const state = run({ requestsPerSecond: 100 }, 1_000)
    setTrafficRate(state, 50)
    advanceSimulation(state, 1_000)
    expect(getSnapshot(state).metrics.offeredRequests).toBe(150)
  })

  it('uses the seeded PRNG reproducibly including a zero seed', () => {
    const first = createPrng(0)
    const second = createPrng(0)
    for (let index = 0; index < 100; index += 1) expect(nextIntInclusive(first, 60_000, 120_000)).toBe(nextIntInclusive(second, 60_000, 120_000))
  })

  it('enforces quota headroom, RC caps, and $LATEST restrictions', () => {
    expect(normalizeConfig({ accountConcurrencyQuota: 1_000, reservedConcurrencyEnabled: true, reservedConcurrency: 10_000 }).reservedConcurrency).toBe(900)
    expect(normalizeConfig({ provisionedConcurrencyEnabled: true, provisionedConcurrency: 999 }).provisionedConcurrency).toBe(900)
    expect(normalizeConfig({ reservedConcurrencyEnabled: true, reservedConcurrency: 400, provisionedConcurrencyEnabled: true, provisionedConcurrency: 999 }).provisionedConcurrency).toBe(400)
    expect(normalizeConfig({ provisionedTarget: 'LATEST', provisionedConcurrencyEnabled: true, provisionedConcurrency: 400 }).provisionedConcurrencyEnabled).toBe(false)
  })
})

describe('bounded chronological data structures', () => {
  it('ring samples retain the last entries in chronological order', () => {
    const ring = createRing<number>(3)
    for (let value = 0; value < 10; value += 1) appendRing(ring, value)
    expect(readRing(ring)).toEqual([7, 8, 9])
    expect(ring.items.length).toBe(3)
  })

  it('an environment has only one scheduled lifecycle event across rescheduling', () => {
    const queue = new EventQueue()
    for (let order = 0; order < 100; order += 1) queue.set({ key: 1, atMs: 1_000 - order, order })
    expect(queue.size).toBe(1)
    queue.set({ key: 2, atMs: 901, order: 101 })
    expect(queue.pop()?.key).toBe(1)
    expect(queue.pop()?.key).toBe(2)
    expect(queue.size).toBe(0)
  })

  it('removes and reuses idle entries with deterministic most-recently-idle order', () => {
    const pool = new IdlePool()
    pool.add(1); pool.add(2); pool.add(3)
    pool.delete(2)
    expect(pool.peek()).toBe(3)
    pool.delete(3)
    expect(pool.peek()).toBe(1)
    expect(pool.size).toBe(1)
  })
})
