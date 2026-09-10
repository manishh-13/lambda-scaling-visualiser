import { formatNumber, formatRate } from '../lib/format'

interface Props {
  concurrent: number
  invocations: number
  throttles: number
  durationMs: number
  provisionedInvocations: number
  spilloverInvocations: number
  acceptedRps: number
  throttledRps: number
  totalEnvironments: number
  warmIdle: number
  demanded: number
  durationSamples?: number
  acceptedRequests?: number
  quotaOccupancy?: number
  onDemandConcurrent?: number
  provisionedAllocated?: number
}

export function MetricsStrip(props: Props) {
  const primary = [
    { name: 'Demanded concurrency', value: formatNumber(props.demanded, 1), scope: 'Calculated now' },
    { name: 'ConcurrentExecutions', value: formatNumber(props.concurrent), scope: 'Current' },
    { name: 'Accepted requests per second', value: formatRate(props.acceptedRps), scope: 'Current interval' },
    { name: 'Throttled requests per second', value: formatRate(props.throttledRps), scope: 'Current interval' },
    { name: 'Quota occupancy', value: formatNumber(props.quotaOccupancy ?? props.concurrent), scope: `Current: ${formatNumber(props.provisionedAllocated ?? 0)} provisioned + ${formatNumber(props.onDemandConcurrent ?? props.concurrent)} on-demand in flight` },
    { name: 'Total visible environments', value: formatNumber(props.totalEnvironments), scope: 'Current, includes idle' },
    { name: 'Warm idle environments', value: formatNumber(props.warmIdle), scope: 'Current, no concurrency used' },
  ]
  const cloudwatch = [
    { name: 'Accepted requests', value: formatNumber(props.acceptedRequests ?? props.invocations), scope: 'Sum since reset, Init included' },
    { name: 'Invocations', value: formatNumber(props.invocations), scope: 'Sum since reset, handler started' },
    { name: 'Throttles', value: formatNumber(props.throttles), scope: 'Sum since reset' },
    { name: 'Duration', value: props.durationSamples === 0 ? 'No samples' : `${formatNumber(props.durationMs, 2)} ms`, scope: 'Average ms, Init excluded' },
    { name: 'ProvisionedConcurrencyInvocations', value: formatNumber(props.provisionedInvocations), scope: 'Sum since reset' },
    { name: 'ProvisionedConcurrencySpilloverInvocations', value: formatNumber(props.spilloverInvocations), scope: 'Sum since reset' },
  ]
  return (
    <>
      <section className="metrics-strip" aria-label="Current learning metrics">{primary.map((metric) => <div className="metric" key={metric.name}><p className="metric-name">{metric.name}</p><p className="metric-value">{metric.value}</p><span className="metric-scope">{metric.scope}</span></div>)}</section>
      <details className="cloudwatch-details" open><summary>Simulation counters using CloudWatch metric names</summary><div className="cloudwatch-metrics">{cloudwatch.map((metric) => <div className="metric" key={metric.name}><p className="metric-name">{metric.name}</p><p className="metric-value">{metric.value}</p><span className="metric-scope">{metric.scope}</span></div>)}</div><p className="cloudwatch-note">These are simulated definitions. The application does not read CloudWatch.</p></details>
    </>
  )
}
