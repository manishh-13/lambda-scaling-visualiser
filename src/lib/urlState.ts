/**
 * Deep-link state for the simulator.
 *
 * Every user-controlled setting round trips through the query string so a copied
 * URL recreates the exact initial configuration and seed. All work happens on a
 * URLSearchParams instance and the pathname is never touched, so a GitHub Pages
 * project subpath such as /lambda-scaling-visualiser/ survives untouched.
 */

export const URL_SCHEMA_VERSION = 1

export const PRESET_IDS = [
  'custom',
  'slow-code',
  'fast-code',
  'sudden-spike',
  'short-huge',
  'cold-starts',
] as const

export type PresetId = (typeof PRESET_IDS)[number]

export const TRAFFIC_PROFILES = ['constant', 'spike'] as const

export type TrafficProfile = (typeof TRAFFIC_PROFILES)[number]

export const TARGET_IDS = ['latest', 'version-or-alias'] as const

export type TargetId = (typeof TARGET_IDS)[number]

export const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4] as const

export type SpeedOption = (typeof SPEED_OPTIONS)[number]

/** Complete editable configuration. Nothing else may vary between two share links. */
export interface AppConfig {
  schemaVersion: number
  preset: PresetId
  trafficProfile: TrafficProfile
  /** Average handler duration in milliseconds. Represents CloudWatch Duration, Init excluded. */
  handlerDurationMs: number
  requestsPerSecond: number
  /** Example default account concurrency quota, adjustable and not an AWS universal value. */
  accountQuota: number
  /** Illustrative Init duration in milliseconds. */
  initDurationMs: number
  /** Illustrative idle retirement timeout in milliseconds. */
  idleTimeoutMs: number
  reservedEnabled: boolean
  reservedConcurrency: number
  provisionedEnabled: boolean
  provisionedConcurrency: number
  target: TargetId
  seed: number
  comparisonMode: boolean
  speed: SpeedOption
}

/** Concurrency that cannot be reserved by a single function: quota minus this headroom. */
export const UNRESERVED_HEADROOM = 100

export const LIMITS = {
  handlerDurationMs: { min: 1, max: 900_000 },
  requestsPerSecond: { min: 0, max: 100_000 },
  accountQuota: { min: UNRESERVED_HEADROOM, max: 10_000 },
  initDurationMs: { min: 0, max: 60_000 },
  idleTimeoutMs: { min: 1_000, max: 3_600_000 },
  seed: { min: 0, max: 4_294_967_295 },
} as const

export const DEFAULT_APP_CONFIG: AppConfig = {
  schemaVersion: URL_SCHEMA_VERSION,
  preset: 'custom',
  trafficProfile: 'constant',
  handlerDurationMs: 1_000,
  requestsPerSecond: 100,
  accountQuota: 1_000,
  initDurationMs: 400,
  idleTimeoutMs: 15_000,
  reservedEnabled: false,
  reservedConcurrency: 0,
  provisionedEnabled: false,
  provisionedConcurrency: 0,
  target: 'version-or-alias',
  seed: 1,
  comparisonMode: false,
  speed: 1,
}

