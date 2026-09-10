import { describe, expect, it } from 'vitest'
import { DURATION_PRESETS, DURATION_SLIDER_STEPS, durationFromSlider, formatHandlerDuration, MAX_HANDLER_MS, sliderFromDuration } from './duration'
import { normalizeSimpleConfig, readSimpleConfig, simpleShareUrl } from './config'
import { advanceSimulation, createSimulation, getSnapshot, sendManualRequest } from '../sim'

describe('full Lambda handler duration range', () => {
  it('puts 1 ms and 15 minutes at the two slider endpoints', () => {
    expect(durationFromSlider(0)).toBe(1)
    expect(durationFromSlider(DURATION_SLIDER_STEPS)).toBe(900_000)
    expect(sliderFromDuration(1)).toBe(0)
    expect(sliderFromDuration(MAX_HANDLER_MS)).toBe(DURATION_SLIDER_STEPS)
    expect(DURATION_PRESETS).toContain(900_000)
    expect(DURATION_PRESETS).toContain(30_000)
  })

  it('is monotonic with useful precision for both short and long handlers', () => {
    let previous = 0
    for (let position = 0; position <= DURATION_SLIDER_STEPS; position += 1) {
      const value = durationFromSlider(position)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeLessThanOrEqual(MAX_HANDLER_MS)
      previous = value
    }
    for (const duration of [1, 20, 100, 1_000, 3_000, 30_000, 60_000, 300_000, MAX_HANDLER_MS]) {
      const roundTrip = durationFromSlider(sliderFromDuration(duration))
      expect(Math.abs(roundTrip - duration)).toBeLessThanOrEqual(Math.max(1, duration * 0.008))
    }
  })

  it('clamps malformed or out-of-range slider values', () => {
    expect(durationFromSlider(-100)).toBe(1)
    expect(durationFromSlider(9999)).toBe(MAX_HANDLER_MS)
    expect(durationFromSlider(Number.NaN)).toBe(1)
    expect(sliderFromDuration(Number.POSITIVE_INFINITY)).toBe(0)
    expect(sliderFromDuration(2_000_000)).toBe(DURATION_SLIDER_STEPS)
  })

  it.each([[100, '100 ms'], [1_000, '1 s'], [30_000, '30 s'], [60_000, '1 min'], [90_000, '1 min 30 s'], [MAX_HANDLER_MS, '15 min']])('labels %i ms as %s', (value, text) => {
    expect(formatHandlerDuration(value)).toBe(text)
  })

  it('shares and restores a full fifteen minute handler, not just the slider limit', () => {
    const config = normalizeSimpleConfig({ durationMs: MAX_HANDLER_MS })
    const link = simpleShareUrl(config, 'https://example.test/lambda-scaling-visualiser/')
    expect(readSimpleConfig(new URL(link).search).durationMs).toBe(MAX_HANDLER_MS)
    expect(normalizeSimpleConfig({ durationMs: MAX_HANDLER_MS + 1 }).durationMs).toBe(MAX_HANDLER_MS)
  })

  it('runs one fifteen minute handler until exactly 900000 ms in the real engine', () => {
    const state = createSimulation({ requestsPerSecond: 0, handlerDurationMs: MAX_HANDLER_MS, initDurationMs: 0 }, 1, { idleRetirementEnabled: false })
    sendManualRequest(state)
    advanceSimulation(state, MAX_HANDLER_MS - 50)
    expect(getSnapshot(state).metrics.concurrentExecutions).toBe(1)
    expect(getSnapshot(state).metrics.durationSamples).toBe(0)
    advanceSimulation(state, 50)
    const done = getSnapshot(state)
    expect(done.metrics.concurrentExecutions).toBe(0)
    expect(done.metrics.durationSamples).toBe(1)
    expect(done.metrics.durationAverageMs).toBe(MAX_HANDLER_MS)
    expect(done.recentEvents.find(event => event.type === 'INVOKE_COMPLETED')?.timeMs).toBe(MAX_HANDLER_MS)
  })
})
