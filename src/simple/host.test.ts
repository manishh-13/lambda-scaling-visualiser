import { describe, expect, it } from 'vitest'
import {
  DRIVER_INTERVAL_MS,
  HISTORY_POINTS,
  HISTORY_SAMPLE_MS,
  PUBLISH_INTERVAL_MS,
  SimpleHost,
  type SimpleHostDeps,
} from './host'
import { DEFAULT_SIMPLE_CONFIG, normalizeSimpleConfig, type SimpleConfig } from './config'
import { SLOT, type SimpleCommand, type SimpleResponse, type SimpleSnapshot } from './types'
import { countSlotFlag, countSlotStates } from './slots'
import { TICK_MS } from '../sim'

/** Omit distributed over the union, so an INIT draft keeps its config field. */
type CommandDraft = SimpleCommand extends infer T ? (T extends SimpleCommand ? Omit<T, 'revision'> : never) : never

function config(patch: Partial<SimpleConfig> = {}): SimpleConfig {
  return normalizeSimpleConfig({ ...DEFAULT_SIMPLE_CONFIG, ...patch })
}

function harness() {
  let nowMs = 0
  let callback: (() => void) | null = null
  let starts = 0
  let stops = 0
  const responses: SimpleResponse[] = []
  const deps: SimpleHostDeps = {
    now: () => nowMs,
    start: (fn, intervalMs) => {
      callback = fn
      starts += 1
      expect(intervalMs).toBe(DRIVER_INTERVAL_MS)
    },
    stop: () => {
      callback = null
      stops += 1
    },
    post: response => responses.push(response),
  }
  const host = new SimpleHost(deps)
  let revision = 0

  const send = (command: CommandDraft, at?: number) => {
    revision = at ?? revision + 1
    host.handle({ ...command, revision } as SimpleCommand)
  }
  const runReal = (ms: number) => {
    const ticks = Math.round(ms / DRIVER_INTERVAL_MS)
    for (let index = 0; index < ticks; index += 1) {
      nowMs += DRIVER_INTERVAL_MS
      callback?.()
    }
  }
  const snapshots = () =>
    responses.filter((item): item is Extract<SimpleResponse, { type: 'SNAPSHOT' }> => item.type === 'SNAPSHOT')

  return {
    host,
    responses,
    send,
    runReal,
    runRealThenFlush(ms: number) {
      runReal(ms)
      host.flush()
    },
    advanceClock: (ms: number) => {
      nowMs += ms
    },
    fire: () => callback?.(),
    get timerActive() {
      return callback !== null
    },
    get starts() {
      return starts
    },
    get stops() {
      return stops
    },
    snapshots,
    latest(): SimpleSnapshot {
      const all = snapshots()
      return all[all.length - 1].snapshot
    },
    manualResults: () =>
      responses.filter((item): item is Extract<SimpleResponse, { type: 'MANUAL_RESULT' }> => item.type === 'MANUAL_RESULT'),
    errors: () => responses.filter(item => item.type === 'ERROR'),
  }
}

