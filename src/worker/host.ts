/**
 * Framework free command handler for the simulation worker.
 *
 * The worker owns the wall clock. It converts real elapsed time into exact
 * 50 ms simulation steps, bounds how much work one driver tick may do, and
 * publishes snapshots on its own slower cadence. Nothing here imports React,
 * Zustand, or a DOM API, and both the clock and the repeating timer are
 * injected, so the whole runtime is unit testable with fake clocks.
 */

import {
  TICK_MS,
  advanceSimulation,
  createSimulation,
  getSnapshot,
  startTraffic,
  stopTraffic,
  type SimulationConfig,
  type SimulationSnapshot,
  type SimulationState,
} from '../sim'
import type { AppConfig } from '../lib/urlState'
import {
  INITIAL_NARRATION,
  NARRATION_MIN_INTERVAL_MS,
  NarrationLimiter,
  buildNarration,
  type NarrationInput,
  type NarrationThrottleCause,
} from '../lib/narration'
import type {
  ComparisonLaneSnapshot,
  UiMetrics,
  UiProvisioned,
  UiSnapshot,
  UiThrottleEvent,
  WorkerCommand,
  WorkerCommandType,
  WorkerResponse,
} from '../store/types'

/** How often the driver wakes to convert real time into simulation steps. */
export const DRIVER_INTERVAL_MS = 20

/** Snapshot publish cadence, about 15 Hz. The engine clock is unaffected by it. */
export const SNAPSHOT_INTERVAL_MS = 66

/** A tab that was backgrounded must not replay minutes of simulation at once. */
export const MAX_REAL_ELAPSED_MS = 250

/** Hard bound on work per driver tick: 40 steps is two simulated seconds. */
export const MAX_STEPS_PER_DRIVER_TICK = 40

/** Bound on the deterministic prepare-to-ready fast forward. */
export const MAX_PREPARE_MS = 300_000

export const MAX_THROTTLE_EVENT_SAMPLES = 32

export const TIMELINE_SAMPLES = 240

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4]

export interface HostClock {
  /** Monotonic real time in milliseconds. */
  now(): number
}

export interface HostTimer {
  start(callback: () => void, intervalMs: number): void
  stop(): void
}

export interface HostDeps {
  clock: HostClock
  timer: HostTimer
  post(response: WorkerResponse): void
}

const THROTTLE_CAUSES: readonly NarrationThrottleCause[] = [
  'RPS_CEILING',
  'RESERVED_CONCURRENCY',
  'ACCOUNT_CONCURRENCY',
  'SCALING_RATE',
]

function toSimulationConfig(config: AppConfig): SimulationConfig {
  return {
    handlerDurationMs: config.handlerDurationMs,
    requestsPerSecond: config.requestsPerSecond,
    accountConcurrencyQuota: config.accountQuota,
    initDurationMs: config.initDurationMs,
    idleTimeoutMs: config.idleTimeoutMs,
    retiringDurationMs: 400,
    reservedConcurrencyEnabled: config.reservedEnabled,
    reservedConcurrency: config.reservedConcurrency,
    provisionedConcurrencyEnabled: config.provisionedEnabled,
    provisionedConcurrency: config.provisionedConcurrency,
    provisionedTarget: config.target === 'latest' ? 'LATEST' : 'VERSION_OR_ALIAS',
  }
}

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1
  let closest = SPEED_OPTIONS[0]
  for (const option of SPEED_OPTIONS) {
    if (Math.abs(option - speed) < Math.abs(closest - speed)) closest = option
  }
  return closest
}

function toUiMetrics(snapshot: SimulationSnapshot): UiMetrics {
  const hasSamples = snapshot.metrics.durationSamples > 0
  return {
    demandedConcurrency: snapshot.demandedConcurrency,
    concurrentExecutions: snapshot.metrics.concurrentExecutions,
    acceptedRps: snapshot.acceptedRequestsPerSecond,
    throttledRps: snapshot.throttledRequestsPerSecond,
    totalEnvironments: snapshot.totalEnvironments,
    warmIdle: snapshot.warmIdleEnvironments,
    scalingTokens: snapshot.scaling.unitsAvailable,
    activeCap: snapshot.activeConcurrencyCap,
    invocations: snapshot.metrics.invocations,
    throttles: snapshot.metrics.throttles,
    errors: snapshot.metrics.errors,
    durationMs: hasSamples ? snapshot.metrics.durationAverageMs : snapshot.config.handlerDurationMs,
    provisionedInvocations: snapshot.metrics.provisionedConcurrencyInvocations,
    spilloverInvocations: snapshot.metrics.provisionedConcurrencySpilloverInvocations,
    acceptedRequests: snapshot.metrics.acceptedRequests,
    durationHasSamples: hasSamples,
    configuredRps: snapshot.config.requestsPerSecond,
    offeredRps: snapshot.trafficRunning ? snapshot.offeredRequestsPerSecond : 0,
    coldStarts: snapshot.metrics.coldStarts,
    quotaOccupancy: snapshot.quotaOccupancy,
    onDemandConcurrentExecutions: snapshot.onDemandConcurrentExecutions,
  }
}

