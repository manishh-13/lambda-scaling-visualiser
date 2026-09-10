import { useCallback, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { INSPECTOR_HEIGHT_PX } from './grid'
import type { VisualEnvironment } from './types'
import { compactSummary, describeEnvironment, historyLines, navigateIndex, ordinalFromInput } from './inspector'

interface Props {
  environments: VisualEnvironment[]
  index: number
  columns: number
  pageStep: number
  nowMs?: number
  idPrefix: string
  announcement: string
  onSelect: (index: number) => void
  note?: string
}

export function EnvironmentInspector({ environments, index, columns, pageStep, nowMs, idPrefix, announcement, onSelect, note }: Props) {
  const [open, setOpen] = useState(false)
  const count = environments.length
  const environment = environments[index]
  const ordinalId = `${idPrefix}-ordinal`
  const detailsId = `${idPrefix}-details`
  const liveId = `${idPrefix}-live`

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const paged = event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'ArrowUp' || event.key === 'ArrowDown'
    const next = navigateIndex(event.key, index, count, paged ? { columns, pageStep } : {})
    if (next === null) return
    event.preventDefault()
    onSelect(next)
  }, [columns, count, index, onSelect, pageStep])

  return (
    <section
      className="lcm-inspector"
      aria-label="Environment inspector"
      style={{ '--lcm-inspector-height': `${INSPECTOR_HEIGHT_PX}px` } as CSSProperties}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
    >
      <div className="lcm-inspector-controls" onKeyDown={handleKeyDown}>
        <label className="lcm-inspector-label" htmlFor={ordinalId}>Environment number</label>
        <input
          className="lcm-inspector-input"
          id={ordinalId}
          type="number"
          min={count ? 1 : 0}
          max={count}
          step={1}
          value={count ? index + 1 : 0}
          disabled={!count}
          aria-describedby={detailsId}
          onChange={(event) => {
            const next = ordinalFromInput(event.target.value, count)
            if (next !== null) onSelect(next)
          }}
        />
        <button type="button" className="lcm-button" onClick={() => onSelect(Math.max(0, index - 1))} disabled={!count || index <= 0}>Previous</button>
        <button type="button" className="lcm-button" onClick={() => onSelect(Math.min(count - 1, index + 1))} disabled={!count || index >= count - 1}>Next</button>
        <span className="lcm-inspector-hint">Arrow keys move one environment, Page keys move one row block, Home and End jump to the ends.</span>
      </div>
      <p className="lcm-visually-hidden" id={liveId} aria-live="polite">{announcement}</p>
      <details className="lcm-inspector-details" id={detailsId} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="lcm-inspector-summary">{environment ? compactSummary(environment, index + 1, count) : 'No environments to inspect'}</summary>
        {environment ? (
          <div className="lcm-inspector-body">
            <dl className="lcm-inspector-grid">
              {describeEnvironment(environment, index + 1, count, nowMs).map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="lcm-inspector-history">
              <span className="lcm-inspector-subtitle">Recent state history</span>
              {historyLines(environment).length ? (
                <ol>{historyLines(environment).map((line, position) => <li key={`${line}-${position}`}>{line}</li>)}</ol>
              ) : (
                <p>No recorded transitions yet.</p>
              )}
            </div>
            {note ? <p className="lcm-inspector-note">{note}</p> : null}
          </div>
        ) : (
          <p className="lcm-inspector-body">Start traffic to create environments.</p>
        )}
      </details>
    </section>
  )
}
