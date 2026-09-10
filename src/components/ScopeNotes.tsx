import { assumptions } from '../content/explainers'

export function ScopeNotes() {
  return (
    <section className="assumption-band" aria-labelledby="assumptions-heading">
      <h2 id="assumptions-heading">A model, with boundaries</h2>
      <ul className="assumption-list">{assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}</ul>
      <p className="method-note">This simulator uses a continuously refilling token bucket to illustrate the documented Lambda scaling rate. AWS documents continuous best-effort refill but does not publish its internal admission algorithm.</p>
      <p className="method-note">Concurrency counts accepted requests from the beginning of Init through the end of Invoke. Warm idle environments are visible but do not consume current concurrency. Provisioned allocation does occupy quota while idle. The formula estimates steady handler demand; cold Init temporarily adds in-flight time.</p>
    </section>
  )
}
