import { useEffect, useMemo, useRef, useState } from 'react'
import { formatNumber } from '../lib/format'
import { SLOT } from './types'
import { groupSlotsWithTiming } from './display'
import { drawRemainingTime, MIN_RING_CELL_PX, remainingFraction } from './progress'
import { InvocationProgress } from './InvocationProgress'

export const CAPACITY_COLORS = {
  free: '#e6effa', freeStroke: '#c4d5eb',
  running: '#0869d7', warm: '#a46517', init: '#f4b53f',
  reserved: '#7952c7', reservedSurface: '#eee8fa',
  provisioned: '#c5e8e1', provisionedStroke: '#15796f', provisionedRunning: '#08776d',
  outside: '#f8f2ed', outsideStroke: '#e5d9ce', ink: '#202127',
} as const

export function gridGeometry(width: number, count: number) {
  const baseColumns = width < 520 ? 25 : 40
  const columns = Math.max(1, Math.min(count, Math.ceil(baseColumns * Math.sqrt(Math.max(1, count / 1_000)))))
  const gap = count > 2_000 ? 1.5 : width < 520 ? 3 : 4
  const padding = 3
  const cell = Math.max(1, (width - 2 * padding - gap * (columns - 1)) / columns)
  const rows = Math.ceil(count / columns)
  return { columns, rows, cell, gap, padding, height: rows * (cell + gap) - gap + padding * 2 }
}

export function slotDescription(code: number): string {
  const state = code & SLOT.STATE_MASK
  const parts: string[] = []
  if (code & SLOT.RESERVED) parts.push('reserved for this function')
  if (code & SLOT.PROVISIONED) parts.push('provisioned')
  if (code & SLOT.OUTSIDE) parts.push('unreserved pool, outside this function')
  if (state === SLOT.INIT) parts.push('initialising')
  else if (state === SLOT.RUNNING) parts.push('running')
  else if (state === SLOT.WARM) parts.push('warm, ready for reuse')
  else if (code & SLOT.PROVISIONED) parts.push('ready')
  else parts.push('free concurrency')
  return parts.join(', ')
}

function drawSlot(context: CanvasRenderingContext2D, code: number, x: number, y: number, size: number, selected: boolean, remaining: number) {
  const c = CAPACITY_COLORS
  const state = code & SLOT.STATE_MASK
  const pc = Boolean(code & SLOT.PROVISIONED)
  const rc = Boolean(code & SLOT.RESERVED)
  const outside = Boolean(code & SLOT.OUTSIDE)
  context.fillStyle = outside ? c.outside : pc ? c.provisioned : rc ? c.reservedSurface : c.free
  if (state === SLOT.RUNNING) context.fillStyle = pc ? c.provisionedRunning : c.running
  if (state === SLOT.INIT) context.fillStyle = c.init
  if (state === SLOT.WARM) context.fillStyle = c.warm
  context.beginPath()
  context.roundRect(x, y, size, size, Math.min(2.5, size / 5))
  context.fill()
  context.strokeStyle = rc ? c.reserved : pc ? c.provisionedStroke : outside ? c.outsideStroke : c.freeStroke
  context.lineWidth = rc ? 1.6 : 0.7
  context.stroke()
  if (pc && size >= 4) {
    context.strokeStyle = state === SLOT.RUNNING ? '#b8eee2' : c.provisionedStroke
    context.lineWidth = 0.8
    const inset = Math.min(2, size * 0.25)
    context.strokeRect(x + inset, y + inset, size - inset * 2, size - inset * 2)
  }
  if (outside && size >= 5) {
    context.strokeStyle = c.outsideStroke
    context.lineWidth = 0.7
    context.beginPath()
    context.moveTo(x + size * 0.27, y + size * 0.75)
    context.lineTo(x + size * 0.75, y + size * 0.27)
    context.stroke()
  }
  if (state === SLOT.RUNNING) drawRemainingTime(context, x, y, size, remaining)
  if (state === SLOT.WARM && size >= 6) {
    context.fillStyle = '#fff1cf'
    context.beginPath()
    const cx = x + size / 2, cy = y + size / 2, r = size * 0.2
    context.moveTo(cx, cy - r)
    context.lineTo(cx + r, cy)
    context.lineTo(cx, cy + r)
    context.lineTo(cx - r, cy)
    context.closePath()
    context.fill()
  }
  if (state === SLOT.INIT && size >= 6) {
    context.strokeStyle = '#734500'
    context.lineWidth = Math.max(0.8, size * 0.06)
    context.beginPath()
    context.arc(x + size / 2, y + size / 2, size * 0.22, -Math.PI / 2, Math.PI)
    context.stroke()
  }
  if (selected) {
    context.strokeStyle = c.ink
    context.lineWidth = 2
    context.strokeRect(x - 2, y - 2, size + 4, size + 4)
  }
}

