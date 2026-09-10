/**
 * Framework free runtime for the simple screen.
 *
 * The host owns the wall clock and turns real elapsed time into exact 50 ms engine
 * ticks, so every admission still passes through the same kernel checks as the full
 * screen. Nothing here imports React, Zustand or a DOM API, and the clock, the
 * repeating timer and the response channel are all injected, so the whole runtime is
 * unit testable with fakes and needs no global harness hook.
 */

import {
  SCALING_BUCKET_MAX_UNITS,
  TICK_MS,
  advanceSimulation,
  createSimulation,
  getSnapshot,
  sendManualRequest,
  setTrafficRate,
  startTraffic,
  stopTraffic,
  type SimulationConfig,
  type SimulationState,
  type ThrottleBlocker,
} from '../sim'
import { readRing } from '../sim/collections'
import {
  DEFAULT_SIMPLE_CONFIG,
  allocationFor,
  normalizeSimpleConfig,
  requiresRestart,
  type SimpleConfig,
} from './config'
import { SlotField } from './slots'
import type { ScalingPoint, SimpleCommand, SimpleResponse, SimpleSnapshot } from './types'

/** How often the driver wakes to convert real time into engine ticks. */
export const DRIVER_INTERVAL_MS = 20

/** Snapshot publish cadence: at most 20 Hz. The engine clock is unaffected by it. */
export const PUBLISH_INTERVAL_MS = 50

/** A backgrounded tab must not replay minutes of simulation in one driver tick. */
export const MAX_REAL_ELAPSED_MS = 250

/** Hard bound on work per driver tick: 40 ticks is two simulated seconds. */
export const MAX_TICKS_PER_DRIVER_TICK = 40

/** The chart samples exact engine ticks, two of them per point. */
export const HISTORY_SAMPLE_MS = 100

/** Twenty seconds of samples. */
export const HISTORY_POINTS = 200

/** One fixed seed: the simple screen has no seed control, only reproducible runs. */
export const SIMPLE_SEED = 1

export interface SimpleHostDeps {
  now: () => number
  start: (callback: () => void, intervalMs: number) => void
  stop: () => void
  post: (response: SimpleResponse) => void
}

export function toSimulationConfig(config: SimpleConfig): SimulationConfig {
  return {
    handlerDurationMs: config.durationMs,
    requestsPerSecond: config.rps,
    accountConcurrencyQuota: config.quota,
    // Init and idle retirement are teaching toggles; the durations stay legal either way.
    initDurationMs: config.initEnabled ? config.initMs : 0,
    idleTimeoutMs: config.idleMs,
    // Retirement is instantaneous here, so no tile ever shows a RETIRING colour.
    retiringDurationMs: 0,
    reservedConcurrencyEnabled: config.reservedEnabled,
    reservedConcurrency: config.reserved,
    provisionedConcurrencyEnabled: config.provisionedEnabled,
    provisionedConcurrency: config.provisioned,
    provisionedTarget: 'VERSION_OR_ALIAS',
  }
}

export class SimpleHost {
  private readonly deps: SimpleHostDeps
  private readonly field = new SlotField()

  private revision = 0
  private config: SimpleConfig | null = null
  private state: SimulationState | null = null

  /** True only after an explicit Pause. A quiet clock is otherwise just quiescence. */
  private paused = false

  private accumulatorMs = 0
  private lastTickAtMs: number | null = null
  private lastPublishAtMs: number | null = null
  private timerActive = false

  private history: ScalingPoint[] = []
  private scalingRejectionsAtSample = 0
  private lastReject: ThrottleBlocker | null = null

  constructor(deps: SimpleHostDeps) {
    this.deps = deps
  }

  handle(command: SimpleCommand): void {
    const revision = typeof command?.revision === 'number' ? command.revision : this.revision
    try {
      if (command === null || typeof command !== 'object' || typeof command.type !== 'string') {
        throw new Error('A command needs a type.')
      }
      if (command.type === 'INIT') {
        // INIT always starts a run, whatever revision the previous session reached.
        this.revision = revision
        this.reset(command.config)
        this.publish(true)
        return
      }
      // A stale command belongs to a configuration the user has already replaced.
      if (revision < this.revision) return
      this.revision = revision
      this.route(command)
    } catch (error) {
      this.deps.post({
        type: 'ERROR',
        revision,
        message: error instanceof Error ? error.message : String(error),
      })
      // A failed command must not leave a clock running behind an error message.
      this.stopClock()
    }
  }

  dispose(): void {
    this.timerActive = false
    this.deps.stop()
    this.state = null
  }

  /** Stop the driver, so the screen never shows a clock that is not actually running. */
  stopClock(): void {
    this.paused = true
    this.accumulatorMs = 0
    this.syncTimer()
    if (this.state) this.publish(true)
  }

