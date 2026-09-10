import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  LIMITS,
  PARAM_KEYS,
  SPEED_OPTIONS,
  UNRESERVED_HEADROOM,
  URL_SCHEMA_VERSION,
  buildShareUrl,
  decodeConfig,
  decodeConfigFromSearch,
  encodeConfig,
  encodeConfigToSearch,
  maxProvisionedConcurrency,
  maxReservableConcurrency,
  normalizeConfig,
  readConfigFromUrl,
  writeConfigToUrl,
  type AppConfig,
} from './urlState'

const fullConfig: AppConfig = {
  schemaVersion: URL_SCHEMA_VERSION,
  preset: 'cold-starts',
  trafficProfile: 'spike',
  handlerDurationMs: 1_000,
  requestsPerSecond: 400,
  accountQuota: 1_000,
  initDurationMs: 400,
  idleTimeoutMs: 120_000,
  reservedEnabled: true,
  reservedConcurrency: 500,
  provisionedEnabled: true,
  provisionedConcurrency: 400,
  target: 'version-or-alias',
  seed: 987_654,
  comparisonMode: true,
  speed: 2,
}

function roundTrip(config: AppConfig): AppConfig {
  return decodeConfig(encodeConfig(config))
}

describe('round trip', () => {
  it('reproduces a complete configuration', () => {
    expect(roundTrip(fullConfig)).toEqual(fullConfig)
  })

  it('reproduces the defaults', () => {
    expect(roundTrip(DEFAULT_APP_CONFIG)).toEqual(DEFAULT_APP_CONFIG)
  })

  it('encodes every setting listed in the deep-link contract', () => {
    const params = encodeConfig(fullConfig)
    for (const key of Object.values(PARAM_KEYS)) {
      expect(params.has(key), `missing parameter ${key}`).toBe(true)
    }
  })

  it('reproduces every speed option', () => {
    for (const speed of SPEED_OPTIONS) {
      expect(roundTrip({ ...fullConfig, speed }).speed).toBe(speed)
    }
  })

  it('reproduces a fractional requests per second value', () => {
    expect(roundTrip({ ...fullConfig, requestsPerSecond: 12.5 }).requestsPerSecond).toBe(12.5)
  })

  it('reproduces both boolean states', () => {
    const off = roundTrip({
      ...fullConfig,
      reservedEnabled: false,
      provisionedEnabled: false,
      comparisonMode: false,
    })
    expect(off.reservedEnabled).toBe(false)
    expect(off.provisionedEnabled).toBe(false)
    expect(off.comparisonMode).toBe(false)
  })

  it('is idempotent when encoding an already encoded configuration', () => {
    const once = encodeConfigToSearch(fullConfig)
    const twice = encodeConfigToSearch(decodeConfigFromSearch(once))
    expect(twice).toBe(once)
  })

  it('accepts a leading question mark in the query string', () => {
    const search = encodeConfigToSearch(fullConfig)
    expect(search.startsWith('?')).toBe(true)
    expect(decodeConfigFromSearch(search)).toEqual(fullConfig)
  })
})

describe('missing and unknown parameters', () => {
  it('falls back to defaults for an empty query string', () => {
    expect(decodeConfigFromSearch('')).toEqual(DEFAULT_APP_CONFIG)
  })

  it('ignores unknown parameters instead of failing', () => {
    const decoded = decodeConfigFromSearch('?utm_source=talk&somethingNew=42&rps=250')
    expect(decoded.requestsPerSecond).toBe(250)
    expect(decoded.handlerDurationMs).toBe(DEFAULT_APP_CONFIG.handlerDurationMs)
  })

  it('preserves unrelated parameters when encoding onto an existing query', () => {
    const params = encodeConfig(fullConfig, new URLSearchParams('utm_source=talk'))
    expect(params.get('utm_source')).toBe('talk')
  })

  it('fills only the absent settings when the query is partial', () => {
    const decoded = decodeConfigFromSearch('?dur=250&seed=7')
    expect(decoded.handlerDurationMs).toBe(250)
    expect(decoded.seed).toBe(7)
    expect(decoded.accountQuota).toBe(DEFAULT_APP_CONFIG.accountQuota)
    expect(decoded.speed).toBe(DEFAULT_APP_CONFIG.speed)
  })

  it('normalizes the schema version of an older link', () => {
    expect(decodeConfigFromSearch('?v=0&rps=10').schemaVersion).toBe(URL_SCHEMA_VERSION)
  })
})