describe('idle on load and the manual cold start', () => {
  it('lands idle at time zero with a full grid of empty quota slots', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })

    const snapshot = h.latest()
    expect(snapshot.timeMs).toBe(0)
    expect(snapshot.trafficRunning).toBe(false)
    expect(snapshot.paused).toBe(false)
    expect(h.timerActive).toBe(false)
    expect(snapshot.slots).toHaveLength(1_000)
    expect(countSlotStates(snapshot.slots)).toEqual({ free: 1_000, initialising: 0, running: 0, warm: 0 })
    expect(snapshot.concurrent).toBe(0)
    expect(snapshot.history).toEqual([{ timeMs: 0, units: 1_000, scalingRejections: 0 }])

    h.runRealThenFlush(2_000)
    expect(h.latest().timeMs).toBe(0)
  })

  it('runs one real request on a click without starting the stream, then goes quiet', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ initEnabled: true, initMs: 400, durationMs: 1_000 }) })
    h.send({ type: 'MANUAL' })

    expect(h.manualResults()).toEqual([{ type: 'MANUAL_RESULT', revision: 2, accepted: true, cause: null }])
    let snapshot = h.latest()
    expect(snapshot.trafficRunning).toBe(false)
    expect(snapshot.accepted).toBe(1)
    expect(snapshot.concurrent).toBe(1)
    expect(snapshot.initialising).toBe(1)
    expect(countSlotStates(snapshot.slots).initialising).toBe(1)
    expect(h.timerActive).toBe(true)

    h.runRealThenFlush(400)
    snapshot = h.latest()
    expect(snapshot.timeMs).toBe(400)
    expect(snapshot.initialising).toBe(0)
    expect(snapshot.running).toBe(1)
    expect(countSlotStates(snapshot.slots).running).toBe(1)

    h.runRealThenFlush(2_000)
    snapshot = h.latest()
    expect(snapshot.completed).toBe(1)
    expect(snapshot.concurrent).toBe(0)
    // Warm reuse persists in the kernel but the lifecycle story is switched off.
    expect(snapshot.warm).toBe(0)
    expect(countSlotStates(snapshot.slots)).toEqual({ free: 1_000, initialising: 0, running: 0, warm: 0 })
    expect(h.timerActive).toBe(false)
  })

  it('reports the cause when a click is rejected', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ reservedEnabled: true, reserved: 0 }) })
    h.send({ type: 'MANUAL' })

    const result = h.manualResults()[0]
    expect(result.accepted).toBe(false)
    expect(result.cause).toBe('RPS_CEILING')
    expect(h.latest().rejected).toBe(1)
    expect(h.latest().lastReject).toBe('RPS_CEILING')
    expect(h.latest().concurrent).toBe(0)
  })
})

describe('the default run', () => {
  it('serves 400 requests per second for one second with no throttles', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    h.runRealThenFlush(1_000)

    const snapshot = h.latest()
    expect(snapshot.timeMs).toBe(1_000)
    expect(snapshot.accepted).toBe(400)
    expect(snapshot.rejected).toBe(0)
    expect(snapshot.throttlesByCause).toEqual({
      RPS_CEILING: 0,
      RESERVED_CONCURRENCY: 0,
      ACCOUNT_CONCURRENCY: 0,
      SCALING_RATE: 0,
    })
    expect(snapshot.lastReject).toBeNull()
    expect(snapshot.concurrent).toBe(400)
    expect(snapshot.running).toBe(400)
    expect(snapshot.quotaOccupancy).toBe(400)
    expect(snapshot.unreservedAvailable).toBe(600)
    const counts = countSlotStates(snapshot.slots)
    expect(counts.running).toBe(400)
    expect(counts.free).toBe(600)
    expect(counts.initialising + counts.running).toBe(snapshot.concurrent)
  })

  it('publishes at most twenty times a second while it runs', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    const before = h.snapshots().length
    h.runReal(1_000)

    const published = h.snapshots().length - before
    expect(published).toBeLessThanOrEqual(1_000 / PUBLISH_INTERVAL_MS)
    expect(published).toBeGreaterThan(5)
  })
})