  /** Publish immediately, ignoring the publish cadence. */
  flush(): void {
    this.publish(true)
  }

  get currentRevision(): number {
    return this.revision
  }

  private route(command: SimpleCommand): void {
    switch (command.type) {
      case 'CONFIGURE':
        this.configure(command.config)
        break
      case 'START':
        startTraffic(this.require())
        this.syncTimer()
        break
      case 'STOP':
        // Arrivals stop; the clock keeps running so in-flight work drains and the
        // scaling bucket refills, and it ends by itself once nothing is left to do.
        stopTraffic(this.require())
        this.syncTimer()
        break
      case 'MANUAL':
        this.manual()
        return
      case 'RESET':
        this.reset(this.requireConfig())
        break
      case 'PAUSE':
        this.require()
        this.paused = true
        this.accumulatorMs = 0
        this.syncTimer()
        break
      case 'RESUME':
        this.require()
        this.paused = false
        this.syncTimer()
        break
      case 'STEP':
        this.require()
        // A step is only meaningful against a stopped clock, so the runtime enforces it
        // rather than trusting the screen to hide the control.
        if (!this.paused) throw new Error('Step needs a paused clock.')
        this.advance(1)
        this.syncTimer()
        break
      default: {
        const unknown = command as { type?: unknown }
        throw new Error(`Unknown command: ${String(unknown.type)}`)
      }
    }
    this.publish(true)
  }

  private manual(): void {
    const state = this.require()
    const throttlesBefore = state.metrics.throttles
    sendManualRequest(state)
    const accepted = state.manual.lastOutcome === 'ACCEPTED'
    let cause: ThrottleBlocker | null = null
    if (!accepted && state.metrics.throttles > throttlesBefore) {
      cause = readRing(state.throttleEvents).at(-1)?.primaryCause ?? null
      this.lastReject = cause ?? this.lastReject
    }
    this.deps.post({ type: 'MANUAL_RESULT', revision: this.revision, accepted, cause })
    // A click never starts the arrival stream, but the clock does have to run so the
    // request can init, complete and give its scaling units back. It leaves the driver
    // accumulator alone: repeated clicks during a running stream would otherwise throw
    // away fractional real time that has not yet become a whole tick.
    this.syncTimer()
    this.publish(true)
  }

  private configure(input: SimpleConfig): void {
    const before = this.config
    const state = this.state
    if (!before || !state) throw new Error('The simulation has not been initialised yet.')
    const after = normalizeSimpleConfig(input)
    if (!requiresRestart(before, after)) {
      // Request rate and speed are the only live edits: they never rebuild a run.
      this.config = after
      if (after.rps !== before.rps) setTrafficRate(state, after.rps)
      // Only a new speed multiplier re-settles the driver. A rate edit, which a slider
      // sends on every drag, must not discard real time that is not yet a whole tick.
      if (after.speed !== before.speed) this.resync()
      else this.syncTimer()
      return
    }
    // Every other edit is a different function, so it needs a new run from time zero,
    // and it keeps the transport exactly as the user left it.
    const running = state.trafficRunning
    const paused = this.paused
    this.reset(after)
    if (running) startTraffic(this.require())
    this.paused = paused
    this.resync()
  }

  private reset(input: SimpleConfig): void {
    const config = normalizeSimpleConfig(input)
    this.config = config
    this.state = createSimulation(toSimulationConfig(config), SIMPLE_SEED, {
      // The simple screen teaches steady state, not the minutes provisioned
      // concurrency really takes to prepare.
      provisionedReadyAtStart: true,
      idleRetirementEnabled: config.idleEnabled,
    })
    this.paused = false
    this.field.reset()
    this.history = []
    this.scalingRejectionsAtSample = 0
    this.lastReject = null
    this.accumulatorMs = 0
    this.lastTickAtMs = this.deps.now()
    this.lastPublishAtMs = null
    this.sample()
    this.syncTimer()
  }

  private require(): SimulationState {
    if (!this.state) throw new Error('The simulation has not been initialised yet.')
    return this.state
  }

  private requireConfig(): SimpleConfig {
    return this.config ?? DEFAULT_SIMPLE_CONFIG
  }

  private resync(): void {
    this.accumulatorMs = 0
    this.lastTickAtMs = this.deps.now()
    this.syncTimer()
  }

  /**
   * Nothing left to animate: no request in flight, no idle retirement pending, and the
   * scaling bucket has refilled, so further ticks would only move the clock.
   */
  private isQuiescent(): boolean {
    const state = this.state
    if (!state) return true
    if (state.trafficRunning) return false
    if (state.queue.size > 0) return false
    for (const environment of state.environments.values()) {
      if (environment.state === 'INITIALISING' || environment.state === 'RUNNING') return false
      if (environment.state === 'RETIRING') return false
    }
    return state.bucket.balance >= SCALING_BUCKET_MAX_UNITS - 1e-9
  }

