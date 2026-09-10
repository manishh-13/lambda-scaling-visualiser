import { createPrng, hashSeed, nextIntInclusive, type PrngState } from './prng'
import {
  EVENT_BUFFER_CAPACITY, ENVIRONMENT_HISTORY_CAPACITY, HISTORY_BUFFER_CAPACITY,
  TICK_MS, THROTTLE_CAUSE_PRECEDENCE, normalizeConfig,
  type ActiveLimitsSnapshot, type EnvironmentHistoryEntry, type EnvironmentSnapshot,
  type EnvironmentState, type EnvironmentStateCounts, type HistorySample,
  type ProvisionedSnapshot, type ServingLane, type SimEvent, type SimulationConfig,
  type SimulationMetrics, type SimulationSnapshot, type ThrottleBlocker,
} from './types'
import { appendRing, createRing, EventQueue, IdlePool, readRing, type Ring } from './collections'
import {
  capacityBlockers, rateOpportunity, refillScalingBucket, scalingExpansionCost,
  type RateGate, type ScalingBucket,
} from './admission'

const EPSILON = 1e-8
const ALLOCATION_EVENT_KEY = -1
const zeroCauses = (): Record<ThrottleBlocker, number> => ({
  RPS_CEILING: 0, RESERVED_CONCURRENCY: 0, ACCOUNT_CONCURRENCY: 0, SCALING_RATE: 0,
})

/**
 * Bounded run options for the approved simple 1,000 slot view. They are teaching
 * conveniences layered on the same kernel, never new physics: every admission still
 * passes the identical concurrency, quota, request-rate and scaling checks.
 */
export interface SimulationOptions {
  /**
   * Create READY provisioned environments at time 0, with no seeded preparation draw
   * and no allocation steps. Explicitly educational: real provisioned concurrency
   * prepares for minutes before becoming ready.
   */
  provisionedReadyAtStart?: boolean
  /**
   * When false, a completed on-demand environment stays WARM_IDLE and reusable
   * indefinitely and no retirement event is queued for it. Presentation of those
   * cells is a UI concern; the kernel only stops retiring them.
   */
  idleRetirementEnabled?: boolean
}

/** Every option resolved to a concrete value, as stored on the state. */
export interface NormalizedSimulationOptions {
  provisionedReadyAtStart: boolean
  idleRetirementEnabled: boolean
}

export function normalizeOptions(input: SimulationOptions = {}): NormalizedSimulationOptions {
  return {
    provisionedReadyAtStart: input.provisionedReadyAtStart === true,
    idleRetirementEnabled: input.idleRetirementEnabled !== false,
  }
}

/** Which offered stream produced an admission attempt. */
type OfferSource = 'AUTOMATED' | 'MANUAL'

interface Environment {
  key: number
  id: string
  kind: 'ON_DEMAND' | 'PROVISIONED'
  state: EnvironmentState
  stateSinceMs: number
  requestId: string | null
  spillover: boolean
  invocations: number
  coldStarts: number
  history: Ring<EnvironmentHistoryEntry>
}

/** Deterministic in-place state. Only the functions in this module mutate it. */
export interface SimulationState {
  readonly seed: number
  config: SimulationConfig
  readonly options: NormalizedSimulationOptions
  timeMs: number
  tick: number
  trafficRunning: boolean
  trafficEpochMs: number
  arrivalIndex: number
  requestSequence: number
  environmentSequence: number
  eventSequence: number
  scheduleSequence: number
  onDemandEnvironmentsCreated: number
  onDemandUsable: number
  onDemandConcurrent: number
  environments: Map<number, Environment>
  queue: EventQueue
  warmIdle: IdlePool
  provisionedIdle: IdlePool
  prng: PrngState
  bucket: ScalingBucket
  capacityUnits: number
  lastExpansionCost: number
  rateGate: RateGate
  provisionedGate: RateGate
  manual: ManualRequestTally
  provisioned: ProvisionedSnapshot
  metrics: SimulationMetrics
  events: Ring<SimEvent>
  throttleEvents: Ring<SimEvent>
  history: Ring<HistorySample>
  interval: IntervalTally
}

