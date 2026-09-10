import { create } from 'zustand'
import {
  buildShareUrl,
  DEFAULT_APP_CONFIG,
  normalizeConfig,
  readConfigFromUrl,
  writeConfigToUrl,
} from '../lib/urlState'
import type { AppConfig, PresetId, SpeedOption } from '../lib/urlState'
import { INITIAL_NARRATION } from '../lib/narration'
import { presets } from '../content/presets'
import type {
  UiMetrics,
  UiProvisioned,
  UiSnapshot,
  WorkerCommand,
  WorkerCommandDraft,
  WorkerResponse,
} from './types'

const emptyMetrics: UiMetrics = {
  demandedConcurrency: DEFAULT_APP_CONFIG.requestsPerSecond * DEFAULT_APP_CONFIG.handlerDurationMs / 1000,
  concurrentExecutions: 0,
  acceptedRps: 0,
  throttledRps: 0,
  totalEnvironments: 0,
  warmIdle: 0,
  scalingTokens: 1_000,
  activeCap: DEFAULT_APP_CONFIG.accountQuota,
  invocations: 0,
  throttles: 0,
  errors: 0,
  durationMs: DEFAULT_APP_CONFIG.handlerDurationMs,
  provisionedInvocations: 0,
  spilloverInvocations: 0,
  acceptedRequests: 0,
  durationHasSamples: false,
  configuredRps: DEFAULT_APP_CONFIG.requestsPerSecond,
  offeredRps: 0,
  coldStarts: 0,
  quotaOccupancy: 0,
  onDemandConcurrentExecutions: 0,
}

const emptyProvisioned: UiProvisioned = {
  status: 'DISABLED',
  requested: 0,
  ready: 0,
  allocated: 0,
  preparationDelayMs: 0,
  allocationDurationMs: 0,
  allocationStartedAtMs: null,
  readyAtMs: null,
  progress: 0,
  quotaReserved: 0,
}

const emptySnapshot: UiSnapshot = {
  timeMs: 0,
  trafficActive: false,
  provisionedStatus: 'DISABLED',
  environments: [],
  metrics: emptyMetrics,
  causes: { RPS_CEILING: 0, RESERVED_CONCURRENCY: 0, ACCOUNT_CONCURRENCY: 0, SCALING_RATE: 0 },
  timeline: [],
  narration: INITIAL_NARRATION,
  provisioned: emptyProvisioned,
  recentThrottleEvents: [],
  clockRunning: false,
  paused: true,
  pausedByUser: false,
  canStartTraffic: true,
}

export interface SimulationStore {
  draftConfig: AppConfig
  appliedConfig: AppConfig
  dirty: boolean
  /** Mirrors the worker. True means the engine clock is intentionally halted. */
  paused: boolean
  /** A Pause command is in flight. Step waits for the acknowledgment. */
  pausePending: boolean
  snapshot: UiSnapshot
  copyStatus: string
  /** Shown when the clipboard is unavailable, so the link can be copied by hand. */
  shareLinkFallback: string | null
  /** Last worker failure, surfaced so a broken worker is never silent. */
  workerError: string | null
  /** Set when the worker refuses a command, for example Start before READY. */
  lastRefusal: string | null
  initialize: () => void
  updateDraft: (patch: Partial<AppConfig>) => void
  applyAndReset: () => void
  applyPreset: (preset: PresetId) => void
  startTraffic: () => void
  stopTraffic: () => void
  pause: () => void
  resume: () => void
  step: () => void
  reset: () => void
  setSpeed: (speed: SpeedOption) => void
  copyShareLink: () => Promise<void>
  waitUntilProvisionedReady: () => void
  dismissMessages: () => void
}

interface Runtime {
  worker: Worker
  commandId: number
  /** Snapshots from an earlier revision are stale and must be dropped. */
  expectedRevision: number
}

let runtime: Runtime | null = null

/** Terminate the worker. Exported for hot module replacement and for tests. */
export function disposeSimulationRuntime(): void {
  if (!runtime) return
  runtime.worker.onmessage = null
  runtime.worker.onerror = null
  runtime.worker.terminate()
  runtime = null
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeSimulationRuntime)
}

function send(command: WorkerCommandDraft): number {
  if (!runtime) return -1
  runtime.commandId += 1
  const full = { ...command, commandId: runtime.commandId } as WorkerCommand
  if (full.type === 'INIT' || full.type === 'RESET') runtime.expectedRevision += 1
  runtime.worker.postMessage(full)
  return runtime.commandId
}

