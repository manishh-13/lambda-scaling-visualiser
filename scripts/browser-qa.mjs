import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Uses a fresh browser profile and closes it in finally. Never connects to user tabs.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const axePath = require.resolve('axe-core/axe.min.js')
const base = process.env.QA_URL ?? 'http://127.0.0.1:4322/lambda-scaling-visualiser/'
const executablePath = process.env.CHROME_PATH ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome')
await access(executablePath)
const tempRoot = join(homedir(), '.aki', 'tmp')
await mkdir(tempRoot, { recursive: true })
const profile = await mkdtemp(join(tempRoot, 'lambda-simple-browser-'))
const errors = []
const externalRequests = new Set()
const results = {}
let browser

const read = (page, testid) => page.$eval(`[data-testid="${testid}"]`, node => node.textContent)
const numeric = value => Number(value.replaceAll(',', ''))
async function setNumber(page, id, value) {
  await page.$eval(`#${id}`, (input, text) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, String(value))
}
async function selectNumber(page, id) {
  // Native selection avoids platform-dependent triple-click and select-all shortcuts.
  // Backspace, typing, Enter and Tab still use actual browser keyboard events.
  await page.$eval(`#${id}`, input => { input.focus(); input.select() })
}
async function durationPreset(page, label, expected) {
  await page.click(`button[aria-label="Set handler duration to ${label}"]`)
  await page.waitForFunction((text, value) => document.querySelector('#duration-number').value === value && [...document.querySelectorAll('.duration-presets button')].some(node => node.textContent === text && node.getAttribute('aria-pressed') === 'true'), { polling: 'mutation', timeout: 3_000 }, label, String(expected))
}
async function settled(page, testid, expected) {
  await page.waitForFunction((id, value) => document.querySelector(`[data-testid="${id}"]`)?.textContent === value,
    { polling: 'mutation', timeout: 12_000 }, testid, expected)
}
async function goto(page, search = '') {
  await page.goto(base + search, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#send-one')
}
async function noOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert.ok(dimensions.root <= dimensions.viewport && dimensions.body <= dimensions.viewport, `${label} overflow: ${JSON.stringify(dimensions)}`)
  results[label] = dimensions
}
async function axe(page, label) {
  await page.addScriptTag({ path: axePath })
  const violations = await page.evaluate(async () => {
    const report = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })
    return report.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, reason: node.failureSummary })) }))
  })
  results[label] = violations
  assert.deepEqual(violations, [], `${label} accessibility violations: ${JSON.stringify(violations)}`)
}
async function pixel(page, slot, dx = 0.2, dy = 0.2) {
  return page.$eval('canvas', (canvas, [index, fx, fy]) => {
    const width = canvas.getBoundingClientRect().width
    const columns = Number(canvas.dataset.columns)
    const gap = Number(canvas.dataset.gap)
    const cell = Number(canvas.dataset.cell)
    const ratio = canvas.width / width
    const x = (3 + index % columns * (cell + gap) + cell * fx) * ratio
    const y = (3 + Math.floor(index / columns) * (cell + gap) + cell * fy) * ratio
    return [...canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data]
  }, [slot, dx, dy])
}