describe('transport', () => {
  it('drains work and refills the bucket after Stop, then ends the timer', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    h.runRealThenFlush(1_000)
    const accepted = h.latest().accepted

    h.send({ type: 'STOP' })
    expect(h.latest().trafficRunning).toBe(false)
    expect(h.timerActive).toBe(true)

    h.runRealThenFlush(8_000)
    const snapshot = h.latest()
    expect(snapshot.accepted).toBe(accepted)
    expect(snapshot.completed).toBe(accepted)
    expect(snapshot.concurrent).toBe(0)
    expect(snapshot.units).toBe(1_000)
    expect(h.timerActive).toBe(false)
  })

  it('freezes the clock on Pause, steps exactly one tick, and keeps the pause through Start', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    h.runRealThenFlush(200)
    expect(h.latest().timeMs).toBe(200)

    h.send({ type: 'PAUSE' })
    expect(h.timerActive).toBe(false)
    expect(h.latest().paused).toBe(true)
    h.advanceClock(60_000)
    h.fire()
    expect(h.latest().timeMs).toBe(200)

    h.send({ type: 'STEP' })
    expect(h.latest().timeMs).toBe(200 + TICK_MS)
    expect(h.errors()).toHaveLength(0)
    h.send({ type: 'STOP' })
    h.send({ type: 'START' })
    expect(h.latest().trafficRunning).toBe(true)
    expect(h.latest().paused).toBe(true)
    expect(h.timerActive).toBe(false)

    h.send({ type: 'RESUME' })
    expect(h.timerActive).toBe(true)
    h.runRealThenFlush(100)
    expect(h.latest().timeMs).toBe(350)
    expect(h.latest().paused).toBe(false)
  })

  it('refuses a step while the clock is running and advances nothing', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    h.runRealThenFlush(200)

    h.send({ type: 'STEP' })
    expect(h.errors()).toHaveLength(1)
    expect(h.latest().timeMs).toBe(200)
    // The failed command stops the clock rather than leaving it running behind an error.
    expect(h.latest().paused).toBe(true)
    expect(h.timerActive).toBe(false)
  })

  it('keeps exact simulated time when clicks arrive during a running stream', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    for (let index = 0; index < 50; index += 1) {
      h.advanceClock(DRIVER_INTERVAL_MS)
      h.fire()
      h.send({ type: 'MANUAL' })
    }
    h.host.flush()

    const snapshot = h.latest()
    expect(snapshot.timeMs).toBe(1_000)
    expect(snapshot.accepted).toBe(450)
    expect(snapshot.rejected).toBe(0)
    expect(snapshot.concurrent + snapshot.completed).toBe(450)
    const counts = countSlotStates(snapshot.slots)
    expect(counts.initialising + counts.running).toBe(snapshot.concurrent)
  })

  it('retires a warm environment on the idle timer and then stops the clock by itself', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ idleEnabled: true, idleMs: 1_000, durationMs: 1_000 }) })
    h.send({ type: 'MANUAL' })
    h.runRealThenFlush(1_500)

    let snapshot = h.latest()
    expect(snapshot.completed).toBe(1)
    expect(snapshot.warm).toBe(1)
    expect(countSlotStates(snapshot.slots).warm).toBe(1)
    expect(h.timerActive).toBe(true)

    h.runRealThenFlush(2_000)
    snapshot = h.latest()
    expect(snapshot.warm).toBe(0)
    expect(countSlotStates(snapshot.slots)).toEqual({ free: 1_000, initialising: 0, running: 0, warm: 0 })
    expect(h.timerActive).toBe(false)
  })
})

describe('configuration and revisions', () => {
  it('applies a request rate change live and rebuilds for anything else', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    h.runRealThenFlush(500)
    expect(h.latest().timeMs).toBe(500)

    h.send({ type: 'CONFIGURE', config: config({ rps: 800 }) })
    let snapshot = h.latest()
    expect(snapshot.timeMs).toBe(500)
    expect(snapshot.config.rps).toBe(800)
    expect(snapshot.trafficRunning).toBe(true)
    expect(snapshot.accepted).toBeGreaterThan(0)

    // A rate edit must not discard the real time that is not yet a whole tick.
    h.advanceClock(DRIVER_INTERVAL_MS)
    h.fire()
    h.send({ type: 'CONFIGURE', config: config({ rps: 600 }) })
    h.runRealThenFlush(480)
    expect(h.latest().timeMs).toBe(1_000)
    expect(h.latest().config.rps).toBe(600)

    h.send({ type: 'CONFIGURE', config: config({ rps: 800, quota: 2_000 }) })
    snapshot = h.latest()
    expect(snapshot.timeMs).toBe(0)
    expect(snapshot.slots).toHaveLength(2_000)
    expect(snapshot.accepted).toBe(0)
    expect(snapshot.trafficRunning).toBe(true)
    expect(snapshot.history).toHaveLength(1)
    expect(h.timerActive).toBe(true)
  })

  it('keeps an explicit pause through a rebuild and clears it on Reset', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() })
    h.send({ type: 'START' })
    h.runRealThenFlush(200)
    h.send({ type: 'PAUSE' })

    h.send({ type: 'CONFIGURE', config: config({ durationMs: 2_000 }) })
    let snapshot = h.latest()
    expect(snapshot.timeMs).toBe(0)
    expect(snapshot.paused).toBe(true)
    expect(snapshot.trafficRunning).toBe(true)
    expect(h.timerActive).toBe(false)

    h.send({ type: 'RESET' })
    snapshot = h.latest()
    expect(snapshot.timeMs).toBe(0)
    expect(snapshot.paused).toBe(false)
    expect(snapshot.trafficRunning).toBe(false)
    expect(snapshot.accepted).toBe(0)
    expect(snapshot.config.durationMs).toBe(2_000)
    expect(h.timerActive).toBe(false)
  })

  it('ignores a stale revision but always accepts INIT', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config() }, 1)
    h.send({ type: 'CONFIGURE', config: config({ quota: 2_000 }) }, 5)
    expect(h.latest().slots).toHaveLength(2_000)

    const before = h.responses.length
    h.send({ type: 'CONFIGURE', config: config({ quota: 3_000 }) }, 3)
    expect(h.responses).toHaveLength(before)
    expect(h.latest().slots).toHaveLength(2_000)
    expect(h.host.currentRevision).toBe(5)

    h.send({ type: 'INIT', config: config({ quota: 4_000 }) }, 2)
    expect(h.latest().slots).toHaveLength(4_000)
    expect(h.host.currentRevision).toBe(2)
    const last = h.snapshots()[h.snapshots().length - 1]
    expect(last.revision).toBe(2)
  })

  it('surfaces an error instead of throwing', () => {
    const h = harness()
    h.send({ type: 'START' })
    expect(h.errors()).toHaveLength(1)
    expect(h.snapshots()).toHaveLength(0)

    h.send({ type: 'INIT', config: config() })
    h.host.handle({ type: 'NOPE', revision: 9 } as never)
    expect(h.errors()).toHaveLength(2)
  })
})

