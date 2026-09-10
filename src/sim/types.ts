/**
 * Pure simulation types and constants for the Lambda scaling visualiser.
 *
 * This module is framework free. It must not import React, Zustand, DOM APIs,
 * or any browser global, and it must not read wall clock time.
 */

export const TICK_MS = 50

/** Scaling unit token bucket, an educational approximation of the documented scaling rate. */
export const SCALING_BUCKET_MAX_UNITS = 1000
export const SCALING_BUCKET_INITIAL_UNITS = 1000
export const SCALING_BUCKET_REFILL_UNITS_PER_SECOND = 100

/** Synchronous request rate ceiling per unit of concurrency. */
export const RPS_PER_CONCURRENCY_UNIT = 10

/** Account concurrency that cannot be reserved by a single function. */
export const UNRESERVED_ACCOUNT_HEADROOM = 100

/** Seeded provisioned concurrency preparation delay range, in simulated milliseconds. */
export const PROVISIONED_PREPARATION_MIN_MS = 60_000
export const PROVISIONED_PREPARATION_MAX_MS = 120_000

/** Provisioned allocation throughput: 6,000 environments per simulated minute. */
export const PROVISIONED_ALLOCATION_PER_MINUTE = 6000

/** Bounded buffers. The engine never keeps an unbounded request history. */
export const EVENT_BUFFER_CAPACITY = 200
export const HISTORY_BUFFER_CAPACITY = 600
export const ENVIRONMENT_HISTORY_CAPACITY = 8

/** One simulated second of tick samples. */
export const TICKS_PER_SECOND = 1000 / TICK_MS

/** The recent throttle diagnosis panel window. */
export const THROTTLE_WINDOW_SECONDS = 10

export type EnvironmentKind = 'ON_DEMAND' | 'PROVISIONED'

export type EnvironmentState =
  | 'INITIALISING'
  | 'RUNNING'
  | 'WARM_IDLE'
  | 'PROVISIONED_IDLE'
  | 'RETIRING'

export type ThrottleBlocker =
  | 'RPS_CEILING'
  | 'RESERVED_CONCURRENCY'
  | 'ACCOUNT_CONCURRENCY'
  | 'SCALING_RATE'

/**
 * Deterministic primary cause precedence. Index 0 wins.
 * This attribution is a simulator diagnosis, not a CloudWatch dimension.
 */
export const THROTTLE_CAUSE_PRECEDENCE: readonly ThrottleBlocker[] = [
  'RPS_CEILING',
  'RESERVED_CONCURRENCY',
  'ACCOUNT_CONCURRENCY',
  'SCALING_RATE',
]

export type ProvisionedTarget = 'VERSION_OR_ALIAS' | 'LATEST'

export type ProvisionedStatus = 'DISABLED' | 'PREPARING' | 'READY'

/** Which lane served an accepted request. */
export type ServingLane = 'PROVISIONED' | 'ON_DEMAND_WARM' | 'ON_DEMAND_COLD'

export interface SimulationConfig {
  /** CloudWatch Duration, handler time only, never including Init. */
  handlerDurationMs: number
  requestsPerSecond: number
  /** Example default account concurrency quota. Not an AWS universal value. */
  accountConcurrencyQuota: number
  /** Illustrative init duration. Real initialization time varies. */
  initDurationMs: number
  /** Illustrative idle timeout. AWS does not document warm retention. */
  idleTimeoutMs: number
  /** Brief visible retiring state before removal. */
  retiringDurationMs: number
  reservedConcurrencyEnabled: boolean
  reservedConcurrency: number
  provisionedConcurrencyEnabled: boolean
  provisionedConcurrency: number
  provisionedTarget: ProvisionedTarget
}

export const DEFAULT_CONFIG: SimulationConfig = {
  handlerDurationMs: 1000,
  requestsPerSecond: 100,
  accountConcurrencyQuota: 1000,
  initDurationMs: 400,
  idleTimeoutMs: 15_000,
  retiringDurationMs: 400,
  reservedConcurrencyEnabled: false,
  reservedConcurrency: 0,
  provisionedConcurrencyEnabled: false,
  provisionedConcurrency: 0,
  provisionedTarget: 'VERSION_OR_ALIAS',
}

