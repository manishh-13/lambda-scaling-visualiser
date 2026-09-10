import { useCallback, useEffect, useRef, useState } from 'react'
import { allocationFor, normalizeSimpleConfig, readSimpleConfig, requiresRestart, simpleShareUrl, type SimpleConfig } from './config'
import { SLOT, type SimpleCommand, type SimpleResponse, type SimpleSnapshot } from './types'

export function initialSnapshot(config: SimpleConfig): SimpleSnapshot {
  const allocation = allocationFor(config)
  const slots = Uint8Array.from({ length: config.quota }, (_, index) =>
    (index < allocation.provisioned ? SLOT.PROVISIONED : 0)
    | (config.reservedEnabled && index < allocation.reserved ? SLOT.RESERVED : 0)
    | (config.reservedEnabled && index >= allocation.reserved ? SLOT.OUTSIDE : 0))
  return {
    // Nothing is running before the first snapshot arrives, so every countdown is zero.
    config, timeMs: 0, trafficRunning: false, paused: false, slots, remainingMs: new Float64Array(config.quota),
    concurrent: 0, running: 0, initialising: 0, warm: 0,
    accepted: 0, completed: 0, rejected: 0, acceptedRps: 0, rejectedRps: 0,
    units: 1_000, quotaOccupancy: allocation.provisioned,
    unreservedAvailable: allocation.unreservedPool,
    throttlesByCause: { RPS_CEILING: 0, RESERVED_CONCURRENCY: 0, ACCOUNT_CONCURRENCY: 0, SCALING_RATE: 0 },
    lastReject: null, history: [{ timeMs: 0, units: 1_000, scalingRejections: 0 }],
  }
}

export function useSimulation() {
  const [config, setConfig] = useState(() => readSimpleConfig(typeof window === 'undefined' ? '' : window.location.search))
  const configRef = useRef(config)
  const [snapshot, setSnapshot] = useState(() => initialSnapshot(config))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [manualResult, setManualResult] = useState<{ sequence: number; accepted: boolean; cause: string | null } | null>(null)
  const worker = useRef<Worker | null>(null)
  const revision = useRef(0)
  const alive = useRef(false)

  useEffect(() => {
    alive.current = true
    let active: Worker | null = null
    try {
      active = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      worker.current = active
      active.onmessage = (event: MessageEvent<SimpleResponse>) => {
        const response = event.data
        if (response.revision !== revision.current) return
        if (response.type === 'SNAPSHOT') setSnapshot(response.snapshot)
        else if (response.type === 'ERROR') setError(response.message)
        else setManualResult(previous => ({ sequence: (previous?.sequence ?? 0) + 1, accepted: response.accepted, cause: response.cause }))
      }
      active.onerror = event => setError(event.message || 'The simulation could not start. Reload this page to try again.')
      active.onmessageerror = () => setError('A simulation update could not be read. Reload this page to try again.')
      active.postMessage({ type: 'INIT', config: configRef.current, revision: revision.current } satisfies SimpleCommand)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This browser could not start the simulation.')
    }
    return () => {
      alive.current = false
      if (active) {
        active.onmessage = null
        active.onerror = null
        active.onmessageerror = null
        active.terminate()
      }
      worker.current = null
    }
  }, [])

  const update = useCallback((patch: Partial<SimpleConfig>) => {
    const next = normalizeSimpleConfig({ ...configRef.current, ...patch })
    if (JSON.stringify(next) === JSON.stringify(configRef.current)) return
    const restart = requiresRestart(configRef.current, next)
    configRef.current = next
    setConfig(next)
    revision.current += 1
    if (restart) {
      setSnapshot(previous => ({ ...initialSnapshot(next), trafficRunning: previous.trafficRunning, paused: previous.paused }))
      setNotice('Applied. A fresh demonstration is using these settings.')
      setManualResult(null)
    } else {
      setNotice('Applied live.')
    }
    setCopyStatus('')
    setShareUrl('')
    window.history.replaceState(null, '', simpleShareUrl(next, window.location.href))
    worker.current?.postMessage({ type: 'CONFIGURE', config: next, revision: revision.current } satisfies SimpleCommand)
  }, [])

  const command = useCallback((type: 'START' | 'STOP' | 'MANUAL' | 'RESET' | 'PAUSE' | 'RESUME' | 'STEP') => {
    if (type === 'RESET') {
      revision.current += 1
      setSnapshot(initialSnapshot(configRef.current))
      setManualResult(null)
      setNotice('Reset. Your settings are kept.')
    } else if (type !== 'MANUAL') setNotice('')
    worker.current?.postMessage({ type, revision: revision.current } satisfies SimpleCommand)
  }, [])

  const copyLink = useCallback(async () => {
    const link = simpleShareUrl(configRef.current, window.location.href)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(link)
      if (alive.current) { setCopyStatus('Link copied'); setShareUrl('') }
    } catch {
      if (alive.current) { setCopyStatus('Select and copy the link below'); setShareUrl(link) }
    }
  }, [])

  return { config, snapshot, update, command, error, notice, copyStatus, shareUrl, copyLink, manualResult }
}
