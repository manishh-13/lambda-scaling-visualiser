import { formatDuration, formatNumber } from '../lib/format'

export const MAX_HANDLER_MS = 900_000
export const DURATION_SLIDER_STEPS = 1_000
export const DURATION_PRESETS = [100, 1_000, 30_000, 60_000, 900_000] as const

/** Log spacing keeps short handlers selectable without hiding the 15 minute endpoint. */
export function durationFromSlider(position: number): number {
  const bounded = Number.isFinite(position) ? Math.max(0, Math.min(DURATION_SLIDER_STEPS, position)) : 0
  return Math.round(Math.exp(bounded / DURATION_SLIDER_STEPS * Math.log(MAX_HANDLER_MS)))
}

export function sliderFromDuration(durationMs: number): number {
  const bounded = Number.isFinite(durationMs) ? Math.max(1, Math.min(MAX_HANDLER_MS, durationMs)) : 1
  return Math.round(Math.log(bounded) / Math.log(MAX_HANDLER_MS) * DURATION_SLIDER_STEPS)
}

export function formatHandlerDuration(durationMs: number): string {
  if (durationMs < 60_000) return formatDuration(durationMs)
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = (durationMs % 60_000) / 1_000
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${formatNumber(seconds, 3)} s`
}
