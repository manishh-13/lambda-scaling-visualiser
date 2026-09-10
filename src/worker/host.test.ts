import { beforeEach, describe, expect, it } from 'vitest'
import {
  DRIVER_INTERVAL_MS,
  MAX_REAL_ELAPSED_MS,
  MAX_STEPS_PER_DRIVER_TICK,
  SNAPSHOT_INTERVAL_MS,
  SimulationHost,
  type HostClock,
  type HostTimer,
} from './host'
import { DEFAULT_APP_CONFIG, normalizeConfig, type AppConfig } from '../lib/urlState'
import type { UiSnapshot, WorkerAckResponse, WorkerCommandDraft, WorkerResponse } from '../store/types'
import { TICK_MS } from '../sim'

class FakeClock implements HostClock {
  ms = 0
  now(): number {
    return this.ms
  }
  advance(by: number): void {
    this.ms += by
  }
}

class FakeTimer implements HostTimer {
  callback: (() => void) | null = null
  intervalMs = 0
  starts = 0
  stops = 0

  start(callback: () => void, intervalMs: number): void {
    this.callback = callback
    this.intervalMs = intervalMs
    this.starts += 1
  }

  stop(): void {
    this.callback = null
    this.stops += 1
  }

  get active(): boolean {
    return this.callback !== null
  }

  fire(): void {
    this.callback?.()
  }
}

function config(patch: Partial<AppConfig> = {}): AppConfig {
  return normalizeConfig({ ...DEFAULT_APP_CONFIG, seed: 7, ...patch })
}

function harness() {
  const clock = new FakeClock()
  const timer = new FakeTimer()
  const responses: WorkerResponse[] = []
  const host = new SimulationHost({ clock, timer, post: (response) => responses.push(response) })
  let commandId = 0

  const send = (command: WorkerCommandDraft) => {
    commandId += 1
    host.handle({ ...command, commandId } as never)
  }
  const runReal = (ms: number) => {
    const ticks = Math.round(ms / DRIVER_INTERVAL_MS)
    for (let index = 0; index < ticks; index += 1) {
      clock.advance(DRIVER_INTERVAL_MS)
      timer.fire()
    }
  }
  const snapshots = (): UiSnapshot[] =>
    responses
      .filter((item): item is Extract<WorkerResponse, { type: 'SNAPSHOT' }> => item.type === 'SNAPSHOT')
      .map((item) => item.snapshot)
  const acks = () => responses.filter((item): item is WorkerAckResponse => item.type === 'ACK')

  return {
    clock,
    timer,
    host,
    responses,
    send,
    runReal,
    // The publish cadence is slower than the driver, so force a publish whenever
    // a test asserts on the exact simulated time.
    runRealThenFlush(ms: number) {
      runReal(ms)
      host.flush()
    },
    snapshots,
    latest(): UiSnapshot {
      const all = snapshots()
      return all[all.length - 1]
    },
    acks,
    lastAck(): WorkerAckResponse {
      const all = acks()
      return all[all.length - 1]
    },
  }
}

type Harness = ReturnType<typeof harness>

