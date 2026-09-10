import { useLayoutEffect, useState } from 'react'
import { Minus, Plus } from 'lucide-react'

interface NumberControlProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  suffix?: string
  commitOnBlur?: boolean
  integer?: boolean
  describedBy?: string
  onChange: (value: number) => void
}

/** Quota drafts apply on Enter/blur; other controls keep their immediate behavior. */
export function NumberControl({ id, label, value, min, max, step = 1, disabled = false, suffix, commitOnBlur = false, integer = false, describedBy, onChange }: NumberControlProps) {
  const [text, setText] = useState(String(value))
  useLayoutEffect(() => { setText(String(value)) }, [value])
  const normalize = (next: number) => Math.max(min, Math.min(max, integer ? Math.round(next) : next))
  const draft = text.trim() === '' ? value : Number(text)
  const buttonValue = commitOnBlur && Number.isFinite(draft) ? normalize(draft) : value
  const apply = (next: number) => {
    const normalized = normalize(next)
    setText(String(normalized))
    if (normalized !== value) onChange(normalized)
  }
  const changeText = (raw: string) => {
    setText(raw)
    // A prefix such as "2" is not a finished quota of 2500. Do not clamp it or
    // restart the simulation (and shrink reservations) before the user finishes.
    if (commitOnBlur || raw.trim() === '') return
    const next = Number(raw)
    if (Number.isFinite(next)) {
      const clamped = normalize(next)
      if (clamped !== next) setText(String(clamped))
      onChange(clamped)
    }
  }
  const finish = () => {
    if (commitOnBlur) apply(Number.isFinite(draft) ? draft : value)
    else setText(String(value))
  }
  return <div className="number-control" data-disabled={disabled}>
    <button type="button" aria-label={`Decrease ${label.toLowerCase()}`} disabled={disabled || buttonValue <= min} onPointerDown={event => { if (commitOnBlur) event.preventDefault() }} onClick={() => apply(buttonValue - step)}><Minus size={13} aria-hidden="true" /></button>
    <input id={id} aria-label={label} aria-describedby={describedBy} type="number" inputMode={integer ? 'numeric' : 'decimal'} min={min} max={max} step="any" disabled={disabled} value={text} onChange={event => changeText(event.target.value)} onBlur={finish} onKeyDown={event => {
      if (!commitOnBlur) return
      if (event.key === 'Enter') { event.preventDefault(); finish() }
      else if (event.key === 'Escape') { event.preventDefault(); setText(String(value)) }
    }} />
    {suffix && <span className="input-suffix" aria-hidden="true">{suffix}</span>}
    <button type="button" aria-label={`Increase ${label.toLowerCase()}`} disabled={disabled || buttonValue >= max} onPointerDown={event => { if (commitOnBlur) event.preventDefault() }} onClick={() => apply(buttonValue + step)}><Plus size={13} aria-hidden="true" /></button>
  </div>
}

export function Switch({ id, label, checked, onChange, tone = 'blue' }: { id: string; label: string; checked: boolean; onChange: (next: boolean) => void; tone?: string }) {
  return <button type="button" id={id} className={`switch switch-${tone}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
}

export function RangeControl({ id, label, value, min, max, step, onChange, valueText }: { id: string; label: string; value: number; min: number; max: number; step: number; onChange: (next: number) => void; valueText?: string }) {
  return <input type="range" id={id} aria-label={label} aria-valuetext={valueText} min={min} max={Math.max(max, value)} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
}
