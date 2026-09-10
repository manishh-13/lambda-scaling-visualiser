import type { AppConfig } from '../lib/urlState'
import type { ProvisionedStatus, SimEvent } from '../sim/types'
import type { VisualEnvironment } from '../renderers/types'
import type { TimelinePoint } from '../components/TimelineCharts'
import type { CauseKey } from '../components/ThrottleDiagnosis'

export interface UiMetrics {
  demandedConcurrency: number
  concurrentExecutions: number
  acceptedRps: number
  throttledRps: number
  totalEnvironments: number
  warmIdle: number
  scalingTokens: number
  activeCap: number
  invocations: number
  throttles: number
  errors: number
  durationMs: number
  provisionedInvocations: number
  spilloverInvocations: number
  /** Admissions, counted from the start of Init. Invocations count handler starts. */
  acceptedRequests: number
  /** False until at least one handler completed, so Duration has no sample yet. */
  durationHasSamples: boolean
  /** Configured requests per second. Use this for the live formula. */
  configuredRps: number
  /** Requests actually offered right now. Zero while traffic is stopped. */
  offeredRps: number
  /** Init runs since reset. A cold start is one Init of a new on-demand environment. */
  coldStarts: number
  /** Concurrency held against the account quota, provisioned allocation included. */
  quotaOccupancy: number
  /** In-flight requests served by on-demand capacity only. */
  onDemandConcurrentExecutions: number
}

/** Provisioned allocation timing, enough for a UI progress read without guessing. */
export interface UiProvisioned {
  status: ProvisionedStatus
  requested: number
  ready: number
  /** Pre-initialized environments, unusable until the whole allocation is ready. */
  allocated: number
  preparationDelayMs: number
  allocationDurationMs: number
  allocationStartedAtMs: number | null
  readyAtMs: number | null
  /** Allocation progress from 0 to 1, derived from simulated time and readyAtMs. */
  progress: number
  /** Concurrency held against the quota from the allocation request onwards. */
  quotaReserved: number
}

/**
 * A recent 429, carried through with every engine field intact: seq, type,
 * timeMs, requestId, the full blocker list, and the limits that were active at
 * the moment of rejection. The diagnosis panel needs all of it.
 */
export type UiThrottleEvent = SimEvent & {
  primaryCause: CauseKey
  blockers: CauseKey[]
}

export interface ComparisonLaneSnapshot {
  concurrentExecutions: number
  totalEnvironments: number
  initialising: number
  running: number
  warmIdle: number
  provisionedIdle: number
  invocations: number
  coldStarts: number
  /** Simulated time for this lane. Both lanes always advance by the same ticks. */
  timeMs: number
  environments: VisualEnvironment[]
  metrics: UiMetrics
  provisioned: UiProvisioned
  /** Bounded sample of the most recent 429s in this lane. */
  recentThrottleEvents: UiThrottleEvent[]
}

export interface ComparisonSnapshot {
  left: ComparisonLaneSnapshot
  right: ComparisonLaneSnapshot
}

export interface UiSnapshot {
  timeMs: number
  trafficActive: boolean
  provisionedStatus: ProvisionedStatus
  environments: VisualEnvironment[]
  metrics: UiMetrics
  causes: Record<CauseKey, number>
  timeline: TimelinePoint[]
  narration: string
  comparison?: ComparisonSnapshot
  provisioned: UiProvisioned
  /** Bounded sample of the most recent 429s, for the diagnosis panel. */
  recentThrottleEvents: UiThrottleEvent[]
  /** True while the worker owned wall clock driver is advancing the engine. */
  clockRunning: boolean
  /** True when the engine clock is halted, whatever halted it. */
  paused: boolean
  /**
   * True only when the halt came from an explicit Pause. When it is false the
   * clock is sitting on an idle start line and Start will begin the animation.
   */
  pausedByUser: boolean
  /** In comparison mode, traffic cannot start until the prepared lane is READY. */
  canStartTraffic: boolean
}

export type WorkerCommandType =
  | 'INIT'
  | 'RESET'
  | 'START'
  | 'STOP'
  | 'PAUSE'
  | 'RESUME'
  | 'STEP'
  | 'SET_SPEED'
  | 'PREPARE_TO_READY'

interface CommandEnvelope {
  /** Monotonic identifier so the main thread can match an acknowledgment. */
  commandId: number
}

export interface WorkerInit extends CommandEnvelope {
  type: 'INIT'
  config: AppConfig
}

export interface WorkerReset extends CommandEnvelope {
  type: 'RESET'
  config: AppConfig
}

export interface WorkerSetSpeed extends CommandEnvelope {
  type: 'SET_SPEED'
  speed: number
}

/** Omit that distributes across a union, so each variant keeps its own shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A command before the store stamps its identifier on it. */
export type WorkerCommandDraft = DistributiveOmit<WorkerCommand, 'commandId'>

export type WorkerCommand =
  | WorkerInit
  | WorkerReset
  | WorkerSetSpeed
  | (CommandEnvelope & { type: 'START' })
  | (CommandEnvelope & { type: 'STOP' })
  | (CommandEnvelope & { type: 'PAUSE' })
  | (CommandEnvelope & { type: 'RESUME' })
  | (CommandEnvelope & { type: 'STEP' })
  | (CommandEnvelope & { type: 'PREPARE_TO_READY' })

export interface WorkerSnapshotResponse {
  type: 'SNAPSHOT'
  /** Bumped by INIT and RESET. The main thread drops snapshots from older runs. */
  revision: number
  snapshot: UiSnapshot
}

export interface WorkerAckResponse {
  type: 'ACK'
  commandId: number
  command: WorkerCommandType
  revision: number
  accepted: boolean
  /** Present when a command was refused, for example starting before READY. */
  reason?: string
}

export interface WorkerErrorResponse {
  type: 'ERROR'
  message: string
  command?: WorkerCommandType
}

export type WorkerResponse = WorkerSnapshotResponse | WorkerAckResponse | WorkerErrorResponse
