import type { UiProvisioned } from '../store/types'
import { formatElapsed, formatNumber } from '../lib/format'

export type AllocationView = UiProvisioned

interface Props {
  allocation?: AllocationView
  timeMs: number
  onPrepare: () => void
  trafficActive?: boolean
}

export function ProvisionedStatus({ allocation, timeMs, onPrepare, trafficActive = false }: Props) {
  if (!allocation || allocation.status === 'DISABLED') return null
  const progress = allocation.status === 'READY' ? 100 : Math.min(99.9, timeMs / Math.max(1, allocation.readyAtMs ?? 1) * 100)
  return (
    <section className="allocation-status" aria-label="Provisioned allocation status">
      <div className="allocation-top"><strong>{allocation.status}</strong><span>{formatNumber(allocation.ready ?? 0)} / {formatNumber(allocation.requested ?? 0)} ready</span>{allocation.status === 'PREPARING' && <button className="secondary-button" type="button" disabled={trafficActive} onClick={onPrepare}>Advance until READY</button>}</div>
      <progress value={progress} max="100" aria-label="Illustrative provisioned allocation progress">{progress.toFixed(1)}%</progress>
      {allocation.status === 'PREPARING' && <p>{formatNumber(allocation.allocated ?? 0)} environments allocated internally; none usable until the entire request is READY. Any traffic uses on-demand capacity; comparison mode waits with both traffic sources stopped.</p>}
      <p>Simulation preparation delay: {formatElapsed(allocation.preparationDelayMs ?? 0)}, seeded from the documented 60 to 120 second range. Allocation then runs at up to 6,000 environments per minute, {formatElapsed(allocation.allocationDurationMs ?? 0)} here. These timings are illustrative, not an exact AWS guarantee.</p>
      <p>Quota allocation: {formatNumber(allocation.quotaReserved ?? 0)} units, including idle capacity. Allocated provisioned concurrency is billed even at zero traffic. This model reserves the request's quota throughout PREPARING.</p>
    </section>
  )
}
