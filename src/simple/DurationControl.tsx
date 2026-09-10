import { NumberControl } from './Controls'
import { DURATION_PRESETS, DURATION_SLIDER_STEPS, durationFromSlider, formatHandlerDuration, MAX_HANDLER_MS, sliderFromDuration } from './duration'

export function DurationControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="workload-field duration-control">
    <div className="control-heading">
      <label htmlFor="duration-number">Handler duration <span>{formatHandlerDuration(value)}</span></label>
      <NumberControl id="duration-number" label="Handler duration in milliseconds" value={value} min={1} max={MAX_HANDLER_MS} step={50} suffix="ms" onChange={onChange} />
    </div>
    <input type="range" id="duration-range" aria-label="Handler duration slider" aria-valuetext={formatHandlerDuration(value)} aria-describedby="duration-scale-note" min={0} max={DURATION_SLIDER_STEPS} step={1} value={sliderFromDuration(value)} onChange={event => onChange(durationFromSlider(Number(event.target.value)))} />
    <div className="duration-presets" role="group" aria-label="Quick handler durations">
      {DURATION_PRESETS.map(duration => <button type="button" key={duration} aria-label={`Set handler duration to ${formatHandlerDuration(duration)}`} aria-pressed={value === duration} onClick={() => onChange(duration)}>{formatHandlerDuration(duration)}</button>)}
    </div>
    <p className="duration-scale-note" id="duration-scale-note">1 ms to 15 min. Enter milliseconds for an exact value.</p>
  </div>
}