describe('quota accounting and slot flags', () => {
  it('takes provisioned concurrency out of the unreserved pool', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ provisionedEnabled: true, provisioned: 200 }) })
    const snapshot = h.latest()
    expect(snapshot.unreservedAvailable).toBe(800)
    expect(snapshot.quotaOccupancy).toBe(200)
    expect(countSlotFlag(snapshot.slots, SLOT.PROVISIONED)).toBe(200)
    // Ready at start, but an idle provisioned environment is not an execution.
    expect(snapshot.concurrent).toBe(0)
    expect(countSlotStates(snapshot.slots).initialising + countSlotStates(snapshot.slots).running).toBe(0)
  })

  it('charges a reservation whole, so on-demand work inside it costs the pool nothing', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ reservedEnabled: true, reserved: 400 }) })
    expect(h.latest().unreservedAvailable).toBe(600)

    h.send({ type: 'START' })
    h.runRealThenFlush(1_000)
    const snapshot = h.latest()
    expect(snapshot.concurrent).toBeGreaterThan(0)
    expect(snapshot.unreservedAvailable).toBe(600)
  })

  it('never counts provisioned concurrency twice inside a reservation', () => {
    const h = harness()
    h.send({
      type: 'INIT',
      config: config({ reservedEnabled: true, reserved: 400, provisionedEnabled: true, provisioned: 200 }),
    })
    const snapshot = h.latest()
    expect(snapshot.unreservedAvailable).toBe(600)
    expect(countSlotFlag(snapshot.slots, SLOT.RESERVED)).toBe(400)
    expect(countSlotFlag(snapshot.slots, SLOT.PROVISIONED)).toBe(200)
    expect(countSlotFlag(snapshot.slots, SLOT.RESERVED | SLOT.PROVISIONED)).toBe(200)
    expect(countSlotFlag(snapshot.slots, SLOT.OUTSIDE)).toBe(600)
  })

  it('keeps every busy slot inside the function limit and matches the concurrency count', () => {
    const h = harness()
    h.send({
      type: 'INIT',
      config: config({
        reservedEnabled: true,
        reserved: 400,
        provisionedEnabled: true,
        provisioned: 200,
        initEnabled: true,
      }),
    })
    h.send({ type: 'START' })
    for (let index = 0; index < 10; index += 1) {
      h.runRealThenFlush(100)
      const snapshot = h.latest()
      const counts = countSlotStates(snapshot.slots)
      expect(counts.initialising + counts.running).toBe(snapshot.concurrent)
      for (let slot = 0; slot < snapshot.slots.length; slot += 1) {
        const value = snapshot.slots[slot]
        if (value & SLOT.OUTSIDE) expect(value & SLOT.STATE_MASK).toBe(SLOT.FREE)
      }
    }
  })
})

