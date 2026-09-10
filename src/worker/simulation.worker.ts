/// <reference lib="webworker" />

/**
 * Worker entry point. It only wires real browser primitives into the framework
 * free SimulationHost, so every behaviour is testable without a worker.
 */

import { SimulationHost, type HostClock, type HostTimer } from './host'
import type { WorkerCommand, WorkerResponse } from '../store/types'

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

const clock: HostClock = {
  now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

const timer: HostTimer = {
  start(callback, intervalMs) {
    if (intervalHandle !== null) clearInterval(intervalHandle)
    intervalHandle = setInterval(callback, intervalMs)
  },
  stop() {
    if (intervalHandle === null) return
    clearInterval(intervalHandle)
    intervalHandle = null
  },
}

const host = new SimulationHost({
  clock,
  timer,
  post: (response: WorkerResponse) => workerScope.postMessage(response),
})

workerScope.onmessage = (event: MessageEvent<WorkerCommand>) => {
  host.handle(event.data)
}

workerScope.onerror = (event) => {
  const message = typeof event === 'string' ? event : (event as ErrorEvent).message
  workerScope.postMessage({ type: 'ERROR', message: message ?? 'Unknown worker error.' } satisfies WorkerResponse)
}

// A hot module replacement swap must not leave the previous interval running.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    host.dispose()
    timer.stop()
  })
}