describe('worker owned clock driver', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  it('lands paused at time zero after INIT and does not run on its own', () => {
    h.send({ type: 'INIT', config: config() })
    expect(h.latest().timeMs).toBe(0)
    expect(h.latest().paused).toBe(true)
    expect(h.latest().pausedByUser).toBe(false)
    expect(h.latest().clockRunning).toBe(false)
    expect(h.latest().trafficActive).toBe(false)
    expect(h.timer.active).toBe(false)

    h.runRealThenFlush(2_000)
    expect(h.latest().timeMs).toBe(0)
  })

  it('converts real elapsed time into exact 50 ms steps at 1x', () => {
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'RESUME' })
    expect(h.timer.active).toBe(true)
    expect(h.timer.intervalMs).toBe(DRIVER_INTERVAL_MS)

    h.runRealThenFlush(1_000)
    expect(h.latest().timeMs).toBe(1_000)
    for (const snapshot of h.snapshots()) expect(snapshot.timeMs % TICK_MS).toBe(0)
  })

  it('scales simulated time by the speed multiplier without changing the step size', () => {
    h.send({ type: 'INIT', config: config({ speed: 4 }) })
    h.send({ type: 'RESUME' })
    h.runRealThenFlush(1_000)
    expect(h.latest().timeMs).toBe(4_000)
    for (const snapshot of h.snapshots()) expect(snapshot.timeMs % TICK_MS).toBe(0)
  })

  it('applies a speed change without a reset and without breaking the step size', () => {
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'RESUME' })
    h.runRealThenFlush(500)
    expect(h.latest().timeMs).toBe(500)

    h.send({ type: 'SET_SPEED', speed: 2 })
    h.runRealThenFlush(500)
    expect(h.latest().timeMs).toBe(1_500)
    expect(h.latest().timeMs % TICK_MS).toBe(0)
  })

  it('bounds the work one driver tick may do after a long stall', () => {
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'RESUME' })
    h.clock.advance(30_000)
    h.timer.fire()
    h.host.flush()
    expect(h.latest().timeMs).toBe(MAX_REAL_ELAPSED_MS)
    expect(h.latest().timeMs).toBeLessThanOrEqual(MAX_STEPS_PER_DRIVER_TICK * TICK_MS)
  })

  it('does not drift after a pause, however long the pause lasted', () => {
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'RESUME' })
    h.runRealThenFlush(500)
    expect(h.latest().timeMs).toBe(500)

    h.send({ type: 'PAUSE' })
    expect(h.timer.active).toBe(false)
    expect(h.latest().pausedByUser).toBe(true)
    h.clock.advance(60_000)
    h.timer.fire()
    expect(h.latest().timeMs).toBe(500)

    h.send({ type: 'RESUME' })
    h.runRealThenFlush(100)
    expect(h.latest().timeMs).toBe(600)
  })

  it('publishes snapshots on its own cadence, not once per simulation step', () => {
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'RESUME' })
    const before = h.snapshots().length
    h.runReal(1_000)
    const published = h.snapshots().length - before
    const expected = 1_000 / SNAPSHOT_INTERVAL_MS
    expect(published).toBeGreaterThanOrEqual(Math.floor(expected * 0.6))
    expect(published).toBeLessThanOrEqual(Math.ceil(expected * 1.4))
    expect(h.latest().timeMs / TICK_MS).toBeGreaterThan(published)
  })
})

describe('transport commands', () => {
  it('starts the clock from a pristine run, because Start must visibly run', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ requestsPerSecond: 100, handlerDurationMs: 1_000 }) })
    h.send({ type: 'START' })
    expect(h.latest().trafficActive).toBe(true)
    expect(h.latest().paused).toBe(false)
    expect(h.timer.active).toBe(true)

    h.runRealThenFlush(1_000)
    expect(h.latest().timeMs).toBe(1_000)
    expect(h.latest().metrics.acceptedRequests).toBeGreaterThan(0)
  })

  it('keeps an explicit pause after Start, so Step stays useful', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'RESUME' })
    h.send({ type: 'PAUSE' })
    h.send({ type: 'START' })
    expect(h.latest().trafficActive).toBe(true)
    expect(h.latest().paused).toBe(true)
    expect(h.latest().pausedByUser).toBe(true)
    expect(h.timer.active).toBe(false)

    const before = h.latest().timeMs
    h.send({ type: 'STEP' })
    expect(h.lastAck().accepted).toBe(true)
    expect(h.latest().timeMs).toBe(before + TICK_MS)
  })

  it('accepts Step only while the clock is halted', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'STEP' })
    expect(h.lastAck().accepted).toBe(true)
    expect(h.latest().timeMs).toBe(TICK_MS)

    h.send({ type: 'RESUME' })
    h.send({ type: 'STEP' })
    expect(h.lastAck().accepted).toBe(false)
    expect(h.lastAck().reason).toBe('STEP_REQUIRES_PAUSE')
  })

  it('offers no arrivals before Start and stops arrivals without stopping the clock', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ requestsPerSecond: 100, handlerDurationMs: 1_000 }) })
    h.send({ type: 'RESUME' })
    h.runRealThenFlush(1_000)
    expect(h.latest().timeMs).toBe(1_000)
    expect(h.latest().metrics.acceptedRequests).toBe(0)
    expect(h.latest().metrics.offeredRps).toBe(0)
    expect(h.latest().metrics.configuredRps).toBe(100)

    h.send({ type: 'START' })
    h.runRealThenFlush(1_000)
    const accepted = h.latest().metrics.acceptedRequests
    expect(accepted).toBeGreaterThan(0)

    h.send({ type: 'STOP' })
    expect(h.latest().trafficActive).toBe(false)
    expect(h.latest().metrics.offeredRps).toBe(0)
    h.runRealThenFlush(1_000)
    // The clock keeps running so in-flight work finishes, but nothing new arrives.
    expect(h.latest().timeMs).toBe(3_000)
    expect(h.latest().metrics.acceptedRequests).toBe(accepted)
  })

  it('bumps the revision on RESET so older snapshots can be discarded', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'RESUME' })
    h.runReal(500)
    const firstRevision = h.acks()[0].revision

    h.send({ type: 'RESET', config: config() })
    const ack = h.lastAck()
    expect(ack.revision).toBe(firstRevision + 1)
    expect(h.latest().timeMs).toBe(0)
    expect(h.latest().paused).toBe(true)
    expect(h.latest().pausedByUser).toBe(false)
    const revisions = h.responses
      .filter((item): item is Extract<WorkerResponse, { type: 'SNAPSHOT' }> => item.type === 'SNAPSHOT')
      .map((item) => item.revision)
    expect(Math.max(...revisions)).toBe(ack.revision)
  })

  it('reports an error instead of throwing when a command arrives too early', () => {
    const h = harness()
    h.send({ type: 'START' })
    expect(h.responses.some((item) => item.type === 'ERROR')).toBe(true)
    expect(h.snapshots()).toHaveLength(0)
  })

  it('reports an error for an unknown command', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.host.handle({ type: 'NOPE', commandId: 99 } as never)
    expect(h.responses.some((item) => item.type === 'ERROR')).toBe(true)
  })
})

