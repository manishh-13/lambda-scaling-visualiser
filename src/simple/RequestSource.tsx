import { useEffect, useState } from 'react'
import { ArrowRight, CornerUpLeft } from 'lucide-react'
import { formatNumber } from '../lib/format'

interface Props {
  trafficRunning: boolean
  paused: boolean
  rejectedRps: number
  manualResult: { sequence: number; accepted: boolean; cause: string | null } | null
  onSend: () => void
  disabled: boolean
}

export function RequestSource({ trafficRunning, paused, rejectedRps, manualResult, onSend, disabled }: Props) {
  const [manualFlash, setManualFlash] = useState(false)
  const manualSequence = manualResult?.sequence ?? 0
  const manuallyRejected = manualResult?.accepted === false
  useEffect(() => {
    setManualFlash(manuallyRejected)
    if (!manuallyRejected) return
    const timeout = window.setTimeout(() => setManualFlash(false), 1_400)
    return () => window.clearTimeout(timeout)
  }, [manualSequence, manuallyRejected])

  const liveRejection = trafficRunning && rejectedRps > 0
  const showRejection = liveRejection || manualFlash
  return <div className="request-source" data-paused={paused} data-rejecting={showRejection}>
    <button type="button" className="send-request" id="send-one" aria-label="Send one request" disabled={disabled} onClick={onSend}><ArrowRight size={28} strokeWidth={1.4} aria-hidden="true" /></button>
    <span>Send one<br />request</span>
    <div className="request-line" aria-hidden="true">{trafficRunning && !paused && <i />}</div>
    <div className="throttle-feedback" data-testid="throttle-feedback" data-active={showRejection} data-mode={liveRejection ? 'live' : 'manual'} aria-hidden={!showRejection}>
      <div className="throttle-animation" aria-hidden="true"><CornerUpLeft size={30} strokeWidth={1} /><span key={manualSequence} className="deflected-request">429</span></div>
      <strong>429 rejected</strong>
      <span>{liveRejection ? `${formatNumber(rejectedRps)}/s` : 'Request returned'}</span>
    </div>
  </div>
}