describe('malformed values', () => {
  it('falls back to defaults for non-numeric numbers', () => {
    const decoded = decodeConfigFromSearch(
      '?dur=abc&rps=NaN&quota=&init=null&idle=undefined&seed=%20&speed=fast',
    )
    expect(decoded.handlerDurationMs).toBe(DEFAULT_APP_CONFIG.handlerDurationMs)
    expect(decoded.requestsPerSecond).toBe(DEFAULT_APP_CONFIG.requestsPerSecond)
    expect(decoded.accountQuota).toBe(DEFAULT_APP_CONFIG.accountQuota)
    expect(decoded.initDurationMs).toBe(DEFAULT_APP_CONFIG.initDurationMs)
    expect(decoded.idleTimeoutMs).toBe(DEFAULT_APP_CONFIG.idleTimeoutMs)
    expect(decoded.seed).toBe(DEFAULT_APP_CONFIG.seed)
    expect(decoded.speed).toBe(DEFAULT_APP_CONFIG.speed)
  })

  it('rejects infinities', () => {
    const decoded = decodeConfigFromSearch('?rps=Infinity&dur=-Infinity')
    expect(decoded.requestsPerSecond).toBe(DEFAULT_APP_CONFIG.requestsPerSecond)
    expect(decoded.handlerDurationMs).toBe(DEFAULT_APP_CONFIG.handlerDurationMs)
  })

  it('falls back to defaults for unknown preset, traffic profile and target values', () => {
    const decoded = decodeConfigFromSearch(
      '?preset=not-a-preset&target=not-a-target&traffic=not-a-profile',
    )
    expect(decoded.preset).toBe(DEFAULT_APP_CONFIG.preset)
    expect(decoded.target).toBe(DEFAULT_APP_CONFIG.target)
    expect(decoded.trafficProfile).toBe(DEFAULT_APP_CONFIG.trafficProfile)
  })

  it('decodes each supported traffic profile', () => {
    expect(decodeConfigFromSearch('?traffic=constant').trafficProfile).toBe('constant')
    expect(decodeConfigFromSearch('?traffic=SPIKE').trafficProfile).toBe('spike')
  })

  it('accepts case-insensitive enum values', () => {
    const decoded = decodeConfigFromSearch('?preset=FAST-CODE&target=Version-Or-Alias')
    expect(decoded.preset).toBe('fast-code')
    expect(decoded.target).toBe('version-or-alias')
  })

  it('accepts the documented boolean spellings and defaults otherwise', () => {
    expect(decodeConfigFromSearch('?cmp=true').comparisonMode).toBe(true)
    expect(decodeConfigFromSearch('?cmp=1').comparisonMode).toBe(true)
    expect(decodeConfigFromSearch('?cmp=YES').comparisonMode).toBe(true)
    expect(decodeConfigFromSearch('?cmp=false').comparisonMode).toBe(false)
    expect(decodeConfigFromSearch('?cmp=0').comparisonMode).toBe(false)
    expect(decodeConfigFromSearch('?cmp=maybe').comparisonMode).toBe(
      DEFAULT_APP_CONFIG.comparisonMode,
    )
  })

  it('rounds fractional integers', () => {
    const decoded = decodeConfigFromSearch('?dur=250.6&quota=1000.4&seed=7.5&init=399.5')
    expect(decoded.handlerDurationMs).toBe(251)
    expect(decoded.accountQuota).toBe(1_000)
    expect(decoded.seed).toBe(8)
    expect(decoded.initDurationMs).toBe(400)
  })

  it('snaps an unlisted speed to the nearest supported option', () => {
    expect(decodeConfigFromSearch('?speed=3').speed).toBe(2)
    expect(decodeConfigFromSearch('?speed=0.3').speed).toBe(0.25)
    expect(decodeConfigFromSearch('?speed=1000').speed).toBe(4)
    expect(decodeConfigFromSearch('?speed=-5').speed).toBe(0.25)
  })

  it('survives a duplicated parameter by taking the first value', () => {
    expect(decodeConfigFromSearch('?rps=10&rps=20').requestsPerSecond).toBe(10)
  })
})

describe('out-of-range values', () => {
  it('clamps numbers below the minimum', () => {
    const decoded = decodeConfigFromSearch('?dur=0&rps=-50&quota=1&init=-10&idle=1&seed=-9')
    expect(decoded.handlerDurationMs).toBe(LIMITS.handlerDurationMs.min)
    expect(decoded.requestsPerSecond).toBe(LIMITS.requestsPerSecond.min)
    expect(decoded.accountQuota).toBe(LIMITS.accountQuota.min)
    expect(decoded.initDurationMs).toBe(LIMITS.initDurationMs.min)
    expect(decoded.idleTimeoutMs).toBe(LIMITS.idleTimeoutMs.min)
    expect(decoded.seed).toBe(LIMITS.seed.min)
  })

  it('clamps numbers above the maximum', () => {
    const decoded = decodeConfigFromSearch(
      '?dur=99999999&rps=99999999&quota=99999999&init=99999999&idle=99999999&seed=99999999999',
    )
    expect(decoded.handlerDurationMs).toBe(LIMITS.handlerDurationMs.max)
    expect(decoded.requestsPerSecond).toBe(LIMITS.requestsPerSecond.max)
    expect(decoded.accountQuota).toBe(LIMITS.accountQuota.max)
    expect(decoded.initDurationMs).toBe(LIMITS.initDurationMs.max)
    expect(decoded.idleTimeoutMs).toBe(LIMITS.idleTimeoutMs.max)
    expect(decoded.seed).toBe(LIMITS.seed.max)
  })
})

