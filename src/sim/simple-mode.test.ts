import { describe, expect, it } from 'vitest'
import {
  advanceSimulation, cloneSnapshotBytes, createSimulation, getSnapshot, normalizeOptions,
  sendManualRequest, startTraffic, stopTraffic,
  type SimulationOptions, type SimulationState,
} from './engine'
import { type SimulationConfig } from './types'

const SIMPLE_SLOTS = 1_000

function simulation(
  patch: Partial<SimulationConfig> = {},
  options: SimulationOptions = {},
  seed = 17,
): SimulationState {
  return createSimulation({ idleTimeoutMs: 15_000, ...patch }, seed, options)
}

function running(patch: Partial<SimulationConfig>, options: SimulationOptions, milliseconds: number): SimulationState {
  const state = simulation(patch, options)
  startTraffic(state)
  advanceSimulation(state, milliseconds)
  return state
}

function lastEvent(state: SimulationState, type: string) {
  return getSnapshot(state).recentEvents.filter(event => event.type === type).at(-1)!
}

describe('simple view options', () => {
  it('defaults to legacy behaviour and normalizes only the documented options', () => {
    expect(normalizeOptions()).toEqual({ provisionedReadyAtStart: false, idleRetirementEnabled: true })
    expect(normalizeOptions({})).toEqual({ provisionedReadyAtStart: false, idleRetirementEnabled: true })
    expect(normalizeOptions({ provisionedReadyAtStart: true, idleRetirementEnabled: false }))
      .toEqual({ provisionedReadyAtStart: true, idleRetirementEnabled: false })
    expect(simulation().options).toEqual({ provisionedReadyAtStart: false, idleRetirementEnabled: true })
  })

  it('a two argument legacy run is byte identical to the same run with empty options', () => {
    const config: Partial<SimulationConfig> = {
      requestsPerSecond: 5_000, handlerDurationMs: 200,
      provisionedConcurrencyEnabled: true, provisionedConcurrency: 200,
    }
    const legacy = createSimulation(config, 23)
    const explicit = createSimulation(config, 23, {})
    for (const state of [legacy, explicit]) {
      advanceSimulation(state, 90_000)
      startTraffic(state)
      advanceSimulation(state, 5_000)
      stopTraffic(state)
      advanceSimulation(state, 20_000)
    }
    expect(cloneSnapshotBytes(explicit)).toBe(cloneSnapshotBytes(legacy))
    expect(legacy.provisioned.preparationDelayMs).toBeGreaterThanOrEqual(60_000)
    expect(legacy.provisioned.readyAtMs).toBe(legacy.provisioned.preparationDelayMs + 2_000)
  })
})

describe('the approved simple 1,000 slot run', () => {
  it('400 RPS at a one second handler with no Init and no retirement settles at 400 and reuses for free', () => {
    const state = running(
      { requestsPerSecond: 400, handlerDurationMs: 1_000, initDurationMs: 0 },
      { idleRetirementEnabled: false },
      5_000,
    )
    const settled = getSnapshot(state)
    expect(settled.metrics.concurrentExecutions).toBe(400)
    expect(settled.demandedConcurrency).toBe(400)
    expect(settled.activeConcurrencyCap).toBe(SIMPLE_SLOTS)
    expect(settled.metrics.throttles).toBe(0)
    expect(settled.onDemandEnvironmentsCreated).toBe(400)
    expect(settled.environmentCounts.retiring).toBe(0)

    advanceSimulation(state, 10_000)
    const later = getSnapshot(state)
    expect(later.metrics.concurrentExecutions).toBe(400)
    expect(later.onDemandEnvironmentsCreated).toBe(400)
    expect(later.totalEnvironments).toBe(400)
    expect(later.metrics.throttles).toBe(0)
    expect(later.metrics.coldStarts).toBe(400)
    // Every invocation after the first 400 reused a warm environment at no scaling cost.
    expect(later.metrics.invocations).toBeGreaterThan(5_000)
    for (const sample of later.history.filter(entry => entry.timeMs > 1_000)) {
      expect(sample.throttled).toBe(0)
      expect(sample.throttledByCause.SCALING_RATE).toBe(0)
    }
    expect(later.scaling.capacityUnits).toBe(400)
    expect(later.scaling.unitsAvailable).toBe(SIMPLE_SLOTS)
  })
})

