export interface TimelinePoint {
  timeMs: number
  initializing: number
  running: number
  warmIdle: number
  provisionedIdle: number
  retiring: number
  throttledRps: number
}

interface Props {
  points: TimelinePoint[]
}

const series = [
  { key: 'initializing' as const, label: 'Initialising', color: '#d99a3c' },
  { key: 'running' as const, label: 'Running', color: '#185bd9' },
  { key: 'warmIdle' as const, label: 'Warm idle', color: '#969aa0' },
  { key: 'provisionedIdle' as const, label: 'Provisioned idle', color: '#2d9992' },
  { key: 'retiring' as const, label: 'Retiring', color: '#606772' },
]

const width = 1000
const height = 340
const left = 58
const right = 70
const envTop = 24
const envBottom = 210
const throttleTop = 244
const throttleBottom = 312

function xFor(index: number, count: number) {
  if (count <= 1) return left
  return left + (index / (count - 1)) * (width - left - right)
}

export function TimelineCharts({ points }: Props) {
  const maxEnvironment = Math.max(1, ...points.map((point) => point.initializing + point.running + point.warmIdle + point.provisionedIdle + point.retiring))
  const maxThrottles = Math.max(1, ...points.map((point) => point.throttledRps))
  const stacked = series.map((item, seriesIndex) => {
    const topPoints = points.map((point, index) => {
      const upper = series.slice(0, seriesIndex + 1).reduce((sum, current) => sum + point[current.key], 0)
      return [xFor(index, points.length), envBottom - (upper / maxEnvironment) * (envBottom - envTop)] as const
    })
    const lowerPoints = points.map((point, index) => {
      const lower = series.slice(0, seriesIndex).reduce((sum, current) => sum + point[current.key], 0)
      return [xFor(index, points.length), envBottom - (lower / maxEnvironment) * (envBottom - envTop)] as const
    }).reverse()
    return { ...item, polygon: [...topPoints, ...lowerPoints].map(([x, y]) => `${x},${y}`).join(' ') }
  })
  const visiblePoints = points.length || 1
  const barWidth = Math.max(1, (width - left - right) / visiblePoints - 1)
  const firstTime = points[0]?.timeMs ?? 0
  const lastTime = points.at(-1)?.timeMs ?? 0

  return (
    <div className="timeline-panel">
      <div className="chart-legend" aria-hidden="true">
        {series.map((item) => <span className="legend-item" key={item.key}><i className="legend-swatch" style={{ '--swatch': item.color } as React.CSSProperties} />{item.label}</span>)}
        <span className="legend-item"><i className="legend-swatch" style={{ '--swatch': '#aa402f' } as React.CSSProperties} />Throttled requests per second</span>
      </div>
      <svg className="timeline-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="timeline-title timeline-description">
        <title id="timeline-title">Environment states and throttled requests over simulated time</title>
        <desc id="timeline-description">The upper stacked area shows environment counts by state. The lower brick histogram shows throttled requests per second on a separate axis.</desc>
        {[0, 0.5, 1].map((ratio) => {
          const y = envBottom - ratio * (envBottom - envTop)
          return <g key={ratio}><line className="chart-grid" x1={left} x2={width - right} y1={y} y2={y} /><text className="chart-label" x={left - 10} y={y + 4} textAnchor="end">{Math.round(maxEnvironment * ratio)}</text></g>
        })}
        <line className="chart-axis" x1={left} x2={left} y1={envTop} y2={envBottom} />
        <text className="chart-label" x={16} y={envTop + 4}>ENV</text>
        {points.length > 1 ? stacked.map((item) => <polygon key={item.key} points={item.polygon} fill={item.color} fillOpacity="0.78" stroke={item.color} strokeWidth="1" />) : <text className="chart-empty" x={width / 2} y={120} textAnchor="middle">Start traffic to draw the capacity timeline.</text>}
        <line className="chart-axis" x1={left} x2={width - right} y1={throttleBottom} y2={throttleBottom} />
        <line className="chart-axis" x1={width - right} x2={width - right} y1={throttleTop} y2={throttleBottom} />
        <text className="chart-label" x={width - right + 10} y={throttleTop + 4}>{Math.round(maxThrottles)}</text>
        <text className="chart-label" x={width - right + 10} y={throttleBottom}>0</text>
        <text className="chart-label" x={16} y={throttleTop + 4}>429</text>
        {points.map((point, index) => {
          const barHeight = (point.throttledRps / maxThrottles) * (throttleBottom - throttleTop)
          return <rect key={`${point.timeMs}-${index}`} x={xFor(index, points.length) - barWidth / 2} y={throttleBottom - barHeight} width={barWidth} height={barHeight} fill="#aa402f" />
        })}
        <text className="chart-label" x={left} y={332}>{(firstTime / 1000).toFixed(1)} s</text>
        <text className="chart-label" x={width - right} y={332} textAnchor="end">{(lastTime / 1000).toFixed(1)} s</text>
      </svg>
      <p className="sr-only">Current chart summary: {points.length ? `${maxEnvironment} maximum visible environments and ${maxThrottles} maximum throttled requests per second in the displayed interval.` : 'No simulation samples yet.'}</p>
    </div>
  )
}
