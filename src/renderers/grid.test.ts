import { describe, expect, it } from 'vitest'
import {
  CANVAS_EXIT_THRESHOLD,
  CANVAS_THRESHOLD,
  FIELD_HEIGHT_PX,
  INIT_RING_SEGMENTS,
  MARKER_TEXT_MIN_CELL_PX,
  cellRect,
  clampProgress,
  computeGridGeometry,
  computePageWindow,
  gapForCount,
  hitTestCell,
  initRingSegments,
  nextRendererMode,
  pageForIndex,
  quantizeProgress,
  shouldUseCanvas,
  supportsMarkerText,
} from './grid'

describe('renderer switch threshold', () => {
  it('keeps semantic tiles up to the threshold and switches above it', () => {
    expect(shouldUseCanvas(CANVAS_THRESHOLD - 1)).toBe(false)
    expect(shouldUseCanvas(CANVAS_THRESHOLD)).toBe(false)
    expect(shouldUseCanvas(CANVAS_THRESHOLD + 1)).toBe(true)
  })

  it('picks the initial mode from the canvas threshold alone', () => {
    expect(nextRendererMode(null, 200)).toBe('dom')
    expect(nextRendererMode(null, 201)).toBe('canvas')
    expect(nextRendererMode(undefined, 0)).toBe('dom')
  })

  it('switches a live DOM grid to canvas only above the threshold', () => {
    expect(nextRendererMode('dom', 200)).toBe('dom')
    expect(nextRendererMode('dom', 201)).toBe('canvas')
  })

  it('holds canvas through the hysteresis band and returns to tiles below it', () => {
    expect(nextRendererMode('canvas', 201)).toBe('canvas')
    expect(nextRendererMode('canvas', 200)).toBe('canvas')
    expect(nextRendererMode('canvas', CANVAS_EXIT_THRESHOLD)).toBe('canvas')
    expect(nextRendererMode('canvas', CANVAS_EXIT_THRESHOLD - 1)).toBe('dom')
    expect(nextRendererMode('canvas', 179)).toBe('dom')
  })

  it('is idempotent, so repeated renders cannot thrash', () => {
    for (const count of [0, 179, 180, 200, 201, 5_000]) {
      const first = nextRendererMode(null, count)
      expect(nextRendererMode(first, count)).toBe(first)
    }
  })

  it('uses a tighter gap once the canvas renderer is active', () => {
    expect(gapForCount(200)).toBe(6)
    expect(gapForCount(201)).toBe(3)
    expect(gapForCount(601)).toBe(2)
  })
})

describe('computeGridGeometry', () => {
  it('fits every environment inside the fixed field height when it can', () => {
    const geometry = computeGridGeometry(900, FIELD_HEIGHT_PX, 200, { minCell: 12 })
    expect(geometry.fits).toBe(true)
    expect(geometry.capacity).toBeGreaterThanOrEqual(200)
    expect(geometry.columns * geometry.rows).toBe(geometry.capacity)
  })

  it('chooses the largest cell size that still fits', () => {
    const few = computeGridGeometry(900, FIELD_HEIGHT_PX, 12)
    const many = computeGridGeometry(900, FIELD_HEIGHT_PX, 900)
    expect(few.cell).toBeGreaterThan(many.cell)
    expect(few.cell).toBeLessThanOrEqual(34)
  })

  it('never places a row or column outside the measured box', () => {
    const geometry = computeGridGeometry(500, FIELD_HEIGHT_PX, 400)
    const lastX = geometry.padding + (geometry.columns - 1) * (geometry.cell + geometry.gap) + geometry.cell
    const lastY = geometry.padding + (geometry.rows - 1) * (geometry.cell + geometry.gap) + geometry.cell
    expect(lastX).toBeLessThanOrEqual(500)
    expect(lastY).toBeLessThanOrEqual(FIELD_HEIGHT_PX)
  })

  it('reports that it does not fit when the count exceeds the smallest usable grid', () => {
    const geometry = computeGridGeometry(300, FIELD_HEIGHT_PX, 100_000)
    expect(geometry.fits).toBe(false)
    expect(geometry.cell).toBe(8)
    expect(geometry.capacity).toBeGreaterThan(0)
  })

  it('stays defined for a zero width measurement', () => {
    const geometry = computeGridGeometry(0, FIELD_HEIGHT_PX, 10)
    expect(geometry.columns).toBeGreaterThanOrEqual(1)
    expect(geometry.rows).toBeGreaterThanOrEqual(1)
  })
})

