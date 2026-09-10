/**
 * Quota slots for the simple screen.
 *
 * A tile is one unit of account concurrency quota, not an environment. The grid
 * therefore always has exactly `quota` entries, and an empty tile is unused quota
 * rather than a pre-created environment. Real environments reported by the kernel
 * are mapped onto stable tile indices so a cell does not jump between frames.
 */

import { allocationFor, type SimpleConfig } from './config'
import { SLOT } from './types'
import type { EnvironmentSnapshot } from '../sim'

export interface SlotGeometry {
  quota: number
  /** Dedicated provisioned range, always the first tiles. */
  provisioned: number
  /** Reserved range, always the first tiles, and it contains the provisioned range. */
  reserved: number
  reservedEnabled: boolean
  /** On-demand environments live in [onDemandStart, onDemandEnd). */
  onDemandStart: number
  onDemandEnd: number
}

export interface SlotProjection {
  slots: Uint8Array
  /** Handler time left per slot, aligned with `slots`, zero unless the slot is RUNNING. */
  remainingMs: Float64Array
}

export interface SlotStateCounts {
  free: number
  initialising: number
  running: number
  warm: number
}

export function slotGeometry(config: SimpleConfig): SlotGeometry {
  const allocation = allocationFor(config)
  const quota = config.quota
  const provisioned = Math.max(0, Math.min(allocation.provisioned, quota))
  const reserved = config.reservedEnabled ? Math.max(0, Math.min(allocation.reserved, quota)) : 0
  return {
    quota,
    provisioned,
    reserved,
    reservedEnabled: config.reservedEnabled,
    onDemandStart: provisioned,
    onDemandEnd: config.reservedEnabled ? Math.max(provisioned, reserved) : quota,
  }
}

/**
 * Allocation flags only. A provisioned tile inside a reservation carries both flags,
 * because provisioned concurrency is a subset of reserved concurrency, so adding the
 * two counts would count that tile twice.
 */
function allocationFlags(geometry: SlotGeometry): Uint8Array {
  const slots = new Uint8Array(geometry.quota)
  for (let index = 0; index < geometry.quota; index += 1) {
    let flags = 0
    if (index < geometry.provisioned) flags |= SLOT.PROVISIONED
    if (geometry.reservedEnabled) flags |= index < geometry.reserved ? SLOT.RESERVED : SLOT.OUTSIDE
    slots[index] = flags
  }
  return slots
}

function sequence(environment: EnvironmentSnapshot): number {
  const parsed = Number(environment.id.slice(environment.id.indexOf('-') + 1))
  return Number.isFinite(parsed) ? parsed : 0
}

function byCreation(a: EnvironmentSnapshot, b: EnvironmentSnapshot): number {
  return sequence(a) - sequence(b)
}

export function countSlotStates(slots: Uint8Array): SlotStateCounts {
  const counts: SlotStateCounts = { free: 0, initialising: 0, running: 0, warm: 0 }
  for (const value of slots) {
    const state = value & SLOT.STATE_MASK
    if (state === SLOT.INIT) counts.initialising += 1
    else if (state === SLOT.RUNNING) counts.running += 1
    else if (state === SLOT.WARM) counts.warm += 1
    else counts.free += 1
  }
  return counts
}

export function countSlotFlag(slots: Uint8Array, flag: number): number {
  let total = 0
  for (const value of slots) if ((value & flag) === flag) total += 1
  return total
}

/**
 * Stable environment to tile assignment across frames.
 *
 * A busy tile is never displaced: an environment that is initialising or running keeps
 * its index for as long as it holds a request. Idle assignments are a courtesy so warm
 * reuse looks continuous, and they yield as soon as a busy environment needs the space,
 * so a large warm footprint can never hide work.
 */
export class SlotField {
  private readonly assigned = new Map<string, number>()

  reset(): void {
    this.assigned.clear()
  }

  indexOf(environmentId: string): number | undefined {
    return this.assigned.get(environmentId)
  }