export function CapacityGrid({ slots: rawSlots, remainingMs: rawRemainingMs, durationMs, concurrent, showInit, showIdle }: { slots: Uint8Array; remainingMs: Float64Array; durationMs: number; concurrent: number; showInit: boolean; showIdle: boolean }) {
  const { slots, remainingMs } = useMemo(() => groupSlotsWithTiming(rawSlots, rawRemainingMs), [rawSlots, rawRemainingMs])
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const inspector = useRef<HTMLDetailsElement>(null)
  const [width, setWidth] = useState(720)
  const [selected, setSelected] = useState<number | null>(null)
  const safeSelected = selected === null ? null : Math.min(selected, slots.length - 1)
  const geometry = gridGeometry(width, slots.length)

  useEffect(() => {
    const node = container.current
    if (!node) return
    const update = () => setWidth(Math.max(100, node.getBoundingClientRect().width))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const node = canvas.current
    if (!node) return
    const context = node.getContext('2d')
    if (!context) return
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    node.width = Math.round(width * ratio)
    node.height = Math.round(geometry.height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, geometry.height)
    for (let index = 0; index < slots.length; index += 1) {
      const x = geometry.padding + (index % geometry.columns) * (geometry.cell + geometry.gap)
      const y = geometry.padding + Math.floor(index / geometry.columns) * (geometry.cell + geometry.gap)
      drawSlot(context, slots[index], x, y, geometry.cell, safeSelected === index, remainingFraction(remainingMs[index], durationMs))
    }
  }, [slots, remainingMs, durationMs, width, safeSelected, geometry.height, geometry.cell, geometry.columns, geometry.gap, geometry.padding])

  return <div className="capacity-map" ref={container}>
    <canvas ref={canvas} className="capacity-canvas" data-testid="capacity-grid" data-slot-count={slots.length} data-layout="grouped" data-columns={geometry.columns} data-cell={geometry.cell} data-gap={geometry.gap} data-progress-mode={geometry.cell >= MIN_RING_CELL_PX ? 'ring' : 'bar'} style={{ height: geometry.height }} role="img" aria-label={`${formatNumber(slots.length)} account concurrency slots, ${formatNumber(concurrent)} requests in flight. States are grouped left to right within each allocation, not fixed environment identities. Free slots are pale blue, running slots have a draining time-left ring (a short bar in dense grids), warm slots have a diamond, reserved slots have a violet border, and provisioned slots have a double border.`} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      const x = event.clientX - rect.left - geometry.padding
      const y = event.clientY - rect.top - geometry.padding
      if (x < 0 || y < 0) return
      const column = Math.floor(x / (geometry.cell + geometry.gap))
      const row = Math.floor(y / (geometry.cell + geometry.gap))
      const index = row * geometry.columns + column
      if (column < geometry.columns && index < slots.length && x % (geometry.cell + geometry.gap) <= geometry.cell && y % (geometry.cell + geometry.gap) <= geometry.cell) {
        setSelected(index)
        if (inspector.current) inspector.current.open = true
      }
    }} />
    <div className="map-key" aria-label="Slot legend">
      <span><i className="key-free" aria-hidden="true" />Free</span>
      <span><i className="key-running" aria-hidden="true" />Running</span>
      <span><i className="key-reserved" aria-hidden="true" />Reserved</span>
      <span><i className="key-provisioned" aria-hidden="true" />Provisioned</span>
      {showInit && <span><i className="key-init" aria-hidden="true" />Init</span>}
      {showIdle && <span><i className="key-warm" aria-hidden="true" />Warm</span>}
    </div>
    <p className="grid-progress-note"><i aria-hidden="true" />{geometry.cell >= MIN_RING_CELL_PX ? 'The white ring drains as handler time runs out.' : 'The white bar shrinks as handler time runs out.'} Click a box for its countdown.</p>
    <details className="slot-inspector" ref={inspector}>
      <summary>Inspect a grid position</summary>
      <div className="slot-inspector-controls">
        <label htmlFor="slot-number">Grid position</label>
        <input id="slot-number" type="number" min={1} max={slots.length} value={(safeSelected ?? 0) + 1} onChange={event => setSelected(Math.max(0, Math.min(slots.length - 1, Math.round(Number(event.target.value) || 1) - 1)))} />
        <output htmlFor="slot-number">{slotDescription(slots[safeSelected ?? 0])}</output>
      </div>
      {(slots[safeSelected ?? 0] & SLOT.STATE_MASK) === SLOT.RUNNING && <InvocationProgress remainingMs={remainingMs[safeSelected ?? 0]} durationMs={durationMs} />}
      <p className="inspector-note">This is a display position. Requests regroup as they finish; the countdown belongs to the request shown here now.</p>
    </details>
  </div>
}