/** Short, stable query keys. Renaming one is a schema version bump. */
export const PARAM_KEYS = {
  schemaVersion: 'v',
  preset: 'preset',
  trafficProfile: 'traffic',
  handlerDurationMs: 'dur',
  requestsPerSecond: 'rps',
  accountQuota: 'quota',
  initDurationMs: 'init',
  idleTimeoutMs: 'idle',
  reservedEnabled: 'res',
  reservedConcurrency: 'resv',
  provisionedEnabled: 'prov',
  provisionedConcurrency: 'provv',
  target: 'target',
  seed: 'seed',
  comparisonMode: 'cmp',
  speed: 'speed',
} as const

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function readNumber(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

function readClampedNumber(
  params: URLSearchParams,
  key: string,
  range: { min: number; max: number },
  fallback: number,
): number {
  const parsed = readNumber(params, key)
  if (parsed === undefined) return fallback
  return clamp(parsed, range.min, range.max)
}

function readClampedInteger(
  params: URLSearchParams,
  key: string,
  range: { min: number; max: number },
  fallback: number,
): number {
  const parsed = readNumber(params, key)
  if (parsed === undefined) return fallback
  return clamp(Math.round(parsed), range.min, range.max)
}

function readBoolean(params: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = params.get(key)
  if (raw === null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return fallback
}

function readEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = params.get(key)
  if (raw === null) return fallback
  const normalized = raw.trim().toLowerCase()
  const match = allowed.find((option) => option.toLowerCase() === normalized)
  return match ?? fallback
}

function readSpeed(params: URLSearchParams, fallback: SpeedOption): SpeedOption {
  const parsed = readNumber(params, PARAM_KEYS.speed)
  if (parsed === undefined) return fallback
  // Ties resolve to the lower option, which keeps snapping deterministic.
  let closest: SpeedOption = SPEED_OPTIONS[0]
  let smallestGap = Number.POSITIVE_INFINITY
  for (const option of SPEED_OPTIONS) {
    const gap = Math.abs(option - parsed)
    if (gap < smallestGap) {
      smallestGap = gap
      closest = option
    }
  }
  return closest
}

/** Largest concurrency a single function may reserve against a given account quota. */
export function maxReservableConcurrency(accountQuota: number): number {
  return Math.max(0, accountQuota - UNRESERVED_HEADROOM)
}

/** Largest provisioned concurrency allowed, given the quota and any reserved allocation. */
export function maxProvisionedConcurrency(config: {
  accountQuota: number
  reservedEnabled: boolean
  reservedConcurrency: number
}): number {
  if (config.reservedEnabled) return Math.max(0, config.reservedConcurrency)
  return maxReservableConcurrency(config.accountQuota)
}

/**
 * Force a configuration into the valid space. Applied on both decode and encode
 * so encoding is idempotent and a round trip is lossless.
 */
export function normalizeConfig(config: AppConfig): AppConfig {
  const accountQuota = clamp(
    Math.round(config.accountQuota),
    LIMITS.accountQuota.min,
    LIMITS.accountQuota.max,
  )

  const reservedEnabled = config.reservedEnabled
  const reservedConcurrency = clamp(
    Math.round(config.reservedConcurrency),
    0,
    maxReservableConcurrency(accountQuota),
  )

  const target: TargetId = TARGET_IDS.includes(config.target) ? config.target : DEFAULT_APP_CONFIG.target
  const provisionedEnabled = target === 'latest' ? false : config.provisionedEnabled
  const provisionedConcurrency = clamp(
    Math.round(config.provisionedConcurrency),
    0,
    maxProvisionedConcurrency({ accountQuota, reservedEnabled, reservedConcurrency }),
  )

  return {
    schemaVersion: URL_SCHEMA_VERSION,
    preset: PRESET_IDS.includes(config.preset) ? config.preset : DEFAULT_APP_CONFIG.preset,
    trafficProfile: TRAFFIC_PROFILES.includes(config.trafficProfile)
      ? config.trafficProfile
      : DEFAULT_APP_CONFIG.trafficProfile,
    handlerDurationMs: clamp(
      Math.round(config.handlerDurationMs),
      LIMITS.handlerDurationMs.min,
      LIMITS.handlerDurationMs.max,
    ),
    requestsPerSecond: clamp(
      config.requestsPerSecond,
      LIMITS.requestsPerSecond.min,
      LIMITS.requestsPerSecond.max,
    ),
    accountQuota,
    initDurationMs: clamp(
      Math.round(config.initDurationMs),
      LIMITS.initDurationMs.min,
      LIMITS.initDurationMs.max,
    ),
    idleTimeoutMs: clamp(
      Math.round(config.idleTimeoutMs),
      LIMITS.idleTimeoutMs.min,
      LIMITS.idleTimeoutMs.max,
    ),
    reservedEnabled,
    reservedConcurrency,
    provisionedEnabled,
    provisionedConcurrency,
    target,
    seed: clamp(Math.round(config.seed), LIMITS.seed.min, LIMITS.seed.max),
    comparisonMode: config.comparisonMode,
    speed: SPEED_OPTIONS.includes(config.speed) ? config.speed : DEFAULT_APP_CONFIG.speed,
  }
}

/**
 * Decode a configuration from query parameters. Missing values fall back to the
 * defaults, malformed and out-of-range values are clamped, and unrecognised
 * parameters are ignored rather than treated as an error.
 */
export function decodeConfig(params: URLSearchParams): AppConfig {
  const defaults = DEFAULT_APP_CONFIG

  const accountQuota = readClampedInteger(
    params,
    PARAM_KEYS.accountQuota,
    LIMITS.accountQuota,
    defaults.accountQuota,
  )
  const reservedEnabled = readBoolean(params, PARAM_KEYS.reservedEnabled, defaults.reservedEnabled)
  const reservedRaw = readClampedInteger(
    params,
    PARAM_KEYS.reservedConcurrency,
    { min: 0, max: LIMITS.accountQuota.max },
    defaults.reservedConcurrency,
  )
  const target = readEnum(params, PARAM_KEYS.target, TARGET_IDS, defaults.target)

  return normalizeConfig({
    schemaVersion: URL_SCHEMA_VERSION,
    preset: readEnum(params, PARAM_KEYS.preset, PRESET_IDS, defaults.preset),
    trafficProfile: readEnum(
      params,
      PARAM_KEYS.trafficProfile,
      TRAFFIC_PROFILES,
      defaults.trafficProfile,
    ),
    handlerDurationMs: readClampedInteger(
      params,
      PARAM_KEYS.handlerDurationMs,
      LIMITS.handlerDurationMs,
      defaults.handlerDurationMs,
    ),
    requestsPerSecond: readClampedNumber(
      params,
      PARAM_KEYS.requestsPerSecond,
      LIMITS.requestsPerSecond,
      defaults.requestsPerSecond,
    ),
    accountQuota,
    initDurationMs: readClampedInteger(
      params,
      PARAM_KEYS.initDurationMs,
      LIMITS.initDurationMs,
      defaults.initDurationMs,
    ),
    idleTimeoutMs: readClampedInteger(
      params,
      PARAM_KEYS.idleTimeoutMs,
      LIMITS.idleTimeoutMs,
      defaults.idleTimeoutMs,
    ),
    reservedEnabled,
    reservedConcurrency: reservedRaw,
    provisionedEnabled: readBoolean(
      params,
      PARAM_KEYS.provisionedEnabled,
      defaults.provisionedEnabled,
    ),
    provisionedConcurrency: readClampedInteger(
      params,
      PARAM_KEYS.provisionedConcurrency,
      { min: 0, max: LIMITS.accountQuota.max },
      defaults.provisionedConcurrency,
    ),
    target,
    seed: readClampedInteger(params, PARAM_KEYS.seed, LIMITS.seed, defaults.seed),
    comparisonMode: readBoolean(params, PARAM_KEYS.comparisonMode, defaults.comparisonMode),
    speed: readSpeed(params, defaults.speed),
  })
}

/** Decode from a raw query string such as "?rps=50" or "rps=50". */
export function decodeConfigFromSearch(search: string): AppConfig {
  return decodeConfig(new URLSearchParams(search))
}

/**
 * Encode a configuration into query parameters. When `base` is supplied its
 * unrelated parameters are preserved, so an unknown parameter added by someone
 * else is not silently dropped.
 */
export function encodeConfig(config: AppConfig, base?: URLSearchParams): URLSearchParams {
  const normalized = normalizeConfig(config)
  const params = new URLSearchParams(base ? base.toString() : '')

  params.set(PARAM_KEYS.schemaVersion, String(normalized.schemaVersion))
  params.set(PARAM_KEYS.preset, normalized.preset)
  params.set(PARAM_KEYS.trafficProfile, normalized.trafficProfile)
  params.set(PARAM_KEYS.handlerDurationMs, String(normalized.handlerDurationMs))
  params.set(PARAM_KEYS.requestsPerSecond, String(normalized.requestsPerSecond))
  params.set(PARAM_KEYS.accountQuota, String(normalized.accountQuota))
  params.set(PARAM_KEYS.initDurationMs, String(normalized.initDurationMs))
  params.set(PARAM_KEYS.idleTimeoutMs, String(normalized.idleTimeoutMs))
  params.set(PARAM_KEYS.reservedEnabled, normalized.reservedEnabled ? '1' : '0')
  params.set(PARAM_KEYS.reservedConcurrency, String(normalized.reservedConcurrency))
  params.set(PARAM_KEYS.provisionedEnabled, normalized.provisionedEnabled ? '1' : '0')
  params.set(PARAM_KEYS.provisionedConcurrency, String(normalized.provisionedConcurrency))
  params.set(PARAM_KEYS.target, normalized.target)
  params.set(PARAM_KEYS.seed, String(normalized.seed))
  params.set(PARAM_KEYS.comparisonMode, normalized.comparisonMode ? '1' : '0')
  params.set(PARAM_KEYS.speed, String(normalized.speed))

  return params
}

/** Encode to a query string including the leading question mark. */
export function encodeConfigToSearch(config: AppConfig, baseSearch = ''): string {
  return `?${encodeConfig(config, new URLSearchParams(baseSearch)).toString()}`
}

/**
 * Build a shareable absolute URL from the current location. Only the query is
 * rewritten, so a project subpath and any hash are kept intact.
 */
export function buildShareUrl(config: AppConfig, currentHref: string): string {
  const url = new URL(currentHref)
  url.search = encodeConfig(config, url.searchParams).toString()
  return url.toString()
}

export interface UrlStateContext {
  location: { href: string }
  history: Pick<History, 'replaceState'>
}

function resolveContext(context?: UrlStateContext): UrlStateContext | undefined {
  if (context) return context
  if (typeof window === 'undefined') return undefined
  return { location: window.location, history: window.history }
}

/** Read the configuration encoded in the current address bar. */
export function readConfigFromUrl(context?: UrlStateContext): AppConfig {
  const resolved = resolveContext(context)
  if (!resolved) return { ...DEFAULT_APP_CONFIG }
  return decodeConfigFromSearch(new URL(resolved.location.href).search)
}

/**
 * Write the configuration back with history.replaceState so editing controls
 * does not add history entries. A no-op outside the browser.
 */
export function writeConfigToUrl(config: AppConfig, context?: UrlStateContext): void {
  const resolved = resolveContext(context)
  if (!resolved) return
  resolved.history.replaceState(null, '', buildShareUrl(config, resolved.location.href))
}
