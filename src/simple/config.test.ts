import { describe, expect, it } from 'vitest'
import { allocationFor, DEFAULT_SIMPLE_CONFIG, normalizeSimpleConfig, readSimpleConfig, requiresRestart, simpleShareUrl } from './config'
import { CAPACITY_COLORS, gridGeometry, slotDescription } from './CapacityGrid'
import { SLOT } from './types'
import { initialSnapshot } from './useSimulation'

describe('simple configuration and allocation', () => {
  it('starts simple with Init and idle retirement off, at 400 RPS', () => {
    expect(normalizeSimpleConfig()).toEqual(DEFAULT_SIMPLE_CONFIG)
    expect(readSimpleConfig()).toEqual(DEFAULT_SIMPLE_CONFIG)
    const snapshot = initialSnapshot(DEFAULT_SIMPLE_CONFIG)
    expect(snapshot.slots.length).toBe(1_000)
    expect(snapshot.slots.every(code => code === SLOT.FREE)).toBe(true)
    expect(snapshot.concurrent).toBe(0)
    expect(snapshot.unreservedAvailable).toBe(1_000)
  })

  it.each([
    [{}, { reserved: 0, provisioned: 0, unreservedPool: 1_000, functionLimit: 1_000 }],
    [{ reservedEnabled: true }, { reserved: 400, provisioned: 0, unreservedPool: 600, functionLimit: 400 }],
    [{ provisionedEnabled: true, provisioned: 400 }, { reserved: 0, provisioned: 400, unreservedPool: 600, functionLimit: 1_000 }],
    [{ reservedEnabled: true, reserved: 400, provisionedEnabled: true, provisioned: 200 }, { reserved: 400, provisioned: 200, unreservedPool: 600, functionLimit: 400 }],
    [{ reservedEnabled: true, reserved: 0, provisionedEnabled: true, provisioned: 200 }, { reserved: 0, provisioned: 0, unreservedPool: 1_000, functionLimit: 0 }],
  ])('counts RC and PC only once for %o', (input, allocation) => {
    expect(allocationFor(normalizeSimpleConfig(input))).toMatchObject(allocation)
  })

  it('keeps 100 quota units unreserved and bounds PC by RC when enabled', () => {
    expect(normalizeSimpleConfig({ reserved: 1_000, reservedEnabled: true }).reserved).toBe(900)
    expect(normalizeSimpleConfig({ provisioned: 1_000, provisionedEnabled: true }).provisioned).toBe(900)
    expect(normalizeSimpleConfig({ reserved: 100, reservedEnabled: true, provisioned: 400 }).provisioned).toBe(100)
  })

  it('sanitizes nonfinite, fractional, and out-of-range settings', () => {
    const config = normalizeSimpleConfig({ quota: 1_000.1, rps: Number.NaN, reserved: Number.POSITIVE_INFINITY, durationMs: -10, idleMs: 0, speed: 99 })
    expect(config).toMatchObject({ quota: 1_000, rps: 400, reserved: 400, durationMs: 1, idleMs: 1_000, speed: 1 })
  })

  it('restores all simple settings without restoring playback', () => {
    const config = normalizeSimpleConfig({ rps: 321.5, durationMs: 20, quota: 2_000, reservedEnabled: true, reserved: 550, provisionedEnabled: true, provisioned: 200, initEnabled: true, initMs: 123, idleEnabled: true, idleMs: 4_000, speed: 4 })
    const link = simpleShareUrl(config, 'https://example.test/lambda-scaling-visualiser/?unrelated=kept#demo')
    const url = new URL(link)
    expect(readSimpleConfig(url.search)).toEqual(config)
    expect(url.pathname).toBe('/lambda-scaling-visualiser/')
    expect(url.hash).toBe('#demo')
    expect(url.searchParams.get('unrelated')).toBe('kept')
    expect(url.searchParams.get('v')).toBe('2')
  })

  it('preserves explicit lifecycle intent from an older link', () => {
    expect(readSimpleConfig('?v=1&rps=50&dur=500&init=200&idle=3000')).toMatchObject({ rps: 50, durationMs: 500, initEnabled: true, idleEnabled: true })
    expect(readSimpleConfig('?v=2&init=200&idle=3000')).toMatchObject({ initEnabled: false, idleEnabled: false })
    expect(readSimpleConfig('?rps=bad&quota=Infinity')).toEqual(DEFAULT_SIMPLE_CONFIG)
  })

  it('does not reset on rate or speed edits, but restarts capacity and lifecycle safely', () => {
    expect(requiresRestart(DEFAULT_SIMPLE_CONFIG, { ...DEFAULT_SIMPLE_CONFIG, rps: 3_000, speed: 4 })).toBe(false)
    expect(requiresRestart(DEFAULT_SIMPLE_CONFIG, { ...DEFAULT_SIMPLE_CONFIG, reservedEnabled: true })).toBe(true)
    expect(requiresRestart(DEFAULT_SIMPLE_CONFIG, { ...DEFAULT_SIMPLE_CONFIG, idleEnabled: true })).toBe(true)
    expect(requiresRestart(DEFAULT_SIMPLE_CONFIG, { ...DEFAULT_SIMPLE_CONFIG, durationMs: 20 })).toBe(true)
  })
})

describe('simple slot visual language', () => {
  it('initial reservation remains visible independently of state and PC membership', () => {
    const config = normalizeSimpleConfig({ reservedEnabled: true, reserved: 400, provisionedEnabled: true, provisioned: 200 })
    const snapshot = initialSnapshot(config)
    expect([...snapshot.slots].filter(code => code & SLOT.RESERVED)).toHaveLength(400)
    expect([...snapshot.slots].filter(code => code & SLOT.PROVISIONED)).toHaveLength(200)
    expect([...snapshot.slots].filter(code => code & SLOT.OUTSIDE)).toHaveLength(600)
    expect(snapshot.quotaOccupancy).toBe(200)
    expect(snapshot.unreservedAvailable).toBe(600)
    expect(slotDescription(SLOT.RESERVED | SLOT.PROVISIONED | SLOT.RUNNING)).toBe('reserved for this function, provisioned, running')
  })

  it.each([[320, 1_000], [780, 1_000], [280, 10_000], [800, 10_000], [280, 100]])('fits all %i px / %i slots without clipping', (width, count) => {
    const g = gridGeometry(width, count)
    expect(g.columns * g.rows).toBeGreaterThanOrEqual(count)
    expect(g.padding * 2 + g.columns * g.cell + (g.columns - 1) * g.gap).toBeLessThanOrEqual(width + 0.001)
    expect(g.height).toBeGreaterThan(0)
    expect(g.height).toBeLessThan(800)
  })

  it('keeps the exported geometry finite for an empty projection', () => {
    const geometry = gridGeometry(320, 0)
    expect(Object.values(geometry).every(Number.isFinite)).toBe(true)
    expect(geometry.columns).toBe(1)
    expect(geometry.rows).toBe(0)
  })

  it('separates warm from free by luminance and retains non-color descriptions', () => {
    const luminance = (color: string) => {
      const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    }
    const ratio = (luminance(CAPACITY_COLORS.free) + 0.05) / (luminance(CAPACITY_COLORS.warm) + 0.05)
    expect(ratio).toBeGreaterThan(3)
    expect(slotDescription(SLOT.WARM)).toContain('warm')
    expect(slotDescription(SLOT.RESERVED)).toContain('reserved')
    expect(slotDescription(SLOT.OUTSIDE)).toContain('outside this function')
  })
})