describe('provisioned concurrency and comparison mode', () => {
  const comparisonConfig = () =>
    config({
      comparisonMode: true,
      handlerDurationMs: 1_000,
      requestsPerSecond: 400,
      initDurationMs: 400,
      accountQuota: 1_000,
      reservedEnabled: false,
      provisionedEnabled: true,
      provisionedConcurrency: 400,
      target: 'version-or-alias',
    })

  it('refuses to start traffic until the prepared lane is READY', () => {
    const h = harness()
    h.send({ type: 'INIT', config: comparisonConfig() })
    expect(h.latest().provisioned.status).toBe('PREPARING')
    expect(h.latest().canStartTraffic).toBe(false)

    h.send({ type: 'START' })
    expect(h.lastAck().accepted).toBe(false)
    expect(h.lastAck().reason).toBe('PROVISIONED_NOT_READY')
    expect(h.latest().trafficActive).toBe(false)
    expect(h.latest().paused).toBe(true)
  })

  it('advances both lanes with no traffic to the exact readyAt instant, then halts', () => {
    const h = harness()
    h.send({ type: 'INIT', config: comparisonConfig() })
    const readyAtMs = h.latest().provisioned.readyAtMs
    expect(readyAtMs).not.toBeNull()

    h.send({ type: 'PREPARE_TO_READY' })
    const snapshot = h.latest()
    expect(h.lastAck().accepted).toBe(true)
    expect(snapshot.provisioned.status).toBe('READY')
    expect(snapshot.provisioned.progress).toBe(1)
    expect(snapshot.timeMs).toBe(Math.ceil(readyAtMs! / TICK_MS) * TICK_MS)
    expect(snapshot.paused).toBe(true)
    expect(snapshot.pausedByUser).toBe(false)
    expect(h.timer.active).toBe(false)
    // No traffic ran during preparation, so the run starts from a clean field.
    expect(snapshot.metrics.acceptedRequests).toBe(0)
    expect(snapshot.metrics.throttles).toBe(0)
    expect(snapshot.canStartTraffic).toBe(true)

    const comparison = snapshot.comparison!
    expect(comparison.left.timeMs).toBe(comparison.right.timeMs)
    expect(comparison.left.provisioned.status).toBe('DISABLED')
    expect(comparison.right.provisioned.status).toBe('READY')
    expect(comparison.right.environments).toHaveLength(400)
    expect(comparison.left.environments).toHaveLength(0)
  })

  it('reports monotone preparation progress, with no drop at the allocation handover', () => {
    const h = harness()
    h.send({ type: 'INIT', config: comparisonConfig() })
    h.send({ type: 'RESUME' })
    let previous = 0
    for (let index = 0; index < 40; index += 1) {
      h.runRealThenFlush(1_000)
      const progress = h.latest().provisioned.progress
      expect(progress).toBeGreaterThanOrEqual(previous)
      previous = progress
      if (h.latest().provisioned.status === 'READY') break
    }
    expect(previous).toBeGreaterThan(0)
  })

  it('runs both lanes on identical ticks and traffic, and only the prepared lane avoids Init', () => {
    const h = harness()
    h.send({ type: 'INIT', config: comparisonConfig() })
    h.send({ type: 'PREPARE_TO_READY' })
    h.send({ type: 'START' })
    expect(h.lastAck().accepted).toBe(true)
    expect(h.latest().paused).toBe(false)
    h.runRealThenFlush(1_000)

    const comparison = h.latest().comparison!
    expect(comparison.left.timeMs).toBe(comparison.right.timeMs)
    expect(comparison.left.metrics.acceptedRequests).toBe(comparison.right.metrics.acceptedRequests)
    expect(comparison.right.metrics.coldStarts).toBe(0)
    expect(comparison.left.metrics.coldStarts).toBeGreaterThan(0)
    expect(comparison.right.metrics.provisionedInvocations).toBeGreaterThan(0)
    expect(comparison.left.metrics.provisionedInvocations).toBe(0)
    expect(comparison.left.environments.length).toBeGreaterThan(0)
    expect(comparison.right.environments.length).toBeGreaterThan(0)
  })

  it('gives the comparison lanes the same reserved setting and the same seed', () => {
    const h = harness()
    h.send({
      type: 'INIT',
      config: config({
        comparisonMode: true,
        reservedEnabled: true,
        reservedConcurrency: 400,
        provisionedEnabled: true,
        provisionedConcurrency: 200,
        target: 'version-or-alias',
      }),
    })
    const comparison = h.latest().comparison!
    expect(comparison.left.metrics.activeCap).toBe(comparison.right.metrics.activeCap)
    expect(comparison.left.provisioned.requested).toBe(0)
    expect(comparison.right.provisioned.requested).toBe(200)
  })

  it('refuses prepare-to-ready when provisioned concurrency is not configured', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'PREPARE_TO_READY' })
    expect(h.lastAck().accepted).toBe(false)
    expect(h.lastAck().reason).toBe('PROVISIONED_NOT_CONFIGURED')
  })

  it('reports init ring progress for environments that are initialising', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ requestsPerSecond: 20, handlerDurationMs: 1_000, initDurationMs: 400 }) })
    h.send({ type: 'START' })
    h.runRealThenFlush(200)
    const initialising = h.latest().environments.filter((environment) => environment.state === 'INITIALIZING')
    expect(initialising.length).toBeGreaterThan(0)
    for (const environment of initialising) {
      expect(environment.initProgress).toBeGreaterThanOrEqual(0)
      expect(environment.initProgress).toBeLessThanOrEqual(1)
      // The handler progress arc belongs to RUNNING only.
      expect(environment.progress).toBe(0)
    }
    // An environment created earlier in the same window is partway through Init.
    expect(initialising.some((environment) => (environment.initProgress ?? 0) > 0)).toBe(true)
  })
})

