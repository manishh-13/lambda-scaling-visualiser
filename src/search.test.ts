import { describe, expect, it } from 'vitest'
import html from '../index.html?raw'
import sitemapXml from '../public/sitemap.xml?raw'

const canonical = 'https://manishh-13.github.io/lambda-scaling-visualiser/'
const document = new DOMParser().parseFromString(html, 'text/html')

const meta = (key: string) => document.querySelector<HTMLMetaElement>(`meta[property="${key}"]`)?.content

describe('search-facing static page', () => {
  it('describes the interactive tool and declares its live canonical URL', () => {
    expect(document.title).toBe('AWS Lambda Scaling Visualiser | Interactive Concurrency Simulator')
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toMatch(/traffic and duration.*concurrency/)
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(canonical)
    expect(document.querySelector('meta[name="robots"][content*="noindex"]')).toBeNull()
  })

  it('includes useful, visible explanation and real references in the HTML before JavaScript loads', () => {
    const explainer = document.querySelector<HTMLElement>('.search-explainer')
    expect(document.querySelector('#root')?.children).toHaveLength(0)
    expect(explainer?.parentElement).toBe(document.body)
    expect(explainer?.hidden).toBe(false)
    expect(explainer?.getAttribute('aria-hidden')).toBeNull()
    expect(explainer?.classList.contains('sr-only')).toBe(false)
    expect(explainer?.textContent).toMatch(/requests per second multiplied by average duration/)
    expect(explainer?.textContent).toMatch(/reserved concurrency.*provisioned concurrency/)
    expect(explainer?.textContent).toContain('not live account metrics')
    expect([...explainer!.querySelectorAll('a')].map(link => link.href)).toEqual([
      'https://github.com/manishh-13/lambda-scaling-visualiser',
      'https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html',
    ])
    expect(document.querySelector('script[type="module"]')?.getAttribute('src')).toBe('/src/main.tsx')
  })

  it('declares consistent full-size link preview metadata', () => {
    expect(meta('og:title')).toBe(document.title)
    expect(meta('og:url')).toBe(canonical)
    expect(meta('og:image')).toBe(`${canonical}social-preview.png`)
    expect(meta('og:image:width')).toBe('1200')
    expect(meta('og:image:height')).toBe('630')
    expect(meta('og:image:alt')).toMatch(/shared concurrency pool/)
    expect(document.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image')
  })

  it('includes exactly one canonical URL in the sitemap', () => {
    const sitemap = new DOMParser().parseFromString(sitemapXml, 'text/xml')
    expect(sitemap.querySelector('parsererror')).toBeNull()
    expect([...sitemap.getElementsByTagName('loc')].map(loc => loc.textContent)).toEqual([canonical])
  })
})
