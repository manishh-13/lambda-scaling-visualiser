/**
 * Display-only regrouping of quota tiles.
 *
 * The engine assigns a stable tile to every environment, so warm reuse keeps its index
 * and the grid does not jump between frames. That stability scatters states once a few
 * environments in the middle of a block go idle. This helper is the rendering view of the
 * same data: it reorders state bits so each allocation region reads as contiguous blocks,
 * and it never moves a tile across a region boundary, so provisioned, on-demand, reserved
 * and outside-the-limit counts are untouched.
 *
 * Per-slot timing travels with its tile, so a countdown ring keeps belonging to the
 * request that is actually running in it.
 */

import { SLOT } from './types'

const FLAG_MASK = ~SLOT.STATE_MASK & 0xff

/** Busy first, then reuse, then unused quota. */
const DISPLAY_ORDER = [SLOT.RUNNING, SLOT.INIT, SLOT.WARM, SLOT.FREE] as const

export interface TimedSlots {
  slots: Uint8Array
  remainingMs: Float64Array
}

/**
 * Stable counting sort per maximal run of identical allocation flags: one pass to count
 * the states, one pass to place every tile at the next free position of its state. Linear
 * in the number of tiles, and tiles of the same state keep their original relative order,
 * which is what makes an optional parallel array safe to carry along.
 */
function regroup(slots: Uint8Array, remainingMs: Float64Array | null): TimedSlots {
  const grouped = new Uint8Array(slots.length)
  const groupedRemaining = new Float64Array(remainingMs === null ? 0 : slots.length)
  const cursors = new Int32Array(SLOT.STATE_MASK + 1)

  let runStart = 0
  while (runStart < slots.length) {
    const flags = slots[runStart] & FLAG_MASK
    cursors.fill(0)

    let runEnd = runStart
    while (runEnd < slots.length && (slots[runEnd] & FLAG_MASK) === flags) {
      cursors[slots[runEnd] & SLOT.STATE_MASK] += 1
      runEnd += 1
    }

    // Counts become the first write position of each state inside this region.
    let offset = runStart
    for (const state of DISPLAY_ORDER) {
      const count = cursors[state]
      cursors[state] = offset
      offset += count
    }

    for (let index = runStart; index < runEnd; index += 1) {
      const state = slots[index] & SLOT.STATE_MASK
      const target = cursors[state]
      cursors[state] = target + 1
      grouped[target] = slots[index]
      if (remainingMs !== null) groupedRemaining[target] = remainingMs[index]
    }
    runStart = runEnd
  }
  return { slots: grouped, remainingMs: groupedRemaining }
}

/**
 * Returns a new array in which every maximal run of tiles sharing the same allocation
 * flags has its states sorted into DISPLAY_ORDER. Pure, deterministic and idempotent:
 * the input is never modified, and regrouping an already grouped array is a no-op.
 */
export function groupSlotsForDisplay(slots: Uint8Array): Uint8Array {
  return regroup(slots, null).slots
}

/**
 * The same regrouping, carrying per-slot remaining handler time with each tile.
 *
 * A value never crosses an allocation boundary and never changes tile, so the returned
 * arrays stay aligned by index. Both inputs are left unmodified.
 *
 * Every producer of the two arrays builds them together and therefore aligned, so a
 * length mismatch is a programming error rather than a state worth rendering: it throws
 * instead of guessing which array to trust.
 */
export function groupSlotsWithTiming(slots: Uint8Array, remainingMs: Float64Array): TimedSlots {
  if (remainingMs.length !== slots.length) {
    throw new RangeError(
      `Slot timing must align with slots: ${slots.length} slots against ${remainingMs.length} timings.`,
    )
  }
  return regroup(slots, remainingMs)
}
