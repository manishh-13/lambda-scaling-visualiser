export const CANVAS_THRESHOLD = 200

export const FIELD_HEIGHT_PX = 260

export const INSPECTOR_HEIGHT_PX = 150

export const GRID_PADDING_PX = 1
export const MIN_CELL_PX = 8
export const MAX_CELL_PX = 34
export const MARKER_TEXT_MIN_CELL_PX = 15
export const REDUCED_MOTION_STEPS = 4
export const INIT_RING_SEGMENTS = 6

export interface GridGeometry {
  columns: number
  rows: number
  cell: number
  gap: number
  padding: number
  capacity: number
  fits: boolean
}

export interface GridOptions {
  gap?: number
  minCell?: number
  maxCell?: number
  padding?: number
}

export interface CellRect {
  x: number
  y: number
  size: number
}

export interface PageWindow {
  page: number
  pageCount: number
  startIndex: number
  endIndex: number
  count: number
  capacity: number
  paginated: boolean
}

export const CANVAS_EXIT_THRESHOLD = 180

export type RendererMode = 'dom' | 'canvas'

export function shouldUseCanvas(count: number): boolean {
  return count > CANVAS_THRESHOLD
}

export function nextRendererMode(previous: RendererMode | null | undefined, count: number): RendererMode {
  if (previous === 'canvas') return count < CANVAS_EXIT_THRESHOLD ? 'dom' : 'canvas'
  return shouldUseCanvas(count) ? 'canvas' : 'dom'
}

export function gapForCount(count: number): number {
  if (count > 600) return 2
  if (count > CANVAS_THRESHOLD) return 3
  return 6
}

function trackLength(available: number, cell: number, gap: number): number {
  return Math.max(1, Math.floor((available + gap) / (cell + gap)))
}

export function computeGridGeometry(width: number, height: number, count: number, options: GridOptions = {}): GridGeometry {
  const padding = options.padding ?? GRID_PADDING_PX
  const gap = options.gap ?? gapForCount(count)
  const minCell = Math.max(1, options.minCell ?? MIN_CELL_PX)
  const maxCell = Math.max(minCell, options.maxCell ?? MAX_CELL_PX)
  const safeCount = Math.max(1, Math.floor(count))
  const usableWidth = Math.max(1, width - padding * 2)
  const usableHeight = Math.max(1, height - padding * 2)

  let fallback: GridGeometry | null = null
  for (let cell = maxCell; cell >= minCell; cell -= 1) {
    const columns = trackLength(usableWidth, cell, gap)
    const rows = trackLength(usableHeight, cell, gap)
    const capacity = columns * rows
    const geometry: GridGeometry = { columns, rows, cell, gap, padding, capacity, fits: capacity >= safeCount }
    if (geometry.fits) return geometry
    fallback = geometry
  }
  return fallback ?? { columns: 1, rows: 1, cell: minCell, gap, padding, capacity: 1, fits: safeCount <= 1 }
}

export function cellRect(indexOnPage: number, geometry: GridGeometry): CellRect {
  const column = indexOnPage % geometry.columns
  const row = Math.floor(indexOnPage / geometry.columns)
  return {
    x: geometry.padding + column * (geometry.cell + geometry.gap),
    y: geometry.padding + row * (geometry.cell + geometry.gap),
    size: geometry.cell,
  }
}

export function hitTestCell(x: number, y: number, geometry: GridGeometry, visibleCount: number): number | null {
  const stride = geometry.cell + geometry.gap
  const localX = x - geometry.padding
  const localY = y - geometry.padding
  if (localX < 0 || localY < 0) return null
  const column = Math.floor(localX / stride)
  const row = Math.floor(localY / stride)
  if (column >= geometry.columns || row >= geometry.rows) return null
  if (localX - column * stride >= geometry.cell) return null
  if (localY - row * stride >= geometry.cell) return null
  const index = row * geometry.columns + column
  if (index < 0 || index >= visibleCount) return null
  return index
}

export function computePageWindow(count: number, capacity: number, page: number): PageWindow {
  const safeCount = Math.max(0, Math.floor(count))
  const safeCapacity = Math.max(1, Math.floor(capacity))
  const pageCount = Math.max(1, Math.ceil(safeCount / safeCapacity))
  const safePage = Math.min(pageCount, Math.max(1, Math.floor(page) || 1))
  const startIndex = Math.min(safeCount, (safePage - 1) * safeCapacity)
  const endIndex = Math.min(safeCount, startIndex + safeCapacity)
  return {
    page: safePage,
    pageCount,
    startIndex,
    endIndex,
    count: safeCount,
    capacity: safeCapacity,
    paginated: pageCount > 1,
  }
}

export function pageForIndex(index: number, capacity: number): number {
  const safeCapacity = Math.max(1, Math.floor(capacity))
  return Math.floor(Math.max(0, Math.floor(index)) / safeCapacity) + 1
}

export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  if (progress <= 0) return 0
  if (progress >= 1) return 1
  return progress
}

export function quantizeProgress(progress: number, reducedMotion: boolean, steps: number = REDUCED_MOTION_STEPS): number {
  const clamped = clampProgress(progress)
  if (!reducedMotion) return clamped
  const safeSteps = Math.max(1, Math.floor(steps))
  return Math.floor(clamped * safeSteps) / safeSteps
}

export function initRingSegments(progress: number, reducedMotion: boolean, segments: number = INIT_RING_SEGMENTS): number {
  const safeSegments = Math.max(1, Math.floor(segments))
  const clamped = clampProgress(progress)
  if (clamped >= 1) return safeSegments
  const filled = reducedMotion ? Math.floor(clamped * safeSegments) : Math.round(clamped * safeSegments)
  return Math.min(safeSegments, Math.max(0, filled))
}

export function supportsMarkerText(cell: number): boolean {
  return cell >= MARKER_TEXT_MIN_CELL_PX
}