try {
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ['--disable-extensions', '--disable-background-networking', '--no-first-run', '--renderer-process-limit=2'] })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => {
    const url = request.url()
    if (/^https?:/.test(url) && new URL(url).origin !== new URL(base).origin) externalRequests.add(url)
  })
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 })
  await goto(page)
  assert.equal(await page.$eval('canvas', node => node.dataset.slotCount), '1000')
  assert.equal(await page.$eval('.extra-options', node => node.open), false)
  assert.equal(await read(page, 'unreserved-pool'), '1,000')
  assert.equal(await read(page, 'running-now'), '0')
  await noOverflow(page, 'desktop')
  await axe(page, 'desktopAxe')
  assert.equal(await page.$eval('h1', node => node.textContent), 'Shared capacity.See Lambda scale.')
  assert.match(await page.$eval('.lede', node => node.textContent), /Functions in the same account and Region share/)
  assert.match(await page.$eval('.lede', node => node.textContent), /^A simple visual representation of how AWS Lambda scales\./)
  assert.equal(await page.$eval('canvas', node => node.dataset.layout), 'grouped')
  const bottomType = await page.evaluate(() => Object.fromEntries(['.scaling-summary > p:not(.scaling-number)', '.plot-label', '.plot-axis', '.formula-note', '.app-footer', '.model-label', '.map-caption'].map(selector => [selector, parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)])))
  for (const [selector, size] of Object.entries(bottomType)) assert.ok(size >= 14, `${selector} is only ${size}px`)
  for (const selector of ['.map-caption', '.app-footer', '.formula-note', '.scaling-summary > p:not(.scaling-number)']) assert.ok(bottomType[selector] >= 16, `${selector} body copy is only ${bottomType[selector]}px`)
  results.bottomType = bottomType
  const layout = await page.evaluate(() => {
    const region = document.querySelector('.region-panel').getBoundingClientRect()
    const scaling = document.querySelector('.scaling-panel').getBoundingClientRect()
    const options = document.querySelector('.extra-options').getBoundingClientRect()
    return { sideBySide: scaling.left >= region.right, alignedTops: Math.abs(region.top - scaling.top) < 2, optionsAbove: options.bottom < region.top, optionsVisible: options.top >= 0 && options.bottom < innerHeight }
  })
  assert.deepEqual(layout, { sideBySide: true, alignedTops: true, optionsAbove: true, optionsVisible: true })
  results.layout = layout
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.evaluate(() => document.querySelector('.simulation-stage').scrollIntoView({ block: 'start' }))
  const simultaneous = await page.evaluate(() => {
    const canvas = document.querySelector('canvas').getBoundingClientRect()
    const chart = document.querySelector('.scaling-panel').getBoundingClientRect()
    return { gridVisible: canvas.top >= 0 && canvas.bottom <= innerHeight, chartVisible: chart.top >= 0 && chart.bottom <= innerHeight }
  })
  assert.deepEqual(simultaneous, { gridVisible: true, chartVisible: true })
  results.simultaneous = simultaneous
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 })
  await durationPreset(page, '15 min', 900000)
  assert.equal(await page.$eval('#duration-number', node => node.value), '900000')
  assert.equal(await page.$eval('#duration-range', node => node.getAttribute('aria-valuetext')), '15 min')
  await durationPreset(page, '30 s', 30000)
  assert.equal(await page.$eval('#duration-number', node => node.value), '30000')
  await page.focus('#duration-range')
  await page.keyboard.press('End')
  await page.waitForFunction(() => document.querySelector('#duration-number').value === '900000', { polling: 'mutation', timeout: 3_000 })
  assert.equal(await page.$eval('#duration-number', node => node.value), '900000')
  const durationLink = page.url()
  await page.reload({ waitUntil: 'networkidle0' })
  assert.equal(await page.$eval('#duration-number', node => node.value), '900000')
  assert.ok(durationLink.includes('dur=900000'))
  results.fullDuration = { milliseconds: 900000, quickPreset: true, sliderKeyboardEnd: true, sharedUrlRestored: true }
  await durationPreset(page, '1 s', 1000)

  await page.click('#send-one')
  await settled(page, 'running-now', '1')
  await settled(page, 'completed', '1')
  assert.equal(await read(page, 'running-now'), '0')
  assert.equal(await page.$eval('#traffic-toggle', node => node.textContent), 'Start traffic')
  results.manual = 'one request completed, stream still stopped'

  await page.click('button[aria-label="Reset simulation"]')
  await page.click('#traffic-toggle')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="simulation"]').dataset.timeMs) >= 6_000, { polling: 'mutation', timeout: 12_000 })
  assert.equal(await read(page, 'running-now'), '400')
  assert.equal(await read(page, 'rejected'), '0')
  assert.equal(await read(page, 'scaling-units'), '1,000')
  results.steadyState = { running: 400, rejected: 0, scalingUnits: 1000 }
  const groupedLayout = await page.$eval('canvas', canvas => {
    const width = canvas.getBoundingClientRect().width
    const columns = Number(canvas.dataset.columns), gap = Number(canvas.dataset.gap)
    const cell = Number(canvas.dataset.cell)
    const ratio = canvas.width / width
    const context = canvas.getContext('2d')
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const active = []
    for (let index = 0; index < 1000; index += 1) {
      const x = Math.floor((3 + index % columns * (cell + gap) + cell * 0.2) * ratio)
      const y = Math.floor((3 + Math.floor(index / columns) * (cell + gap) + cell * 0.2) * ratio)
      const offset = (y * canvas.width + x) * 4
      if (pixels[offset] === 8 && pixels[offset + 1] === 105 && pixels[offset + 2] === 215) active.push(index)
    }
    return { count: active.length, first: active[0], last: active.at(-1), contiguous: active.every((value, index) => value === index) }
  })
  assert.deepEqual(groupedLayout, { count: 400, first: 0, last: 399, contiguous: true })
  results.groupedLayout = groupedLayout
  await page.screenshot({ path: join(root, 'docs', 'lambda-scaling-visualiser.png'), fullPage: true })

  await setNumber(page, 'rps-number', 600)
  await settled(page, 'running-now', '600')
  assert.ok(numeric(await read(page, 'completed')) > 1_000, 'Rate changes must not reset completion counters')
  await page.click('#traffic-toggle')
  await settled(page, 'running-now', '0')
  results.liveRate = '600/s applied without a reset; Stop drained requests'

  await page.click('#reserved-switch')
  await settled(page, 'unreserved-pool', '600')
  const reservedPixel = await pixel(page, 10)
  const outsidePixel = await pixel(page, 800)
  assert.notDeepEqual(reservedPixel, outsidePixel)
  assert.ok(reservedPixel[2] > reservedPixel[1], `Reserved must be visibly violet: ${reservedPixel}`)
  await page.click('#provisioned-switch')
  assert.match(await page.$eval('.pool-labels', node => node.textContent), /400 reserved, including 200 provisioned/)
  assert.equal(await read(page, 'unreserved-pool'), '600')
  await page.waitForFunction(() => document.querySelector('.allocation-note')?.textContent.includes('ready instantly'), { polling: 'mutation' })
  const pcPixel = await pixel(page, 10)
  assert.ok(pcPixel[1] > pcPixel[0], `Provisioned must be teal: ${pcPixel}`)
  results.allocation = { reservedPixel, outsidePixel, pcPixel, unreservedPool: 600 }
  await page.screenshot({ path: join(root, 'docs', 'reserved-and-provisioned.png'), fullPage: true })
  await page.click('#send-one')
  await settled(page, 'running-now', '1')
  assert.equal(await read(page, 'scaling-units'), '1,000')
  await settled(page, 'completed', '1')

  await goto(page, '?v=2&rps=0&dur=200&initOn=1&init=400&idleOn=1&idle=3000')
  await page.click('#send-one')
  await settled(page, 'in-flight', '1')
  assert.equal(await read(page, 'running-now'), '0', 'Init consumes concurrency before handler start')
  await settled(page, 'completed', '1')
  const warmPixel = await pixel(page, 0)
  const freePixel = await pixel(page, 800)
  assert.notDeepEqual(warmPixel, freePixel)
  assert.ok(warmPixel[0] > warmPixel[1] && warmPixel[1] > warmPixel[2], `Warm must be ochre: ${warmPixel}`)
  assert.match(await page.$eval('.lifecycle-live', node => node.textContent), /1 warm/)
  await page.screenshot({ path: join(root, 'docs', 'warm-lifecycle.png'), fullPage: true })
  await page.waitForFunction(() => document.querySelector('.lifecycle-live')?.textContent.startsWith('0 warm'), { polling: 'mutation', timeout: 6_000 })
  results.lifecycle = { warmPixel, freePixel, initConsumesConcurrency: true, warmRetires: true }

  await goto(page, '?v=2&rps=0&dur=4000')
  await page.click('.extra-options > summary')
  await page.click('#send-one')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="simulation"]').dataset.timeMs) >= 500, { polling: 'mutation', timeout: 5_000 })
  await page.$eval('canvas', canvas => {
    const rect = canvas.getBoundingClientRect()
    const offset = 3 + Number(canvas.dataset.cell) / 2
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + offset, clientY: rect.top + offset }))
  })
  assert.equal(await page.$eval('.slot-inspector', node => node.open), true)
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="invocation-progress"]').dataset.remainingMs) <= 3000, { polling: 'mutation', timeout: 5_000 })
  await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Pause').click())
  await page.waitForFunction(() => document.querySelector('.live-pill')?.textContent === 'Paused', { polling: 'mutation' })
  const countdown = await page.evaluate(() => ({
    time: Number(document.querySelector('[data-testid="simulation"]').dataset.timeMs),
    remaining: Number(document.querySelector('[data-testid="invocation-progress"]').dataset.remainingMs),
    aria: document.querySelector('[data-testid="invocation-progress"]').getAttribute('aria-valuenow'),
    stroke: document.querySelector('.progress-value').getAttribute('stroke-dasharray'),
    mode: document.querySelector('canvas').dataset.progressMode,
    image: document.querySelector('canvas').toDataURL(),
  }))
  assert.ok(countdown.remaining > 0 && countdown.remaining <= 3000)
  assert.equal(countdown.remaining, 4000 - countdown.time)
  assert.equal(Number(countdown.aria), countdown.remaining)
  assert.equal(parseFloat(countdown.stroke), countdown.remaining / 4000 * 100)
  assert.equal(countdown.mode, 'ring')
  await page.evaluate(() => new Promise(resolve => { let frames = 0; const next = () => { if (++frames === 8) resolve(); else requestAnimationFrame(next) }; requestAnimationFrame(next) }))
  assert.equal(await page.$eval('[data-testid="invocation-progress"]', node => Number(node.dataset.remainingMs)), countdown.remaining)
  assert.equal(await page.$eval('canvas', node => node.toDataURL()), countdown.image, 'Paused rings must not animate on a separate wall clock')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Step 50 ms').click())
  await page.waitForFunction(before => Number(document.querySelector('[data-testid="invocation-progress"]').dataset.remainingMs) === before - 50, { polling: 'mutation' }, countdown.remaining)
  assert.notEqual(await page.$eval('canvas', node => node.toDataURL()), countdown.image, 'A step must redraw the actual ring')
  await axe(page, 'countdownAxe')
  await page.click('.extra-options > summary')
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
  await page.screenshot({ path: join(root, 'docs', 'invocation-countdown.png'), fullPage: true })
  await page.evaluate(() => { document.querySelector('.extra-options').open = true; [...document.querySelectorAll('button')].find(node => node.textContent === 'Resume').click() })
  await settled(page, 'completed', '1')
  assert.equal(await page.$('[data-testid="invocation-progress"]'), null)
  results.countdown = { actualEngineTime: true, pauses: true, stepMs: 50, pairedWithCanvas: true, clearsOnCompletion: true }

  await goto(page, '?v=2&rps=321.5&dur=250&quota=2000&res=1&resv=500&prov=1&provv=200&initOn=1&init=123&idleOn=0&speed=2')
  const restored = await page.evaluate(() => ({ rps: document.querySelector('#rps-number').value, duration: document.querySelector('#duration-number').value, quota: document.querySelector('#quota-number').value, reserved: document.querySelector('#reserved-number').value, provisioned: document.querySelector('#provisioned-number').value, init: document.querySelector('#init-number').value, speed: document.querySelector('#speed').value }))
  assert.deepEqual(restored, { rps: '321.5', duration: '250', quota: '2000', reserved: '500', provisioned: '200', init: '123', speed: '2' })
  results.sharedSettings = restored
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('QA clipboard denied')) } }))
  await page.click('.share-button')
  await page.waitForSelector('#share-url')
  assert.match(await page.$eval('#share-url', node => node.value), /rps=321.5/)
  results.clipboardFallback = true

  await goto(page, '?v=2&rps=30000&dur=20&speed=4')
  await page.click('#traffic-toggle')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="simulation"]').dataset.timeMs) >= 3000, { polling: 'mutation', timeout: 6_000 })
  await page.waitForSelector('.throttle-feedback[data-active="true"]')
  assert.equal(await page.$eval('.deflected-request', node => getComputedStyle(node).animationName), 'reject-return')
  assert.equal(await page.$$eval('.deflected-request', nodes => nodes.length), 1)
  assert.match(await page.$eval('.throttle-feedback', node => node.textContent), /429 rejected20,000\/s/)
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
  await page.screenshot({ path: join(root, 'docs', 'throttle-feedback.png'), fullPage: true })
  await page.click('.extra-options > summary')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Pause').click())
  await page.waitForFunction(() => document.querySelector('.live-pill')?.textContent === 'Paused' && [...document.querySelectorAll('button')].some(node => node.textContent === 'Step 50 ms' && !node.disabled), { polling: 'mutation', timeout: 5_000 })
  assert.equal(await read(page, 'running-now'), '200')
  assert.ok(numeric(await read(page, 'rejected')) > 0)
  assert.match(await page.$eval('.has-rejections', node => node.textContent), /Request-rate ceiling/)
  const beforeStep = await page.$eval('[data-testid="simulation"]', node => Number(node.dataset.timeMs))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Step 50 ms').click())
  await page.waitForFunction(time => Number(document.querySelector('[data-testid="simulation"]').dataset.timeMs) === time + 50, { polling: 'mutation' }, beforeStep)
  assert.equal(await page.$eval('.deflected-request', node => getComputedStyle(node).animationPlayState), 'paused')
  results.throttleAnimation = { sampleCount: 1, animation: 'reject-return', pauseRespected: true }
  results.requestRateCeiling = { running: 200, oneStepMs: 50 }
  await page.click('#traffic-toggle')
  await setNumber(page, 'duration-number', 200)
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="simulation"]').dataset.timeMs) === 0 && document.querySelector('.live-pill')?.textContent === 'Paused', { polling: 'mutation', timeout: 5_000 })
  const resumeEnabled = await page.evaluate(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Resume' && !node.disabled))
  assert.ok(resumeEnabled, 'Resume must remain enabled after editing a stopped, paused run')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Resume').click())
  await page.waitForFunction(() => document.querySelector('.live-pill')?.textContent === 'Ready when you are', { polling: 'mutation', timeout: 5_000 })
  results.pausedEditRecovery = true

  await goto(page)
  await page.click('.extra-options > summary')
  await page.click('#reserved-switch')
  await settled(page, 'unreserved-pool', '600')
  await page.click('#provisioned-switch')
  await page.waitForFunction(() => document.querySelector('#provisioned-switch').getAttribute('aria-checked') === 'true', { polling: 'mutation' })
  assert.equal(await page.$eval('#quota-number', node => node.getAttribute('aria-describedby')), 'quota-entry-note')
  await selectNumber(page, 'quota-number')
  await page.keyboard.press('Backspace')
  assert.equal(await page.$eval('#quota-number', node => node.value), '')
  for (const [key, text] of [['2', '2'], ['5', '25'], ['0', '250'], ['0', '2500']]) {
    await page.keyboard.type(key)
    assert.equal(await page.$eval('#quota-number', node => node.value), text)
    assert.equal(await page.$eval('canvas', node => node.dataset.slotCount), '1000', 'Incomplete quota typing must not restart the simulation')
    assert.equal(await page.$eval('#reserved-number', node => node.value), '400')
    assert.equal(await page.$eval('#provisioned-number', node => node.value), '200')
  }
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('canvas').dataset.slotCount === '2500', { polling: 'mutation' })
  assert.ok(page.url().includes('quota=2500'))
  assert.equal(await page.$eval('#reserved-number', node => node.value), '400')
  assert.equal(await page.$eval('#provisioned-number', node => node.value), '200')
  await selectNumber(page, 'quota-number')
  await page.keyboard.type('1234')
  assert.equal(await page.$eval('#quota-number', node => node.value), '1234')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => document.querySelector('canvas').dataset.slotCount === '1234', { polling: 'mutation' })
  await page.click('button[aria-label="Increase example account concurrency quota"]')
  await page.waitForFunction(() => document.querySelector('#quota-number').value === '1334', { polling: 'mutation' })
  await page.click('button[aria-label="Decrease example account concurrency quota"]')
  await page.waitForFunction(() => document.querySelector('#quota-number').value === '1234', { polling: 'mutation' })
  await selectNumber(page, 'quota-number')
  await page.keyboard.type('5')
  await page.keyboard.press('Escape')
  assert.equal(await page.$eval('#quota-number', node => node.value), '1234')
  await page.keyboard.press('Tab')
  await selectNumber(page, 'quota-number')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Tab')
  assert.equal(await page.$eval('#quota-number', node => node.value), '1234')
  await page.reload({ waitUntil: 'networkidle0' })
  assert.equal(await page.$eval('#quota-number', node => node.value), '1234')
  assert.equal(await page.$eval('canvas', node => node.dataset.slotCount), '1234')
  results.manualQuotaEntry = { realKeystrokes: true, enterAndTab: true, arbitraryWholeNumber: 1234, incrementsStillWork: true, reservedAndProvisionedPreserved: true, cancelAndEmptyRestore: true, urlRestored: true }

  await goto(page, '?v=2&res=1&resv=0')
  await page.click('#send-one')
  await page.waitForSelector('.throttle-feedback[data-active="true"]')
  assert.equal(await page.$eval('.throttle-feedback', node => node.dataset.mode), 'manual')
  await settled(page, 'rejected', '1')
  await page.waitForFunction(() => document.querySelector('.throttle-feedback').dataset.active === 'false', { polling: 'mutation', timeout: 4_000 })
  results.manualThrottleFeedback = true

  for (const width of [1280, 1024, 390, 320, 768]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1, hasTouch: width === 390 })
    await goto(page)
    await noOverflow(page, `width${width}`)
    const typeSize = await page.evaluate(() => ({ body: parseFloat(getComputedStyle(document.querySelector('.map-caption')).fontSize), metadata: parseFloat(getComputedStyle(document.querySelector('.plot-axis')).fontSize), input: parseFloat(getComputedStyle(document.querySelector('#duration-number')).fontSize) }))
    assert.ok(typeSize.body >= 16 && typeSize.metadata >= 14 && typeSize.input >= 16, `${width}px text was shrunk: ${JSON.stringify(typeSize)}`)
    if (width <= 1000) assert.ok(await page.evaluate(() => document.querySelector('.scaling-panel').getBoundingClientRect().bottom <= document.querySelector('.region-panel').getBoundingClientRect().top), 'Narrow layouts should put scaling immediately above the grid')
    await page.click('.extra-options > summary')
    await noOverflow(page, `width${width}OptionsOpen`)
    if (width === 390) {
      await selectNumber(page, 'quota-number')
      await page.keyboard.type('1500')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('canvas').dataset.slotCount === '1500', { polling: 'mutation' })
      assert.equal(await page.$eval('#quota-number', node => node.value), '1500')
      await selectNumber(page, 'quota-number')
      await page.keyboard.type('1600')
      await page.tap('button[aria-label="Increase example account concurrency quota"]')
      await page.waitForFunction(() => document.querySelector('canvas').dataset.slotCount === '1700', { polling: 'mutation' })
      assert.equal(await page.$eval('#quota-number', node => node.value), '1700')
      await page.tap('button[aria-label="Decrease example account concurrency quota"]')
      await page.waitForFunction(() => document.querySelector('canvas').dataset.slotCount === '1600', { polling: 'mutation' })
      results.mobileQuotaTouchButtons = true
      await selectNumber(page, 'quota-number')
      await page.keyboard.type('1000')
      await page.keyboard.press('Tab')
      await page.waitForFunction(() => document.querySelector('canvas').dataset.slotCount === '1000', { polling: 'mutation' })
      results.mobileQuotaEntry = true
      await axe(page, 'mobileAxe')
      await page.click('.extra-options > summary')
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
      await page.screenshot({ path: join(root, 'docs', 'mobile-simple.png'), fullPage: true })
    }
  }

  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  await goto(page, '?v=2&quota=10000&rps=0&dur=30000&prov=1&provv=2000&res=1&resv=4000')
  await page.click('#send-one')
  await settled(page, 'running-now', '1')
  assert.equal(await page.$eval('canvas', node => node.dataset.progressMode), 'bar')
  assert.ok(await page.$eval('canvas', node => Number(node.dataset.cell)) < 8)
  await noOverflow(page, 'denseGrid')
  results.denseProgress = 'time-left bar instead of an unreadable tiny ring'

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  await goto(page)
  await page.click('#traffic-toggle')
  await settled(page, 'running-now', '400')
  results.reducedMotion = await page.evaluate(() => ({ matches: matchMedia('(prefers-reduced-motion: reduce)').matches, animation: getComputedStyle(document.querySelector('.request-line i')).animationName, display: getComputedStyle(document.querySelector('.request-line i')).display }))
  assert.deepEqual(results.reducedMotion, { matches: true, animation: 'none', display: 'none' })
  await goto(page, '?v=2&rps=3000&dur=1000&speed=4')
  await page.click('#traffic-toggle')
  await page.waitForSelector('.throttle-feedback[data-active="true"]')
  const staticThrottle = await page.$eval('.deflected-request', node => ({ animation: getComputedStyle(node).animationName, opacity: getComputedStyle(node).opacity, text: node.textContent }))
  assert.deepEqual(staticThrottle, { animation: 'none', opacity: '1', text: '429' })
  results.reducedMotionThrottle = staticThrottle
  assert.deepEqual(errors, [], `Browser errors: ${JSON.stringify(errors)}`)
  assert.deepEqual([...externalRequests], [], 'The app must not call external services or fonts')
  results.browserErrors = errors
  results.externalRequests = [...externalRequests]
  console.log(JSON.stringify({ status: 'PASS', ...results }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message, stack: error.stack, browserErrors: errors, ...results }, null, 2))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  await rm(profile, { recursive: true, force: true })
}
