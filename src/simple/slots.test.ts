import { describe, expect, it } from 'vitest'
import { SlotField, countSlotFlag, countSlotStates, slotGeometry } from './slots'
import { DEFAULT_SIMPLE_CONFIG, normalizeSimpleConfig, type SimpleConfig } from './config'
import { SLOT } from './types'
import type { EnvironmentSnapshot, EnvironmentState } from '../sim'

function config(patch: Partial<SimpleConfig> = {}): SimpleConfig {
  return normalizeSimpleConfig({ ...DEFAULT_SIMPLE_CONFIG, ...patch })
}

let sequence = 0

function environment(state: EnvironmentState, kind: EnvironmentSnapshot['kind'] = 'ON_DEMAND'): EnvironmentSnapshot {
  sequence += 1
  return {
    id: `${kind === 'PROVISIONED' ? 'P' : 'E'}-${String(sequence).padStart(4, '0')}`,
    kind,
    state,
    stateSinceMs: 0,
    timeInStateMs: 0,
    activeRequestId: null,
    invocations: 0,
    coldStarts: 0,
    history: [],
  }
}

function indexesOf(slots: Uint8Array, state: number): number[] {
  const found: number[] = []
  for (let index = 0; index < slots.length; index += 1) {
    if ((slots[index] & SLOT.STATE_MASK) === state) found.push(index)
  }
  return found
}

describe('quota geometry', () => {
  it('returns one entry per quota unit, and an empty entry is unused quota', () => {
    const field = new SlotField()
    const slots = field.map(config({ quota: 250 }), [])
    expect(slots).toHaveLength(250)
    expect(countSlotStates(slots)).toEqual({ free: 250, initialising: 0, running: 0, warm: 0 })
    expect(countSlotFlag(slots, SLOT.PROVISIONED)).toBe(0)
    expect(countSlotFlag(slots, SLOT.RESERVED)).toBe(0)
    expect(countSlotFlag(slots, SLOT.OUTSIDE)).toBe(0)
  })

  it('gives provisioned concurrency the first tiles', () => {
    const settings = config({ provisionedEnabled: true, provisioned: 200 })
    const slots = new SlotField().map(settings, [])
    expect(slotGeometry(settings).onDemandStart).toBe(200)
    expect(countSlotFlag(slots, SLOT.PROVISIONED)).toBe(200)
    for (let index = 0; index < 200; index += 1) expect(slots[index] & SLOT.PROVISIONED).toBeTruthy()
    expect(slots[200] & SLOT.PROVISIONED).toBe(0)
    expect(countSlotFlag(slots, SLOT.OUTSIDE)).toBe(0)
  })

  it('flags everything past a reservation as outside the function limit', () => {
    const slots = new SlotField().map(config({ reservedEnabled: true, reserved: 400 }), [])
    expect(countSlotFlag(slots, SLOT.RESERVED)).toBe(400)
    expect(countSlotFlag(slots, SLOT.OUTSIDE)).toBe(600)
    expect(slots[399] & SLOT.RESERVED).toBeTruthy()
    expect(slots[400] & SLOT.OUTSIDE).toBeTruthy()
  })

  it('nests provisioned inside reserved without counting a tile twice', () => {
    const settings = config({
      reservedEnabled: true,
      reserved: 400,
      provisionedEnabled: true,
      provisioned: 200,
    })
    const slots = new SlotField().map(settings, [])
    expect(countSlotFlag(slots, SLOT.RESERVED)).toBe(400)
    expect(countSlotFlag(slots, SLOT.PROVISIONED)).toBe(200)
    expect(countSlotFlag(slots, SLOT.RESERVED | SLOT.PROVISIONED)).toBe(200)
    expect(countSlotFlag(slots, SLOT.OUTSIDE)).toBe(600)
    expect(slotGeometry(settings)).toEqual({
      quota: 1_000,
      provisioned: 200,
      reserved: 400,
      reservedEnabled: true,
      onDemandStart: 200,
      onDemandEnd: 400,
    })
  })
})

