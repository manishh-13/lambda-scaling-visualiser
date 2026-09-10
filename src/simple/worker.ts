/// <reference lib="webworker" />

/**
 * Worker entry for the simple screen. It only wires real browser primitives into the
 * framework free SimpleHost, so every behaviour stays testable without a worker.
 */

import { SimpleHost } from './host'
import type { SimpleCommand, SimpleResponse } from './types'

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

let intervalHandle: ReturnType<typeof setInterval> | null = null

const host = new SimpleHost({
  now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  start(callback, intervalMs) {
    if (intervalHandle !== null) clearInterval(intervalHandle)
    intervalHandle = setInterval(callback, intervalMs)
  },
  stop() {
    if (intervalHandle === null) return
    clearInterval(intervalHandle)
    intervalHandle = null
  },
  post: (response: SimpleResponse) => scope.postMessage(response),
})

scope.onmessage = (event: MessageEvent<SimpleCommand>) => {
  host.handle(event.data)
}

scope.onerror = (event) => {
  const message = typeof event === 'string' ? event : (event as ErrorEvent).message
  scope.postMessage({
    type: 'ERROR',
    revision: host.currentRevision,
    message: message ?? 'Unknown worker error.',
  } satisfies SimpleResponse)
  // An uncaught failure stops the driver, so the screen never animates a dead run.
  host.stopClock()
}

// A hot module replacement swap must not leave the previous interval running.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    host.dispose()
    if (intervalHandle !== null) clearInterval(intervalHandle)
    intervalHandle = null
  })
}
