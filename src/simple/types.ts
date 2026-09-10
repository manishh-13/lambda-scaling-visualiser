import type { SimpleConfig } from './config'
import type { ThrottleBlocker } from '../sim/types'

/** State and allocation are independent, so a busy PC slot can still belong to RC. */
export const SLOT = {
  FREE: 0, INIT: 1, RUNNING: 2, WARM: 3, STATE_MASK: 3,
  RESERVED: 4, PROVISIONED: 8, OUTSIDE: 16,
} as const

export interface ScalingPoint {
  timeMs: number
  units: number
  scalingRejections: number
}

export interface SimpleSnapshot {
  config: SimpleConfig
  timeMs: number
  trafficRunning: boolean
  paused: boolean
  slots: Uint8Array
  /**
   * Handler time left for each slot, in the same order and length as `slots`, and zero
   * for every slot that is not RUNNING. Simulated time, never wall clock.
   */
  remainingMs: Float64Array
  concurrent: number
  running: number
  initialising: number
  warm: number
  accepted: number
  completed: number
  rejected: number
  acceptedRps: number
  rejectedRps: number
  units: number
  quotaOccupancy: number
  unreservedAvailable: number
  throttlesByCause: Record<ThrottleBlocker, number>
  lastReject: ThrottleBlocker | null
  history: ScalingPoint[]
}

export type SimpleCommand =
  | { type: 'INIT' | 'CONFIGURE'; config: SimpleConfig; revision: number }
  | { type: 'START' | 'STOP' | 'MANUAL' | 'RESET' | 'PAUSE' | 'RESUME' | 'STEP'; revision: number }

export type SimpleResponse =
  | { type: 'SNAPSHOT'; revision: number; snapshot: SimpleSnapshot }
  | { type: 'MANUAL_RESULT'; revision: number; accepted: boolean; cause: ThrottleBlocker | null }
  | { type: 'ERROR'; revision: number; message: string }
