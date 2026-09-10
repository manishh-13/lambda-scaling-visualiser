import { THROTTLE_CAUSE_PRECEDENCE, type ThrottleBlocker } from './types'

export interface ScalingBucket {
  balance: number
  lastRefillMs: number
}

export function refillScalingBucket(bucket: ScalingBucket, nowMs: number): void {
  if (nowMs < bucket.lastRefillMs) throw new RangeError('Simulation time cannot go backwards.')
  bucket.balance = Math.min(1_000, bucket.balance + (nowMs - bucket.lastRefillMs) * 0.1)
  bucket.lastRefillMs = nowMs
}

/** Capacity units authorize an environment slot and ten synchronous RPS together. */
export function scalingExpansionCost(capacityUnits: number, environmentsNeeded: number, rpsNeeded: number): number {
  return Math.max(0, environmentsNeeded - capacityUnits, rpsNeeded / 10 - capacityUnits)
}

export interface RateGate { phase: number }

/** Fractional phase is rounding error, never saved whole-request burst allowance. */
export function rateOpportunity(gate: RateGate, offeredRps: number, ceilingRps: number): boolean {
  if (ceilingRps <= 0) return false
  if (offeredRps <= ceilingRps) return true
  gate.phase += ceilingRps / offeredRps
  if (gate.phase + 1e-9 < 1) return false
  gate.phase = Math.max(0, gate.phase - 1)
  return true
}

export interface CapacityInputs {
  concurrent: number
  onDemandConcurrent: number
  provisionedAllocated: number
  usesProvisioned: boolean
  accountQuota: number
  reserved: number | null
  scalingCost: number
  scalingTokens: number
  rpsBlocked: boolean
}

/** Diagnoses all blockers without allocating capacity or changing metric counters. */
export function capacityBlockers(input: CapacityInputs): ThrottleBlocker[] {
  const occupancy = input.provisionedAllocated + input.onDemandConcurrent
  const blocked = new Set<ThrottleBlocker>()
  if (input.rpsBlocked) blocked.add('RPS_CEILING')
  if (input.reserved !== null && (input.concurrent >= input.reserved || (!input.usesProvisioned && occupancy >= input.reserved))) {
    blocked.add('RESERVED_CONCURRENCY')
  }
  if (input.concurrent >= input.accountQuota || (!input.usesProvisioned && occupancy >= input.accountQuota)) {
    blocked.add('ACCOUNT_CONCURRENCY')
  }
  if (!input.usesProvisioned && input.scalingCost > input.scalingTokens + 1e-8) blocked.add('SCALING_RATE')
  return THROTTLE_CAUSE_PRECEDENCE.filter(cause => blocked.has(cause))
}
