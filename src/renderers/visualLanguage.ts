import type { VisualEnvironment, VisualEnvironmentState } from './types'

export const STATE_ORDER: VisualEnvironmentState[] = ['INITIALIZING', 'RUNNING', 'WARM_IDLE', 'PROVISIONED_IDLE', 'RETIRING']

export const STATE_MARKERS: Record<VisualEnvironmentState, string> = {
  INITIALIZING: 'INIT',
  RUNNING: 'RUN',
  WARM_IDLE: 'WARM',
  PROVISIONED_IDLE: 'PC',
  RETIRING: 'OUT',
}

export const STATE_LABELS: Record<VisualEnvironmentState, string> = {
  INITIALIZING: 'Initialising',
  RUNNING: 'Running',
  WARM_IDLE: 'Warm idle',
  PROVISIONED_IDLE: 'Provisioned idle',
  RETIRING: 'Retiring',
}

export const STATE_SHAPES: Record<VisualEnvironmentState, string> = {
  INITIALIZING: 'segmented ring plus INIT marker',
  RUNNING: 'progress arc plus request marker',
  WARM_IDLE: 'small diamond warm glyph',
  PROVISIONED_IDLE: 'double outline plus PC marker',
  RETIRING: 'dashed outline, faded',
}

export const PROVISIONED_MARKER = 'PC'

export interface Palette {
  ink: string
  muted: string
  line: string
  lineStrong: string
  paper: string
  cobalt: string
  cobaltSoft: string
  teal: string
  tealSoft: string
  amber: string
  amberSoft: string
  graphite: string
  warm: string
}

export const FALLBACK_PALETTE: Palette = {
  ink: '#132238',
  muted: '#657080',
  line: '#d8d3c7',
  lineStrong: '#ada89e',
  paper: '#fbf9f3',
  cobalt: '#185bd9',
  cobaltSoft: '#dce7fc',
  teal: '#087e78',
  tealSoft: '#d6eeea',
  amber: '#b86908',
  amberSoft: '#fae5bd',
  graphite: '#606772',
  warm: '#ece8df',
}

const PALETTE_VARIABLES: Record<keyof Palette, string> = {
  ink: '--ink',
  muted: '--muted',
  line: '--line',
  lineStrong: '--line-strong',
  paper: '--paper-raised',
  cobalt: '--cobalt',
  cobaltSoft: '--cobalt-soft',
  teal: '--teal',
  tealSoft: '--teal-soft',
  amber: '--amber',
  amberSoft: '--amber-soft',
  graphite: '--graphite',
  warm: '--warm',
}

export function readPalette(element: Element | null): Palette {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return FALLBACK_PALETTE
  const computed = window.getComputedStyle(element)
  const palette = { ...FALLBACK_PALETTE }
  for (const key of Object.keys(PALETTE_VARIABLES) as Array<keyof Palette>) {
    const value = computed.getPropertyValue(PALETTE_VARIABLES[key]).trim()
    if (value) palette[key] = value
  }
  return palette
}

export function stateSurface(state: VisualEnvironmentState, palette: Palette): string {
  switch (state) {
    case 'INITIALIZING': return palette.amberSoft
    case 'RUNNING': return palette.cobaltSoft
    case 'PROVISIONED_IDLE': return palette.tealSoft
    case 'RETIRING': return palette.paper
    default: return palette.warm
  }
}

export function stateAccent(state: VisualEnvironmentState, palette: Palette): string {
  switch (state) {
    case 'INITIALIZING': return palette.amber
    case 'RUNNING': return palette.cobalt
    case 'PROVISIONED_IDLE': return palette.teal
    case 'RETIRING': return palette.graphite
    default: return palette.lineStrong
  }
}

export function environmentTypeLabel(environment: VisualEnvironment): string {
  return environment.type === 'PROVISIONED' ? 'provisioned' : 'on-demand'
}

export function environmentAriaLabel(environment: VisualEnvironment, ordinal: number): string {
  const state = STATE_LABELS[environment.state].toLowerCase()
  const shape = STATE_SHAPES[environment.state]
  const provisioned = environment.type === 'PROVISIONED' ? ', keeps its PC marker' : ''
  return `Environment ${ordinal}, ${environment.id}, ${environmentTypeLabel(environment)}, ${state}, shown as ${shape}${provisioned}`
}

export function countByState(environments: VisualEnvironment[]): Record<VisualEnvironmentState, number> {
  const counts: Record<VisualEnvironmentState, number> = {
    INITIALIZING: 0,
    RUNNING: 0,
    WARM_IDLE: 0,
    PROVISIONED_IDLE: 0,
    RETIRING: 0,
  }
  for (const environment of environments) counts[environment.state] += 1
  return counts
}

export function fieldSummary(environments: VisualEnvironment[]): string {
  const counts = countByState(environments)
  const parts = STATE_ORDER.filter((state) => counts[state] > 0).map((state) => `${counts[state]} ${STATE_LABELS[state].toLowerCase()}`)
  if (!parts.length) return 'No execution environments.'
  return `${environments.length} execution environments: ${parts.join(', ')}.`
}

export function markerFor(environment: VisualEnvironment): string {
  return environment.type === 'PROVISIONED' ? PROVISIONED_MARKER : STATE_MARKERS[environment.state]
}

export function initTurn(environment: VisualEnvironment, segments: number, totalSegments: number): number {
  if (environment.initProgress === undefined) return 1
  return segments / Math.max(1, totalSegments)
}
