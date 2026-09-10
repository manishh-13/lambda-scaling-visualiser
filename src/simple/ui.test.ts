import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { DEFAULT_SIMPLE_CONFIG } from './config'
import { initialSnapshot } from './useSimulation'
import { SLOT, type SimpleCommand, type SimpleResponse } from './types'

class TestWorker {
  static instances: TestWorker[] = []
  onmessage: ((event: { data: SimpleResponse }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: SimpleCommand[] = []
  terminated = false
  constructor() { TestWorker.instances.push(this) }
  postMessage(command: SimpleCommand) { this.messages.push(command) }
  terminate() { this.terminated = true }
  emit(message: SimpleResponse) { this.onmessage?.({ data: message }) }
}

let root: Root
let container: HTMLDivElement
const worker = () => TestWorker.instances.at(-1)!
const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!
const input = (selector: string) => container.querySelector<HTMLInputElement>(selector)!
const click = (selector: string) => act(() => button(selector).click())
const emit = (message: SimpleResponse) => act(() => worker().emit(message))
const change = (selector: string, value: string) => act(() => {
  const node = input(selector)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Worker', TestWorker)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => undefined }) as CanvasRenderingContext2D)
  window.history.replaceState(null, '', '/lambda-scaling-visualiser/')
  TestWorker.instances = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mount(strict = false) {
  act(() => root.render(strict ? createElement(StrictMode, {}, createElement(App)) : createElement(App)))
}

describe('the real simple screen', () => {
  it('loads with 1000 free slots, optional lifecycle closed, and no apply/save controls', () => {
    mount()
    expect(container.querySelector('h1')?.textContent).toBe('Shared capacity.See Lambda scale.')
    expect(container.querySelector('canvas')?.dataset.slotCount).toBe('1000')
    expect(container.querySelector<HTMLDetailsElement>('.extra-options')?.open).toBe(false)
    expect(container.querySelector('[data-testid="unreserved-pool"]')?.textContent).toBe('1,000')
    expect([...container.querySelectorAll('button')].some(node => /save|apply/i.test(node.textContent ?? ''))).toBe(false)
    expect(input('#reserved-number').disabled).toBe(true)
    expect(input('#provisioned-number').disabled).toBe(true)
    expect(worker().messages).toEqual([{ type: 'INIT', config: DEFAULT_SIMPLE_CONFIG, revision: 0 }])
  })

  it('describes a shared account pool and a grouped demonstration of one function', () => {
    mount()
    expect(container.querySelector('.lede')?.textContent).toMatch(/^A simple visual representation of how AWS Lambda scales\./)
    expect(container.querySelector('.lede')?.textContent).toContain('Functions in the same account and Region share a concurrency quota')
    expect(container.querySelector('#region-heading')?.textContent).toBe('The shared account pool')
    expect(container.querySelector('.map-caption')?.textContent).toContain('grouped by state within each allocation')
    expect(container.querySelector('canvas')?.dataset.layout).toBe('grouped')
  })

  it('puts discoverable lifecycle controls above a shared capacity and scaling stage', () => {
    mount()
    const options = container.querySelector('.extra-options')!
    const stage = container.querySelector('.simulation-stage')!
    expect(options.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(options.querySelector('summary')?.textContent).toContain('Init, warm retention, account quota & speed')
    expect(stage.querySelector('.capacity-column .region-panel')).not.toBeNull()
    expect(stage.querySelector('.scaling-column .scaling-panel')).not.toBeNull()
    expect(container.querySelectorAll('.scaling-panel')).toHaveLength(1)
    expect(options.querySelector('.disclosure-hint')?.textContent).toBe('Optional, off by default')
    click('#init-switch')
    expect(options.querySelector('.disclosure-hint')?.textContent).toBe('Lifecycle enabled')
  })

  it('keeps each real countdown paired with its request when the grid compacts', () => {
    mount()
    const snapshot = initialSnapshot(DEFAULT_SIMPLE_CONFIG)
    snapshot.slots[24] = SLOT.RUNNING
    snapshot.slots[700] = SLOT.RUNNING
    snapshot.remainingMs[24] = 750
    snapshot.remainingMs[700] = 250
    snapshot.running = snapshot.concurrent = 2
    emit({ type: 'SNAPSHOT', revision: 0, snapshot })
    const progress = () => container.querySelector<HTMLElement>('[data-testid="invocation-progress"]')!
    expect(progress().dataset.remainingMs).toBe('750')
    expect(progress().getAttribute('aria-valuetext')).toBe('750 ms remaining of 1 s')
    expect(container.querySelector('.progress-value')?.getAttribute('stroke-dasharray')).toBe('75 100')
    change('#slot-number', '2')
    expect(progress().dataset.remainingMs).toBe('250')
    const remaining = Float64Array.from(snapshot.remainingMs)
    remaining[700] = 200
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...snapshot, remainingMs: remaining, timeMs: 50, paused: true } })
    expect(progress().dataset.remainingMs).toBe('200')
    expect(container.querySelector('label[for="slot-number"]')?.textContent).toBe('Grid position')
    change('#slot-number', '3')
    expect(progress()).toBeNull()
    expect(snapshot.remainingMs[24]).toBe(750)
    expect(snapshot.remainingMs[700]).toBe(250)
  })

  it('hides the countdown on completion and starts a fresh one on reuse', () => {
    mount()
    const snapshot = initialSnapshot(DEFAULT_SIMPLE_CONFIG)
    snapshot.slots[0] = SLOT.RUNNING
    snapshot.remainingMs[0] = 1000
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...snapshot, running: 1, concurrent: 1 } })
    expect(container.querySelector<HTMLElement>('.invocation-progress')?.dataset.remainingMs).toBe('1000')
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...initialSnapshot(DEFAULT_SIMPLE_CONFIG), completed: 1, timeMs: 1000 } })
    expect(container.querySelector('.invocation-progress')).toBeNull()
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...snapshot, slots: Uint8Array.from(snapshot.slots), remainingMs: Float64Array.from(snapshot.remainingMs), running: 1, concurrent: 1, completed: 1, timeMs: 1000 } })
    expect(container.querySelector<HTMLElement>('.invocation-progress')?.dataset.remainingMs).toBe('1000')
    click('button[aria-label="Reset simulation"]')
    expect(container.querySelector('.invocation-progress')).toBeNull()
  })

  it('reaches fifteen minutes using either the visible preset or the slider', () => {
    mount()
    click('button[aria-label="Set handler duration to 15 min"]')
    expect(input('#duration-number').value).toBe('900000')
    expect(input('#duration-range').getAttribute('aria-valuetext')).toBe('15 min')
    expect(worker().messages.at(-1)).toMatchObject({ type: 'CONFIGURE', config: { durationMs: 900_000 } })
    click('button[aria-label="Set handler duration to 30 s"]')
    expect(input('#duration-number').value).toBe('30000')
    change('#duration-range', '1000')
    expect(input('#duration-number').value).toBe('900000')
    expect(new URL(window.location.href).searchParams.get('dur')).toBe('900000')
    click('button[aria-label="Set handler duration to 1 s"]')
    expect(input('#duration-number').value).toBe('1000')
  })

  it('the inspector reads the same compact states as the rendered grid, not scattered identities', () => {
    mount()
    const snapshot = initialSnapshot(DEFAULT_SIMPLE_CONFIG)
    snapshot.slots[24] = SLOT.RUNNING
    snapshot.slots[700] = SLOT.RUNNING
    snapshot.running = snapshot.concurrent = 2
    emit({ type: 'SNAPSHOT', revision: 0, snapshot })
    expect(container.querySelector('.slot-inspector output')?.textContent).toBe('running')
    change('#slot-number', '2')
    expect(container.querySelector('.slot-inspector output')?.textContent).toBe('running')
    change('#slot-number', '3')
    expect(container.querySelector('.slot-inspector output')?.textContent).toBe('free concurrency')
    expect(snapshot.slots[0]).toBe(SLOT.FREE)
    expect(snapshot.slots[700]).toBe(SLOT.RUNNING)
  })

  it('shows bounded 429 feedback only when traffic is rejected, and hides it on Stop', () => {
    mount()
    const snapshot = { ...initialSnapshot(DEFAULT_SIMPLE_CONFIG), trafficRunning: true, rejectedRps: 2_000, rejected: 100 }
    emit({ type: 'SNAPSHOT', revision: 0, snapshot })
    const feedback = container.querySelector<HTMLElement>('[data-testid="throttle-feedback"]')!
    expect(feedback.dataset.active).toBe('true')
    expect(feedback.textContent).toContain('2,000/s')
    expect(container.querySelectorAll('.deflected-request')).toHaveLength(1)
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...snapshot, paused: true } })
    expect(container.querySelector<HTMLElement>('.request-source')?.dataset.paused).toBe('true')
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...snapshot, trafficRunning: false, rejectedRps: 0 } })
    expect(feedback.dataset.active).toBe('false')
  })

  it('briefly shows a single rejected click and cancels its timer on reset', () => {
    vi.useFakeTimers()
    mount()
    emit({ type: 'MANUAL_RESULT', revision: 0, accepted: false, cause: 'RESERVED_CONCURRENCY' })
    const feedback = container.querySelector<HTMLElement>('[data-testid="throttle-feedback"]')!
    expect(feedback.dataset.active).toBe('true')
    expect(feedback.dataset.mode).toBe('manual')
    act(() => vi.advanceTimersByTime(1_500))
    expect(feedback.dataset.active).toBe('false')
    emit({ type: 'MANUAL_RESULT', revision: 0, accepted: false, cause: 'RESERVED_CONCURRENCY' })
    expect(feedback.dataset.active).toBe('true')
    click('button[aria-label="Reset simulation"]')
    expect(feedback.dataset.active).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies RC/PC instantly without a save and never subtracts PC twice', () => {
    mount()
    click('#reserved-switch')
    expect(button('#reserved-switch').getAttribute('aria-checked')).toBe('true')
    expect(input('#reserved-number').disabled).toBe(false)
    expect(container.querySelector('[data-testid="unreserved-pool"]')?.textContent).toBe('600')
    expect(container.querySelector('.pool-labels')?.textContent).toContain('400 reserved')
    click('#provisioned-switch')
    expect(container.querySelector('[data-testid="unreserved-pool"]')?.textContent).toBe('600')
    expect(container.querySelector('.pool-labels')?.textContent).toContain('400 reserved, including 200 provisioned')
    expect(container.querySelector('.allocation-note')?.textContent).toContain('ready instantly')
    expect(worker().messages.at(-1)).toMatchObject({ type: 'CONFIGURE', revision: 2, config: { reservedEnabled: true, provisionedEnabled: true } })
  })

  it('lets an account quota be typed digit by digit before applying it on Enter', () => {
    mount()
    click('#reserved-switch')
    click('#provisioned-switch')
    act(() => input('#quota-number').focus())
    const messagesBefore = worker().messages.length
    for (const text of ['', '2', '25', '250', '2500']) {
      change('#quota-number', text)
      expect(input('#quota-number').value).toBe(text)
      expect(container.querySelector('canvas')?.dataset.slotCount).toBe('1000')
    }
    expect(worker().messages).toHaveLength(messagesBefore)
    act(() => input('#quota-number').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(input('#quota-number').value).toBe('2500')
    expect(container.querySelector('canvas')?.dataset.slotCount).toBe('2500')
    expect(input('#reserved-number').value).toBe('400')
    expect(input('#provisioned-number').value).toBe('200')
    expect(worker().messages.at(-1)).toMatchObject({ type: 'CONFIGURE', config: { quota: 2500, reserved: 400, provisioned: 200 } })
    expect(new URL(window.location.href).searchParams.get('quota')).toBe('2500')
  })

  it('accepts a manually typed quota that is not a multiple of the button increment', () => {
    mount()
    act(() => input('#quota-number').focus())
    for (const text of ['', '1', '12', '123', '1234']) change('#quota-number', text)
    act(() => input('#quota-number').blur())
    expect(input('#quota-number').value).toBe('1234')
    expect(container.querySelector('canvas')?.dataset.slotCount).toBe('1234')
    click('button[aria-label="Increase example account concurrency quota"]')
    expect(input('#quota-number').value).toBe('1334')
    click('button[aria-label="Decrease example account concurrency quota"]')
    expect(input('#quota-number').value).toBe('1234')
  })

  it('validates quota bounds only when finished and restores empty or cancelled edits', () => {
    mount()
    act(() => input('#quota-number').focus())
    change('#quota-number', '55')
    expect(input('#quota-number').value).toBe('55')
    expect(container.querySelector('canvas')?.dataset.slotCount).toBe('1000')
    act(() => input('#quota-number').blur())
    expect(input('#quota-number').value).toBe('100')
    act(() => input('#quota-number').focus())
    change('#quota-number', '99999')
    expect(input('#quota-number').value).toBe('99999')
    act(() => input('#quota-number').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(input('#quota-number').value).toBe('10000')
    change('#quota-number', '')
    act(() => input('#quota-number').blur())
    expect(input('#quota-number').value).toBe('10000')
    act(() => input('#quota-number').focus())
    change('#quota-number', '2500')
    act(() => input('#quota-number').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(input('#quota-number').value).toBe('10000')
    expect(container.querySelector('canvas')?.dataset.slotCount).toBe('10000')
  })

  it('shows the normalized quota after a fractional no-op edit and resets drafts on presets', () => {
    mount()
    act(() => input('#quota-number').focus())
    change('#quota-number', '1000.4')
    act(() => input('#quota-number').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(input('#quota-number').value).toBe('1000')
    change('#quota-number', '2')
    act(() => [...container.querySelectorAll('button')].find(node => node.textContent === 'Scaling spike')!.click())
    expect(input('#quota-number').value).toBe('10000')
    expect(container.querySelector('canvas')?.dataset.slotCount).toBe('10000')
  })

  it('applies typed numbers immediately and permits clearing/replacing the input', () => {
    mount()
    change('#rps-number', '')
    expect(input('#rps-number').value).toBe('')
    change('#rps-number', '321.5')
    expect(worker().messages.at(-1)).toMatchObject({ type: 'CONFIGURE', config: { rps: 321.5 } })
    expect(container.querySelector('.formula-note')?.textContent).toContain('321.5 requests/s')
    change('#duration-number', '250')
    expect(container.querySelector('.formula-note')?.textContent).toContain('80.38 concurrent requests demanded')
    expect(new URL(window.location.href).searchParams.get('rps')).toBe('321.5')
    expect(new URL(window.location.href).searchParams.get('dur')).toBe('250')
  })

  it('clamps displayed numbers and does not send configuration messages for no-op edits', () => {
    mount()
    const initialMessages = worker().messages.length
    change('#rps-number', '400')
    expect(worker().messages.length).toBe(initialMessages)
    change('#rps-number', '999999')
    expect(input('#rps-number').value).toBe('100000')
    expect(worker().messages.at(-1)).toMatchObject({ type: 'CONFIGURE', config: { rps: 100_000 } })
    const afterClamp = worker().messages.length
    change('#rps-number', '999999')
    expect(input('#rps-number').value).toBe('100000')
    expect(worker().messages.length).toBe(afterClamp)
  })

  it('manual send neither starts the stream nor pretends to complete the request', () => {
    mount()
    click('#send-one')
    expect(worker().messages.at(-1)).toEqual({ type: 'MANUAL', revision: 0 })
    expect(worker().messages.some(command => command.type === 'START')).toBe(false)
    const snapshot = initialSnapshot(DEFAULT_SIMPLE_CONFIG)
    snapshot.slots[0] = SLOT.RUNNING
    emit({ type: 'MANUAL_RESULT', revision: 0, accepted: true, cause: null })
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...snapshot, concurrent: 1, running: 1, accepted: 1 } })
    expect(container.querySelector('[data-testid="running-now"]')?.textContent).toBe('1')
    expect(container.querySelector('.request-feedback')?.textContent).toBe('One request sent.')
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...initialSnapshot(DEFAULT_SIMPLE_CONFIG), completed: 1, accepted: 1, timeMs: 1_000 } })
    expect(container.querySelector('[data-testid="running-now"]')?.textContent).toBe('0')
    expect(container.querySelector('[data-testid="completed"]')?.textContent).toBe('1')
    expect(container.querySelector('.lifecycle-live')).toBeNull()
  })

  it('drops snapshots from before a configuration edit and shows manual rejections', () => {
    mount()
    click('#reserved-switch')
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...initialSnapshot(DEFAULT_SIMPLE_CONFIG), running: 888 } })
    expect(container.querySelector('[data-testid="running-now"]')?.textContent).toBe('0')
    emit({ type: 'MANUAL_RESULT', revision: 1, accepted: false, cause: 'RESERVED_CONCURRENCY' })
    expect(container.querySelector('.request-feedback')?.textContent).toContain('429: Reserved limit')
  })

  it('restores shared settings and resets without clearing them', () => {
    window.history.replaceState(null, '', '?v=2&rps=123.5&dur=200&prov=1&provv=300&initOn=1&init=250')
    mount()
    expect(input('#rps-number').value).toBe('123.5')
    expect(input('#provisioned-number').value).toBe('300')
    expect(button('#init-switch').getAttribute('aria-checked')).toBe('true')
    click('button[aria-label="Reset simulation"]')
    expect(input('#rps-number').value).toBe('123.5')
    expect(input('#provisioned-number').value).toBe('300')
    expect(worker().messages.at(-1)).toEqual({ type: 'RESET', revision: 1 })
  })

  it('enables lifecycle without showing a warm counter by default', () => {
    mount()
    expect(input('#idle-number').disabled).toBe(true)
    click('#idle-switch')
    expect(input('#idle-number').disabled).toBe(false)
    expect(container.querySelector('.lifecycle-live')?.textContent).toContain('warm environments')
    expect(container.querySelector('.key-warm')).not.toBeNull()
    click('#init-switch')
    expect(container.querySelector('.key-init')).not.toBeNull()
  })

  it('keeps Resume enabled after an edit resets a stopped, explicitly paused run', () => {
    mount()
    emit({ type: 'SNAPSHOT', revision: 0, snapshot: { ...initialSnapshot(DEFAULT_SIMPLE_CONFIG), paused: true, timeMs: 500 } })
    change('#duration-number', '200')
    const resume = [...container.querySelectorAll('button')].find(node => node.textContent === 'Resume')!
    expect(resume.disabled).toBe(false)
    act(() => resume.click())
    expect(worker().messages.at(-1)).toEqual({ type: 'RESUME', revision: 1 })
  })

  it('keeps the slot inspector on a whole, in-range quota slot', () => {
    mount()
    change('#slot-number', '2.5')
    expect(input('#slot-number').value).toBe('3')
    change('#slot-number', '999999')
    expect(input('#slot-number').value).toBe('1000')
    change('#slot-number', '-2')
    expect(input('#slot-number').value).toBe('1')
    expect(container.querySelector('.slot-inspector output')?.textContent).toBe('free concurrency')
  })

  it('shows a manual copy fallback when clipboard access is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } })
    mount()
    await act(async () => { button('.share-button').click() })
    expect(input('#share-url').value).toContain('v=2')
    expect(container.querySelector('.share-result')?.textContent).toBe('Select and copy the link below')
  })

  it('surfaces worker failure and closes every StrictMode worker', () => {
    mount(true)
    expect(TestWorker.instances).toHaveLength(2)
    expect(TestWorker.instances[0].terminated).toBe(true)
    act(() => worker().onerror?.({ message: 'Worker failed for test' }))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Worker failed for test')
    expect(button('#traffic-toggle').disabled).toBe(true)
    act(() => root.unmount())
    expect(worker().terminated).toBe(true)
  })
})