describe('provisioned concurrency ready at start', () => {
  it('reports 400 READY and allocated provisioned environments at time zero with no preparation', () => {
    const state = simulation(
      { provisionedConcurrencyEnabled: true, provisionedConcurrency: 400 },
      { provisionedReadyAtStart: true },
    )
    const snapshot = getSnapshot(state)
    expect(snapshot.timeMs).toBe(0)
    expect(snapshot.provisioned).toMatchObject({
      status: 'READY', requested: 400, ready: 400, allocated: 400, quotaReserved: 400,
      preparationDelayMs: 0, allocationDurationMs: 0, readyAtMs: 0, allocationStartedAtMs: 0,
    })
    expect(snapshot.environmentCounts.provisionedIdle).toBe(400)
    expect(snapshot.totalEnvironments).toBe(400)
    expect(snapshot.limits.provisionedConcurrency).toBe(400)
    expect(snapshot.limits.provisionedRpsCeiling).toBe(4_000)
    expect(snapshot.recentEvents.map(event => event.type)).toEqual(['PROVISIONED_READY'])
    expect(state.queue.peek()).toBeUndefined()
  })

  it('draws no seeded preparation value, so every seed produces the identical run', () => {
    const bytes = [1, 999].map(seed => {
      const state = simulation(
        { provisionedConcurrencyEnabled: true, provisionedConcurrency: 400, requestsPerSecond: 400 },
        { provisionedReadyAtStart: true },
        seed,
      )
      startTraffic(state)
      advanceSimulation(state, 2_000)
      const snapshot = getSnapshot(state)
      expect(snapshot.metrics.coldStarts).toBe(0)
      expect(snapshot.metrics.provisionedConcurrencyInvocations).toBeGreaterThan(0)
      return cloneSnapshotBytes({ ...state, seed: 0 } as SimulationState)
    })
    expect(bytes[1]).toBe(bytes[0])

    const seeded = [1, 999].map(seed => simulation(
      { provisionedConcurrencyEnabled: true, provisionedConcurrency: 400 }, {}, seed,
    ).provisioned.preparationDelayMs)
    expect(seeded[1]).not.toBe(seeded[0])
  })
})

describe('idle retirement option', () => {
  const config: Partial<SimulationConfig> = {
    requestsPerSecond: 40, handlerDurationMs: 500, initDurationMs: 0,
    idleTimeoutMs: 1_000, retiringDurationMs: 400,
  }

  it('keeps completed on demand environments WARM_IDLE and reusable when retirement is disabled', () => {
    const state = running(config, { idleRetirementEnabled: false }, 1_000)
    stopTraffic(state)
    advanceSimulation(state, 30_000)
    const idle = getSnapshot(state)
    expect(idle.environmentCounts.warmIdle).toBe(20)
    expect(idle.environmentCounts.retiring).toBe(0)
    expect(idle.totalEnvironments).toBe(20)
    // The kernel hides nothing: the cells remain in the snapshot for the UI to decide.
    expect(idle.environments.filter(environment => environment.state === 'WARM_IDLE')).toHaveLength(20)
    expect(idle.recentEvents.some(event => event.type === 'ENVIRONMENT_RETIRING')).toBe(false)
    expect(idle.recentEvents.some(event => event.type === 'ENVIRONMENT_RETIRED')).toBe(false)
    expect(idle.scaling.capacityUnits).toBe(20)

    startTraffic(state)
    advanceSimulation(state, 1_000)
    const reused = getSnapshot(state)
    expect(reused.onDemandEnvironmentsCreated).toBe(20)
    expect(reused.metrics.coldStarts).toBe(20)
    expect(reused.metrics.throttles).toBe(0)
  })

  it('retires normally when the option is enabled or left at its default', () => {
    for (const options of [{}, { idleRetirementEnabled: true }]) {
      const state = running(config, options, 1_000)
      stopTraffic(state)
      advanceSimulation(state, 30_000)
      const snapshot = getSnapshot(state)
      expect(snapshot.totalEnvironments).toBe(0)
      expect(snapshot.environmentCounts.warmIdle).toBe(0)
      expect(snapshot.recentEvents.filter(event => event.type === 'ENVIRONMENT_RETIRED')).toHaveLength(20)
      expect(snapshot.scaling.capacityUnits).toBe(0)
    }
  })
})