/**
 * Per interval accounting, reset at every 50 ms tick boundary. The rate grant counters
 * are the shared request-rate budget: both the automated arrival stream and manual clicks
 * spend from the same counters, so neither source can receive a second whole allowance.
 */
interface IntervalTally {
  offered: number
  accepted: number
  throttled: number
  onDemandAccepted: number
  /** Manual clicks offered this interval, whatever their outcome. */
  manualOffered: number
  /** Manual clicks accepted on the on-demand lane, excluded from the arrival rate estimate. */
  manualOnDemandAccepted: number
  /** Account or function request-rate grants this interval, both sources. */
  rateGrants: number
  /** The manual share of rateGrants. */
  manualRateGrants: number
  /** Provisioned lane request-rate grants this interval, both sources. */
  provisionedRateGrants: number
  /** The manual share of provisionedRateGrants. */
  manualProvisionedRateGrants: number
  causes: Record<ThrottleBlocker, number>
}

/** Lifetime outcome of manual clicks, for a view that reports the click it just made. */
export interface ManualRequestTally {
  offered: number
  accepted: number
  throttled: number
  lastRequestId: string | null
  lastOutcome: 'ACCEPTED' | 'THROTTLED' | null
}

function newInterval(): IntervalTally {
  return {
    offered: 0, accepted: 0, throttled: 0, onDemandAccepted: 0,
    manualOffered: 0, manualOnDemandAccepted: 0, rateGrants: 0, manualRateGrants: 0,
    provisionedRateGrants: 0, manualProvisionedRateGrants: 0, causes: zeroCauses(),
  }
}

function schedule(state: SimulationState, key: number, atMs: number): void {
  state.queue.set({ key, atMs, order: ++state.scheduleSequence })
}

function emit(state: SimulationState, event: Omit<SimEvent, 'seq' | 'timeMs'>): void {
  const sample = { ...event, seq: ++state.eventSequence, timeMs: state.timeMs }
  appendRing(state.events, sample)
  if (sample.type === 'REQUEST_THROTTLED') appendRing(state.throttleEvents, sample)
}

function concurrencyCap(state: SimulationState): number {
  return state.config.reservedConcurrencyEnabled ? state.config.reservedConcurrency : state.config.accountConcurrencyQuota
}

function activeLimits(state: SimulationState): ActiveLimitsSnapshot {
  const reserved = state.config.reservedConcurrencyEnabled ? state.config.reservedConcurrency : null
  return {
    accountConcurrencyQuota: state.config.accountConcurrencyQuota,
    accountRpsCeiling: state.config.accountConcurrencyQuota * 10,
    reservedConcurrency: reserved,
    functionRpsCeiling: reserved === null ? null : reserved * 10,
    provisionedConcurrency: state.provisioned.ready || null,
    provisionedRpsCeiling: state.provisioned.ready ? state.provisioned.ready * 10 : null,
    scalingUnitsAvailable: state.bucket.balance,
    scalingUnitCostPerEnvironment: 1,
  }
}

