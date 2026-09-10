import { useId } from 'react'
import { formatNumber } from '../lib/format'
import type { ScalingPoint } from './types'

export function ScalingChart({ history, units, timeMs }: { history: ScalingPoint[]; units: number; timeMs: number }) {
  const gradient = useId().replaceAll(':', '')
  const width = 480, height = 96, start = Math.max(0, timeMs - 20_000), duration = 20_000
  const points = history.filter(point => point.timeMs >= start)
  const x = (time: number) => 6 + Math.max(0, Math.min(1, (time - start) / duration)) * (width - 12)
  const y = (value: number) => 6 + (1 - value / 1_000) * (height - 12)
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.timeMs).toFixed(2)},${y(point.units).toFixed(2)}`).join(' ')
  const area = points.length ? `${path} L${x(points.at(-1)!.timeMs)},${height} L${x(points[0].timeMs)},${height} Z` : ''
  return <div className="scaling-plot">
    <div className="plot-label"><span>Available scaling units</span><span>Last 20 seconds</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Scaling capacity over the last 20 simulated seconds, ${formatNumber(units)} units available. Red marks indicate scaling-rate rejections.`} preserveAspectRatio="none">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d8982c" stopOpacity="0.22" /><stop offset="100%" stopColor="#d8982c" stopOpacity="0.015" /></linearGradient></defs>
      {[0, 500, 1_000].map(value => <line key={value} x1={0} x2={width} y1={y(value)} y2={y(value)} stroke="#e7e9ed" strokeWidth={1} />)}
      {area && <path d={area} fill={`url(#${gradient})`} />}
      {path && <path d={path} fill="none" stroke="#a3690d" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      {points.filter(point => point.scalingRejections > 0).map(point => <rect key={point.timeMs} x={x(point.timeMs)} y={height - 5} width={2} height={5} rx={1} fill="#ba3b30" />)}
    </svg>
    <div className="plot-axis"><span>{formatNumber(start / 1_000, 1)}s</span><span>Red marks: scaling rejections</span><span>{formatNumber((start + duration) / 1_000, 1)}s</span></div>
  </div>
}
