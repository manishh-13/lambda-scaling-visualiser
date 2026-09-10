import { useCallback, useId, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { formatNumber } from '../lib/format'
import { EnvironmentInspector } from './EnvironmentInspector'
import { EnvironmentLegend } from './EnvironmentLegend'
import { FieldPagination } from './FieldPagination'
import {
  FIELD_HEIGHT_PX,
  INIT_RING_SEGMENTS,
  MAX_CELL_PX,
  computeGridGeometry,
  computePageWindow,
  initRingSegments,
  pageForIndex,
  quantizeProgress,
  supportsMarkerText,
} from './grid'
import { clampIndex, selectionAnnouncement } from './inspector'
import type { EnvironmentRendererProps } from './types'
import { environmentAriaLabel, fieldSummary, initTurn, markerFor } from './visualLanguage'
import { useElementWidth, usePrefersReducedMotion } from './useFieldMetrics'

const DOM_MIN_CELL_PX = 12

export function DomEnvironmentRenderer({ environments, onInspect, nowMs, laneLabel, reducedMotion, paused }: EnvironmentRendererProps) {
  const uid = useId()
  const reduced = usePrefersReducedMotion(reducedMotion)
  const [setFieldNode, width] = useElementWidth<HTMLDivElement>()
  const [page, setPage] = useState(1)
  const [index, setIndex] = useState(0)
  const [announcement, setAnnouncement] = useState('')

  const count = environments.length
  const geometry = useMemo(
    () => computeGridGeometry(width, FIELD_HEIGHT_PX, count, { minCell: DOM_MIN_CELL_PX, maxCell: MAX_CELL_PX }),
    [width, count],
  )
  const pageWindow = computePageWindow(count, geometry.capacity, page)
  const safeIndex = clampIndex(index, count)
  const visible = environments.slice(pageWindow.startIndex, pageWindow.endIndex)
  const showMarkerText = supportsMarkerText(geometry.cell)

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

  const gridLabelId = `${uid}-grid-label`
  const legendHeadingId = `${uid}-legend`
  const statusId = `${uid}-status`

  return (
    <div className="lcm-field-shell" data-paused={paused ? 'true' : 'false'}>
      <p className="lcm-field-caption" id={gridLabelId}>
        {laneLabel ? `${laneLabel}: ` : ''}Semantic tile grid, {formatNumber(count)} environments. Hover or focus a tile to inspect it.
      </p>
      <div className="lcm-field" ref={setFieldNode} style={{ '--lcm-field-height': `${FIELD_HEIGHT_PX}px` } as CSSProperties}>
        <ul
          className="lcm-grid"
          aria-labelledby={gridLabelId}
          style={{
            '--lcm-cell': `${geometry.cell}px`,
            '--lcm-gap': `${geometry.gap}px`,
            gridTemplateColumns: `repeat(${geometry.columns}, ${geometry.cell}px)`,
          } as CSSProperties}
        >
          {visible.map((environment, offset) => {
            const position = pageWindow.startIndex + offset
            const segments = initRingSegments(environment.initProgress ?? 0, reduced)
            const style = {
              '--lcm-progress': quantizeProgress(environment.progress, reduced),
              '--lcm-init-turn': initTurn(environment, segments, INIT_RING_SEGMENTS),
            } as CSSProperties
            return (
              <li className="lcm-cell" key={environment.id}>
                <button
                  type="button"
                  className={`lcm-tile lcm-state-${environment.state}${environment.type === 'PROVISIONED' ? ' lcm-provisioned' : ''}${position === safeIndex ? ' lcm-selected' : ''}`}
                  style={style}
                  aria-label={environmentAriaLabel(environment, position + 1)}
                  aria-pressed={position === safeIndex}
                  onFocus={() => select(position)}
                  onMouseEnter={() => select(position)}
                  onClick={() => select(position)}
                >
                  <span className="lcm-tile-marker" aria-hidden="true">{showMarkerText ? markerFor(environment) : ''}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <p className="lcm-visually-hidden">{fieldSummary(environments)}</p>
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
      />
      <EnvironmentLegend environments={environments} headingId={legendHeadingId} />
    </div>
  )
}