export function createSimulation(
  input: Partial<SimulationConfig> = {},
  seed = 1,
  options: SimulationOptions = {},
): SimulationState {
  const config = normalizeConfig(input)
  const resolved = normalizeOptions(options)
  const requested = config.provisionedConcurrencyEnabled ? config.provisionedConcurrency : 0
  const readyAtStart = requested > 0 && resolved.provisionedReadyAtStart
  const normalizedSeed = hashSeed(seed)
  const prng = createPrng(normalizedSeed)
  // Ready at start draws no preparation delay at all, so it consumes no PRNG value.
  const preparationDelayMs = requested && !readyAtStart ? nextIntInclusive(prng, 60_000, 120_000) : 0
  const allocationDurationMs = readyAtStart ? 0 : requested * 10
  const state: SimulationState = {
    seed: normalizedSeed, config, options: resolved, timeMs: 0, tick: 0, trafficRunning: false,
    trafficEpochMs: 0, arrivalIndex: 1, requestSequence: 0, environmentSequence: 0,
    eventSequence: 0, scheduleSequence: 0, onDemandEnvironmentsCreated: 0,
    onDemandUsable: 0, onDemandConcurrent: 0, environments: new Map(),
    queue: new EventQueue(), warmIdle: new IdlePool(), provisionedIdle: new IdlePool(),
    prng, bucket: { balance: 1_000, lastRefillMs: 0 }, capacityUnits: 0, lastExpansionCost: 0,
    rateGate: { phase: 0 }, provisionedGate: { phase: 0 },
    manual: { offered: 0, accepted: 0, throttled: 0, lastRequestId: null, lastOutcome: null },
    provisioned: {
      status: requested ? (readyAtStart ? 'READY' : 'PREPARING') : 'DISABLED', requested,
      ready: readyAtStart ? requested : 0,
      preparationDelayMs, allocationDurationMs,
      readyAtMs: requested ? (readyAtStart ? 0 : preparationDelayMs + allocationDurationMs) : null,
      target: config.provisionedTarget, allocated: readyAtStart ? requested : 0,
      quotaReserved: requested,
      allocationStartedAtMs: readyAtStart ? 0 : null,
    },
    metrics: {
      concurrentExecutions: 0, acceptedRequests: 0, invocations: 0, throttles: 0, errors: 0,
      durationAverageMs: 0, durationSumMs: 0, durationSamples: 0,
      provisionedConcurrencyInvocations: 0, provisionedConcurrencySpilloverInvocations: 0,
      coldStarts: 0, offeredRequests: 0, throttlesByCause: zeroCauses(),
    },
    events: createRing(EVENT_BUFFER_CAPACITY), throttleEvents: createRing(32),
    history: createRing(HISTORY_BUFFER_CAPACITY), interval: newInterval(),
  }
  if (readyAtStart) {
    for (let index = 0; index < requested; index += 1) createEnvironment(state, 'PROVISIONED')
    emit(state, {
      type: 'PROVISIONED_READY',
      detail: `${requested} provisioned environments start ready. Real preparation takes minutes.`,
    })
  } else if (requested) {
    schedule(state, ALLOCATION_EVENT_KEY, preparationDelayMs)
    emit(state, { type: 'PROVISIONED_PREPARING', detail: `Preparing ${requested} provisioned environments.` })
  }
  return state
}

export function startTraffic(state: SimulationState): SimulationState {
  if (state.trafficRunning) return state
  state.trafficRunning = true
  state.trafficEpochMs = state.timeMs
  state.arrivalIndex = 1
  state.rateGate.phase = 0
  state.provisionedGate.phase = 0
  emit(state, { type: 'TRAFFIC_STARTED' })
  return state
}

export function stopTraffic(state: SimulationState): SimulationState {
  if (!state.trafficRunning) return state
  state.trafficRunning = false
  state.rateGate.phase = 0
  state.provisionedGate.phase = 0
  emit(state, { type: 'TRAFFIC_STOPPED' })
  return state
}

/** An explicit deterministic traffic command. UI configuration edits instead create a new run. */
export function setTrafficRate(state: SimulationState, requestsPerSecond: number): SimulationState {
  const next = normalizeConfig({ ...state.config, requestsPerSecond })
  state.config = next
  state.trafficEpochMs = state.timeMs
  state.arrivalIndex = 1
  state.rateGate.phase = 0
  state.provisionedGate.phase = 0
  emit(state, { type: 'TRAFFIC_RATE_CHANGED', detail: `${next.requestsPerSecond} offered RPS.` })
  return state
}

function transition(state: SimulationState, environment: Environment, next: EnvironmentState): void {
  environment.state = next
  environment.stateSinceMs = state.timeMs
  appendRing(environment.history, { state: next, atMs: state.timeMs })
}

function createEnvironment(state: SimulationState, kind: Environment['kind']): Environment {
  const key = ++state.environmentSequence
  const environment: Environment = {
    key, id: `${kind === 'PROVISIONED' ? 'P' : 'E'}-${String(key).padStart(4, '0')}`,
    kind, state: kind === 'PROVISIONED' ? 'PROVISIONED_IDLE' : 'INITIALISING',
    stateSinceMs: state.timeMs, requestId: null, spillover: false, invocations: 0, coldStarts: 0,
    history: createRing(ENVIRONMENT_HISTORY_CAPACITY),
  }
  appendRing(environment.history, { state: environment.state, atMs: state.timeMs })
  state.environments.set(key, environment)
  if (kind === 'ON_DEMAND') {
    state.onDemandEnvironmentsCreated += 1
    state.onDemandUsable += 1
    emit(state, { type: 'ENVIRONMENT_CREATED', environmentId: environment.id })
  } else state.provisionedIdle.add(key)
  return environment
}