describe('environment mapping', () => {
  it('maps provisioned environments into their own range and on-demand work after it', () => {
    const settings = config({ provisionedEnabled: true, provisioned: 3, quota: 1_000 })
    const environments = [
      environment('RUNNING', 'PROVISIONED'),
      environment('PROVISIONED_IDLE', 'PROVISIONED'),
      environment('PROVISIONED_IDLE', 'PROVISIONED'),
      environment('INITIALISING'),
      environment('RUNNING'),
    ]
    const slots = new SlotField().map(settings, environments)
    expect(indexesOf(slots, SLOT.RUNNING)).toEqual([0, 4])
    expect(indexesOf(slots, SLOT.INIT)).toEqual([3])
    // An idle provisioned tile is allocated, not busy, so it stays visually empty.
    expect(slots[1] & SLOT.STATE_MASK).toBe(SLOT.FREE)
    expect(slots[1] & SLOT.PROVISIONED).toBeTruthy()
  })

  it('shows warm reuse only while idle retirement is part of the story', () => {
    const environments = [environment('RUNNING'), environment('WARM_IDLE'), environment('WARM_IDLE')]
    const field = new SlotField()

    const off = field.map(config({ quota: 100 }), environments)
    expect(countSlotStates(off)).toEqual({ free: 99, initialising: 0, running: 1, warm: 0 })

    const on = field.map(config({ quota: 100, idleEnabled: true, idleMs: 3_000 }), environments)
    expect(countSlotStates(on)).toEqual({ free: 97, initialising: 0, running: 1, warm: 2 })
  })

  it('releases the tile of a retiring environment', () => {
    const retiring = environment('RETIRING')
    const slots = new SlotField().map(config({ quota: 100, idleEnabled: true }), [retiring])
    expect(countSlotStates(slots).free).toBe(100)
  })

  it('keeps a busy tile at the same index across frames', () => {
    const settings = config({ quota: 100, idleEnabled: true })
    const field = new SlotField()
    const busy = environment('RUNNING')
    const idle = [environment('WARM_IDLE'), environment('WARM_IDLE')]

    field.map(settings, [...idle, busy])
    const first = field.indexOf(busy.id)
    field.map(settings, [busy])
    field.map(settings, [busy, environment('WARM_IDLE')])
    expect(field.indexOf(busy.id)).toBe(first)
  })

  it('evicts idle tiles rather than hide any busy environment', () => {
    const settings = config({ quota: 100, idleEnabled: true })
    const field = new SlotField()
    const idle = Array.from({ length: 100 }, () => environment('WARM_IDLE'))
    const full = field.map(settings, idle)
    expect(countSlotStates(full).warm).toBe(100)

    const busy = [environment('RUNNING'), environment('INITIALISING')]
    const slots = field.map(settings, [...idle, ...busy])
    const counts = countSlotStates(slots)
    expect(counts.running).toBe(1)
    expect(counts.initialising).toBe(1)
    expect(counts.warm).toBe(98)
    expect(counts.free).toBe(0)
    for (const item of busy) expect(field.indexOf(item.id)).toBeGreaterThanOrEqual(0)
  })

  it('never places work outside the function limit', () => {
    const settings = config({
      quota: 1_000,
      reservedEnabled: true,
      reserved: 400,
      provisionedEnabled: true,
      provisioned: 200,
      idleEnabled: true,
    })
    const environments = [
      ...Array.from({ length: 200 }, () => environment('RUNNING', 'PROVISIONED')),
      ...Array.from({ length: 300 }, () => environment('RUNNING')),
    ]
    const slots = new SlotField().map(settings, environments)
    const running = indexesOf(slots, SLOT.RUNNING)
    // Two hundred provisioned tiles plus the two hundred on-demand tiles that fit.
    expect(running).toHaveLength(400)
    for (const index of running) expect(index).toBeLessThan(400)
    expect(countSlotFlag(slots, SLOT.OUTSIDE)).toBe(600)
    for (let index = 400; index < 1_000; index += 1) {
      expect(slots[index] & SLOT.STATE_MASK).toBe(SLOT.FREE)
    }
  })
})