describe('manual requests', () => {
  it('admits exactly one request that completes at the exact handler duration', () => {
    const state = simulation({ handlerDurationMs: 1_000, initDurationMs: 0, requestsPerSecond: 0 })
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ offered: 1, accepted: 1, throttled: 0, lastOutcome: 'ACCEPTED' })
    const accepted = lastEvent(state, 'REQUEST_ACCEPTED')
    expect(accepted).toMatchObject({ timeMs: 0, lane: 'ON_DEMAND_COLD', coldStart: true })
    expect(getSnapshot(state).metrics).toMatchObject({ offeredRequests: 1, acceptedRequests: 1, concurrentExecutions: 1 })

    advanceSimulation(state, 950)
    expect(getSnapshot(state).metrics.concurrentExecutions).toBe(1)
    advanceSimulation(state, 50)
    const done = lastEvent(state, 'INVOKE_COMPLETED')
    expect(done).toMatchObject({ timeMs: 1_000, durationMs: 1_000, requestId: state.manual.lastRequestId })
    const finished = getSnapshot(state)
    expect(finished.metrics).toMatchObject({
      concurrentExecutions: 0, invocations: 1, throttles: 0, durationAverageMs: 1_000,
    })
    expect(finished.environmentCounts.warmIdle).toBe(1)
  })

  it('adds Init before the handler exactly like an automated cold arrival', () => {
    const state = simulation({ handlerDurationMs: 1_000, initDurationMs: 400, requestsPerSecond: 0 })
    sendManualRequest(state)
    advanceSimulation(state, 1_400)
    expect(lastEvent(state, 'INIT_COMPLETED').timeMs).toBe(400)
    expect(lastEvent(state, 'INVOKE_COMPLETED')).toMatchObject({ timeMs: 1_400, durationMs: 1_000 })
  })

  it('is never judged by the configured slider RPS while traffic is stopped', () => {
    for (const requestsPerSecond of [0, 1, 100_000]) {
      const state = simulation({ requestsPerSecond, handlerDurationMs: 1_000, initDurationMs: 0 })
      sendManualRequest(state)
      expect(state.manual.lastOutcome).toBe('ACCEPTED')
      expect(state.trafficRunning).toBe(false)
      expect(getSnapshot(state).metrics.throttles).toBe(0)
    }
  })

  it('serves a click from ready provisioned capacity with no cold start and no scaling debit', () => {
    const state = simulation(
      { provisionedConcurrencyEnabled: true, provisionedConcurrency: 400, handlerDurationMs: 1_000, requestsPerSecond: 0 },
      { provisionedReadyAtStart: true },
    )
    const before = getSnapshot(state).scaling
    sendManualRequest(state)
    const accepted = lastEvent(state, 'REQUEST_ACCEPTED')
    expect(accepted).toMatchObject({ lane: 'PROVISIONED', coldStart: false, spillover: false })
    const after = getSnapshot(state)
    expect(after.metrics.coldStarts).toBe(0)
    expect(after.metrics.provisionedConcurrencyInvocations).toBe(1)
    expect(after.scaling.capacityUnits).toBe(before.capacityUnits)
    expect(after.scaling.unitsAvailable).toBe(before.unitsAvailable)
    expect(after.scaling.lastExpansionCost).toBe(0)
    expect(after.quotaOccupancy).toBe(400)

    advanceSimulation(state, 1_000)
    expect(lastEvent(state, 'INVOKE_COMPLETED')).toMatchObject({ timeMs: 1_000, durationMs: 1_000 })
    expect(getSnapshot(state).environmentCounts.provisionedIdle).toBe(400)
  })

  it('honours the account concurrency quota at the same boundary as the arrival stream', () => {
    const state = running({ requestsPerSecond: 5_000, handlerDurationMs: 200 }, {}, 10_000)
    const saturated = getSnapshot(state)
    expect(saturated.metrics.concurrentExecutions).toBe(SIMPLE_SLOTS)
    const throttlesBefore = saturated.metrics.throttles
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ offered: 1, accepted: 0, throttled: 1, lastOutcome: 'THROTTLED' })
    const rejected = lastEvent(state, 'REQUEST_THROTTLED')
    expect(rejected.requestId).toBe(state.manual.lastRequestId)
    expect(rejected.primaryCause).toBe('ACCOUNT_CONCURRENCY')
    expect(getSnapshot(state).metrics.throttles).toBe(throttlesBefore + 1)
    expect(getSnapshot(state).metrics.concurrentExecutions).toBe(SIMPLE_SLOTS)
  })

  it('rejects every click at reserved concurrency zero, request rate first', () => {
    const state = simulation({ reservedConcurrencyEnabled: true, reservedConcurrency: 0 })
    sendManualRequest(state)
    sendManualRequest(state)
    const rejected = lastEvent(state, 'REQUEST_THROTTLED')
    expect(rejected.primaryCause).toBe('RPS_CEILING')
    expect(rejected.blockers).toEqual(['RPS_CEILING', 'RESERVED_CONCURRENCY'])
    expect(state.manual).toMatchObject({ accepted: 0, throttled: 2 })
    expect(getSnapshot(state).metrics.acceptedRequests).toBe(0)
  })

  it('bounds simultaneous clicks by the interval share of the active request-rate ceiling', () => {
    const state = simulation({
      reservedConcurrencyEnabled: true, reservedConcurrency: 100,
      handlerDurationMs: 1_000, initDurationMs: 0, requestsPerSecond: 0,
    })
    expect(getSnapshot(state).limits.functionRpsCeiling).toBe(1_000)
    for (let click = 0; click < 50; click += 1) sendManualRequest(state)
    expect(state.manual).toMatchObject({ offered: 50, accepted: 50, throttled: 0 })

    sendManualRequest(state)
    expect(state.manual).toMatchObject({ offered: 51, accepted: 50, throttled: 1 })
    expect(lastEvent(state, 'REQUEST_THROTTLED').primaryCause).toBe('RPS_CEILING')

    // One discrete click buys one environment slot, never 20 RPS of authorization.
    expect(getSnapshot(state).scaling.capacityUnits).toBe(50)

    // The budget is per 50 ms interval, so the next interval admits again.
    advanceSimulation(state, 50)
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ offered: 52, accepted: 51, throttled: 1 })
    expect(getSnapshot(state).metrics.concurrentExecutions).toBe(51)
  })

  it('costs exactly one scaling unit for a lone cold click and none for a warm click', () => {
    const state = simulation({ requestsPerSecond: 0, handlerDurationMs: 1_000, initDurationMs: 0 })
    sendManualRequest(state)
    const cold = getSnapshot(state).scaling
    expect(cold.lastExpansionCost).toBe(1)
    expect(cold.capacityUnits).toBe(1)
    expect(cold.unitsAvailable).toBe(999)

    advanceSimulation(state, 1_050)
    sendManualRequest(state)
    const warm = getSnapshot(state).scaling
    expect(warm.lastExpansionCost).toBe(0)
    expect(warm.capacityUnits).toBe(1)
    expect(warm.unitsAvailable).toBe(SIMPLE_SLOTS)
    expect(getSnapshot(state).metrics.coldStarts).toBe(1)
  })

  it('leaves the running arrival stream phase, epoch and cadence untouched', () => {
    const state = running({ requestsPerSecond: 400, handlerDurationMs: 1_000, initDurationMs: 0 }, {}, 1_000)
    const before = {
      trafficRunning: state.trafficRunning, trafficEpochMs: state.trafficEpochMs,
      arrivalIndex: state.arrivalIndex, ratePhase: state.rateGate.phase,
      provisionedPhase: state.provisionedGate.phase, offered: state.metrics.offeredRequests,
      requestSequence: state.requestSequence,
    }
    sendManualRequest(state)
    expect(state.trafficRunning).toBe(before.trafficRunning)
    expect(state.trafficEpochMs).toBe(before.trafficEpochMs)
    expect(state.arrivalIndex).toBe(before.arrivalIndex)
    expect(state.rateGate.phase).toBe(before.ratePhase)
    expect(state.provisionedGate.phase).toBe(before.provisionedPhase)
    expect(state.metrics.offeredRequests).toBe(before.offered + 1)
    expect(state.requestSequence).toBe(before.requestSequence + 1)

    advanceSimulation(state, 1_000)
    const second = getSnapshot(state).history.filter(sample => sample.timeMs > 1_000)
    const offered = second.reduce((sum, sample) => sum + sample.offered, 0)
    expect(offered).toBe(401)
    expect(state.manual.offered).toBe(1)
    expect(getSnapshot(state).offeredRequestsPerSecond).toBe(400)
    expect(getSnapshot(state).metrics.throttles).toBe(0)
  })
})