function beginInvoke(state: SimulationState, environment: Environment): void {
  transition(state, environment, 'RUNNING')
  environment.invocations += 1
  state.metrics.invocations += 1
  if (environment.kind === 'PROVISIONED') state.metrics.provisionedConcurrencyInvocations += 1
  else if (environment.spillover) state.metrics.provisionedConcurrencySpilloverInvocations += 1
  emit(state, {
    type: 'INVOKE_STARTED', environmentId: environment.id,
    requestId: environment.requestId ?? undefined, spillover: environment.spillover,
  })
  schedule(state, environment.key, state.timeMs + state.config.handlerDurationMs)
}

function advanceAllocation(state: SimulationState): void {
  const allocation = state.provisioned
  if (allocation.allocationStartedAtMs === null) {
    allocation.allocationStartedAtMs = state.timeMs
    schedule(state, ALLOCATION_EVENT_KEY, state.timeMs + 10)
    emit(state, { type: 'PROVISIONED_ALLOCATION_PROGRESS', detail: 'Preparation complete; allocating at 100 environments per second.' })
    return
  }
  allocation.allocated += 1
  if (allocation.allocated === allocation.requested) {
    allocation.status = 'READY'
    allocation.ready = allocation.requested
    for (let index = 0; index < allocation.requested; index += 1) createEnvironment(state, 'PROVISIONED')
    emit(state, { type: 'PROVISIONED_READY', detail: `All ${allocation.ready} provisioned environments became ready together.` })
  } else {
    schedule(state, ALLOCATION_EVENT_KEY, state.timeMs + 10)
  }
}

function processEvent(state: SimulationState, key: number): void {
  if (key === ALLOCATION_EVENT_KEY) { advanceAllocation(state); return }
  const environment = state.environments.get(key)
  if (!environment) throw new Error('Scheduled environment is missing.')
  if (environment.state === 'INITIALISING') {
    emit(state, { type: 'INIT_COMPLETED', environmentId: environment.id, requestId: environment.requestId ?? undefined })
    beginInvoke(state, environment)
  } else if (environment.state === 'RUNNING') {
    state.metrics.concurrentExecutions -= 1
    state.metrics.durationSamples += 1
    state.metrics.durationSumMs += state.config.handlerDurationMs
    state.metrics.durationAverageMs = state.metrics.durationSumMs / state.metrics.durationSamples
    emit(state, {
      type: 'INVOKE_COMPLETED', environmentId: environment.id,
      requestId: environment.requestId ?? undefined, durationMs: state.config.handlerDurationMs,
    })
    environment.requestId = null
    if (environment.kind === 'PROVISIONED') {
      transition(state, environment, 'PROVISIONED_IDLE')
      state.provisionedIdle.add(key)
    } else {
      state.onDemandConcurrent -= 1
      transition(state, environment, 'WARM_IDLE')
      state.warmIdle.add(key)
      // With idle retirement disabled the environment stays reusable and queues no event.
      if (state.options.idleRetirementEnabled) schedule(state, key, state.timeMs + state.config.idleTimeoutMs)
    }
  } else if (environment.state === 'WARM_IDLE') {
    state.warmIdle.delete(key)
    const previousUsable = state.onDemandUsable
    state.onDemandUsable -= 1
    // Retiring a share of the footprint also retires that share of its RPS authorization.
    state.capacityUnits = previousUsable > 0
      ? state.capacityUnits * state.onDemandUsable / previousUsable
      : 0
    transition(state, environment, 'RETIRING')
    emit(state, { type: 'ENVIRONMENT_RETIRING', environmentId: environment.id })
    schedule(state, key, state.timeMs + state.config.retiringDurationMs)
  } else if (environment.state === 'RETIRING') {
    state.environments.delete(key)
    emit(state, { type: 'ENVIRONMENT_RETIRED', environmentId: environment.id })
  }
}