export const useSimulationStore = create<SimulationStore>((set, get) => ({
  draftConfig: { ...DEFAULT_APP_CONFIG },
  appliedConfig: { ...DEFAULT_APP_CONFIG },
  dirty: false,
  paused: true,
  pausePending: false,
  snapshot: emptySnapshot,
  copyStatus: '',
  shareLinkFallback: null,
  workerError: null,
  lastRefusal: null,

  initialize: () => {
    // Strict mode mounts effects twice in development, and hot module
    // replacement can reload this module while a worker is alive. One runtime
    // per module instance keeps both cases from leaking workers or timers.
    if (runtime) return
    const initialConfig = typeof window === 'undefined' ? { ...DEFAULT_APP_CONFIG } : readConfigFromUrl()
    const worker = new Worker(new URL('../worker/simulation.worker.ts', import.meta.url), {
      type: 'module',
    })
    runtime = { worker, commandId: 0, expectedRevision: 0 }

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (!runtime) return
      if (message.type === 'SNAPSHOT') {
        if (message.revision < runtime.expectedRevision) return
        set({ snapshot: message.snapshot, paused: message.snapshot.paused, pausePending: false })
        return
      }
      if (message.type === 'ACK') {
        if (message.command === 'PAUSE') set({ pausePending: false })
        if (!message.accepted) set({ lastRefusal: message.reason ?? 'Command refused.' })
        return
      }
      set({ workerError: message.message })
    }
    worker.onerror = (event) => {
      set({ workerError: event.message || 'The simulation worker failed to start.' })
    }
    worker.onmessageerror = () => {
      set({ workerError: 'The simulation worker sent a message that could not be read.' })
    }

    set({ draftConfig: initialConfig, appliedConfig: initialConfig, paused: true })
    send({ type: 'INIT', config: initialConfig })
  },

  updateDraft: (patch) =>
    set((state) => {
      const draftConfig = normalizeConfig({ ...state.draftConfig, ...patch, preset: patch.preset ?? 'custom' })
      if (typeof window !== 'undefined') writeConfigToUrl(draftConfig)
      return {
        draftConfig,
        dirty: JSON.stringify(draftConfig) !== JSON.stringify(state.appliedConfig),
      }
    }),

  applyAndReset: () => {
    const config = normalizeConfig(get().draftConfig)
    send({ type: 'RESET', config })
    if (typeof window !== 'undefined') writeConfigToUrl(config)
    set({
      appliedConfig: config,
      draftConfig: config,
      dirty: false,
      paused: true,
      pausePending: false,
      lastRefusal: null,
    })
  },

  applyPreset: (presetId) => {
    const preset = presets.find((item) => item.id === presetId)
    if (!preset) return
    const config = normalizeConfig({ ...DEFAULT_APP_CONFIG, ...preset.config, preset: presetId })
    send({ type: 'RESET', config })
    if (typeof window !== 'undefined') writeConfigToUrl(config)
    set({
      draftConfig: config,
      appliedConfig: config,
      dirty: false,
      paused: true,
      pausePending: false,
      lastRefusal: null,
    })
  },

  startTraffic: () => {
    send({ type: 'START' })
    // Start releases an idle start line, so reflect that at once instead of
    // waiting for the next snapshot to unlock the transport controls.
    const halted = get().paused && !get().snapshot.pausedByUser
    set({ lastRefusal: null, ...(halted ? { paused: false } : {}) })
  },

  stopTraffic: () => {
    send({ type: 'STOP' })
  },

  pause: () => {
    if (get().paused) return
    set({ paused: true, pausePending: true })
    send({ type: 'PAUSE' })
  },

  resume: () => {
    if (!get().paused) return
    set({ paused: false, pausePending: false })
    send({ type: 'RESUME' })
  },

  step: () => {
    // Step is only meaningful while the clock is halted, and only once the pause
    // has been acknowledged, so a step can never overlap a driver tick.
    if (!get().paused || get().pausePending) return
    send({ type: 'STEP' })
  },

  reset: () => {
    // Reset returns to the applied deep-linked configuration and seed at time
    // zero. Un-applied edits are discarded and the address bar is restored.
    const config = get().appliedConfig
    send({ type: 'RESET', config })
    if (typeof window !== 'undefined') writeConfigToUrl(config)
    set({
      draftConfig: config,
      dirty: false,
      paused: true,
      pausePending: false,
      lastRefusal: null,
    })
  },

  setSpeed: (speed) => {
    const draftConfig = normalizeConfig({ ...get().draftConfig, speed })
    const appliedConfig = normalizeConfig({ ...get().appliedConfig, speed })
    if (typeof window !== 'undefined') writeConfigToUrl(draftConfig)
    set({ draftConfig, appliedConfig })
    // Speed only scales how much real time becomes simulated time, so it never
    // needs a reset and never changes the deterministic engine sequence.
    send({ type: 'SET_SPEED', speed })
  },

  copyShareLink: async () => {
    if (typeof window === 'undefined') return
    const url = buildShareUrl(get().draftConfig, window.location.href)
    const clipboard = navigator.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(url)
        set({ copyStatus: 'Link copied', shareLinkFallback: null })
        window.setTimeout(() => set({ copyStatus: '' }), 1800)
        return
      } catch {
        // Fall through to the manual field below.
      }
    }
    set({ copyStatus: 'Copy the link below', shareLinkFallback: url })
  },

  waitUntilProvisionedReady: () => {
    send({ type: 'PREPARE_TO_READY' })
  },

  dismissMessages: () => set({ copyStatus: '', shareLinkFallback: null, workerError: null, lastRefusal: null }),
}))