describe('cellRect and hitTestCell', () => {
  const geometry = computeGridGeometry(400, FIELD_HEIGHT_PX, 300)

  it('round trips the centre of every visible cell', () => {
    for (let index = 0; index < 40; index += 1) {
      const rect = cellRect(index, geometry)
      const hit = hitTestCell(rect.x + rect.size / 2, rect.y + rect.size / 2, geometry, 300)
      expect(hit).toBe(index)
    }
  })

  it('returns null inside the gap between cells', () => {
    const rect = cellRect(0, geometry)
    const gapPoint = rect.x + rect.size + geometry.gap / 2
    expect(hitTestCell(gapPoint, rect.y + 1, geometry, 300)).toBeNull()
  })

  it('returns null for coordinates outside the grid and for empty trailing cells', () => {
    expect(hitTestCell(-4, 10, geometry, 300)).toBeNull()
    expect(hitTestCell(10, -4, geometry, 300)).toBeNull()
    expect(hitTestCell(10_000, 10, geometry, 300)).toBeNull()
    const rect = cellRect(5, geometry)
    expect(hitTestCell(rect.x + 1, rect.y + 1, geometry, 3)).toBeNull()
  })

  it('walks left to right then top to bottom', () => {
    const first = cellRect(0, geometry)
    const second = cellRect(1, geometry)
    const nextRow = cellRect(geometry.columns, geometry)
    expect(second.x).toBeGreaterThan(first.x)
    expect(second.y).toBe(first.y)
    expect(nextRow.x).toBe(first.x)
    expect(nextRow.y).toBeGreaterThan(first.y)
  })
})

describe('computePageWindow', () => {
  it('shows a single page when everything fits', () => {
    const window = computePageWindow(150, 400, 1)
    expect(window).toMatchObject({ page: 1, pageCount: 1, startIndex: 0, endIndex: 150, paginated: false })
  })

  it('paginates with an exact count and no silent clipping', () => {
    const first = computePageWindow(340, 200, 1)
    const second = computePageWindow(340, 200, 2)
    expect(first).toMatchObject({ pageCount: 2, startIndex: 0, endIndex: 200, paginated: true })
    expect(second).toMatchObject({ page: 2, startIndex: 200, endIndex: 340 })
    expect(first.endIndex - first.startIndex + (second.endIndex - second.startIndex)).toBe(340)
  })

  it('clamps an out of range page request', () => {
    expect(computePageWindow(340, 200, 99).page).toBe(2)
    expect(computePageWindow(340, 200, -3).page).toBe(1)
    expect(computePageWindow(0, 200, 4)).toMatchObject({ page: 1, pageCount: 1, startIndex: 0, endIndex: 0 })
  })

  it('maps an index back to its page', () => {
    expect(pageForIndex(0, 200)).toBe(1)
    expect(pageForIndex(199, 200)).toBe(1)
    expect(pageForIndex(200, 200)).toBe(2)
  })
})

describe('motion helpers', () => {
  it('clamps progress into the unit range', () => {
    expect(clampProgress(-1)).toBe(0)
    expect(clampProgress(2)).toBe(1)
    expect(clampProgress(Number.NaN)).toBe(0)
    expect(clampProgress(0.42)).toBeCloseTo(0.42)
  })

  it('keeps continuous progress when motion is allowed', () => {
    expect(quantizeProgress(0.37, false)).toBeCloseTo(0.37)
  })

  it('collapses progress into discrete steps under reduced motion', () => {
    expect(quantizeProgress(0.37, true)).toBe(0.25)
    expect(quantizeProgress(0.99, true)).toBe(0.75)
    expect(quantizeProgress(1, true)).toBe(1)
    expect(quantizeProgress(0, true)).toBe(0)
  })

  it('fills whole init ring segments only', () => {
    expect(initRingSegments(0, false)).toBe(0)
    expect(initRingSegments(1, false)).toBe(INIT_RING_SEGMENTS)
    expect(initRingSegments(0.5, false)).toBe(3)
    expect(initRingSegments(0.49, true)).toBe(2)
    expect(initRingSegments(2, true)).toBe(INIT_RING_SEGMENTS)
  })

  it('only draws text markers when the cell has room', () => {
    expect(supportsMarkerText(MARKER_TEXT_MIN_CELL_PX)).toBe(true)
    expect(supportsMarkerText(MARKER_TEXT_MIN_CELL_PX - 1)).toBe(false)
  })
})