function toUiProvisioned(snapshot: SimulationSnapshot): UiProvisioned {
  const readyAtMs = snapshot.provisioned.readyAtMs
  const startedAtMs = snapshot.provisioned.allocationStartedAtMs ?? 0
  // Progress runs against readyAtMs on the absolute simulated timeline, so it
  // never resets when the preparation delay hands over to allocation.
  const progress =
    snapshot.provisioned.status === 'READY'
      ? 1
      : snapshot.provisioned.status !== 'PREPARING' || readyAtMs === null || readyAtMs <= 0
        ? 0
        : Math.max(0, Math.min(1, snapshot.timeMs / readyAtMs))
  return {
    status: snapshot.provisioned.status,
    requested: snapshot.provisioned.requested,
    ready: snapshot.provisioned.ready,
    allocated: snapshot.provisioned.allocated,
    preparationDelayMs: snapshot.provisioned.preparationDelayMs,
    allocationDurationMs: snapshot.provisioned.allocationDurationMs,
    allocationStartedAtMs: snapshot.provisioned.allocationStartedAtMs,
    readyAtMs,
    progress,
    quotaReserved: snapshot.provisioned.quotaReserved,
  }
}

function isThrottleCause(value: unknown): value is NarrationThrottleCause {
  return typeof value === 'string' && (THROTTLE_CAUSES as readonly string[]).includes(value)
}

/**
 * Carry every engine field through, including the limits that were active when
 * the request was rejected, and narrow the cause fields so the diagnosis panel
 * never has to handle a missing primary cause.
 */
function toUiThrottleEvents(snapshot: SimulationSnapshot): UiThrottleEvent[] {
  const events: UiThrottleEvent[] = []
  for (const event of snapshot.recentThrottleEvents.slice(-MAX_THROTTLE_EVENT_SAMPLES)) {
    if (!isThrottleCause(event.primaryCause)) continue
    events.push({
      ...event,
      primaryCause: event.primaryCause,
      blockers: (event.blockers ?? [event.primaryCause]).filter(isThrottleCause),
      ...(event.limits ? { limits: { ...event.limits } } : {}),
    })
  }
  return events
}

function toVisualEnvironments(snapshot: SimulationSnapshot): UiSnapshot['environments'] {
  return snapshot.environments.map((environment) => ({
    id: environment.id,
    type: environment.kind,
    state: environment.state === 'INITIALISING' ? ('INITIALIZING' as const) : environment.state,
    activeRequestId: environment.activeRequestId ?? undefined,
    stateSinceMs: environment.stateSinceMs,
    totalInvocations: environment.invocations,
    coldStarts: environment.coldStarts,
    progress:
      environment.state === 'RUNNING' && snapshot.config.handlerDurationMs > 0
        ? Math.max(0, Math.min(1, environment.timeInStateMs / snapshot.config.handlerDurationMs))
        : 0,
    initProgress:
      environment.state === 'INITIALISING' && snapshot.config.initDurationMs > 0
        ? Math.max(0, Math.min(1, environment.timeInStateMs / snapshot.config.initDurationMs))
        : 0,
    recentHistory: environment.history.map((entry) => ({ state: entry.state, atMs: entry.atMs })),
  }))
}

function toComparisonLane(snapshot: SimulationSnapshot): ComparisonLaneSnapshot {
  return {
    concurrentExecutions: snapshot.metrics.concurrentExecutions,
    totalEnvironments: snapshot.totalEnvironments,
    initialising: snapshot.environmentCounts.initialising,
    running: snapshot.environmentCounts.running,
    warmIdle: snapshot.environmentCounts.warmIdle,
    provisionedIdle: snapshot.environmentCounts.provisionedIdle,
    invocations: snapshot.metrics.invocations,
    coldStarts: snapshot.metrics.coldStarts,
    timeMs: snapshot.timeMs,
    environments: toVisualEnvironments(snapshot),
    metrics: toUiMetrics(snapshot),
    provisioned: toUiProvisioned(snapshot),
    recentThrottleEvents: toUiThrottleEvents(snapshot),
  }
}