export const CONFIG_LIMITS = {
  handlerDurationMs: { min: 1, max: 900_000 },
  requestsPerSecond: { min: 0, max: 100_000 },
  accountConcurrencyQuota: { min: 100, max: 10_000 },
  initDurationMs: { min: 0, max: 60_000 },
  idleTimeoutMs: { min: 1000, max: 3_600_000 },
  retiringDurationMs: { min: 0, max: 30_000 },
} as const

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Maximum reservable concurrency for one function: quota minus the unreserved headroom. */
export function maxReservableConcurrency(accountConcurrencyQuota: number): number {
  return Math.max(0, accountConcurrencyQuota - UNRESERVED_ACCOUNT_HEADROOM)
}

/** Maximum provisioned concurrency: bounded by reserved concurrency when it is enabled. */
export function maxProvisionedConcurrency(config: {
  accountConcurrencyQuota: number
  reservedConcurrencyEnabled: boolean
  reservedConcurrency: number
}): number {
  if (config.reservedConcurrencyEnabled) {
    return Math.max(0, Math.floor(config.reservedConcurrency))
  }
  return maxReservableConcurrency(config.accountConcurrencyQuota)
}

/** Validate and clamp a partial configuration into a complete, self consistent one. */
export function normalizeConfig(input: Partial<SimulationConfig>): SimulationConfig {
  const merged = { ...DEFAULT_CONFIG, ...input }

  const handlerDurationMs = clampNumber(
    merged.handlerDurationMs,
    CONFIG_LIMITS.handlerDurationMs.min,
    CONFIG_LIMITS.handlerDurationMs.max,
  )
  const requestsPerSecond = clampNumber(
    merged.requestsPerSecond,
    CONFIG_LIMITS.requestsPerSecond.min,
    CONFIG_LIMITS.requestsPerSecond.max,
  )
  const accountConcurrencyQuota = Math.floor(
    clampNumber(
      merged.accountConcurrencyQuota,
      CONFIG_LIMITS.accountConcurrencyQuota.min,
      CONFIG_LIMITS.accountConcurrencyQuota.max,
    ),
  )
  const initDurationMs = clampNumber(
    merged.initDurationMs,
    CONFIG_LIMITS.initDurationMs.min,
    CONFIG_LIMITS.initDurationMs.max,
  )
  const idleTimeoutMs = clampNumber(
    merged.idleTimeoutMs,
    CONFIG_LIMITS.idleTimeoutMs.min,
    CONFIG_LIMITS.idleTimeoutMs.max,
  )
  const retiringDurationMs = clampNumber(
    merged.retiringDurationMs,
    CONFIG_LIMITS.retiringDurationMs.min,
    CONFIG_LIMITS.retiringDurationMs.max,
  )

  const reservedConcurrencyEnabled = merged.reservedConcurrencyEnabled === true
  const reservedConcurrency = reservedConcurrencyEnabled
    ? Math.floor(
        clampNumber(merged.reservedConcurrency, 0, maxReservableConcurrency(accountConcurrencyQuota)),
      )
    : 0

  const provisionedTarget: ProvisionedTarget =
    merged.provisionedTarget === 'LATEST' ? 'LATEST' : 'VERSION_OR_ALIAS'

  // Provisioned concurrency cannot be configured on $LATEST.
  const provisionedAllowed = provisionedTarget !== 'LATEST' && merged.provisionedConcurrencyEnabled === true
  const provisionedCeiling = maxProvisionedConcurrency({
    accountConcurrencyQuota,
    reservedConcurrencyEnabled,
    reservedConcurrency,
  })
  const provisionedConcurrency = provisionedAllowed
    ? Math.floor(clampNumber(merged.provisionedConcurrency, 0, provisionedCeiling))
    : 0
  const provisionedConcurrencyEnabled = provisionedAllowed && provisionedConcurrency > 0

  return {
    handlerDurationMs,
    requestsPerSecond,
    accountConcurrencyQuota,
    initDurationMs,
    idleTimeoutMs,
    retiringDurationMs,
    reservedConcurrencyEnabled,
    reservedConcurrency,
    provisionedConcurrencyEnabled,
    provisionedConcurrency,
    provisionedTarget,
  }
}

export interface EnvironmentHistoryEntry {
  state: EnvironmentState
  atMs: number
}

export interface EnvironmentSnapshot {
  id: string
  kind: EnvironmentKind
  state: EnvironmentState
  stateSinceMs: number
  timeInStateMs: number
  activeRequestId: string | null
  invocations: number
  coldStarts: number
  history: EnvironmentHistoryEntry[]
}

