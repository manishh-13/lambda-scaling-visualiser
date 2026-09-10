import { describe, expect, it } from 'vitest'
import { groupSlotsForDisplay, groupSlotsWithTiming } from './display'
import { SLOT } from './types'

const FLAG_MASK = ~SLOT.STATE_MASK & 0xff

function tally(slots: Uint8Array, mask: number): Map<number, number> {
  const counts = new Map<number, number>()
  for (const value of slots) {
    const key = value & mask
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Every (flags, state) pair appears as exactly one uninterrupted run. */
function runsOf(slots: Uint8Array): number[][] {
  const runs: number[][] = []
  for (let index = 0; index < slots.length; index += 1) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last[0] === slots[index]) last[1] += 1
    else runs.push([slots[index], 1])
  }
  return runs
}

function expectNoHoles(slots: Uint8Array): void {
  const seen = new Set<number>()
  for (const [value] of runsOf(slots)) {
    expect(seen.has(value)).toBe(false)
    seen.add(value)
  }
}

describe('groupSlotsForDisplay', () => {
  it('fills a contiguous block from scattered warm reuse', () => {
    const slots = Uint8Array.from([
      SLOT.RUNNING, SLOT.WARM, SLOT.RUNNING, SLOT.FREE, SLOT.WARM,
      SLOT.INIT, SLOT.FREE, SLOT.RUNNING, SLOT.WARM, SLOT.FREE,
    ])
    const grouped = groupSlotsForDisplay(slots)
    expect([...grouped]).toEqual([
      SLOT.RUNNING, SLOT.RUNNING, SLOT.RUNNING,
      SLOT.INIT,
      SLOT.WARM, SLOT.WARM, SLOT.WARM,
      SLOT.FREE, SLOT.FREE, SLOT.FREE,
    ])
    expectNoHoles(grouped)
  })

  it('groups each allocation region separately and never reallocates a tile', () => {
    const pc = SLOT.PROVISIONED | SLOT.RESERVED
    const rc = SLOT.RESERVED
    const outside = SLOT.OUTSIDE
    const slots = Uint8Array.from([
      pc | SLOT.FREE, pc | SLOT.RUNNING, pc | SLOT.FREE, pc | SLOT.RUNNING,
      rc | SLOT.WARM, rc | SLOT.FREE, rc | SLOT.RUNNING, rc | SLOT.INIT, rc | SLOT.FREE,
      outside | SLOT.FREE, outside | SLOT.FREE,
    ])
    const grouped = groupSlotsForDisplay(slots)

    expect([...grouped.slice(0, 4)]).toEqual([pc | SLOT.RUNNING, pc | SLOT.RUNNING, pc | SLOT.FREE, pc | SLOT.FREE])
    expect([...grouped.slice(4, 9)]).toEqual([
      rc | SLOT.RUNNING, rc | SLOT.INIT, rc | SLOT.WARM, rc | SLOT.FREE, rc | SLOT.FREE,
    ])
    expect([...grouped.slice(9)]).toEqual([outside | SLOT.FREE, outside | SLOT.FREE])
    // Flags are positional, so every region keeps exactly the tiles it started with.
    expect(tally(grouped, FLAG_MASK)).toEqual(tally(slots, FLAG_MASK))
    expectNoHoles(grouped)
  })

  it('preserves every exact state and flag count', () => {
    const slots = Uint8Array.from([
      SLOT.PROVISIONED | SLOT.RUNNING, SLOT.PROVISIONED | SLOT.FREE, SLOT.PROVISIONED | SLOT.WARM,
      SLOT.INIT, SLOT.FREE, SLOT.RUNNING, SLOT.WARM, SLOT.INIT,
      SLOT.OUTSIDE | SLOT.FREE,
    ])
    const grouped = groupSlotsForDisplay(slots)
    expect(grouped).toHaveLength(slots.length)
    expect(tally(grouped, SLOT.STATE_MASK)).toEqual(tally(slots, SLOT.STATE_MASK))
    expect(tally(grouped, 0xff)).toEqual(tally(slots, 0xff))
  })

  it('is idempotent and leaves the input unmodified', () => {
    const slots = Uint8Array.from([
      SLOT.PROVISIONED | SLOT.WARM, SLOT.PROVISIONED | SLOT.RUNNING,
      SLOT.FREE, SLOT.RUNNING, SLOT.WARM, SLOT.INIT, SLOT.FREE,
    ])
    const original = Uint8Array.from(slots)
    const once = groupSlotsForDisplay(slots)
    const twice = groupSlotsForDisplay(once)

    expect(slots).toEqual(original)
    expect(once).not.toBe(slots)
    expect([...twice]).toEqual([...once])
    expect([...groupSlotsForDisplay(slots)]).toEqual([...once])
  })

  it('handles an empty grid, an all free grid and an all running grid', () => {
    expect(groupSlotsForDisplay(new Uint8Array(0))).toHaveLength(0)

    const free = new Uint8Array(16)
    expect([...groupSlotsForDisplay(free)]).toEqual([...free])

    const full = new Uint8Array(16).fill(SLOT.RUNNING)
    expect([...groupSlotsForDisplay(full)]).toEqual([...full])
  })

  it('groups a high concurrency grid of ten thousand tiles', () => {
    const size = 10_000
    const provisioned = 2_000
    const reserved = 6_000
    const slots = new Uint8Array(size)
    const states = [SLOT.FREE, SLOT.INIT, SLOT.RUNNING, SLOT.WARM]
    for (let index = 0; index < size; index += 1) {
      const flags =
        (index < provisioned ? SLOT.PROVISIONED : 0) |
        (index < reserved ? SLOT.RESERVED : SLOT.OUTSIDE)
      slots[index] = flags | states[(index * 7) % 4]
    }
    const grouped = groupSlotsForDisplay(slots)

    expect(tally(grouped, 0xff)).toEqual(tally(slots, 0xff))
    expect(tally(grouped, SLOT.STATE_MASK)).toEqual(tally(slots, SLOT.STATE_MASK))
    expectNoHoles(grouped)
    // Three regions, each holding all four states.
    expect(runsOf(grouped)).toHaveLength(12)
    expect([...groupSlotsForDisplay(grouped)]).toEqual([...grouped])
  })
})

