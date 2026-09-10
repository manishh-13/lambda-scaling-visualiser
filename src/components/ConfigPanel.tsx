import type { AppConfig, PresetId, TargetId } from '../lib/urlState'
import { LIMITS, maxProvisionedConcurrency, maxReservableConcurrency } from '../lib/urlState'
import { formatDuration, formatNumber, formatRate } from '../lib/format'
import { presets } from '../content/presets'

interface Props {
  config: AppConfig
  dirty: boolean
  idPrefix: string
  onChange: (patch: Partial<AppConfig>) => void
  onApply: () => void
  onPreset: (preset: PresetId) => void
  onCopy: () => void
  copyStatus: string
  shareUrl?: string
}

function Toggle({ id, label, checked, disabled, onChange }: { id: string; label: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="toggle-row">
      <span className="toggle-label" id={`${id}-label`}>{label}</span>
      <button type="button" id={id} className="toggle" role="switch" aria-labelledby={`${id}-label`} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />
    </div>
  )
}

export function ConfigPanel({ config, dirty, idPrefix, onChange, onApply, onPreset, onCopy, copyStatus, shareUrl }: Props) {
  const maxReserved = maxReservableConcurrency(config.accountQuota)
  const maxProvisioned = maxProvisionedConcurrency({
    accountQuota: config.accountQuota,
    reservedEnabled: config.reservedEnabled,
    reservedConcurrency: config.reservedConcurrency,
  })
  return (
    <div>
      <h2 className="rail-heading">Shape the workload</h2>
      <section className="control-section" aria-labelledby={`${idPrefix}-workload-heading`}>
        <h3 className="control-section-title" id={`${idPrefix}-workload-heading`}>Workload</h3>
        <div className="control-stack">
          <div className="field">
            <div className="field-top"><label htmlFor={`${idPrefix}-duration`}>Average handler duration</label><output className="field-output">{formatDuration(config.handlerDurationMs)}</output></div>
            <input id={`${idPrefix}-duration`} type="number" min={LIMITS.handlerDurationMs.min} max={LIMITS.handlerDurationMs.max} step="1" value={config.handlerDurationMs} onChange={(event) => onChange({ handlerDurationMs: Number(event.target.value) })} />
            <p className="field-note">CloudWatch Duration, handler time only. Init is excluded.</p>
          </div>
          <div className="field">
            <div className="field-top"><label htmlFor={`${idPrefix}-rps`}>Incoming requests per second</label><output className="field-output">{formatRate(config.requestsPerSecond)}</output></div>
            <input id={`${idPrefix}-rps`} type="number" min={LIMITS.requestsPerSecond.min} max={LIMITS.requestsPerSecond.max} step="any" value={config.requestsPerSecond} onChange={(event) => onChange({ requestsPerSecond: Number(event.target.value) })} />
          </div>
          <div className="field">
            <div className="field-top"><label htmlFor={`${idPrefix}-quota`}>Example default account concurrency quota</label><output className="field-output">{formatNumber(config.accountQuota)}</output></div>
            <input id={`${idPrefix}-quota`} type="number" min={LIMITS.accountQuota.min} max={LIMITS.accountQuota.max} step="1" value={config.accountQuota} onChange={(event) => onChange({ accountQuota: Number(event.target.value) })} />
            <p className="field-note">1,000 is an adjustable example. Starting quotas can differ between accounts. The simulator accepts up to 10,000 for browser performance, not as an AWS limit.</p>
          </div>
        </div>
      </section>

      <section className="control-section" aria-labelledby={`${idPrefix}-lifecycle-heading`}>
        <h3 className="control-section-title" id={`${idPrefix}-lifecycle-heading`}>Environment lifecycle</h3>
        <div className="control-stack">
          <div className="field">
            <div className="field-top"><label htmlFor={`${idPrefix}-init`}>Illustrative Init duration</label><output className="field-output">{formatDuration(config.initDurationMs)}</output></div>
            <input id={`${idPrefix}-init`} type="range" min={LIMITS.initDurationMs.min} max={LIMITS.initDurationMs.max} step="1" value={config.initDurationMs} aria-valuetext={formatDuration(config.initDurationMs)} onChange={(event) => onChange({ initDurationMs: Number(event.target.value) })} />
            <input aria-label="Illustrative Init duration in milliseconds" type="number" min="0" max={LIMITS.initDurationMs.max} value={config.initDurationMs} onChange={event => onChange({ initDurationMs: Number(event.target.value) })} />
            <p className="field-note">Real initialization time varies by runtime, configuration, and code.</p>
          </div>
          <div className="field">
            <div className="field-top"><label htmlFor={`${idPrefix}-idle`}>Illustrative idle timeout</label><output className="field-output">{formatDuration(config.idleTimeoutMs)}</output></div>
            <input id={`${idPrefix}-idle`} type="range" min={LIMITS.idleTimeoutMs.min} max={LIMITS.idleTimeoutMs.max} step="1" value={config.idleTimeoutMs} aria-valuetext={formatDuration(config.idleTimeoutMs)} onChange={(event) => onChange({ idleTimeoutMs: Number(event.target.value) })} />
            <input aria-label="Illustrative idle timeout in milliseconds" type="number" min="1000" max={LIMITS.idleTimeoutMs.max} value={config.idleTimeoutMs} onChange={event => onChange({ idleTimeoutMs: Number(event.target.value) })} />
            <p className="field-note">AWS does not document or guarantee how long an execution environment stays warm.</p>
          </div>
        </div>
      </section>

      <section className="control-section" aria-labelledby={`${idPrefix}-allocation-heading`}>
        <h3 className="control-section-title" id={`${idPrefix}-allocation-heading`}>Concurrency allocation</h3>
        <div className="control-stack">
          <Toggle id={`${idPrefix}-reserved-enabled`} label="Reserved concurrency" checked={config.reservedEnabled} onChange={(reservedEnabled) => onChange({ reservedEnabled, reservedConcurrency: reservedEnabled && config.reservedConcurrency === 0 ? Math.min(400, maxReserved) : config.reservedConcurrency })} />
          {config.reservedEnabled && <div className="field"><div className="field-top"><label htmlFor={`${idPrefix}-reserved-value`}>Reserved value</label><output className="field-output">max {formatNumber(maxReserved)}</output></div><input id={`${idPrefix}-reserved-value`} type="number" min="0" max={maxReserved} value={config.reservedConcurrency} onChange={(event) => onChange({ reservedConcurrency: Number(event.target.value) })} /><p className="field-note">Acts as both a guaranteed floor and this function's ceiling. This one-function model primarily reveals the ceiling; the floor protects capacity when other functions share the account. No borrowing above the ceiling, and no environments are pre-initialized.</p></div>}
          <div className="field">
            <label htmlFor={`${idPrefix}-target`}>Function target</label>
            <select id={`${idPrefix}-target`} value={config.target} onChange={(event) => onChange({ target: event.target.value as TargetId, provisionedEnabled: event.target.value === 'latest' ? false : config.provisionedEnabled })}>
              <option value="version-or-alias">Published version or alias</option>
              <option value="latest">$LATEST</option>
            </select>
          </div>
          <Toggle id={`${idPrefix}-provisioned-enabled`} label="Provisioned concurrency" checked={config.provisionedEnabled} disabled={config.target === 'latest'} onChange={(provisionedEnabled) => onChange({ provisionedEnabled, provisionedConcurrency: provisionedEnabled && config.provisionedConcurrency === 0 ? Math.min(400, maxProvisioned) : config.provisionedConcurrency })} />
          {config.target === 'latest' && <div className="limit-callout">Provisioned concurrency cannot be configured on $LATEST.</div>}
          {config.provisionedEnabled && config.target !== 'latest' && <div className="field"><div className="field-top"><label htmlFor={`${idPrefix}-provisioned-value`}>Provisioned value</label><output className="field-output">max {formatNumber(maxProvisioned)}</output></div><input id={`${idPrefix}-provisioned-value`} type="number" min="0" max={maxProvisioned} value={config.provisionedConcurrency} onChange={(event) => onChange({ provisionedConcurrency: Number(event.target.value) })} /><p className="field-note">Allocated capacity counts against the account quota and is billed while idle.</p></div>}
        </div>
      </section>

      <section className="control-section" aria-labelledby={`${idPrefix}-presets-heading`}>
        <h3 className="control-section-title" id={`${idPrefix}-presets-heading`}>Guided presets</h3>
        <div className="preset-list">
          {presets.map((preset) => <button type="button" className={`preset-button ${config.preset === preset.id ? 'active' : ''}`} key={preset.id} onClick={() => onPreset(preset.id)}>{preset.name}</button>)}
        </div>
        {config.preset !== 'custom' && <p className="lesson">{presets.find((preset) => preset.id === config.preset)?.lesson}</p>}
      </section>

      <section className="control-section" aria-labelledby={`${idPrefix}-share-heading`}>
        <h3 className="control-section-title" id={`${idPrefix}-share-heading`}>Reproduce it</h3>
        <div className="control-stack">
          <div className="field"><label htmlFor={`${idPrefix}-traffic-profile`}>Traffic profile</label><select id={`${idPrefix}-traffic-profile`} value={config.trafficProfile} onChange={event => onChange({ trafficProfile: event.target.value as AppConfig['trafficProfile'] })}><option value="constant">Constant traffic on Start</option><option value="spike">Sudden step from zero on Start</option></select></div>
          <Toggle id={`${idPrefix}-comparison`} label="Side-by-side comparison" checked={config.comparisonMode} onChange={comparisonMode => onChange({ comparisonMode })} />
          {config.comparisonMode && <p className="field-note">The left side has no provisioned capacity; the right uses your selected allocation. Enable provisioned concurrency to compare cold and prepared starts.</p>}
          <div className="field"><label htmlFor={`${idPrefix}-seed`}>Deterministic seed</label><input className="seed-input" id={`${idPrefix}-seed`} type="number" min="0" max="4294967295" step="1" value={config.seed} onChange={(event) => onChange({ seed: Number(event.target.value) })} /></div>
          <button type="button" className="secondary-button" onClick={onCopy}>Copy share link</button>
          {copyStatus && <p className="field-note" role="status">{copyStatus}</p>}
          {shareUrl && <div className="field"><label htmlFor={`${idPrefix}-share-url`}>Share link (select and copy)</label><input id={`${idPrefix}-share-url`} type="text" readOnly value={shareUrl} onFocus={event => event.target.select()} /></div>}
          <div className="apply-row"><button type="button" className="primary-button" disabled={!dirty} onClick={onApply}>Apply and reset</button><span aria-live="polite" className="sr-only">{dirty ? 'Configuration changes are ready to apply.' : 'Configuration is applied.'}</span></div>
          {dirty && <p className="dirty-note">Changes are staged. Apply and reset to keep the active simulation deterministic.</p>}
        </div>
      </section>
    </div>
  )
}