describe('history', () => {
  it('samples exact ticks every 100 ms and stays bounded at twenty seconds', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ speed: 4 }) })
    h.send({ type: 'START' })
    h.runRealThenFlush(8_000)

    const history = h.latest().history
    expect(history).toHaveLength(HISTORY_POINTS)
    for (const point of history) expect(point.timeMs % HISTORY_SAMPLE_MS).toBe(0)
    for (let index = 1; index < history.length; index += 1) {
      expect(history[index].timeMs - history[index - 1].timeMs).toBe(HISTORY_SAMPLE_MS)
    }
    expect(history[history.length - 1].timeMs - history[0].timeMs).toBe((HISTORY_POINTS - 1) * HISTORY_SAMPLE_MS)
    expect(h.latest().units).toBe(history[history.length - 1].units)
  })

  it('aggregates scaling rejections per 100 ms window without losing one', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ rps: 5_000, quota: 10_000, durationMs: 1_000 }) })
    h.send({ type: 'START' })
    h.runRealThenFlush(1_000)

    const snapshot = h.latest()
    expect(snapshot.throttlesByCause.SCALING_RATE).toBeGreaterThan(0)
    const summed = snapshot.history.reduce((total, point) => total + point.scalingRejections, 0)
    expect(summed).toBe(snapshot.throttlesByCause.SCALING_RATE)
    expect(snapshot.history[0]).toEqual({ timeMs: 0, units: 1_000, scalingRejections: 0 })
    expect(snapshot.lastReject).not.toBeNull()
  })
})

describe('per slot countdown', () => {
  function runningIndex(snapshot: SimpleSnapshot): number {
    const index = [...snapshot.slots].findIndex(value => (value & SLOT.STATE_MASK) === SLOT.RUNNING)
    expect(index).toBeGreaterThanOrEqual(0)
    return index
  }

  it('counts actual handler time down on the tile, and an init never counts towards it', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ initEnabled: true, initMs: 400, durationMs: 1_000 }) })
    h.send({ type: 'MANUAL' })

    let snapshot = h.latest()
    expect(snapshot.remainingMs).toHaveLength(snapshot.slots.length)
    // The request is initialising, so no handler time has started to run out yet.
    expect(countSlotStates(snapshot.slots).initialising).toBe(1)
    expect(Math.max(...snapshot.remainingMs)).toBe(0)

    h.runRealThenFlush(400)
    snapshot = h.latest()
    expect(snapshot.timeMs).toBe(400)
    const index = runningIndex(snapshot)
    expect(snapshot.remainingMs[index]).toBe(1_000)

    h.runRealThenFlush(300)
    snapshot = h.latest()
    expect(snapshot.timeMs).toBe(700)
    expect(snapshot.remainingMs[index]).toBe(700)

    h.runRealThenFlush(700)
    snapshot = h.latest()
    expect(snapshot.completed).toBe(1)
    expect(Math.max(...snapshot.remainingMs)).toBe(0)
  })

  it('freezes every countdown on pause and drains at the chosen speed', () => {
    const h = harness()
    h.send({ type: 'INIT', config: config({ durationMs: 2_000, speed: 2 }) })
    h.send({ type: 'MANUAL' })

    // Double speed: 200 ms of real time is 400 ms of handler time.
    h.runRealThenFlush(200)
    let snapshot = h.latest()
    expect(snapshot.timeMs).toBe(400)
    const index = runningIndex(snapshot)
    expect(snapshot.remainingMs[index]).toBe(1_600)

    h.send({ type: 'PAUSE' })
    h.runRealThenFlush(500)
    snapshot = h.latest()
    expect(snapshot.paused).toBe(true)
    expect(snapshot.timeMs).toBe(400)
    expect(snapshot.remainingMs[index]).toBe(1_600)

    h.send({ type: 'RESUME' })
    h.runRealThenFlush(100)
    snapshot = h.latest()
    expect(snapshot.timeMs).toBe(600)
    expect(snapshot.remainingMs[index]).toBe(1_400)
  })
})
