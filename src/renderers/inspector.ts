import { formatElapsed, formatNumber } from '../lib/format'
import type { VisualEnvironment } from './types'
import { STATE_LABELS, STATE_SHAPES, environmentTypeLabel } from './visualLanguage'

export interface NavigationOptions {
  columns?: number
  pageStep?: number
}

export interface DetailRow {
  label: string
  value: string
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1
  if (!Number.isFinite(index)) return 0
  return Math.min(count - 1, Math.max(0, Math.floor(index)))
}

export function navigateIndex(key: string, index: number, count: number, options: NavigationOptions = {}): number | null {
  if (count <= 0) return null
  const columns = Math.max(1, Math.floor(options.columns ?? 1))
  const pageStep = Math.max(1, Math.floor(options.pageStep ?? columns))
  const current = clampIndex(index, count)
  switch (key) {
    case 'ArrowRight':
    case 'n':
    case 'N':
      return clampIndex(current + 1, count)
    case 'ArrowLeft':
    case 'p':
    case 'P':
      return clampIndex(current - 1, count)
    case 'ArrowDown':
      return clampIndex(current + columns, count)
    case 'ArrowUp':
      return clampIndex(current - columns, count)
    case 'PageDown':
      return clampIndex(current + pageStep, count)
    case 'PageUp':
      return clampIndex(current - pageStep, count)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export function ordinalFromInput(value: string, count: number): number | null {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return null
  return clampIndex(parsed - 1, count)
}

export function describeEnvironment(environment: VisualEnvironment, ordinal: number, count: number, nowMs?: number): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Position', value: `${formatNumber(ordinal)} of ${formatNumber(count)}` },
    { label: 'Environment ID', value: environment.id },
    { label: 'Type', value: environment.type === 'PROVISIONED' ? 'Provisioned' : 'On-demand' },
    { label: 'State', value: STATE_LABELS[environment.state] },
    { label: 'Shown as', value: STATE_SHAPES[environment.state] },
    { label: 'Active request', value: environment.activeRequestId ?? 'None' },
  ]
  if (typeof nowMs === 'number') {
    rows.push({ label: 'Time in state', value: formatElapsed(Math.max(0, nowMs - environment.stateSinceMs)) })
  }
  rows.push({ label: 'Total invocations', value: formatNumber(environment.totalInvocations) })
  rows.push({ label: 'Cold starts', value: formatNumber(environment.coldStarts) })
  return rows
}

export function historyLines(environment: VisualEnvironment, limit = 5): string[] {
  return environment.recentHistory
    .slice(-limit)
    .reverse()
    .map((entry) => `${entry.state.toLowerCase().replace(/_/g, ' ')} at ${formatElapsed(entry.atMs)}`)
}

export function compactSummary(environment: VisualEnvironment, ordinal: number, count: number): string {
  return `${formatNumber(ordinal)} of ${formatNumber(count)} | ${environment.id} | ${environmentTypeLabel(environment)} | ${STATE_LABELS[environment.state].toLowerCase()}`
}

export function selectionAnnouncement(environment: VisualEnvironment, ordinal: number, count: number): string {
  return `Selected environment ${formatNumber(ordinal)} of ${formatNumber(count)}, ${environment.id}, ${environmentTypeLabel(environment)}.`
}
