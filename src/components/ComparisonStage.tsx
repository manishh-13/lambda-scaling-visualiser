import type { ComparisonSnapshot } from '../store/types'
import { HeroStage, LiveFormula } from './HeroStage'
import { formatNumber } from '../lib/format'

interface Props {
  comparison: ComparisonSnapshot
  trafficActive: boolean
  paused: boolean
  durationMs: number
  rps: number
}

export function ComparisonStage({ comparison, trafficActive, paused, durationMs, rps }: Props) {
  return (
    <section className="comparison-stage" aria-labelledby="comparison-heading">
      <div className="comparison-intro"><div><span className="section-number">LIVING CAPACITY MAP / COMPARISON</span><h2 id="comparison-heading">Same traffic. Different starts.</h2></div><p>Identical request timestamps and seed in two alternative one-function accounts. Both lanes share one clock. No traffic begins until the right lane is READY.</p></div>
      <div className="comparison-lanes">
        {(['left', 'right'] as const).map(side => {
          const lane = comparison[side]
          return (
            <div className="comparison-lane" key={side} data-testid={`comparison-${side}`}>
              <HeroStage compact laneTitle={side === 'left' ? 'On-demand only' : 'Provisioned first'} environments={lane.environments} metrics={lane.metrics} timeMs={lane.timeMs} configuredRps={rps} handlerDurationMs={durationMs} trafficActive={trafficActive} provisionedStatus={lane.provisioned.status} paused={paused} />
              <dl className="lane-counters">
                <div><dt>Initialising</dt><dd>{formatNumber(lane.initialising)}</dd></div>
                <div><dt>Running</dt><dd>{formatNumber(lane.running)}</dd></div>
                <div><dt>Cold starts</dt><dd>{formatNumber(lane.coldStarts)}</dd></div>
                <div><dt>Invocations</dt><dd>{formatNumber(lane.invocations)}</dd></div>
                <div><dt>Throttles</dt><dd>{formatNumber(lane.metrics.throttles)}</dd></div>
              </dl>
            </div>
          )
        })}
      </div>
      <LiveFormula rps={rps} durationMs={durationMs} />
      <p className="comparison-note">The metrics strip and timeline below follow the provisioned-first lane. A lane's running tile always shows its real current state, including warm reuse and on-demand spillover.</p>
    </section>
  )
}
