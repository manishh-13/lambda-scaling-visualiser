/** The simple screen has one immediate configuration, never a staged draft. */
export interface SimpleConfig {
  rps: number
  durationMs: number
  quota: number
  reservedEnabled: boolean
  reserved: number
  provisionedEnabled: boolean
  provisioned: number
  initEnabled: boolean
  initMs: number
  idleEnabled: boolean
  idleMs: number
  speed: number
}

export const DEFAULT_SIMPLE_CONFIG: SimpleConfig = {
  rps: 400, durationMs: 1_000, quota: 1_000,
  reservedEnabled: false, reserved: 400,
  provisionedEnabled: false, provisioned: 200,
  initEnabled: false, initMs: 400,
  idleEnabled: false, idleMs: 3_000,
  speed: 1,
}
export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const
export const UNRESERVED_HEADROOM = 100

function number(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  const valid = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, integer ? Math.round(valid) : valid))
}

export function normalizeSimpleConfig(input: Partial<SimpleConfig> = {}): SimpleConfig {
  const d = DEFAULT_SIMPLE_CONFIG
  const quota = number(input.quota, d.quota, 100, 10_000, true)
  const reservedEnabled = input.reservedEnabled === true
  const reserved = number(input.reserved, d.reserved, 0, quota - UNRESERVED_HEADROOM, true)
  const provisioned = number(input.provisioned, d.provisioned, 0, reservedEnabled ? reserved : quota - UNRESERVED_HEADROOM, true)
  return {
    rps: number(input.rps, d.rps, 0, 100_000),
    durationMs: number(input.durationMs, d.durationMs, 1, 900_000, true),
    quota, reservedEnabled, reserved,
    provisionedEnabled: input.provisionedEnabled === true, provisioned,
    initEnabled: input.initEnabled === true,
    initMs: number(input.initMs, d.initMs, 0, 60_000, true),
    idleEnabled: input.idleEnabled === true,
    idleMs: number(input.idleMs, d.idleMs, 1_000, 3_600_000, true),
    speed: SPEEDS.includes(input.speed as typeof SPEEDS[number]) ? input.speed! : d.speed,
  }
}

export function allocationFor(config: SimpleConfig) {
  const reserved = config.reservedEnabled ? config.reserved : 0
  const provisioned = config.provisionedEnabled ? config.provisioned : 0
  return {
    reserved, provisioned,
    functionLimit: config.reservedEnabled ? reserved : config.quota,
    // PC is a subset of RC when both are configured, not another reservation.
    unreservedPool: config.quota - (config.reservedEnabled ? reserved : provisioned),
    onDemandLimit: (config.reservedEnabled ? reserved : config.quota) - provisioned,
  }
}

const keys = {
  rps: 'rps', durationMs: 'dur', quota: 'quota', reservedEnabled: 'res', reserved: 'resv',
  provisionedEnabled: 'prov', provisioned: 'provv', initEnabled: 'initOn', initMs: 'init',
  idleEnabled: 'idleOn', idleMs: 'idle', speed: 'speed',
} as const
const toggles = new Set<keyof SimpleConfig>(['reservedEnabled', 'provisionedEnabled', 'initEnabled', 'idleEnabled'])

export function readSimpleConfig(search = ''): SimpleConfig {
  const params = new URLSearchParams(search)
  const result: Record<string, number | boolean> = { ...DEFAULT_SIMPLE_CONFIG }
  for (const [field, key] of Object.entries(keys)) {
    const raw = params.get(key)?.trim()
    if (raw === undefined || raw === '') continue
    if (toggles.has(field as keyof SimpleConfig)) {
      if (raw === '1' || raw === 'true') result[field] = true
      else if (raw === '0' || raw === 'false') result[field] = false
    } else {
      const value = Number(raw)
      if (Number.isFinite(value)) result[field] = value
    }
  }
  // Earlier links explicitly modeled lifecycle timings. Keep that intent.
  if (params.get('v') === '1') {
    if (!params.has('initOn') && params.has('init')) result.initEnabled = Number(params.get('init')) > 0
    if (!params.has('idleOn') && params.has('idle')) result.idleEnabled = true
  }
  return normalizeSimpleConfig(result as unknown as SimpleConfig)
}

export function simpleShareUrl(config: SimpleConfig, href: string): string {
  const url = new URL(href)
  const normalized = normalizeSimpleConfig(config)
  url.searchParams.set('v', '2')
  for (const [field, key] of Object.entries(keys)) {
    const value = normalized[field as keyof SimpleConfig]
    url.searchParams.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  }
  for (const key of ['preset', 'traffic', 'cmp', 'seed', 'target']) url.searchParams.delete(key)
  return url.toString()
}

export function requiresRestart(before: SimpleConfig, after: SimpleConfig): boolean {
  return (Object.keys(before) as Array<keyof SimpleConfig>)
    .some(key => key !== 'rps' && key !== 'speed' && before[key] !== after[key])
}