describe('narration and throttle samples', () => {
  it('announces at most once per real narration interval, even at 4x', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ speed: 4, requestsPerSecond: 5_000, handlerDurationMs: 1_000 }) })
    h.send({ type: 'START' })
    const before = h.snapshots().length
    h.runReal(6_000)

    const texts = h.snapshots().slice(before).map((snapshot) => snapshot.narration)
    let changes = 0
    for (let index = 1; index < texts.length; index += 1) {
      if (texts[index] !== texts[index - 1]) changes += 1
    }
    // Six real seconds allows at most five further announcements after the first.
    expect(changes).toBeLessThanOrEqual(5)
    expect(texts[texts.length - 1]).not.toBe('')
  })

  it('keeps a bounded recent throttle sample with limits and blockers', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ requestsPerSecond: 30_000, handlerDurationMs: 20, accountQuota: 1_000 }) })
    h.send({ type: 'START' })
    h.runRealThenFlush(2_000)

    const snapshot = h.latest()
    expect(snapshot.metrics.throttles).toBeGreaterThan(0)
    expect(snapshot.recentThrottleEvents.length).toBeGreaterThan(0)
    expect(snapshot.recentThrottleEvents.length).toBeLessThanOrEqual(32)
    for (const event of snapshot.recentThrottleEvents) {
      expect(event.type).toBe('REQUEST_THROTTLED')
      expect(event.seq).toBeGreaterThan(0)
      expect(event.blockers.length).toBeGreaterThan(0)
      expect(event.blockers).toContain(event.primaryCause)
      expect(event.limits).toBeDefined()
    }
    expect(snapshot.causes.RPS_CEILING).toBeGreaterThan(0)
    expect(snapshot.narration).toContain('429')
  })
})