describe('concurrency allocation rules', () => {
  it('caps reserved concurrency at the quota minus the unreserved headroom', () => {
    expect(maxReservableConcurrency(1_000)).toBe(1_000 - UNRESERVED_HEADROOM)
    const decoded = decodeConfigFromSearch('?quota=1000&res=1&resv=990')
    expect(decoded.reservedConcurrency).toBe(900)
  })

  it('never allows a negative reservable ceiling', () => {
    expect(maxReservableConcurrency(UNRESERVED_HEADROOM)).toBe(0)
    expect(decodeConfigFromSearch('?quota=100&res=1&resv=50').reservedConcurrency).toBe(0)
  })

  it('caps provisioned concurrency at the quota minus the headroom without reserved', () => {
    const decoded = decodeConfigFromSearch('?target=version-or-alias&quota=1000&prov=1&provv=5000')
    expect(decoded.provisionedConcurrency).toBe(900)
  })

  it('caps provisioned concurrency at the reserved value when reserved is enabled', () => {
    const decoded = decodeConfigFromSearch(
      '?target=version-or-alias&quota=1000&res=1&resv=400&prov=1&provv=800',
    )
    expect(decoded.reservedConcurrency).toBe(400)
    expect(decoded.provisionedConcurrency).toBe(400)
  })

  it('exposes the provisioned ceiling helper consistently', () => {
    expect(
      maxProvisionedConcurrency({
        accountQuota: 1_000,
        reservedEnabled: false,
        reservedConcurrency: 0,
      }),
    ).toBe(900)
    expect(
      maxProvisionedConcurrency({
        accountQuota: 1_000,
        reservedEnabled: true,
        reservedConcurrency: 250,
      }),
    ).toBe(250)
  })

  it('disables provisioned concurrency when the target is $LATEST', () => {
    const decoded = decodeConfigFromSearch('?target=latest&prov=1&provv=400')
    expect(decoded.provisionedEnabled).toBe(false)
    expect(decoded.provisionedConcurrency).toBe(400)
  })

  it('normalizes a directly built configuration the same way as a decoded one', () => {
    const normalized = normalizeConfig({
      ...fullConfig,
      target: 'latest',
      accountQuota: 1_000,
      reservedConcurrency: 5_000,
      provisionedConcurrency: 5_000,
    })
    expect(normalized.provisionedEnabled).toBe(false)
    expect(normalized.reservedConcurrency).toBe(900)
    expect(normalized.provisionedConcurrency).toBe(900)
  })
})

describe('subpath and history handling', () => {
  const href = 'https://example.github.io/lambda-scaling-visualiser/?old=1#stage'

  it('preserves the GitHub Pages subpath and hash in a share link', () => {
    const shared = new URL(buildShareUrl(fullConfig, href))
    expect(shared.pathname).toBe('/lambda-scaling-visualiser/')
    expect(shared.hash).toBe('#stage')
    expect(shared.searchParams.get('old')).toBe('1')
    expect(decodeConfig(shared.searchParams)).toEqual(fullConfig)
  })

  it('does not introduce a client-side route segment', () => {
    const withoutTrailingSlash = 'https://example.github.io/some-renamed-repo/index.html'
    expect(new URL(buildShareUrl(fullConfig, withoutTrailingSlash)).pathname).toBe(
      '/some-renamed-repo/index.html',
    )
  })

  it('writes with replaceState and keeps the subpath', () => {
    const replaceState = vi.fn()
    writeConfigToUrl(fullConfig, { location: { href }, history: { replaceState } })
    expect(replaceState).toHaveBeenCalledTimes(1)
    const [, , nextUrl] = replaceState.mock.calls[0] as [unknown, string, string]
    expect(new URL(nextUrl).pathname).toBe('/lambda-scaling-visualiser/')
    expect(decodeConfigFromSearch(new URL(nextUrl).search)).toEqual(fullConfig)
  })

  it('reads a configuration back from an injected location', () => {
    const shareUrl = buildShareUrl(fullConfig, href)
    const read = readConfigFromUrl({
      location: { href: shareUrl },
      history: { replaceState: vi.fn() },
    })
    expect(read).toEqual(fullConfig)
  })
})


describe('direct editor input safety', () => {
  it('normalizes non-finite direct editor values to finite bounds', () => {
    const normalized = normalizeConfig({ ...DEFAULT_APP_CONFIG, handlerDurationMs: Number.NaN, requestsPerSecond: Number.NaN, accountQuota: Number.NaN, seed: Number.POSITIVE_INFINITY })
    expect(Object.values(normalized).filter(value => typeof value === 'number').every(Number.isFinite)).toBe(true)
  })
})