  map(config: SimpleConfig, environments: readonly EnvironmentSnapshot[]): Uint8Array {
    const geometry = slotGeometry(config)
    const slots = allocationFlags(geometry)
    const occupied = new Uint8Array(geometry.quota)

    const provisioned: EnvironmentSnapshot[] = []
    const busy: EnvironmentSnapshot[] = []
    const idle: EnvironmentSnapshot[] = []
    const live = new Set<string>()
    for (const environment of environments) {
      // RETIRING is a sub-tick state here, so its tile is already released.
      if (environment.state === 'RETIRING') continue
      live.add(environment.id)
      if (environment.kind === 'PROVISIONED') provisioned.push(environment)
      else if (environment.state === 'INITIALISING' || environment.state === 'RUNNING') busy.push(environment)
      else idle.push(environment)
    }
    for (const id of [...this.assigned.keys()]) if (!live.has(id)) this.assigned.delete(id)
    provisioned.sort(byCreation)
    busy.sort(byCreation)
    idle.sort(byCreation)

    const placed = new Map<string, number>()
    const idlePlaced = new Map<string, number>()

    const keep = (environment: EnvironmentSnapshot, start: number, end: number): number => {
      const current = this.assigned.get(environment.id)
      if (current === undefined || current < start || current >= end || occupied[current]) return -1
      occupied[current] = 1
      return current
    }

    const pendingProvisioned: EnvironmentSnapshot[] = []
    for (const environment of provisioned) {
      const index = keep(environment, 0, geometry.provisioned)
      if (index >= 0) placed.set(environment.id, index)
      else pendingProvisioned.push(environment)
    }
    let cursor = 0
    for (const environment of pendingProvisioned) {
      while (cursor < geometry.provisioned && occupied[cursor]) cursor += 1
      if (cursor >= geometry.provisioned) {
        this.assigned.delete(environment.id)
        continue
      }
      occupied[cursor] = 1
      placed.set(environment.id, cursor)
      this.assigned.set(environment.id, cursor)
    }

    const start = geometry.onDemandStart
    const end = geometry.onDemandEnd
    const pendingBusy: EnvironmentSnapshot[] = []
    for (const environment of busy) {
      const index = keep(environment, start, end)
      if (index >= 0) placed.set(environment.id, index)
      else pendingBusy.push(environment)
    }
    const pendingIdle: EnvironmentSnapshot[] = []
    for (const environment of idle) {
      const index = keep(environment, start, end)
      if (index >= 0) idlePlaced.set(environment.id, index)
      else pendingIdle.push(environment)
    }

    const free: number[] = []
    for (let index = start; index < end; index += 1) if (!occupied[index]) free.push(index)
    let next = 0
    const take = (): number => {
      while (next < free.length && occupied[free[next]]) next += 1
      if (next >= free.length) return -1
      const index = free[next]
      next += 1
      occupied[index] = 1
      return index
    }

    let victims: Array<[string, number]> | null = null
    // The highest idle tile yields first, so busy work stays in one compact block.
    const evict = (): number => {
      if (victims === null) victims = [...idlePlaced].sort((a, b) => a[1] - b[1])
      while (victims.length > 0) {
        const [id, index] = victims.pop()!
        if (idlePlaced.get(id) !== index) continue
        idlePlaced.delete(id)
        this.assigned.delete(id)
        return index
      }
      return -1
    }

    for (const environment of pendingBusy) {
      let index = take()
      if (index < 0) index = evict()
      if (index < 0) continue
      placed.set(environment.id, index)
      this.assigned.set(environment.id, index)
    }
    for (const environment of pendingIdle) {
      const index = take()
      if (index < 0) {
        this.assigned.delete(environment.id)
        continue
      }
      idlePlaced.set(environment.id, index)
      this.assigned.set(environment.id, index)
    }

    // A provisioned environment is idle but permanently allocated, and warm reuse is
    // only part of the story being told while idle retirement is switched on.
    const stateOf = (environment: EnvironmentSnapshot): number => {
      if (environment.state === 'RUNNING') return SLOT.RUNNING
      if (environment.state === 'INITIALISING') return SLOT.INIT
      if (environment.state === 'WARM_IDLE' && config.idleEnabled) return SLOT.WARM
      return SLOT.FREE
    }
    for (const environment of [...provisioned, ...busy, ...idle]) {
      const index = placed.get(environment.id) ?? idlePlaced.get(environment.id)
      if (index === undefined) continue
      slots[index] = (slots[index] & ~SLOT.STATE_MASK) | stateOf(environment)
    }
    return slots
  }

  /**
   * The same tile mapping plus how much handler time each running request has left.
   *
   * The kernel reports time in the current state, and INITIALISING is a state of its own,
   * so a running environment's age is handler time alone and an init never counts towards
   * the countdown. Nothing here reads a wall clock: a paused run reports the same value on
   * every frame. Completed and retired environments report zero; a reused environment
   * starts a fresh countdown when its next handler begins.
   */
  project(config: SimpleConfig, environments: readonly EnvironmentSnapshot[]): SlotProjection {
    const slots = this.map(config, environments)
    const remainingMs = new Float64Array(slots.length)
    const duration = Math.max(0, config.durationMs)
    for (const environment of environments) {
      if (environment.state !== 'RUNNING') continue
      const index = this.indexOf(environment.id)
      if (index === undefined || index >= slots.length) continue
      if ((slots[index] & SLOT.STATE_MASK) !== SLOT.RUNNING) continue
      const elapsed = Number.isFinite(environment.timeInStateMs) ? environment.timeInStateMs : 0
      remainingMs[index] = Math.min(duration, Math.max(0, duration - elapsed))
    }
    return { slots, remainingMs }
  }
}
