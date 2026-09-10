import type { AppConfig, PresetId } from '../lib/urlState'

export interface Preset {
  id: PresetId
  name: string
  lesson: string
  config: Partial<AppConfig>
}

export const presets: Preset[] = [
  {
    id: 'slow-code',
    name: 'Slow code',
    lesson: 'This workload demands about 1,500 concurrency, so it eventually hits the 1,000 account ceiling.',
    config: { handlerDurationMs: 30_000, requestsPerSecond: 50, accountQuota: 1_000, reservedEnabled: false, provisionedEnabled: false, comparisonMode: false },
  },
  {
    id: 'fast-code',
    name: 'Fast code',
    lesson: 'About five warm environments can serve this workload through repeated reuse.',
    config: { handlerDurationMs: 100, requestsPerSecond: 50, accountQuota: 1_000, reservedEnabled: false, provisionedEnabled: false, comparisonMode: false },
  },
  {
    id: 'sudden-spike',
    name: 'Sudden spike',
    lesson: 'Demand is 5,000 concurrency. This scenario uses a 10,000 example quota, so early throttling comes from the scaling rate.',
    config: { handlerDurationMs: 1_000, requestsPerSecond: 5_000, accountQuota: 10_000, reservedEnabled: false, provisionedEnabled: false, comparisonMode: false, trafficProfile: 'spike' },
  },
  {
    id: 'short-huge',
    name: 'Short but huge volume',
    lesson: 'Demand is only 600 concurrency, but the 10,000 RPS ceiling rejects about 20,000 offered requests each second.',
    config: { handlerDurationMs: 20, requestsPerSecond: 30_000, accountQuota: 1_000, reservedEnabled: false, provisionedEnabled: false, comparisonMode: false },
  },
  {
    id: 'cold-starts',
    name: 'Cold starts hurt',
    lesson: 'Identical traffic reaches both sides, but prepared capacity starts invoking while on-demand environments perform Init.',
    config: { handlerDurationMs: 1_000, requestsPerSecond: 400, accountQuota: 1_000, initDurationMs: 400, reservedEnabled: false, reservedConcurrency: 0, provisionedEnabled: true, provisionedConcurrency: 400, target: 'version-or-alias', comparisonMode: true },
  },
]