function accept(state: SimulationState, environment: Environment, requestId: string, lane: ServingLane): void {
  state.queue.delete(environment.key)
  state.warmIdle.delete(environment.key)
  state.provisionedIdle.delete(environment.key)
  environment.requestId = requestId
  environment.spillover = lane !== 'PROVISIONED' && state.provisioned.status === 'READY'
  state.metrics.concurrentExecutions += 1
  state.metrics.acceptedRequests += 1
  state.interval.accepted += 1
  if (lane !== 'PROVISIONED') {
    state.onDemandConcurrent += 1
    state.interval.onDemandAccepted += 1
  }
  const coldStart = lane === 'ON_DEMAND_COLD'
  emit(state, {
    type: 'REQUEST_ACCEPTED', requestId, environmentId: environment.id,
    lane, coldStart, spillover: environment.spillover,
  })
  if (coldStart) {
    environment.coldStarts += 1
    state.metrics.coldStarts += 1
    schedule(state, environment.key, state.timeMs + state.config.initDurationMs)
    if (state.config.initDurationMs === 0) {
      state.queue.delete(environment.key)
      emit(state, { type: 'INIT_COMPLETED', environmentId: environment.id, requestId })
      beginInvoke(state, environment)
    }
  } else beginInvoke(state, environment)
}

/**
 * Requests a synchronous request-rate ceiling permits inside one 50 ms interval. The
 * value is exact and may be fractional: a 10 RPS ceiling is half a request per interval.
 */
function intervalRateBudget(ceilingRps: number): number {
  return ceilingRps <= 0 ? 0 : ceilingRps * TICK_MS / 1_000
}

/** Whether one more grant still fits inside this interval's shared budget. */
function withinIntervalBudget(ceilingRps: number, grantsThisInterval: number): boolean {
  return grantsThisInterval + 1 <= intervalRateBudget(ceilingRps) + EPSILON
}

/**
 * Whether a manual click may take a grant from the shared interval budget.
 *
 * A click is one discrete request, not a configured rate, so it is charged as one grant
 * against the same counter the arrival stream spends from. The only declared exception is
 * a sub-request rounding allowance: when the whole interval budget is less than one
 * request, a ceiling too fine to express in a 50 ms interval, the first click of the
 * interval is still admitted. That allowance is strictly less than one request per
 * interval and it is never granted twice. A ceiling of zero, reserved concurrency zero
 * being the case that matters, permits nothing at all.
 */
function manualRateGrant(ceilingRps: number, grantsThisInterval: number): boolean {
  const budget = intervalRateBudget(ceilingRps)
  if (budget <= 0) return false
  if (withinIntervalBudget(ceilingRps, grantsThisInterval)) return true
  return budget < 1 && grantsThisInterval === 0
}

/**
 * One admission attempt at the current simulated time, shared by the automated arrival
 * stream and by manual clicks. Returns whether the request was accepted.
 *
 * The two sources differ only in how the shared request-rate ceilings are metered, and
 * they share one budget per interval so clicks never earn a second whole allowance:
 *
 * - The arrival stream keeps its phase gate on the configured slider RPS, so its arrival
 *   timestamps, phase and legacy outputs are untouched. Each grant it wins is recorded in
 *   interval.rateGrants.
 * - A manual click is never judged by a slider value it did not use. It asks
 *   manualRateGrant for one grant from the same interval counter, so a saturated stream
 *   leaves it nothing beyond the declared sub-request rounding allowance.
 * - Once clicks have spent part of an interval, the stream yields exactly that share for
 *   the rest of the interval: an arrival whose phase gate passed is instead rate limited
 *   to a 429. Nothing already admitted is revisited, no phase is reset and no arrival
 *   timestamp moves, so the aggregate accepted per interval stays inside the budget.
 *
 * The provisioned lane repeats the identical rule against the provisioned ceiling, so a
 * click that takes provisioned request-rate room makes one stream arrival spill to on
 * demand rather than adding provisioned throughput above the ceiling.
 *
 * Concurrency, reserved concurrency, the account quota and scaling capacity are checked by
 * the identical kernel for both sources. Every counter resets with the interval, so the
 * decision is deterministic and reads no wall clock.
 */