function toNarrationInput(
  snapshot: SimulationSnapshot,
  clockRunning: boolean,
  provisioned: UiProvisioned,
): NarrationInput {
  const byCause = {
    RPS_CEILING: 0,
    RESERVED_CONCURRENCY: 0,
    ACCOUNT_CONCURRENCY: 0,
    SCALING_RATE: 0,
  } as Record<NarrationThrottleCause, number>
  for (const item of snapshot.recentThrottles.byCause) {
    if (isThrottleCause(item.cause)) byCause[item.cause] = item.count
  }
  return {
    timeMs: snapshot.timeMs,
    trafficRunning: snapshot.trafficRunning,
    clockRunning,
    totalEnvironments: snapshot.totalEnvironments,
    initialising: snapshot.environmentCounts.initialising,
    running: snapshot.environmentCounts.running,
    warmIdle: snapshot.environmentCounts.warmIdle,
    provisionedIdle: snapshot.environmentCounts.provisionedIdle,
    provisionedStatus: provisioned.status,
    provisionedProgress: provisioned.progress,
    provisionedRequested: provisioned.requested,
    provisionedAllocated: provisioned.allocated,
    recentThrottleTotal: snapshot.recentThrottles.total,
    recentThrottlesByCause: byCause,
    invocations: snapshot.metrics.invocations,
    provisionedInvocations: snapshot.metrics.provisionedConcurrencyInvocations,
    spilloverInvocations: snapshot.metrics.provisionedConcurrencySpilloverInvocations,
    coldStarts: snapshot.metrics.coldStarts,
  }
}

export class SimulationHost {
  private readonly deps: HostDeps
  private readonly narration: NarrationLimiter

  private revision = 0
  private config: AppConfig | null = null
  private speed = 1

  /** The configured lane. In comparison mode this is the provisioned side. */
  private main: SimulationState | null = null
  /** Comparison only: provisioned concurrency disabled, every other setting equal. */
  private left: SimulationState | null = null
  private comparisonMode = false

  /**
   * The engine clock only advances while this is false. A reset lands paused at
   * time zero, so nothing runs until the user acts.
   */
  private paused = true

  /**
   * True only when the halt came from an explicit Pause. A halt that came from a
   * reset or from prepare-to-ready is an idle start line instead, and Start is
   * allowed to release it so pressing Start traffic visibly runs the simulation.
   */
  private pausedByUser = false

  private accumulatorMs = 0
  private lastTickAtMs: number | null = null
  private lastPublishAtMs: number | null = null
  private timerActive = false
  private narrationBasis: NarrationInput | null = null

  constructor(deps: HostDeps, narrationIntervalMs = NARRATION_MIN_INTERVAL_MS) {
    this.deps = deps
    this.narration = new NarrationLimiter(narrationIntervalMs)
  }

