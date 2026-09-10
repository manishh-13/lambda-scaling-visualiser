import { EnvironmentRenderer } from '../renderers/EnvironmentRenderer'
import type { VisualEnvironment } from '../renderers/types'
import { formatElapsed, formatNumber, formatRate } from '../lib/format'
import type { UiMetrics } from '../store/types'

interface Props {
  environments: VisualEnvironment[]
  metrics: UiMetrics
  timeMs: number
  configuredRps: number
  handlerDurationMs: number
  trafficActive: boolean
  provisionedStatus: string
  paused: boolean
  compact?: boolean
  laneTitle?: string
}

const ignoreInspection = (_environment: VisualEnvironment): void => {}

export function LiveFormula({ rps, durationMs }: { rps: number; durationMs: number }) {
  return (
    <div className="formula-band">
      <div><p className="formula-definition">Concurrency needed = requests per second × average handler duration in seconds</p><p className="formula-copy"><strong>{formatNumber(rps, 3)} RPS</strong><span aria-hidden="true"> × </span><span className="sr-only">multiplied by </span><strong>{formatNumber(durationMs / 1000, 3)} {durationMs === 1000 ? 'second' : 'seconds'}</strong></p></div>
      <span className="formula-result" aria-label={`${rps * durationMs / 1000} demanded concurrency`}>{formatNumber(rps * durationMs / 1000, 3)}<small>demanded</small></span>
    </div>
  )
}

export function HeroStage({ environments, metrics, timeMs, configuredRps, handlerDurationMs, trafficActive, provisionedStatus, paused, compact = false, laneTitle }: Props) {
  const rulerMax = Math.max(1, metrics.demandedConcurrency, metrics.activeCap)
  const demandWidth = metrics.demandedConcurrency / rulerMax * 100
  const actualWidth = metrics.concurrentExecutions / rulerMax * 100
  const capLeft = Math.min(100, metrics.activeCap / rulerMax * 100)
  const offeredRps = trafficActive ? configuredRps : 0
  return (
    <section className={`hero-stage ${compact ? 'compact-stage' : ''}`} aria-label={laneTitle ?? 'Living Capacity Map'} data-playback={paused ? 'paused' : 'running'}>
      <header className="stage-header">
        <div><p className="stage-kicker">{compact ? 'Synchronized lane' : 'Living Capacity Map'}</p><h2 className="stage-title">{laneTitle ?? 'Watch concurrency take shape.'}</h2></div>
        <div className="stage-status">
          <div className="status-item"><span className="status-label">Traffic</span><span className="status-value"><i aria-hidden="true" className={`status-dot ${trafficActive ? 'live' : ''}`} />{trafficActive ? (paused ? 'PAUSED' : 'ARRIVING') : 'STOPPED'}</span></div>
          <div className="status-item"><span className="status-label">Simulated time</span><span className="status-value" data-testid="simulated-time">{formatElapsed(timeMs)}</span></div>
          {provisionedStatus !== 'DISABLED' && <div className="status-item"><span className="status-label">Provisioned</span><span className="status-value"><i aria-hidden="true" className={`status-dot ${provisionedStatus.toLowerCase()}`} />{provisionedStatus}</span></div>}
        </div>
      </header>
      <div className="stage-body">
        <aside className="traffic-source" aria-label={`Traffic source offering ${formatRate(offeredRps)}`}>
          <div className="source-disc" aria-hidden="true">↗</div><span className="source-label">Incoming</span><span className="source-rate">{formatRate(offeredRps)}</span>
          <div className="flow-lane" aria-hidden="true">{trafficActive && <><i className="request-particle" /><i className="request-particle" /><i className="request-particle" /></>}</div>
          {trafficActive && metrics.throttledRps > 0 && <span className="throttle-deflection" aria-hidden="true">429</span>}
          {metrics.throttledRps > 0 && <p className="source-throttles">429<br /><strong>{formatNumber(metrics.throttledRps)}</strong><br />rejected/s</p>}
        </aside>
        <div className="environment-field">
          <div className="field-meta"><h3 className="field-title">Execution environments</h3><span className="field-count">{formatNumber(environments.length)} visible</span></div>
          <EnvironmentRenderer environments={environments} onInspect={ignoreInspection} nowMs={timeMs} laneLabel={laneTitle ?? 'Execution environments'} paused={paused} />
          <p className="sample-note">Request particles are a deterministic representative sample, not one particle per request. Counters remain exact.</p>
        </div>
      </div>
      <div className="capacity-ruler">
        <div className="ruler-chart" role="img" aria-label={`Capacity ruler: ${formatNumber(metrics.demandedConcurrency, 3)} demanded, ${formatNumber(metrics.concurrentExecutions)} actual, ${formatNumber(metrics.activeCap)} active cap`}>
          <div className="ruler-labels"><span>Concurrent requests</span><span>{formatNumber(rulerMax, 3)} scale</span></div>
          <div className="ruler-track" aria-hidden="true"><div className="ruler-demand" style={{ width: `${demandWidth}%` }} /><div className="ruler-actual" style={{ width: `${actualWidth}%` }} /><i className="ruler-cap" style={{ left: `${capLeft}%` }} /></div>
          <div className="ruler-values"><span>Demand <strong>{formatNumber(metrics.demandedConcurrency, 3)}</strong></span><span>Actual <strong>{formatNumber(metrics.concurrentExecutions)}</strong></span><span>Cap <strong>{formatNumber(metrics.activeCap)}</strong></span></div>
        </div>
        <div className="token-meter">
          <div className="token-top"><span>Scaling tokens</span><span>{formatNumber(metrics.scalingTokens)}</span></div>
          <meter min={0} max={1000} value={metrics.scalingTokens} aria-label="Available scaling-unit tokens" />
          <p className="token-note">Maximum 1,000; refill 100 units/s. Illustrative shared bucket.</p>
        </div>
      </div>
      {!compact && <LiveFormula rps={configuredRps} durationMs={handlerDurationMs} />}
    </section>
  )
}