function admitOne(state: SimulationState, source: OfferSource): boolean {
  state.interval.offered += 1
  state.metrics.offeredRequests += 1
  if (source === 'MANUAL') {
    state.interval.manualOffered += 1
    state.manual.offered += 1
  }
  if (state.requestSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('Reset to keep request counters exact.')
  const requestId = `R-${String(++state.requestSequence).padStart(7, '0')}`
  if (source === 'MANUAL') state.manual.lastRequestId = requestId
  const ceilingRps = concurrencyCap(state) * 10
  const eligibleRps = Math.min(state.config.requestsPerSecond, ceilingRps)
  let rpsAllowed: boolean
  if (source === 'MANUAL') {
    rpsAllowed = manualRateGrant(ceilingRps, state.interval.rateGrants)
  } else {
    rpsAllowed = rateOpportunity(state.rateGate, state.config.requestsPerSecond, ceilingRps)
    if (rpsAllowed && state.interval.manualRateGrants > 0) {
      rpsAllowed = withinIntervalBudget(ceilingRps, state.interval.rateGrants)
    }
  }
  if (rpsAllowed) {
    state.interval.rateGrants += 1
    if (source === 'MANUAL') state.interval.manualRateGrants += 1
  }
  let provisionedAllowed = false
  if (state.provisioned.status === 'READY') {
    const provisionedCeilingRps = state.provisioned.ready * 10
    if (source === 'MANUAL') {
      provisionedAllowed = rpsAllowed
        && manualRateGrant(provisionedCeilingRps, state.interval.provisionedRateGrants)
    } else {
      const gate = rpsAllowed ? state.provisionedGate : { ...state.provisionedGate }
      provisionedAllowed = rateOpportunity(gate, eligibleRps, provisionedCeilingRps)
      if (provisionedAllowed && state.interval.manualProvisionedRateGrants > 0) {
        provisionedAllowed = withinIntervalBudget(provisionedCeilingRps, state.interval.provisionedRateGrants)
      }
    }
    if (provisionedAllowed && rpsAllowed) {
      state.interval.provisionedRateGrants += 1
      if (source === 'MANUAL') state.interval.manualProvisionedRateGrants += 1
    }
  }
  const provisionedKey = provisionedAllowed ? state.provisionedIdle.peek() : null
  const warmKey = provisionedKey === null ? state.warmIdle.peek() : null
  const environmentsNeeded = state.onDemandUsable + (warmKey === null ? 1 : 0)
  // Each stream admission in a 50 ms interval represents 20 RPS of aggregate capacity.
  // Clamp the estimate to capacity already authorized so a new tick cannot make
  // sustained demand appear to fall back to one interval-local admission.
  // A manual click is one discrete request, so it pays for the environment slot it needs
  // but is never extrapolated into 20 RPS of sustained rate authorization, and it never
  // inflates the stream's own estimate either. A lone cold click therefore costs exactly
  // one unit, the documented cost of one environment slot.
  const streamOnDemandAccepted = state.interval.onDemandAccepted - state.interval.manualOnDemandAccepted
  const intervalRpsNeeded = (streamOnDemandAccepted + (source === 'MANUAL' ? 0 : 1)) * 1_000 / TICK_MS
  const rpsNeeded = Math.max(state.capacityUnits * 10, intervalRpsNeeded)
  const expansion = provisionedKey === null
    ? scalingExpansionCost(state.capacityUnits, environmentsNeeded, rpsNeeded)
    : 0
  const blockers = capacityBlockers({
    concurrent: state.metrics.concurrentExecutions, onDemandConcurrent: state.onDemandConcurrent,
    provisionedAllocated: state.provisioned.quotaReserved, usesProvisioned: provisionedKey !== null,
    accountQuota: state.config.accountConcurrencyQuota,
    reserved: state.config.reservedConcurrencyEnabled ? state.config.reservedConcurrency : null,
    scalingCost: expansion, scalingTokens: state.bucket.balance, rpsBlocked: !rpsAllowed,
  })
  if (blockers.length) {
    const primary = blockers[0]
    state.metrics.throttles += 1
    state.metrics.throttlesByCause[primary] += 1
    state.interval.throttled += 1
    state.interval.causes[primary] += 1
    emit(state, {
      type: 'REQUEST_THROTTLED', requestId, primaryCause: primary, blockers,
      limits: activeLimits(state), detail: '429 TooManyRequestsException',
    })
    if (source === 'MANUAL') {
      state.manual.throttled += 1
      state.manual.lastOutcome = 'THROTTLED'
    }
    return false
  }
  if (source === 'MANUAL') {
    state.manual.accepted += 1
    state.manual.lastOutcome = 'ACCEPTED'
  }
  if (provisionedKey !== null) {
    accept(state, state.environments.get(provisionedKey)!, requestId, 'PROVISIONED')
    return true
  }
  if (source === 'MANUAL') state.interval.manualOnDemandAccepted += 1
  state.bucket.balance = Math.max(0, state.bucket.balance - expansion)
  state.capacityUnits += expansion
  state.lastExpansionCost = expansion
  const environment = warmKey === null ? createEnvironment(state, 'ON_DEMAND') : state.environments.get(warmKey)!
  accept(state, environment, requestId, warmKey === null ? 'ON_DEMAND_COLD' : 'ON_DEMAND_WARM')
  return true
}

/**
 * Admit exactly one request at the current simulated time through the same kernel.
 * It never starts, stops or re-phases the automated arrival stream, so a click during
 * a running stream leaves that stream's arrival timestamps untouched, and a click while
 * traffic is stopped is judged only on real capacity, never on the configured slider RPS.
 */
export function sendManualRequest(state: SimulationState): SimulationState {
  admitOne(state, 'MANUAL')
  return state
}

function countEnvironments(state: SimulationState): EnvironmentStateCounts {
  const counts = { initialising: 0, running: 0, warmIdle: 0, provisionedIdle: 0, retiring: 0 }
  for (const environment of state.environments.values()) {
    if (environment.state === 'INITIALISING') counts.initialising += 1
    else if (environment.state === 'RUNNING') counts.running += 1
    else if (environment.state === 'WARM_IDLE') counts.warmIdle += 1
    else if (environment.state === 'PROVISIONED_IDLE') counts.provisionedIdle += 1
    else counts.retiring += 1
  }
  return counts
}

function step(state: SimulationState): void {
  const endMs = (state.tick + 1) * TICK_MS
  while (true) {
    const queued = state.queue.peek()
    const arrivalAt = state.trafficRunning && state.config.requestsPerSecond > 0
      ? state.trafficEpochMs + state.arrivalIndex * 1_000 / state.config.requestsPerSecond
      : Number.POSITIVE_INFINITY
    const eventAt = queued?.atMs ?? Number.POSITIVE_INFINITY
    const nextTime = Math.min(eventAt, arrivalAt)
    if (nextTime > endMs + EPSILON) break
    const atMs = Math.min(endMs, Math.max(state.timeMs, nextTime))
    refillScalingBucket(state.bucket, atMs)
    state.timeMs = atMs
    // Every completion at this timestamp precedes its arrivals, including zero Init.
    if (eventAt <= arrivalAt + EPSILON) {
      const event = state.queue.pop()!
      processEvent(state, event.key)
    } else {
      admitOne(state, 'AUTOMATED')
      state.arrivalIndex += 1
    }
  }
  state.timeMs = endMs
  state.tick += 1
  refillScalingBucket(state.bucket, endMs)
  appendRing(state.history, {
    tick: state.tick, timeMs: endMs, concurrentExecutions: state.metrics.concurrentExecutions,
    environments: countEnvironments(state), offered: state.interval.offered,
    accepted: state.interval.accepted, throttled: state.interval.throttled,
    throttledByCause: { ...state.interval.causes },
  })
  state.interval = newInterval()
}

/** Caller supplies exact multiples of 50 ms; sub-tick events are not rounded to that cadence. */
export function advanceSimulation(state: SimulationState, elapsedMs: number): SimulationState {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs % TICK_MS !== 0) {
    throw new RangeError('Advance by a non-negative multiple of 50 ms.')
  }
  for (let index = 0; index < elapsedMs / TICK_MS; index += 1) step(state)
  return state
}

