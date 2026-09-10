import { Pause, Play, RotateCcw, Square, StepForward } from 'lucide-react'
import type { SpeedOption } from '../lib/urlState'

interface Props {
  trafficActive: boolean
  paused: boolean
  pausedByUser?: boolean
  speed: SpeedOption
  canStart?: boolean
  pending?: boolean
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
  onStep: () => void
  onReset: () => void
  onSpeed: (speed: SpeedOption) => void
}

export function TransportControls({ trafficActive, paused, pausedByUser = false, speed, onStart, onStop, onPause, onResume, onStep, onReset, onSpeed, canStart = true, pending = false }: Props) {
  return (
    <div className="transport-bar" aria-label="Simulation transport controls">
      <div className="transport-actions">
        {!trafficActive ? <button type="button" className="primary-button" disabled={!canStart} title={!canStart ? 'Prepare provisioned capacity to READY before starting both lanes.' : undefined} onClick={onStart}><Play size={14} aria-hidden="true" /><span className="button-label primary-label">Start traffic</span></button> : <button type="button" className="primary-button" onClick={onStop}><Square size={14} aria-hidden="true" /><span className="button-label primary-label">Stop traffic</span></button>}
        {!paused ? <button type="button" className="secondary-button" aria-label="Pause simulation" onClick={onPause}><Pause size={14} aria-hidden="true" /><span className="button-label">Pause</span></button> : pausedByUser ? <button type="button" className="secondary-button" aria-label="Resume simulation" onClick={onResume}><Play size={14} aria-hidden="true" /><span className="button-label">Resume</span></button> : <button type="button" className="secondary-button" aria-label="Simulation is at the start line" disabled><Pause size={14} aria-hidden="true" /><span className="button-label">At start line</span></button>}
        <button type="button" className="secondary-button" aria-label="Step one 50 millisecond tick" disabled={!paused || pending} onClick={onStep}><StepForward size={14} aria-hidden="true" /><span className="button-label">Step 50 ms</span></button>
        <button type="button" className="secondary-button" aria-label="Reset simulation" onClick={onReset}><RotateCcw size={14} aria-hidden="true" /><span className="button-label">Reset</span></button>
      </div>
      <div className="speed-control">
        <label htmlFor="simulation-speed">Speed</label>
        <select id="simulation-speed" value={speed} onChange={(event) => onSpeed(Number(event.target.value) as SpeedOption)} aria-label="Simulation speed">
          <option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option>
        </select>
      </div>
    </div>
  )
}