describe('remaining handler time projection', () => {
  function running(timeInStateMs: number, kind: EnvironmentSnapshot['kind'] = 'ON_DEMAND'): EnvironmentSnapshot {
    return { ...environment('RUNNING', kind), timeInStateMs }
  }

  /** Total countdown outside the tiles a test names, which must always be nothing. */
  function restTotal(remainingMs: Float64Array, from: number): number {
    let total = 0
    for (let index = from; index < remainingMs.length; index += 1) total += remainingMs[index]
    return total
  }

  it('counts down actual handler time for staggered running ages', () => {
    const settings = config({ quota: 100, durationMs: 1_000 })
    const environments = [running(0), running(250), running(1_000)]
    const { slots, remainingMs } = new SlotField().project(settings, environments)

    expect(remainingMs).toHaveLength(slots.length)
    expect(indexesOf(slots, SLOT.RUNNING)).toEqual([0, 1, 2])
    expect([...remainingMs.slice(0, 3)]).toEqual([1_000, 750, 0])
    // Nothing runs in the rest of the quota, so nothing counts down there.
    expect(restTotal(remainingMs, 3)).toBe(0)
  })

  it('clamps an overrun age to zero and a negative age to the whole duration', () => {
    const settings = config({ quota: 100, durationMs: 500 })
    const { remainingMs } = new SlotField().project(settings, [running(900), running(-100)])
    expect([...remainingMs.slice(0, 2)]).toEqual([0, 500])
    expect(restTotal(remainingMs, 2)).toBe(0)
  })

  it('projects onto the same tiles the mapping chose under provisioned and reserved concurrency', () => {
    const settings = config({
      quota: 1_000,
      durationMs: 2_000,
      provisionedEnabled: true,
      provisioned: 2,
      reservedEnabled: true,
      reserved: 4,
    })
    const environments = [
      running(500, 'PROVISIONED'),
      running(1_500, 'PROVISIONED'),
      running(250),
      running(750),
    ]
    const { slots, remainingMs } = new SlotField().project(settings, environments)

    expect(indexesOf(slots, SLOT.RUNNING)).toEqual([0, 1, 2, 3])
    expect([...remainingMs.slice(0, 4)]).toEqual([1_500, 500, 1_750, 1_250])
    expect(slots[0] & SLOT.PROVISIONED).toBeTruthy()
    expect(slots[2] & SLOT.RESERVED).toBeTruthy()
    expect(restTotal(remainingMs, 4)).toBe(0)
  })

  it('gives nothing to work that does not fit outside the function limit', () => {
    const settings = config({ quota: 1_000, durationMs: 1_000, reservedEnabled: true, reserved: 2 })
    const environments = [running(100), running(200), running(300), running(400)]
    const { slots, remainingMs } = new SlotField().project(settings, environments)

    expect(indexesOf(slots, SLOT.RUNNING)).toEqual([0, 1])
    expect([...remainingMs.slice(0, 2)]).toEqual([900, 800])
    expect(restTotal(remainingMs, 2)).toBe(0)
  })

  it('reports nothing for a slot that is initialising, warm, retiring or free', () => {
    const settings = config({ quota: 100, durationMs: 1_000, idleEnabled: true, idleMs: 3_000 })
    const environments = [
      { ...environment('INITIALISING'), timeInStateMs: 200 },
      { ...environment('WARM_IDLE'), timeInStateMs: 400 },
      { ...environment('RETIRING'), timeInStateMs: 10 },
      running(600),
    ]
    const { slots, remainingMs } = new SlotField().project(settings, environments)

    // Busy tiles take the lowest indices, so warm reuse lands after them.
    expect(indexesOf(slots, SLOT.INIT)).toEqual([0])
    expect(indexesOf(slots, SLOT.RUNNING)).toEqual([1])
    expect(indexesOf(slots, SLOT.WARM)).toEqual([2])
    expect(remainingMs[0]).toBe(0)
    expect(remainingMs[1]).toBe(400)
    expect(remainingMs[2]).toBe(0)
    expect(restTotal(remainingMs, 2)).toBe(0)
  })

  it('clears the countdown when the request completes and again when the tile is reused', () => {
    const settings = config({ quota: 100, durationMs: 1_000, idleEnabled: true, idleMs: 3_000 })
    const field = new SlotField()
    const busy = running(400)

    expect(field.project(settings, [busy]).remainingMs[0]).toBe(600)

    const completed = { ...busy, state: 'WARM_IDLE' as const, timeInStateMs: 0 }
    expect(restTotal(field.project(settings, [completed]).remainingMs, 0)).toBe(0)

    const reused = { ...busy, state: 'RUNNING' as const, timeInStateMs: 0 }
    const again = field.project(settings, [reused])
    expect(again.remainingMs[0]).toBe(1_000)
    expect(restTotal(again.remainingMs, 1)).toBe(0)
  })

  it('forgets every countdown after a reset', () => {
    const settings = config({ quota: 100, durationMs: 1_000 })
    const field = new SlotField()
    field.project(settings, [running(400)])
    field.reset()

    const after = field.project(settings, [])
    expect(after.remainingMs).toHaveLength(100)
    expect(restTotal(after.remainingMs, 0)).toBe(0)
  })

  it('keeps the map contract: the same tiles and the same stability as before', () => {
    const settings = config({ quota: 100, durationMs: 1_000, idleEnabled: true })
    const field = new SlotField()
    const busy = running(300)
    const idle = [environment('WARM_IDLE'), environment('WARM_IDLE')]

    const projected = field.project(settings, [...idle, busy])
    const index = field.indexOf(busy.id)
    expect(index).toBeDefined()
    expect(projected.remainingMs[index!]).toBe(700)

    const mapped = new SlotField().map(settings, [...idle, busy])
    expect(countSlotStates(projected.slots)).toEqual(countSlotStates(mapped))
    expect(field.indexOf(busy.id)).toBe(index)
  })
})
