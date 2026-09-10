import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { formatNumber } from '../lib/format'
import { EnvironmentInspector } from './EnvironmentInspector'
import { EnvironmentLegend } from './EnvironmentLegend'
import { FieldPagination } from './FieldPagination'
import {
  FIELD_HEIGHT_PX,
  INIT_RING_SEGMENTS,
  cellRect,
  computeGridGeometry,
  computePageWindow,
  hitTestCell,
  initRingSegments,
  pageForIndex,
  quantizeProgress,
  supportsMarkerText,
} from './grid'
import { clampIndex, selectionAnnouncement } from './inspector'
import type { EnvironmentRendererProps, VisualEnvironment } from './types'
import type { Palette } from './visualLanguage'
import { fieldSummary, markerFor, readPalette, stateAccent, stateSurface } from './visualLanguage'
import { useElementWidth, usePrefersReducedMotion } from './useFieldMetrics'

const MAX_DEVICE_PIXEL_RATIO = 3

function drawEnvironment(
  context: CanvasRenderingContext2D,
  environment: VisualEnvironment,
  x: number,
  y: number,
  cell: number,
  palette: Palette,
  reduced: boolean,
  selected: boolean,
) {
  const accent = stateAccent(environment.state, palette)
  const centreX = x + cell / 2
  const centreY = y + cell / 2
  const radius = cell / 2 - Math.max(1, cell / 12)

  context.save()
  if (environment.state === 'RETIRING') context.globalAlpha = 0.55

  context.fillStyle = stateSurface(environment.state, palette)
  context.fillRect(x, y, cell, cell)

  context.lineWidth = 1
  context.strokeStyle = accent
  if (environment.state === 'RETIRING') context.setLineDash([Math.max(2, cell / 5), Math.max(1, cell / 6)])
  context.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1)
  context.setLineDash([])

  if (environment.type === 'PROVISIONED') {
    context.strokeStyle = palette.teal
    context.strokeRect(x + 2.5, y + 2.5, Math.max(1, cell - 5), Math.max(1, cell - 5))
  }

  if (environment.state === 'INITIALIZING') {
    const filled = environment.initProgress === undefined
      ? INIT_RING_SEGMENTS
      : initRingSegments(environment.initProgress, reduced)
    const segmentSweep = (Math.PI * 2) / INIT_RING_SEGMENTS
    context.strokeStyle = palette.amber
    context.lineWidth = Math.max(1, cell / 9)
    for (let segment = 0; segment < filled; segment += 1) {
      const start = -Math.PI / 2 + segment * segmentSweep
      context.beginPath()
      context.arc(centreX, centreY, radius, start + segmentSweep * 0.12, start + segmentSweep * 0.88)
      context.stroke()
    }
  } else if (environment.state === 'RUNNING') {
    const progress = quantizeProgress(environment.progress, reduced)
    context.strokeStyle = palette.cobalt
    context.lineWidth = Math.max(1, cell / 9)
    if (progress > 0) {
      context.beginPath()
      context.arc(centreX, centreY, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2)
      context.stroke()
    }
    context.fillStyle = palette.cobalt
    context.beginPath()
    context.arc(centreX, centreY, Math.max(1, cell / 8), 0, Math.PI * 2)
    context.fill()
  } else if (environment.state === 'WARM_IDLE') {
    const glyph = Math.max(1.5, cell / 6)
    context.save()
    context.fillStyle = palette.graphite
    context.translate(centreX, centreY)
    context.rotate(Math.PI / 4)
    context.fillRect(-glyph / 2, -glyph / 2, glyph, glyph)
    context.restore()
  }

  if (supportsMarkerText(cell)) {
    context.fillStyle = environment.type === 'PROVISIONED' ? palette.teal : palette.ink
    context.font = `700 ${Math.max(5, Math.round(cell / 3.6))}px system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    context.fillText(markerFor(environment), centreX, y + cell - Math.max(1, cell / 12))
  }
  context.restore()

  if (selected) {
    context.save()
    context.strokeStyle = palette.ink
    context.lineWidth = 2
    context.strokeRect(x - 1, y - 1, cell + 2, cell + 2)
    context.restore()
  }
}

export function CanvasEnvironmentRenderer({ environments, onInspect, nowMs, laneLabel, reducedMotion, paused }: EnvironmentRendererProps) {
  const uid = useId()
  const reduced = usePrefersReducedMotion(reducedMotion)
  const [setFieldNode, width] = useElementWidth<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hoveredRef = useRef<number | null>(null)
  const [page, setPage] = useState(1)
  const [index, setIndex] = useState(0)
  const [announcement, setAnnouncement] = useState('')

  const count = environments.length
  const geometry = useMemo(() => computeGridGeometry(width, FIELD_HEIGHT_PX, count), [width, count])
  const pageWindow = computePageWindow(count, geometry.capacity, page)
  const safeIndex = clampIndex(index, count)
  const visible = useMemo(
    () => environments.slice(pageWindow.startIndex, pageWindow.endIndex),
    [environments, pageWindow.startIndex, pageWindow.endIndex],
  )

  const select = useCallback((next: number) => {
    const target = clampIndex(next, count)
    if (target < 0) return
    setIndex(target)
    setPage(pageForIndex(target, geometry.capacity))
    const environment = environments[target]
    if (!environment) return
    setAnnouncement(selectionAnnouncement(environment, target + 1, count))
    onInspect(environment)
  }, [count, environments, geometry.capacity, onInspect])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const ratio = Math.min(MAX_DEVICE_PIXEL_RATIO, Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
    const cssWidth = Math.max(1, width)
    canvas.width = Math.round(cssWidth * ratio)
    canvas.height = Math.round(FIELD_HEIGHT_PX * ratio)
    canvas.style.width = '100%'
    canvas.style.height = `${FIELD_HEIGHT_PX}px`
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, cssWidth, FIELD_HEIGHT_PX)
    const palette = readPalette(canvas)
    visible.forEach((environment, offset) => {
      const rect = cellRect(offset, geometry)
      drawEnvironment(context, environment, rect.x, rect.y, rect.size, palette, reduced, pageWindow.startIndex + offset === safeIndex)
    })
  }, [geometry, pageWindow.startIndex, reduced, safeIndex, visible, width])

  const resolveIndex = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const offset = hitTestCell(event.clientX - rect.left, event.clientY - rect.top, geometry, visible.length)
    return offset === null ? null : pageWindow.startIndex + offset
  }, [geometry, pageWindow.startIndex, visible.length])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const target = resolveIndex(event)
    if (target === null || target === hoveredRef.current) return
    hoveredRef.current = target
    select(target)
  }, [resolveIndex, select])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const target = resolveIndex(event)
    if (target !== null) select(target)
  }, [resolveIndex, select])

  const captionId = `${uid}-caption`
  const legendHeadingId = `${uid}-legend`
  const statusId = `${uid}-status`

  return (
    <div className="lcm-field-shell" data-paused={paused ? 'true' : 'false'}>
      <p className="lcm-field-caption" id={captionId}>
        {laneLabel ? `${laneLabel}: ` : ''}Canvas grid, {formatNumber(count)} environments. The grid is drawn as one canvas, so use the inspector below for keyboard access.
      </p>
      <div className="lcm-field" ref={setFieldNode} style={{ '--lcm-field-height': `${FIELD_HEIGHT_PX}px` } as CSSProperties}>
        <canvas
          ref={canvasRef}
          className="lcm-canvas"
          role="img"
          aria-label={fieldSummary(environments)}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerLeave={() => { hoveredRef.current = null }}
        />
      </div>
      <FieldPagination window={pageWindow} onPage={setPage} statusId={statusId} />
      <EnvironmentInspector
        environments={environments}
        index={safeIndex}
        columns={geometry.columns}
        pageStep={geometry.capacity}
        nowMs={nowMs}
        idPrefix={`${uid}-inspector`}
        announcement={announcement}
        onSelect={select}
        note="The canvas renderer creates no DOM node per environment. This inspector is the keyboard and screen reader equivalent."
      />
      <EnvironmentLegend environments={environments} headingId={legendHeadingId} />
    </div>
  )
}
