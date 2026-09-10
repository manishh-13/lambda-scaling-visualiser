import { describe, expect, it, vi } from 'vitest'
import { drawRemainingTime, remainingFraction } from './progress'

describe('remaining handler progress', () => {
  it('drains from a full ring to empty using the actual remaining duration', () => {
    expect(remainingFraction(1_000, 1_000)).toBe(1)
    expect(remainingFraction(750, 1_000)).toBe(0.75)
    expect(remainingFraction(250, 1_000)).toBe(0.25)
    expect(remainingFraction(0, 1_000)).toBe(0)
    expect(remainingFraction(450_000, 900_000)).toBe(0.5)
  })

  it('bounds invalid values without drawing NaN arcs', () => {
    expect(remainingFraction(-50, 1_000)).toBe(0)
    expect(remainingFraction(2_000, 1_000)).toBe(1)
    for (const [remaining, duration] of [[NaN, 1_000], [1_000, NaN], [Infinity, 1_000], [1_000, Infinity], [1_000, 0]]) expect(remainingFraction(remaining, duration)).toBe(0)
  })

  it('draws a half remaining ring, not a repeating decorative spinner', () => {
    const context = { beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), lineCap: 'butt' } as unknown as CanvasRenderingContext2D
    drawRemainingTime(context, 10, 20, 20, 0.5)
    expect(context.arc).toHaveBeenNthCalledWith(1, 20, 30, 5, 0, Math.PI * 2)
    expect(context.arc).toHaveBeenNthCalledWith(2, 20, 30, 5, -Math.PI / 2, Math.PI / 2)
    expect(context.fillRect).not.toHaveBeenCalled()
    expect(context.lineCap).toBe('butt')
  })

  it('keeps the time-left cue in dense grids with cells smaller than eight pixels', () => {
    const context = { beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D
    drawRemainingTime(context, 10, 20, 6, 0.5)
    expect(context.fillRect).toHaveBeenNthCalledWith(1, 11, 24, 4, 1)
    expect(context.fillRect).toHaveBeenNthCalledWith(2, 11, 24, 2, 1)
    expect(context.arc).not.toHaveBeenCalled()
  })
})
