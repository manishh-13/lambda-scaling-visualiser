import { formatNumber } from '../lib/format'
import type { VisualEnvironment } from './types'
import { STATE_LABELS, STATE_MARKERS, STATE_ORDER, STATE_SHAPES, countByState } from './visualLanguage'

interface Props {
  environments: VisualEnvironment[]
  headingId: string
}

export function EnvironmentLegend({ environments, headingId }: Props) {
  const counts = countByState(environments)
  return (
    <div className="lcm-legend">
      <h3 className="lcm-legend-title" id={headingId}>State legend</h3>
      <ul className="lcm-legend-list" aria-labelledby={headingId}>
        {STATE_ORDER.map((state) => (
          <li key={state} className={`lcm-legend-item lcm-state-${state}`}>
            <span className="lcm-legend-swatch" aria-hidden="true">{STATE_MARKERS[state]}</span>
            <span className="lcm-legend-text">
              <strong>{STATE_LABELS[state]}</strong>
              <span className="lcm-legend-shape">{STATE_SHAPES[state]}</span>
            </span>
            <span className="lcm-legend-count">{formatNumber(counts[state])}</span>
          </li>
        ))}
      </ul>
      <p className="lcm-legend-note">Every state carries a marker and an outline pattern, so colour is never the only signal. A running provisioned environment keeps its PC marker.</p>
    </div>
  )
}
