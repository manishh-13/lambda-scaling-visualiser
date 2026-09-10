import { formatHandlerDuration } from './duration'
import { remainingFraction } from './progress'

export function InvocationProgress({ remainingMs, durationMs }: { remainingMs: number; durationMs: number }) {
  const fraction = remainingFraction(remainingMs, durationMs)
  const left = fraction * durationMs
  return <div className="invocation-progress" role="progressbar" aria-label="Handler time remaining" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={left} aria-valuetext={`${formatHandlerDuration(left)} remaining of ${formatHandlerDuration(durationMs)}`} data-testid="invocation-progress" data-remaining-ms={left}>
    <svg viewBox="0 0 40 40" aria-hidden="true"><circle className="progress-track" cx="20" cy="20" r="16" /><circle className="progress-value" cx="20" cy="20" r="16" pathLength="100" strokeDasharray={`${fraction * 100} 100`} transform="rotate(-90 20 20)" /></svg>
    <div><strong>{formatHandlerDuration(left)} left</strong><span>of {formatHandlerDuration(durationMs)} handler time</span></div>
  </div>
}