export type SimEventType =
  | 'TRAFFIC_STARTED'
  | 'TRAFFIC_STOPPED'
  | 'TRAFFIC_RATE_CHANGED'
  | 'REQUEST_ACCEPTED'
  | 'REQUEST_THROTTLED'
  | 'ENVIRONMENT_CREATED'
  | 'INIT_COMPLETED'
  | 'INVOKE_STARTED'
  | 'PROVISIONED_ALLOCATION_PROGRESS'
  | 'INVOKE_COMPLETED'
  | 'ENVIRONMENT_RETIRING'
  | 'ENVIRONMENT_RETIRED'
  | 'PROVISIONED_PREPARING'
  | 'PROVISIONED_READY'

export interface ActiveLimitsSnapshot {
  accountConcurrencyQuota: number
  accountRpsCeiling: number
  reservedConcurrency: number | null
  functionRpsCeiling: number | null
  provisionedConcurrency: number | null
  provisionedRpsCeiling: number | null
  scalingUnitsAvailable: number
  scalingUnitCostPerEnvironment: number
}

export interface SimEvent {
  seq: number
  timeMs: number
  type: SimEventType
  requestId?: string
  environmentId?: string
  lane?: ServingLane
  coldStart?: boolean
  spillover?: boolean
  primaryCause?: ThrottleBlocker
  blockers?: ThrottleBlocker[]
  durationMs?: number
  limits?: ActiveLimitsSnapshot
  detail?: string
}

export interface EnvironmentStateCounts {
  initialising: number
  running: number
  warmIdle: number
  provisionedIdle: number
  retiring: number
}

export interface HistorySample {
  tick: number
  timeMs: number
  concurrentExecutions: number
  environments: EnvironmentStateCounts
  offered: number
  accepted: number
  throttled: number
  throttledByCause: Record<ThrottleBlocker, number>
}

export interface SimulationMetrics {
  /** Accepted requests currently in flight. */
  concurrentExecutions: number
  /** Accepted arrivals, including those still in Init. */
  acceptedRequests: number
  /** Function code invocations, excluding throttles. */
  invocations: number
  /** Rejected invocation requests. */
  throttles: number
  /** Always zero: this simulation models no invocation failures. */
  errors: number
  /** Handler duration only, excluding Init. */
  durationAverageMs: number
  durationSumMs: number
  durationSamples: number
  provisionedConcurrencyInvocations: number
  provisionedConcurrencySpilloverInvocations: number
  coldStarts: number
  offeredRequests: number
  throttlesByCause: Record<ThrottleBlocker, number>
}

export interface ThrottleCauseBreakdown {
  cause: ThrottleBlocker
  count: number
  percentage: number
  activeLimit: number | null
}

export interface ProvisionedSnapshot {
  status: ProvisionedStatus
  requested: number
  ready: number
  preparationDelayMs: number
  allocationDurationMs: number
  readyAtMs: number | null
  target: ProvisionedTarget
  allocated: number
  quotaReserved: number
  allocationStartedAtMs: number | null
}

export interface ScalingSnapshot {
  unitsAvailable: number
  maxUnits: number
  refillUnitsPerSecond: number
  unitCostPerEnvironment: number
  capacityUnits: number
  lastExpansionCost: number
}

export interface SimulationSnapshot {
  seed: number
  config: SimulationConfig
  timeMs: number
  tick: number
  trafficRunning: boolean
  requestsPerSecond: number
  demandedConcurrency: number
  activeConcurrencyCap: number
  metrics: SimulationMetrics
  acceptedRequestsPerSecond: number
  throttledRequestsPerSecond: number
  offeredRequestsPerSecond: number
  environments: EnvironmentSnapshot[]
  environmentCounts: EnvironmentStateCounts
  totalEnvironments: number
  warmIdleEnvironments: number
  environmentsCreatedTotal: number
  onDemandEnvironmentsCreated: number
  provisioned: ProvisionedSnapshot
  scaling: ScalingSnapshot
  limits: ActiveLimitsSnapshot
  history: HistorySample[]
  recentEvents: SimEvent[]
  recentThrottleEvents: SimEvent[]
  quotaOccupancy: number
  onDemandConcurrentExecutions: number
  recentThrottles: {
    windowSeconds: number
    total: number
    byCause: ThrottleCauseBreakdown[]
  }
}