describe('groupSlotsWithTiming', () => {
  it('moves each countdown with its own tile', () => {
    const slots = Uint8Array.from([SLOT.WARM, SLOT.RUNNING, SLOT.FREE, SLOT.RUNNING, SLOT.INIT])
    const remainingMs = Float64Array.from([0, 250, 0, 900, 0])
    const grouped = groupSlotsWithTiming(slots, remainingMs)

    expect([...grouped.slots]).toEqual([SLOT.RUNNING, SLOT.RUNNING, SLOT.INIT, SLOT.WARM, SLOT.FREE])
    expect([...grouped.remainingMs]).toEqual([250, 900, 0, 0, 0])
  })

  it('preserves the original order of tiles sharing a state', () => {
    const slots = new Uint8Array(6).fill(SLOT.RUNNING)
    slots[2] = SLOT.WARM
    const remainingMs = Float64Array.from([10, 20, 0, 30, 40, 50])
    const grouped = groupSlotsWithTiming(slots, remainingMs)

    expect([...grouped.remainingMs]).toEqual([10, 20, 30, 40, 50, 0])
    expect(grouped.slots[5] & SLOT.STATE_MASK).toBe(SLOT.WARM)
  })

  it('never carries a countdown across an allocation boundary', () => {
    const pc = SLOT.PROVISIONED | SLOT.RESERVED
    const rc = SLOT.RESERVED
    const outside = SLOT.OUTSIDE
    const slots = Uint8Array.from([
      pc | SLOT.FREE, pc | SLOT.RUNNING,
      rc | SLOT.FREE, rc | SLOT.RUNNING, rc | SLOT.RUNNING,
      outside | SLOT.FREE,
    ])
    const remainingMs = Float64Array.from([0, 100, 0, 200, 300, 0])
    const grouped = groupSlotsWithTiming(slots, remainingMs)

    expect([...grouped.slots]).toEqual([
      pc | SLOT.RUNNING, pc | SLOT.FREE,
      rc | SLOT.RUNNING, rc | SLOT.RUNNING, rc | SLOT.FREE,
      outside | SLOT.FREE,
    ])
    expect([...grouped.remainingMs]).toEqual([100, 0, 200, 300, 0, 0])
  })

  it('stays aligned: every countdown sits on a running tile and no other tile has one', () => {
    const slots = Uint8Array.from([
      SLOT.PROVISIONED | SLOT.RUNNING, SLOT.PROVISIONED | SLOT.FREE, SLOT.PROVISIONED | SLOT.RUNNING,
      SLOT.WARM, SLOT.RUNNING, SLOT.FREE, SLOT.INIT, SLOT.RUNNING,
    ])
    const remainingMs = Float64Array.from([120, 0, 480, 0, 640, 0, 0, 720])
    const grouped = groupSlotsWithTiming(slots, remainingMs)

    expect(grouped.remainingMs).toHaveLength(grouped.slots.length)
    for (let index = 0; index < grouped.slots.length; index += 1) {
      const isRunning = (grouped.slots[index] & SLOT.STATE_MASK) === SLOT.RUNNING
      expect(grouped.remainingMs[index] > 0).toBe(isRunning)
    }
    expect([...grouped.remainingMs].filter(value => value > 0).sort((a, b) => a - b))
      .toEqual([120, 480, 640, 720])
  })

  it('is idempotent and leaves both inputs unmodified', () => {
    const slots = Uint8Array.from([SLOT.FREE, SLOT.RUNNING, SLOT.WARM, SLOT.RUNNING, SLOT.INIT])
    const remainingMs = Float64Array.from([0, 700, 0, 100, 0])
    const originalSlots = Uint8Array.from(slots)
    const originalRemaining = Float64Array.from(remainingMs)

    const once = groupSlotsWithTiming(slots, remainingMs)
    const twice = groupSlotsWithTiming(once.slots, once.remainingMs)

    expect(slots).toEqual(originalSlots)
    expect(remainingMs).toEqual(originalRemaining)
    expect(once.slots).not.toBe(slots)
    expect(once.remainingMs).not.toBe(remainingMs)
    expect([...twice.slots]).toEqual([...once.slots])
    expect([...twice.remainingMs]).toEqual([...once.remainingMs])
  })

  it('agrees with the untimed grouping, which still takes one argument', () => {
    const slots = Uint8Array.from([
      SLOT.PROVISIONED | SLOT.WARM, SLOT.PROVISIONED | SLOT.RUNNING,
      SLOT.FREE, SLOT.INIT, SLOT.RUNNING, SLOT.WARM,
      SLOT.OUTSIDE | SLOT.FREE,
    ])
    const grouped = groupSlotsWithTiming(slots, new Float64Array(slots.length))
    expect([...grouped.slots]).toEqual([...groupSlotsForDisplay(slots)])
  })

  it('handles an empty grid', () => {
    const grouped = groupSlotsWithTiming(new Uint8Array(0), new Float64Array(0))
    expect(grouped.slots).toHaveLength(0)
    expect(grouped.remainingMs).toHaveLength(0)
  })

  it('throws when the two arrays disagree on length', () => {
    // Every caller builds the pair together, so a mismatch is a bug, not a frame to draw.
    expect(() => groupSlotsWithTiming(new Uint8Array(4), new Float64Array(3))).toThrow(RangeError)
    expect(() => groupSlotsWithTiming(new Uint8Array(4), new Float64Array(5)))
      .toThrow('4 slots against 5 timings')
    expect(() => groupSlotsWithTiming(new Uint8Array(0), new Float64Array(1))).toThrow(RangeError)
  })

  it('carries timing through a grid of ten thousand tiles', () => {
    const size = 10_000
    const slots = new Uint8Array(size)
    const remainingMs = new Float64Array(size)
    const states = [SLOT.FREE, SLOT.INIT, SLOT.RUNNING, SLOT.WARM]
    for (let index = 0; index < size; index += 1) {
      const flags =
        (index < 2_000 ? SLOT.PROVISIONED : 0) |
        (index < 6_000 ? SLOT.RESERVED : SLOT.OUTSIDE)
      const state = states[(index * 7) % 4]
      slots[index] = flags | state
      remainingMs[index] = state === SLOT.RUNNING ? index + 1 : 0
    }
    const grouped = groupSlotsWithTiming(slots, remainingMs)

    expect(tally(grouped.slots, 0xff)).toEqual(tally(slots, 0xff))
    let running = 0
    for (let index = 0; index < size; index += 1) {
      if ((grouped.slots[index] & SLOT.STATE_MASK) === SLOT.RUNNING) {
        running += 1
        expect(grouped.remainingMs[index]).toBeGreaterThan(0)
      } else {
        expect(grouped.remainingMs[index]).toBe(0)
      }
    }
    expect(running).toBe(size / 4)

    const twice = groupSlotsWithTiming(grouped.slots, grouped.remainingMs)
    expect([...twice.remainingMs]).toEqual([...grouped.remainingMs])
  })
})