function environmentSnapshot(state: SimulationState, environment: Environment): EnvironmentSnapshot {
  return {
    id: environment.id, kind: environment.kind, state: environment.state,
    stateSinceMs: environment.stateSinceMs, timeInStateMs: state.timeMs - environment.stateSinceMs,
    activeRequestId: environment.requestId, invocations: environment.invocations,
    coldStarts: environment.coldStarts, history: readRing(environment.history).map(entry => ({ ...entry })),
  }
}

export function getSnapshot(state: SimulationState): SimulationSnapshot {
  const history = readRing(state.history)
  const last = history.at(-1)
  const counts = countEnvironments(state)
  const recent = history.slice(-200)
  const causeCounts = zeroCauses()
  for (const sample of recent) {
    for (const cause of THROTTLE_CAUSE_PRECEDENCE) causeCounts[cause] += sample.throttledByCause[cause]
  }
  const total = Object.values(causeCounts).reduce((sum, count) => sum + count, 0)
  const copyEvent = (event: SimEvent): SimEvent => ({
    ...event, ...(event.blockers ? { blockers: [...event.blockers] } : {}),
    ...(event.limits ? { limits: { ...event.limits } } : {}),
  })
  return {
    seed: state.seed, config: { ...state.config }, timeMs: state.timeMs, tick: state.tick,
    trafficRunning: state.trafficRunning, requestsPerSecond: state.config.requestsPerSecond,
    demandedConcurrency: state.config.requestsPerSecond * state.config.handlerDurationMs / 1_000,
    activeConcurrencyCap: concurrencyCap(state),
    metrics: { ...state.metrics, throttlesByCause: { ...state.metrics.throttlesByCause } },
    acceptedRequestsPerSecond: (last?.accepted ?? 0) * 20,
    throttledRequestsPerSecond: (last?.throttled ?? 0) * 20,
    offeredRequestsPerSecond: (last?.offered ?? 0) * 20,
    environments: Array.from(state.environments.values(), environment => environmentSnapshot(state, environment)),
    environmentCounts: counts, totalEnvironments: state.environments.size,
    warmIdleEnvironments: counts.warmIdle,
    environmentsCreatedTotal: state.environmentSequence,
    onDemandEnvironmentsCreated: state.onDemandEnvironmentsCreated,
    provisioned: { ...state.provisioned },
    scaling: {
      unitsAvailable: state.bucket.balance, maxUnits: 1_000, refillUnitsPerSecond: 100,
      unitCostPerEnvironment: 1, capacityUnits: state.capacityUnits, lastExpansionCost: state.lastExpansionCost,
    },
    limits: activeLimits(state),
    history: history.map(sample => ({
      ...sample, environments: { ...sample.environments }, throttledByCause: { ...sample.throttledByCause },
    })),
    recentEvents: readRing(state.events).map(copyEvent),
    recentThrottleEvents: readRing(state.throttleEvents)
      .filter(event => event.timeMs > state.timeMs - 10_000).map(copyEvent),
    quotaOccupancy: state.provisioned.quotaReserved + state.onDemandConcurrent,
    onDemandConcurrentExecutions: state.onDemandConcurrent,
    recentThrottles: {
      windowSeconds: 10, total,
      byCause: THROTTLE_CAUSE_PRECEDENCE.map(cause => ({
        cause, count: causeCounts[cause], percentage: total ? causeCounts[cause] / total * 100 : 0,
        activeLimit: cause === 'RPS_CEILING' ? concurrencyCap(state) * 10
          : cause === 'ACCOUNT_CONCURRENCY' ? state.config.accountConcurrencyQuota
            : cause === 'RESERVED_CONCURRENCY' ? activeLimits(state).reservedConcurrency : 1_000,
      })),
    },
  }
}

export function cloneSnapshotBytes(state: SimulationState): string {
  return JSON.stringify(getSnapshot(state))
}
