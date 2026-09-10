import { describe, expect, it } from 'vitest'
import { clampIndex, compactSummary, describeEnvironment, historyLines, navigateIndex, ordinalFromInput, selectionAnnouncement } from './inspector'
import { countByState, environmentAriaLabel, fieldSummary, initTurn, markerFor, readPalette, stateAccent, stateSurface, FALLBACK_PALETTE } from './visualLanguage'
import { INIT_RING_SEGMENTS } from './grid'
import type { VisualEnvironment, VisualEnvironmentState } from './types'

function makeEnvironment(overrides: Partial<VisualEnvironment> = {}): VisualEnvironment {
  return {
    id: 'E-001',
    type: 'ON_DEMAND',
    state: 'RUNNING',
    stateSinceMs: 1_000,
    totalInvocations: 3,
    coldStarts: 1,
    progress: 0.5,
    recentHistory: [
      { state: 'INITIALIZING', atMs: 200 },
      { state: 'RUNNING', atMs: 700 },
    ],
    ...overrides,
  }
}

describe('clampIndex', () => {
  it('keeps the index inside the list', () => {
    expect(clampIndex(-5, 10)).toBe(0)
    expect(clampIndex(12, 10)).toBe(9)
    expect(clampIndex(4, 10)).toBe(4)
  })

  it('reports no selection for an empty list', () => {
    expect(clampIndex(0, 0)).toBe(-1)
  })
})

describe('navigateIndex', () => {
  it('moves one environment with arrows and the next or previous keys', () => {
    expect(navigateIndex('ArrowRight', 3, 10)).toBe(4)
    expect(navigateIndex('n', 3, 10)).toBe(4)
    expect(navigateIndex('ArrowLeft', 3, 10)).toBe(2)
    expect(navigateIndex('p', 3, 10)).toBe(2)
  })

  it('moves by a row when columns are known', () => {
    expect(navigateIndex('ArrowDown', 2, 100, { columns: 20 })).toBe(22)
    expect(navigateIndex('ArrowUp', 25, 100, { columns: 20 })).toBe(5)
  })

  it('moves by a page block and jumps to the ends', () => {
    expect(navigateIndex('PageDown', 0, 900, { columns: 20, pageStep: 200 })).toBe(200)
    expect(navigateIndex('PageUp', 450, 900, { columns: 20, pageStep: 200 })).toBe(250)
    expect(navigateIndex('Home', 500, 900)).toBe(0)
    expect(navigateIndex('End', 4, 900)).toBe(899)
  })

  it('stays inside bounds instead of wrapping', () => {
    expect(navigateIndex('ArrowLeft', 0, 10)).toBe(0)
    expect(navigateIndex('ArrowRight', 9, 10)).toBe(9)
    expect(navigateIndex('ArrowDown', 95, 100, { columns: 20 })).toBe(99)
  })

  it('ignores unrelated keys and empty lists', () => {
    expect(navigateIndex('Enter', 2, 10)).toBeNull()
    expect(navigateIndex('a', 2, 10)).toBeNull()
    expect(navigateIndex('ArrowRight', 0, 0)).toBeNull()
  })
})

describe('ordinalFromInput', () => {
  it('converts a one based ordinal into a zero based index', () => {
    expect(ordinalFromInput('1', 500)).toBe(0)
    expect(ordinalFromInput('500', 500)).toBe(499)
  })

  it('clamps out of range typing and rejects nonsense', () => {
    expect(ordinalFromInput('9999', 500)).toBe(499)
    expect(ordinalFromInput('0', 500)).toBe(0)
    expect(ordinalFromInput('', 500)).toBeNull()
    expect(ordinalFromInput('abc', 500)).toBeNull()
  })
})

