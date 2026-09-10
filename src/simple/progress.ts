export const MIN_RING_CELL_PX = 8

/** Handler time remaining, driven only by the simulation clock. */
export function remainingFraction(remainingMs: number, durationMs: number): number {
  if (!Number.isFinite(remainingMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0
  return Math.max(0, Math.min(1, remainingMs / durationMs))
}

/** A draining ring, with a tiny time-left bar when a dense grid cannot fit a circle. */
export function drawRemainingTime(context: CanvasRenderingContext2D, x: number, y: number, size: number, fraction: number) {
  const remaining = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  if (size < MIN_RING_CELL_PX) {
    const inset = Math.min(1, size / 4)
    context.fillStyle = '#ffffff55'
    context.fillRect(x + inset, y + size - inset - 1, size - inset * 2, 1)
    context.fillStyle = '#ffffff'
    context.fillRect(x + inset, y + size - inset - 1, (size - inset * 2) * remaining, 1)
    return
  }
  const cx = x + size / 2, cy = y + size / 2, radius = size * 0.25
  context.lineWidth = Math.max(1, size * 0.075)
  context.lineCap = 'round'
  context.strokeStyle = '#ffffff55'
  context.beginPath()
  context.arc(cx, cy, radius, 0, Math.PI * 2)
  context.stroke()
  if (remaining > 0) {
    context.strokeStyle = '#ffffff'
    context.beginPath()
    context.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining)
    context.stroke()
  }
  context.lineCap = 'butt'
}