  private syncTimer(): void {
    const shouldRun = this.state !== null && !this.paused && !this.isQuiescent()
    if (shouldRun && !this.timerActive) {
      this.timerActive = true
      this.lastTickAtMs = this.deps.now()
      this.deps.start(() => this.tick(), DRIVER_INTERVAL_MS)
      return
    }
    if (!shouldRun && this.timerActive) {
      this.timerActive = false
      this.deps.stop()
    }
  }

  private tick(): void {
    const now = this.deps.now()
    if (!this.state || this.paused) {
      this.lastTickAtMs = now
      return
    }
    const previous = this.lastTickAtMs ?? now
    const realElapsed = Math.max(0, Math.min(MAX_REAL_ELAPSED_MS, now - previous))
    this.lastTickAtMs = now
    this.accumulatorMs += realElapsed * (this.config?.speed ?? 1)

    let ticks = Math.floor((this.accumulatorMs + 1e-9) / TICK_MS)
    if (ticks > MAX_TICKS_PER_DRIVER_TICK) {
      // Drop the excess rather than queue it, or the engine clock would chase the
      // wall clock forever after one stall.
      ticks = MAX_TICKS_PER_DRIVER_TICK
      this.accumulatorMs = 0
    } else {
      this.accumulatorMs -= ticks * TICK_MS
    }
    if (ticks > 0) this.advance(ticks)

    if (this.isQuiescent()) {
      this.accumulatorMs = 0
      this.syncTimer()
      this.publish(true, now)
      return
    }
    this.publish(false, now)
  }

  /** Exact engine ticks, with the chart sampled on exact 100 ms boundaries. */
  private advance(ticks: number): void {
    const state = this.require()
    for (let index = 0; index < ticks; index += 1) {
      advanceSimulation(state, TICK_MS)
      if (state.timeMs % HISTORY_SAMPLE_MS === 0) this.sample()
      if (this.isQuiescent()) break
    }
  }

  private sample(): void {
    const state = this.require()
    const total = state.metrics.throttlesByCause.SCALING_RATE
    this.history.push({
      timeMs: state.timeMs,
      units: state.bucket.balance,
      scalingRejections: total - this.scalingRejectionsAtSample,
    })
    this.scalingRejectionsAtSample = total
    if (this.history.length > HISTORY_POINTS) this.history.shift()
  }

  private publish(force: boolean, nowMs = this.deps.now()): void {
    if (!this.state || !this.config) return
    if (!force && this.lastPublishAtMs !== null && nowMs - this.lastPublishAtMs < PUBLISH_INTERVAL_MS) return
    this.lastPublishAtMs = nowMs
    this.deps.post({ type: 'SNAPSHOT', revision: this.revision, snapshot: this.snapshot() })
  }

  /** The snapshot the screen renders. Public so a test never needs a global hook. */
  snapshot(): SimpleSnapshot {
    const state = this.require()
    const config = this.config ?? DEFAULT_SIMPLE_CONFIG
    const raw = getSnapshot(state)
    const lastThrottle = readRing(state.throttleEvents).at(-1)?.primaryCause
    if (lastThrottle) this.lastReject = lastThrottle
    const pool = allocationFor(config).unreservedPool
    // One projection per snapshot: the grid and its countdown rings must describe the
    // same frame, so the tile mapping is never run twice.
    const projection = this.field.project(config, raw.environments)
    return {
      config: { ...config },
      timeMs: raw.timeMs,
      trafficRunning: raw.trafficRunning,
      paused: this.paused,
      slots: projection.slots,
      remainingMs: projection.remainingMs,
      concurrent: raw.metrics.concurrentExecutions,
      running: raw.environmentCounts.running,
      initialising: raw.environmentCounts.initialising,
      // Warm reuse still happens in the kernel with the lifecycle toggle off; it is
      // simply not part of the story on screen, so it is reported as nothing.
      warm: config.idleEnabled ? raw.environmentCounts.warmIdle : 0,
      accepted: raw.metrics.acceptedRequests,
      completed: raw.metrics.durationSamples,
      rejected: raw.metrics.throttles,
      acceptedRps: raw.acceptedRequestsPerSecond,
      rejectedRps: raw.throttledRequestsPerSecond,
      units: raw.scaling.unitsAvailable,
      quotaOccupancy: raw.quotaOccupancy,
      // A reservation is charged to the pool whole, so on-demand work inside it takes
      // nothing further from the unreserved space.
      unreservedAvailable: Math.max(
        0,
        config.reservedEnabled ? pool : pool - raw.onDemandConcurrentExecutions,
      ),
      throttlesByCause: { ...raw.metrics.throttlesByCause },
      lastReject: this.lastReject,
      history: this.history.map(point => ({ ...point })),
    }
  }
}