describe('describeEnvironment', () => {
  it('exposes every inspectable field', () => {
    const rows = describeEnvironment(makeEnvironment(), 7, 1_200, 2_500)
    const labels = rows.map((row) => row.label)
    expect(labels).toEqual([
      'Position',
      'Environment ID',
      'Type',
      'State',
      'Shown as',
      'Active request',
      'Time in state',
      'Total invocations',
      'Cold starts',
    ])
    expect(rows[0].value).toBe('7 of 1,200')
    expect(rows[6].value).toBe('1.5 s')
  })

  it('omits time in state when no clock is supplied and reports a missing request', () => {
    const rows = describeEnvironment(makeEnvironment({ activeRequestId: undefined }), 1, 1)
    expect(rows.some((row) => row.label === 'Time in state')).toBe(false)
    expect(rows.find((row) => row.label === 'Active request')?.value).toBe('None')
  })

  it('lists bounded recent history newest first', () => {
    const lines = historyLines(makeEnvironment(), 5)
    expect(lines).toEqual(['running at 700 ms', 'initializing at 200 ms'])
    expect(historyLines(makeEnvironment({ recentHistory: [] }))).toEqual([])
  })

  it('gives a compact one line summary for the details toggle', () => {
    expect(compactSummary(makeEnvironment({ id: 'P-018', type: 'PROVISIONED' }), 18, 400)).toBe('18 of 400 | P-018 | provisioned | running')
  })

  it('announces only the selection identity, so a state change cannot spam the live region', () => {
    const running = makeEnvironment({ id: 'E-042', state: 'RUNNING' })
    const warm = makeEnvironment({ id: 'E-042', state: 'WARM_IDLE', progress: 0 })
    expect(selectionAnnouncement(running, 42, 900)).toBe('Selected environment 42 of 900, E-042, on-demand.')
    expect(selectionAnnouncement(warm, 42, 900)).toBe(selectionAnnouncement(running, 42, 900))
    expect(selectionAnnouncement(running, 43, 900)).not.toBe(selectionAnnouncement(running, 42, 900))
  })
})

describe('shared visual language', () => {
  const states: VisualEnvironmentState[] = ['INITIALIZING', 'RUNNING', 'WARM_IDLE', 'PROVISIONED_IDLE', 'RETIRING']

  it('keeps the provisioned marker while running', () => {
    expect(markerFor(makeEnvironment({ type: 'PROVISIONED', state: 'RUNNING' }))).toBe('PC')
    expect(markerFor(makeEnvironment({ type: 'PROVISIONED', state: 'PROVISIONED_IDLE' }))).toBe('PC')
    expect(markerFor(makeEnvironment({ state: 'INITIALIZING' }))).toBe('INIT')
    expect(markerFor(makeEnvironment({ state: 'WARM_IDLE' }))).toBe('WARM')
  })

  it('describes the state without relying on colour', () => {
    const label = environmentAriaLabel(makeEnvironment({ state: 'INITIALIZING' }), 4)
    expect(label).toContain('Environment 4')
    expect(label).toContain('initialising')
    expect(label).toContain('segmented ring plus INIT marker')
  })

  it('gives a distinct surface and accent for every state', () => {
    const surfaces = new Set(states.map((state) => stateSurface(state, FALLBACK_PALETTE)))
    const accents = new Set(states.map((state) => stateAccent(state, FALLBACK_PALETTE)))
    expect(surfaces.size).toBe(states.length)
    expect(accents.size).toBe(states.length)
  })

  it('counts states and summarises the field', () => {
    const environments = [
      makeEnvironment({ id: 'A', state: 'RUNNING' }),
      makeEnvironment({ id: 'B', state: 'WARM_IDLE' }),
      makeEnvironment({ id: 'C', state: 'WARM_IDLE' }),
    ]
    expect(countByState(environments)).toMatchObject({ RUNNING: 1, WARM_IDLE: 2, INITIALIZING: 0 })
    expect(fieldSummary(environments)).toBe('3 execution environments: 1 running, 2 warm idle.')
    expect(fieldSummary([])).toBe('No execution environments.')
  })

  it('treats a missing init progress as an indeterminate full ring', () => {
    expect(initTurn(makeEnvironment({ state: 'INITIALIZING' }), 2, INIT_RING_SEGMENTS)).toBe(1)
    expect(initTurn(makeEnvironment({ state: 'INITIALIZING', initProgress: 0.5 }), 3, INIT_RING_SEGMENTS)).toBe(0.5)
  })

  it('falls back to the documented palette without a DOM element', () => {
    expect(readPalette(null)).toEqual(FALLBACK_PALETTE)
  })
})