  handle(command: WorkerCommand): void {
    try {
      this.route(command)
    } catch (error) {
      this.deps.post({
        type: 'ERROR',
        command: command?.type,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  dispose(): void {
    this.timerActive = false
    this.deps.timer.stop()
    this.main = null
    this.left = null
  }

  /** Visible for tests and for the worker entry point. */
  get currentRevision(): number {
    return this.revision
  }

  /** Publish the current state immediately, ignoring the snapshot cadence. */
  flush(): void {
    this.publish(true)
  }

  private route(command: WorkerCommand): void {
    switch (command.type) {
      case 'INIT':
      case 'RESET':
        this.reset(command.config)
        this.publish(true)
        this.ack(command, true)
        return
      case 'START':
        this.onStart(command)
        return
      case 'STOP':
        this.requireState()
        stopTraffic(this.main!)
        if (this.left) stopTraffic(this.left)
        this.publish(true)
        this.ack(command, true)
        return
      case 'PAUSE':
        this.requireState()
        this.paused = true
        this.pausedByUser = true
        this.syncTimer()
        this.accumulatorMs = 0
        this.publish(true)
        this.ack(command, true)
        return
      case 'RESUME':
        this.requireState()
        this.paused = false
        this.pausedByUser = false
        this.accumulatorMs = 0
        this.lastTickAtMs = this.deps.clock.now()
        this.syncTimer()
        this.publish(true)
        this.ack(command, true)
        return
      case 'STEP':
        this.onStep(command)
        return
      case 'SET_SPEED':
        this.speed = clampSpeed(command.speed)
        this.accumulatorMs = 0
        this.lastTickAtMs = this.deps.clock.now()
        this.ack(command, true)
        return
      case 'PREPARE_TO_READY':
        this.onPrepareToReady(command)
        return
      default: {
        const unknown = command as { type?: string }
        this.deps.post({ type: 'ERROR', message: `Unknown command: ${String(unknown?.type)}` })
      }
    }
  }

  private onStart(command: WorkerCommand): void {
    this.requireState()
    if (!this.canStartTraffic()) {
      this.ack(command, false, 'PROVISIONED_NOT_READY')
      return
    }
    startTraffic(this.main!)
    if (this.left) startTraffic(this.left)
    // Start always begins arrivals. It also releases an idle start line, but it
    // never overrides an explicit Pause, which only Resume or Step may follow.
    if (this.paused && !this.pausedByUser) this.paused = false
    this.lastTickAtMs = this.deps.clock.now()
    this.accumulatorMs = 0
    this.syncTimer()
    this.publish(true)
    this.ack(command, true)
  }

  private onStep(command: WorkerCommand): void {
    this.requireState()
    if (!this.paused) {
      this.ack(command, false, 'STEP_REQUIRES_PAUSE')
      return
    }
    this.advanceAll(TICK_MS)
    this.publish(true)
    this.ack(command, true)
  }

  private onPrepareToReady(command: WorkerCommand): void {
    this.requireState()
    const provisioned = getSnapshot(this.main!).provisioned
    if (provisioned.status === 'READY') {
      this.ack(command, true)
      return
    }
    if (provisioned.status !== 'PREPARING' || provisioned.readyAtMs === null) {
      this.ack(command, false, 'PROVISIONED_NOT_CONFIGURED')
      return
    }

    // Preparation runs with no arrivals so both lanes reach READY at the same
    // simulated time with an empty environment field, which makes the later
    // start of traffic deterministic.
    stopTraffic(this.main!)
    if (this.left) stopTraffic(this.left)

    const remaining = Math.max(0, provisioned.readyAtMs - getSnapshot(this.main!).timeMs)
    const target = Math.min(MAX_PREPARE_MS, Math.ceil(remaining / TICK_MS) * TICK_MS)
    for (let elapsed = 0; elapsed < target; elapsed += TICK_MS) this.advanceAll(TICK_MS)

    // Halt afterwards so traffic can start from an exact, reproducible instant.
    // This is an idle start line, not an explicit pause, so Start releases it.
    this.paused = true
    this.pausedByUser = false
    this.accumulatorMs = 0
    this.syncTimer()
    this.publish(true)
    const ready = getSnapshot(this.main!).provisioned.status === 'READY'
    this.ack(command, ready, ready ? undefined : 'PREPARE_BOUND_REACHED')
  }

  private reset(config: AppConfig): void {
    this.revision += 1
    this.config = config
    this.speed = clampSpeed(config.speed)
    this.comparisonMode = config.comparisonMode === true

    const simConfig = toSimulationConfig(config)
    this.main = createSimulation(simConfig, config.seed)
    this.left = this.comparisonMode
      ? createSimulation(
          {
            ...simConfig,
            // Same reserved setting, provisioned concurrency off. Nothing else differs.
            provisionedConcurrencyEnabled: false,
            provisionedConcurrency: 0,
          },
          config.seed,
        )
      : null

    this.paused = true
    this.pausedByUser = false
    this.accumulatorMs = 0
    this.lastTickAtMs = this.deps.clock.now()
    this.lastPublishAtMs = null
    this.narrationBasis = null
    this.narration.reset(INITIAL_NARRATION)
    this.syncTimer()
  }

  private requireState(): void {
    if (!this.main) throw new Error('The simulation has not been initialized yet.')
  }

  private canStartTraffic(): boolean {
    if (!this.comparisonMode || !this.main) return true
    return getSnapshot(this.main).provisioned.status === 'READY'
  }

  private isClockRunning(): boolean {
    return this.main !== null && !this.paused
  }

  private syncTimer(): void {
    const shouldRun = this.isClockRunning()
    if (shouldRun && !this.timerActive) {
      this.lastTickAtMs = this.deps.clock.now()
      this.timerActive = true
      this.deps.timer.start(() => this.tick(), DRIVER_INTERVAL_MS)
      return
    }
    if (!shouldRun && this.timerActive) {
      this.timerActive = false
      this.deps.timer.stop()
    }
  }

  /** One driver tick: real elapsed time becomes whole 50 ms simulation steps. */
  private tick(): void {
    const now = this.deps.clock.now()
    if (!this.isClockRunning()) {
      this.lastTickAtMs = now
      return
    }
    const previous = this.lastTickAtMs ?? now
    const realElapsed = Math.max(0, Math.min(MAX_REAL_ELAPSED_MS, now - previous))
    this.lastTickAtMs = now
    this.accumulatorMs += realElapsed * this.speed

    let steps = Math.floor((this.accumulatorMs + 1e-9) / TICK_MS)
    if (steps > MAX_STEPS_PER_DRIVER_TICK) {
      // Drop the excess instead of queueing it. A backlog would make the engine
      // clock run away from the wall clock forever.
      steps = MAX_STEPS_PER_DRIVER_TICK
      this.accumulatorMs = 0
    } else {
      this.accumulatorMs -= steps * TICK_MS
    }
    if (steps > 0) this.advanceAll(steps * TICK_MS)
    this.publishIfDue(now)
  }

  private advanceAll(elapsedMs: number): void {
    if (elapsedMs <= 0) return
    if (elapsedMs % TICK_MS !== 0) {
      throw new Error(`Simulation time must advance in ${TICK_MS} ms steps, received ${elapsedMs}.`)
    }
    if (this.main) advanceSimulation(this.main, elapsedMs)
    if (this.left) advanceSimulation(this.left, elapsedMs)
  }

  private publishIfDue(nowMs: number): void {
    if (this.lastPublishAtMs !== null && nowMs - this.lastPublishAtMs < SNAPSHOT_INTERVAL_MS) return
    this.publish(false, nowMs)
  }

  private publish(force: boolean, nowMs = this.deps.clock.now()): void {
    if (!this.main || !this.config) return
    if (!force && this.lastPublishAtMs !== null && nowMs - this.lastPublishAtMs < SNAPSHOT_INTERVAL_MS) {
      return
    }
    this.lastPublishAtMs = nowMs
    const raw = getSnapshot(this.main)
    const provisioned = toUiProvisioned(raw)
    const clockRunning = this.isClockRunning()

    const input = toNarrationInput(raw, clockRunning, provisioned)
    const candidate = buildNarration(input, this.narrationBasis)
    const before = this.narration.current
    const narration = this.narration.next(candidate, nowMs)
    if (narration !== before || this.narrationBasis === null) this.narrationBasis = input

    const snapshot: UiSnapshot = {
      timeMs: raw.timeMs,
      trafficActive: raw.trafficRunning,
      provisionedStatus: provisioned.status,
      environments: toVisualEnvironments(raw),
      metrics: toUiMetrics(raw),
      causes: {
        RPS_CEILING: 0,
        RESERVED_CONCURRENCY: 0,
        ACCOUNT_CONCURRENCY: 0,
        SCALING_RATE: 0,
      },
      timeline: raw.history.slice(-TIMELINE_SAMPLES).map((sample) => ({
        timeMs: sample.timeMs,
        initializing: sample.environments.initialising,
        running: sample.environments.running,
        warmIdle: sample.environments.warmIdle,
        provisionedIdle: sample.environments.provisionedIdle,
        retiring: sample.environments.retiring,
        throttledRps: sample.throttled * (1000 / TICK_MS),
      })),
      narration,
      provisioned,
      recentThrottleEvents: toUiThrottleEvents(raw),
      clockRunning,
      paused: this.paused,
      pausedByUser: this.pausedByUser,
      canStartTraffic: this.canStartTraffic(),
      ...(this.left
        ? {
            comparison: {
              left: toComparisonLane(getSnapshot(this.left)),
              right: toComparisonLane(raw),
            },
          }
        : {}),
    }
    for (const item of raw.recentThrottles.byCause) {
      if (isThrottleCause(item.cause)) snapshot.causes[item.cause] = item.count
    }

    this.deps.post({ type: 'SNAPSHOT', revision: this.revision, snapshot })
  }

  private ack(command: WorkerCommand, accepted: boolean, reason?: string): void {
    this.deps.post({
      type: 'ACK',
      commandId: command.commandId,
      command: command.type as WorkerCommandType,
      revision: this.revision,
      accepted,
      ...(reason ? { reason } : {}),
    })
  }
}
