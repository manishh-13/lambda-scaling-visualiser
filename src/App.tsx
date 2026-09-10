import { ArrowRight, ArrowUpRight, ChevronDown, Copy, Pause, Play, RotateCcw, Square, StepForward } from 'lucide-react'
import { CapacityGrid } from './simple/CapacityGrid'
import { DurationControl } from './simple/DurationControl'
import { RequestSource } from './simple/RequestSource'
import { NumberControl, RangeControl, Switch } from './simple/Controls'
import { ScalingChart } from './simple/ScalingChart'
import { allocationFor, DEFAULT_SIMPLE_CONFIG, SPEEDS } from './simple/config'
import { useSimulation } from './simple/useSimulation'
import { formatNumber } from './lib/format'
import type { ThrottleBlocker } from './sim/types'

const causes: Record<ThrottleBlocker, string> = {
  RPS_CEILING: 'Request-rate ceiling', RESERVED_CONCURRENCY: 'Reserved limit',
  ACCOUNT_CONCURRENCY: 'Account quota', SCALING_RATE: 'Scaling rate',
}

export function App() {
  const { config, snapshot: s, update, command, error, notice, copyStatus, shareUrl, copyLink, manualResult } = useSimulation()
  const allocation = allocationFor(config)
  const demand = config.rps * config.durationMs / 1_000
  const canPause = s.paused || s.timeMs > 0 || s.trafficRunning
  const liveStatus = s.paused ? 'Paused' : s.trafficRunning ? 'Traffic arriving' : s.concurrent > 0 ? 'Finishing requests' : 'Ready when you are'
  const rpsCeiling = allocation.functionLimit * 10
  const feedback = manualResult ? (manualResult.accepted ? 'One request sent.' : `429: ${causes[manualResult.cause as ThrottleBlocker] ?? 'capacity unavailable'}.`) : 'Click the arrow to send one request.'

  return <div className="app-shell">
    <nav className="topline" aria-label="Application">
      <a className="wordmark" href={import.meta.env.BASE_URL} aria-label="Lambda Scaling Visualiser home"><span aria-hidden="true">λ</span>Lambda Scaling Visualiser</a>
      <button type="button" className="quiet-button share-button" onClick={copyLink}><Copy size={14} aria-hidden="true" />Share this setup</button>
    </nav>
    <main id="main-content" data-testid="simulation" data-time-ms={s.timeMs}>
      <header className="hero-heading">
        <div><p className="eyebrow">Lambda scaling, made simple.</p><h1>Shared capacity.<br /><span>See Lambda scale.</span></h1></div>
        <div className="hero-context"><p className="lede">A simple visual representation of how AWS Lambda scales. Functions in the same account and Region share a concurrency quota. This demo shows one function using that shared pool.</p><div className="live-pill" data-live={s.trafficRunning && !s.paused}><i aria-hidden="true" /><span>{liveStatus}</span></div></div>
      </header>

      {error && <div role="alert" className="error-banner"><strong>Simulation error.</strong> {error} <button type="button" className="text-button" onClick={() => window.location.reload()}>Reload</button></div>}
      {copyStatus && <div className="share-result" role="status">{copyStatus}</div>}
      {shareUrl && <div className="share-fallback"><label htmlFor="share-url">Share link</label><input id="share-url" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} /></div>}

      <section className="workload-controls glass-controls" aria-label="Workload and concurrency">
        <div className="workload-row">
          <div className="workload-field"><div className="control-heading"><label htmlFor="rps-number">Requests per second</label><NumberControl id="rps-number" label="Requests per second" value={config.rps} min={0} max={100_000} step={50} onChange={rps => update({ rps })} /></div><RangeControl id="rps-range" label="Request rate slider" value={config.rps} min={0} max={3_000} step={10} onChange={rps => update({ rps })} /></div>
          <DurationControl value={config.durationMs} onChange={durationMs => update({ durationMs })} />
        </div>
        <div className="allocation-controls">
          <div className="allocation-control"><Switch id="reserved-switch" label="Reserved concurrency" checked={config.reservedEnabled} onChange={reservedEnabled => update({ reservedEnabled })} tone="reserved" /><label htmlFor="reserved-switch">Reserved</label><NumberControl id="reserved-number" label="Reserved concurrency value" value={config.reserved} min={0} max={config.quota - 100} step={50} disabled={!config.reservedEnabled} onChange={reserved => update({ reserved })} /></div>
          <div className="allocation-control"><Switch id="provisioned-switch" label="Provisioned concurrency" checked={config.provisionedEnabled} onChange={provisionedEnabled => update({ provisionedEnabled })} tone="provisioned" /><label htmlFor="provisioned-switch">Provisioned</label><NumberControl id="provisioned-number" label="Provisioned concurrency value" value={config.provisioned} min={0} max={config.reservedEnabled ? config.reserved : config.quota - 100} step={50} disabled={!config.provisionedEnabled} onChange={provisioned => update({ provisioned })} /></div>
          <div className="traffic-actions"><button type="button" id="traffic-toggle" className="primary-button" disabled={Boolean(error)} onClick={() => command(s.trafficRunning ? 'STOP' : 'START')}>{s.trafficRunning ? <Square size={13} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{s.trafficRunning ? 'Stop traffic' : 'Start traffic'}</button><button type="button" className="quiet-button reset-button" aria-label="Reset simulation" onClick={() => command('RESET')}><RotateCcw size={15} aria-hidden="true" /><span>Reset</span></button></div>
        </div>
      </section>
      <p className="instant-note">Most controls apply immediately. Capacity, duration and lifecycle changes restart the demonstration.<span className="sr-only" role="status">{notice}</span></p>

      <details className="extra-options">
        <summary><span><strong>Lifecycle &amp; more</strong><small>Init, warm retention, account quota &amp; speed</small></span><span className="disclosure-hint">{config.initEnabled || config.idleEnabled ? 'Lifecycle enabled' : 'Optional, off by default'}<ChevronDown size={18} aria-hidden="true" /></span></summary>
        <div className="options-content">
          <div className="lifecycle-options">
            <div><div className="option-heading"><Switch id="init-switch" label="Illustrative Init duration" checked={config.initEnabled} onChange={initEnabled => update({ initEnabled })} tone="init" /><label htmlFor="init-switch">Illustrative Init duration</label></div><NumberControl id="init-number" label="Illustrative Init duration in milliseconds" value={config.initMs} min={0} max={60_000} step={50} suffix="ms" disabled={!config.initEnabled} onChange={initMs => update({ initMs })} /><p>Amber rings show initialization before a new environment runs your code. Init also uses concurrency.</p></div>
            <div><div className="option-heading"><Switch id="idle-switch" label="Warm retention window" checked={config.idleEnabled} onChange={idleEnabled => update({ idleEnabled })} tone="warm" /><label htmlFor="idle-switch">Warm retention window</label></div><NumberControl id="idle-number" label="Warm retention window in milliseconds" value={config.idleMs} min={1_000} max={3_600_000} step={1_000} suffix="ms" disabled={!config.idleEnabled} onChange={idleMs => update({ idleMs })} /><p>How long a finished environment stays reusable here before it is reclaimed. Warm environments appear as ochre diamonds, then disappear. This is not your function timeout: AWS never publishes or promises how long an unused environment is kept, so pick a value only to watch the behaviour.</p></div>
          </div>
          <div className="extra-control-row"><div><label htmlFor="quota-number">Example account quota</label><NumberControl id="quota-number" label="Example account concurrency quota" value={config.quota} min={100} max={10_000} step={100} commitOnBlur integer describedBy="quota-entry-note" onChange={quota => update({ quota })} /><p id="quota-entry-note" className="quota-entry-note">Type 100 to 10,000. Enter or leave the field to apply.</p></div><div><label htmlFor="speed">Simulation speed</label><select id="speed" value={config.speed} onChange={event => update({ speed: Number(event.target.value) })}>{SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></div><div className="playback-actions"><button type="button" className="secondary-button" disabled={!canPause} onClick={() => command(s.paused ? 'RESUME' : 'PAUSE')}>{s.paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{s.paused ? 'Resume' : 'Pause'}</button><button type="button" className="secondary-button" disabled={!s.paused} onClick={() => command('STEP')}><StepForward size={14} aria-hidden="true" />Step 50 ms</button></div></div>
          <div className="try-row"><span>Try a different workload</span><button type="button" className="text-button" onClick={() => update({ ...DEFAULT_SIMPLE_CONFIG, quota: 10_000, rps: 5_000 })}>Scaling spike<ArrowUpRight size={13} aria-hidden="true" /></button><button type="button" className="text-button" onClick={() => update({ ...DEFAULT_SIMPLE_CONFIG, rps: 30_000, durationMs: 20 })}>Short, huge volume<ArrowUpRight size={13} aria-hidden="true" /></button><button type="button" className="text-button" onClick={() => update(DEFAULT_SIMPLE_CONFIG)}>Back to simple</button></div>
          <div className="detail-metrics"><span><strong>{formatNumber(s.accepted)}</strong> accepted since reset</span><span><strong>{formatNumber(s.acceptedRps)}</strong> accepted/s this interval</span><span><strong>{formatNumber(s.quotaOccupancy)}</strong> quota occupied (PC + on-demand in flight)</span><span><strong>{formatNumber(rpsCeiling)}</strong> function request-rate ceiling/s</span></div>
          {s.rejected > 0 && <dl className="rejection-breakdown" aria-label="Rejections by cause">{Object.entries(s.throttlesByCause).map(([cause, count]) => <div key={cause}><dt>{causes[cause as ThrottleBlocker]}</dt><dd>{formatNumber(count)}</dd></div>)}</dl>}
        </div>
      </details>

      <div className="simulation-stage">
        <div className="capacity-column">
      <section className="region-panel" aria-labelledby="region-heading">
        <div className="region-header"><div><p className="section-kicker">{formatNumber(config.quota)} account quota slots · One Region</p><h2 id="region-heading">The shared account pool</h2></div><div className="inflight"><strong data-testid="in-flight">{formatNumber(s.concurrent)}</strong><span> / {formatNumber(allocation.functionLimit)} in use<br /><small>by this function</small></span></div></div>
        <div className="region-content">
          <RequestSource trafficRunning={s.trafficRunning} paused={s.paused} rejectedRps={s.rejectedRps} manualResult={manualResult} onSend={() => command('MANUAL')} disabled={Boolean(error)} />
          <div className="region-map-wrap"><CapacityGrid slots={s.slots} remainingMs={s.remainingMs} durationMs={config.durationMs} concurrent={s.concurrent} showInit={config.initEnabled} showIdle={config.idleEnabled} /></div>
        </div>
        <div className="allocation-summary" aria-label="Account allocation">
          <div className="pool-bar" aria-hidden="true">
            {allocation.provisioned > 0 && <i className="pool-provisioned" style={{ flexBasis: `${allocation.provisioned / config.quota * 100}%` }} />}
            {allocation.reserved - allocation.provisioned > 0 && <i className="pool-reserved" style={{ flexBasis: `${(allocation.reserved - allocation.provisioned) / config.quota * 100}%` }} />}
            <i className="pool-unreserved" style={{ flexBasis: `${allocation.unreservedPool / config.quota * 100}%` }} />
          </div>
          <div className="pool-labels">
            {config.reservedEnabled && <span className="reserved-label"><i aria-hidden="true" />{formatNumber(allocation.reserved)} reserved{allocation.provisioned > 0 ? `, including ${formatNumber(allocation.provisioned)} provisioned` : ''}</span>}
            {!config.reservedEnabled && allocation.provisioned > 0 && <span className="provisioned-label"><i aria-hidden="true" />{formatNumber(allocation.provisioned)} provisioned</span>}
            <span>{formatNumber(allocation.unreservedPool)} unreserved{config.reservedEnabled ? ', outside this function' : ', shared pool'}</span>
          </div>
          {config.provisionedEnabled && <p className="allocation-note">Provisioned capacity is ready instantly here so you can explore. Real AWS allocation takes time.</p>}
        </div>
        <p className="map-caption">Squares represent quota, not fixed containers. Requests are grouped by state within each allocation, filling left to right. Only this function is sending traffic.</p>
      </section>
      <div className="request-feedback" role="status" aria-live="polite">{feedback}</div>

      {config.idleEnabled && <p className="lifecycle-live"><i className="warm-diamond" aria-hidden="true" />{formatNumber(s.warm)} warm environments, reusable without another Init. They do not use concurrency.</p>}
        </div>
        <div className="scaling-column">
      <section className="scaling-panel" aria-labelledby="scaling-heading">
        <div className="scaling-summary"><h2 id="scaling-heading">Room to scale</h2><p className="scaling-number"><strong data-testid="scaling-units">{formatNumber(s.units)}</strong><span> / 1,000 units</span></p><meter value={s.units} min={0} max={1_000} aria-label="Available scaling capacity" /><p>Growth spends units. Reuse does not.<br />Refills continuously at 100 units per second.</p><span className="model-label">Illustrative scaling model</span></div>
        <ScalingChart history={s.history} units={s.units} timeMs={s.timeMs} />
      </section>
      <section className="live-metrics" aria-label="Live metrics">
        <div className="live-metric"><span>Running now</span><strong data-testid="running-now">{formatNumber(s.running)}</strong><small>{config.initEnabled ? `${formatNumber(s.initialising)} in Init` : `${formatNumber(demand, 1)} demanded by this workload`}</small></div>
        <div className="live-metric"><span>Completed</span><strong data-testid="completed">{formatNumber(s.completed)}</strong><small>Since reset</small></div>
        <div className="live-metric"><span>Unreserved pool</span><strong data-testid="unreserved-pool">{formatNumber(allocation.unreservedPool)}</strong><small>{formatNumber(s.unreservedAvailable)} currently available</small></div>
        <div className={`live-metric ${s.rejected > 0 ? 'has-rejections' : ''}`}><span>Rejected <span className="status-code">429</span></span><strong data-testid="rejected">{formatNumber(s.rejected)}</strong><small>{s.lastReject ? causes[s.lastReject] : 'No rejections'}</small></div>
      </section>
        </div>
      </div>
      <p className="formula-note"><span>{formatNumber(config.rps, 2)} requests/s × {formatNumber(config.durationMs / 1_000, 3)} s</span><ArrowRight size={13} aria-hidden="true" /><strong>{formatNumber(demand, 2)} concurrent requests demanded</strong></p>

      <footer className="app-footer"><p>Browser-only learning tool. No AWS calls or account needed.</p><details><summary>Model notes &amp; AWS sources</summary><div className="model-notes"><p>All functions in an account and Region share the account concurrency quota. This demonstration sends traffic to one synchronous function, with no other functions using capacity, no retries and no invocation errors. The example quota of 1,000 is adjustable; actual starting quotas vary. The grid groups states for readability and does not track individual containers at fixed positions. Running squares show actual simulated handler time remaining with a draining ring, or a short bar in dense grids. Click a square to inspect its countdown. This clock follows simulation speed, pause and step; it excludes Init.</p><p>Handler duration is the simulated time spent running code, not a configured timeout. This standard synchronous Lambda model supports up to 900 seconds (15 minutes). The duration slider spans that full range with more space for short handlers; the numeric field accepts exact milliseconds. Animated 429s are a representative sample, not one particle per rejected request.</p><p>Reserved concurrency is an allocation and a hard ceiling, not pre-initialized capacity. Provisioned concurrency is pre-initialized capacity on a published version or alias, shown READY immediately for learning. It counts against the quota even when idle. Provisioned capacity inside a reservation is counted once. At least 100 account units remain unreserved.</p><p>With lifecycle options off, Init is omitted and warm environments remain reusable invisibly until reset. Turning on Init or the warm retention window changes the illustrative model and restarts the demonstration. The retention window is an illustrative reclaim time for an unused environment, not the configured function timeout; AWS does not publish or promise it. Retention, Init duration, and immediate PC preparation are not AWS timing guarantees.</p><p>One shared bucket starts at 1,000 units and refills at 100 units/s, capped at 1,000. Expansion costs the larger of additional environment capacity and additional synchronous request-rate capacity divided by ten. RPS limits are smoothed over 50 ms intervals. AWS does not publish its internal admission algorithm. Provisioned recycling and reset-related cold starts are omitted.</p><div className="source-links"><a href="https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html" target="_blank" rel="noreferrer">Concurrency</a><a href="https://docs.aws.amazon.com/lambda/latest/dg/burst-concurrency.html" target="_blank" rel="noreferrer">Scaling rate</a><a href="https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html" target="_blank" rel="noreferrer">Timeout limit</a><a href="https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html" target="_blank" rel="noreferrer">Reserved concurrency</a><a href="https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html" target="_blank" rel="noreferrer">Provisioned concurrency</a></div></div></details></footer>
    </main>
  </div>
}
