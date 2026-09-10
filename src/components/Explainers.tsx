import { explainers } from '../content/explainers'

export function Explainers() {
  return (
    <>
      <section className="section-block" aria-labelledby="explainers-heading">
        <div className="section-heading-row">
          <div><span className="section-number">03 / REFERENCE NOTES</span><h2 className="section-title" id="explainers-heading">Read the map</h2></div>
          <p className="section-intro">Eight short concepts connect what moves on the stage to the AWS documentation behind the model.</p>
        </div>
        <div className="explainer-grid">
          {explainers.map((explainer, index) => (
            <article className="explainer" key={explainer.title}>
              <span className="explainer-index">{String(index + 1).padStart(2, '0')}</span>
              <h3>{explainer.title}</h3>
              <p>{explainer.copy}</p>
              <a className="source-link" href={explainer.source} target="_blank" rel="noreferrer">Read AWS source <span aria-hidden="true">↗</span></a>
            </article>
          ))}
        </div>
      </section>

    </>
  )
}