describe('shared aggregate request-rate ceilings', () => {
  // 30,000 offered RPS at a 20 ms handler against the 1,000 slot quota. The 10,000 RPS
  // ceiling is exactly 500 admissions per 50 ms interval, and the stream saturates it.
  const saturating: Partial<SimulationConfig> = { requestsPerSecond: 30_000, handlerDurationMs: 20 }
  const saturated = (): SimulationState => running(saturating, {}, 2_000)
  const lastTick = (state: SimulationState) => getSnapshot(state).history.at(-1)!

  it('the arrival stream alone saturates the shared interval budget', () => {
    const state = saturated()
    advanceSimulation(state, 50)
    expect(getSnapshot(state).limits.accountRpsCeiling).toBe(10_000)
    expect(lastTick(state)).toMatchObject({ offered: 1_500, accepted: 500, throttled: 1_000 })
    expect(getSnapshot(state).acceptedRequestsPerSecond).toBe(10_000)
  })

  it('a click before a saturated interval makes the stream yield its share, never a 501st acceptance', () => {
    const state = saturated()
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ accepted: 1, throttled: 0 })
    advanceSimulation(state, 50)
    const shared = lastTick(state)
    // 1,501 offers, still exactly 500 acceptances: 499 streamed plus the one click.
    expect(shared).toMatchObject({ offered: 1_501, accepted: 500, throttled: 1_001 })
    expect(shared.throttledByCause.RPS_CEILING).toBe(1_001)
    expect(getSnapshot(state).acceptedRequestsPerSecond).toBe(10_000)
  })

  it('a click after a saturated interval is judged by the new interval, and the stream recovers exactly', () => {
    const state = saturated()
    sendManualRequest(state)
    advanceSimulation(state, 50)
    // The interval reset restores the whole budget, so the next click is admitted again.
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ accepted: 2, throttled: 0 })
    advanceSimulation(state, 50)
    expect(lastTick(state)).toMatchObject({ offered: 1_501, accepted: 500, throttled: 1_001 })
    // An interval with no click is unaffected: the stream takes the full 500 again.
    advanceSimulation(state, 50)
    expect(lastTick(state)).toMatchObject({ offered: 1_500, accepted: 500, throttled: 1_000 })
  })

  it('ten simultaneous clicks take ten of the 500 shared grants, not a second allowance', () => {
    const state = saturated()
    for (let click = 0; click < 10; click += 1) sendManualRequest(state)
    expect(state.manual).toMatchObject({ offered: 10, accepted: 10, throttled: 0 })
    advanceSimulation(state, 50)
    const shared = lastTick(state)
    expect(shared).toMatchObject({ offered: 1_510, accepted: 500, throttled: 1_010 })
    expect(shared.throttledByCause.RPS_CEILING).toBe(1_010)
  })

  it('never rewrites an earlier interval nor moves a later arrival timestamp', () => {
    const baseline = saturated()
    const clicked = saturated()
    const before = getSnapshot(baseline).history.map(sample => JSON.stringify(sample))

    sendManualRequest(clicked)
    // Nothing already offered or accepted is revisited.
    expect(getSnapshot(clicked).history.map(sample => JSON.stringify(sample))).toEqual(before)
    expect(clicked.arrivalIndex).toBe(baseline.arrivalIndex)
    expect(clicked.trafficEpochMs).toBe(baseline.trafficEpochMs)
    expect(clicked.rateGate.phase).toBe(baseline.rateGate.phase)

    advanceSimulation(baseline, 200)
    advanceSimulation(clicked, 200)
    // Arrival timestamps and the per interval offer cadence are identical either way.
    const offers = (state: SimulationState) => getSnapshot(state).history
      .filter(sample => sample.timeMs > 2_000).map(sample => sample.offered)
    expect(offers(clicked)).toEqual([1_501, 1_500, 1_500, 1_500])
    expect(offers(baseline)).toEqual([1_500, 1_500, 1_500, 1_500])
    expect(clicked.arrivalIndex).toBe(baseline.arrivalIndex)
    expect(clicked.rateGate.phase).toBe(baseline.rateGate.phase)
  })

  it('a click on saturated provisioned request rate spills one stream arrival instead of exceeding the ceiling', () => {
    // 4,000 RPS against 400 ready provisioned environments is exactly the 4,000 RPS
    // provisioned ceiling, that is 200 provisioned admissions per 50 ms interval.
    const config: Partial<SimulationConfig> = {
      requestsPerSecond: 4_000, handlerDurationMs: 50, initDurationMs: 0,
      provisionedConcurrencyEnabled: true, provisionedConcurrency: 400,
    }
    const baseline = running(config, { provisionedReadyAtStart: true }, 1_000)
    const baselineBefore = getSnapshot(baseline).metrics
    advanceSimulation(baseline, 50)
    const baselineAfter = getSnapshot(baseline).metrics
    expect(baselineAfter.provisionedConcurrencyInvocations - baselineBefore.provisionedConcurrencyInvocations).toBe(200)
    expect(baselineAfter.provisionedConcurrencySpilloverInvocations).toBe(0)
    expect(baselineAfter.coldStarts).toBe(0)

    const clicked = running(config, { provisionedReadyAtStart: true }, 1_000)
    const before = getSnapshot(clicked).metrics
    sendManualRequest(clicked)
    expect(lastEvent(clicked, 'REQUEST_ACCEPTED')).toMatchObject({ lane: 'PROVISIONED', coldStart: false })
    advanceSimulation(clicked, 50)
    const after = getSnapshot(clicked).metrics
    // Aggregate provisioned admissions stay at the ceiling: 199 streamed plus the click.
    expect(after.provisionedConcurrencyInvocations - before.provisionedConcurrencyInvocations).toBe(200)
    // The displaced stream arrival spills to on demand rather than adding throughput.
    expect(after.provisionedConcurrencySpilloverInvocations - before.provisionedConcurrencySpilloverInvocations).toBe(1)
    expect(after.coldStarts - before.coldStarts).toBe(1)
    expect(after.throttles).toBe(before.throttles)
  })

  it('grants the declared single click rounding allowance when the budget is under one request', () => {
    // Reserved concurrency 1 is a 10 RPS ceiling, half a request per 50 ms interval.
    const state = simulation({
      reservedConcurrencyEnabled: true, reservedConcurrency: 1,
      handlerDurationMs: 100, initDurationMs: 0, requestsPerSecond: 0,
    })
    expect(getSnapshot(state).limits.functionRpsCeiling).toBe(10)
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ accepted: 1, throttled: 0 })
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ accepted: 1, throttled: 1 })
    expect(lastEvent(state, 'REQUEST_THROTTLED').primaryCause).toBe('RPS_CEILING')

    // The allowance is one click per interval and is never granted twice in the same one.
    advanceSimulation(state, 150)
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ accepted: 2, throttled: 1 })
    sendManualRequest(state)
    expect(state.manual).toMatchObject({ accepted: 2, throttled: 2 })
  })
})
