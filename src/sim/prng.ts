/**
 * Deterministic seeded pseudo random number generator.
 *
 * The simulation never calls the platform random source. Every simulated random choice, such as
 * the provisioned concurrency preparation delay, comes from this generator so the
 * same seed always reproduces the same run.
 */

export interface PrngState {
  /** The original seed, kept for snapshots and reset. */
  seed: number
  /** Mutable internal 32 bit state. */
  value: number
}

const UINT32 = 0x1_0000_0000

/** xfnv1a style string hash, used so text seeds are accepted deterministically. */
export function hashSeed(seed: number | string): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) return 1
    return Math.abs(Math.trunc(seed)) % UINT32
  }
  let h = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function createPrng(seed: number | string): PrngState {
  const hashed = hashSeed(seed)
  return { seed: hashed, value: (hashed || 1) >>> 0 }
}

export function clonePrng(prng: PrngState): PrngState {
  return { seed: prng.seed, value: prng.value }
}

/** mulberry32: small, fast, and stable across platforms. */
export function nextUint32(prng: PrngState): number {
  prng.value = (prng.value + 0x6d2b79f5) >>> 0
  let t = prng.value
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (t ^ (t >>> 14)) >>> 0
}

/** Uniform float in [0, 1). */
export function nextFloat(prng: PrngState): number {
  return nextUint32(prng) / UINT32
}

/** Uniform integer in [min, max], inclusive on both ends. */
export function nextIntInclusive(prng: PrngState, min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max))
  const hi = Math.floor(Math.max(min, max))
  if (hi <= lo) return lo
  return lo + Math.floor(nextFloat(prng) * (hi - lo + 1))
}
