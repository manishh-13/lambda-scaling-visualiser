import { useState } from 'react'
import type { SimEvent } from '../sim/types'
import { formatElapsed, formatNumber } from '../lib/format'

export type CauseKey = 'RPS_CEILING' | 'RESERVED_CONCURRENCY' | 'ACCOUNT_CONCURRENCY' | 'SCALING_RATE'

interface Props {
  causes: Record<CauseKey, number>
  accountQuota: number
  reservedEnabled: boolean
  reservedValue: number
  recentEvents?: SimEvent[]
  quotaOccupancy?: number
}

const details: Array<{ key: CauseKey; label: string; explanation: string; limit: (props: Props) => string }> = [
  { key: 'RPS_CEILING', label: 'RPS ceiling', explanation: 'Offered synchronous traffic exceeded the active aggregate request-rate ceiling.', limit: ({ accountQuota, reservedEnabled, reservedValue }) => `${formatNumber(10 * (reservedEnabled ? reservedValue : accountQuota))} RPS` },
  { key: 'RESERVED_CONCURRENCY', label: 'Reserved concurrency', explanation: 'This function reached its reserved ceiling, including its provisioned allocation. Unreserved account headroom cannot be borrowed.', limit: ({ reservedEnabled, reservedValue }) => reservedEnabled ? `${formatNumber(reservedValue)} concurrency units` : 'Not enabled' },
  { key: 'ACCOUNT_CONCURRENCY', label: 'Account concurrency', explanation: 'In-flight on-demand requests and allocated provisioned capacity filled the example account quota.', limit: ({ accountQuota }) => `${formatNumber(accountQuota)} concurrency units` },
  { key: 'SCALING_RATE', label: 'Scaling rate', explanation: 'The function could not add environments or aggregate synchronous RPS capacity any faster.', limit: () => '1,000 units maximum; refill 100 units/s' },
]

function causeLabel(cause: string): string {
  return details.find(detail => detail.key === cause)?.label ?? cause
}

export function ThrottleDiagnosis(props: Props) {
  const total = Object.values(props.causes).reduce((sum, count) => sum + count, 0)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const events = props.recentEvents ?? []
  const selected = events.find(event => event.seq === selectedSeq) ?? events.at(-1)
  const secondary = selected?.blockers?.filter(cause => cause !== selected.primaryCause) ?? []
  return (
    <div className="diagnosis-layout">
      <div className="throttle-total">
        <p className="throttle-number">{formatNumber(total)}</p>
        <p className="throttle-caption">Rejected requests in the last 10 simulated seconds. Each is counted once under its primary cause.</p>
        <p className="throttle-caption">Precedence: RPS ceiling, reserved concurrency, account concurrency, then scaling rate.</p>
      </div>
      <div>
        {total === 0 && <div className="zero-state">No throttles in the last 10 seconds. All offered requests were admitted.</div>}
        <div className="cause-list">
          {details.map(detail => {
            const count = props.causes[detail.key]
            const percentage = total ? count / total * 100 : 0
            return (
              <div className="cause-row" key={detail.key}>
                <div className="cause-name">{detail.label}</div>
                <div className="cause-count">{formatNumber(count)}<span className="cause-percent">{percentage.toFixed(1)}%</span></div>
                <p className="cause-explanation">{detail.explanation}<span className="cause-limit">Active limit: {detail.limit(props)}</span></p>
              </div>
            )
          })}
        </div>
        <p className="diagnosis-note">Cause attribution is a simulator diagnosis, not a native standard CloudWatch dimension. These counters are exact; the recent request detail is a bounded sample.</p>
        {selected && <details className="recent-throttle-details">
          <summary>Inspect recent 429 requests</summary>
          <div className="field">
            <label htmlFor="recent-throttle">Recent rejected request (last 32 maximum)</label>
            <select id="recent-throttle" value={selected.seq} onChange={event => setSelectedSeq(Number(event.target.value))}>
              {[...events].reverse().map(event => <option key={event.seq} value={event.seq}>{event.requestId} at {formatElapsed(event.timeMs)}</option>)}
            </select>
          </div>
          <dl className="throttle-detail-grid">
            <div><dt>Response</dt><dd>429 TooManyRequestsException</dd></div>
            <div><dt>Primary diagnosis</dt><dd>{causeLabel(selected.primaryCause ?? '')}</dd></div>
            <div><dt>Secondary blockers</dt><dd>{secondary.length ? secondary.map(causeLabel).join(', ') : 'None'}</dd></div>
            <div><dt>Limits at rejection</dt><dd>Account: {formatNumber(selected.limits?.accountConcurrencyQuota ?? props.accountQuota)}; RPS: {formatNumber(selected.limits?.functionRpsCeiling ?? selected.limits?.accountRpsCeiling ?? props.accountQuota * 10)}; scaling balance: {formatNumber(selected.limits?.scalingUnitsAvailable ?? 0, 2)}.</dd></div>
          </dl>
          <p className="field-note">This request used no environment or concurrency, never ran Init or Invoke, and did not increment Invocations or Errors.</p>
        </details>}
      </div>
    </div>
  )
}
