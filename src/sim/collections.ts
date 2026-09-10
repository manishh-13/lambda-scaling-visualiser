/** Bounded samples retain ordering without shifting an array on every request. */
export interface Ring<T> {
  items: T[]
  start: number
  capacity: number
}

export function createRing<T>(capacity: number): Ring<T> {
  return { items: [], start: 0, capacity }
}

export function appendRing<T>(ring: Ring<T>, item: T): void {
  if (ring.items.length < ring.capacity) ring.items.push(item)
  else {
    ring.items[ring.start] = item
    ring.start = (ring.start + 1) % ring.capacity
  }
}

export function readRing<T>(ring: Ring<T>): T[] {
  return ring.items.slice(ring.start).concat(ring.items.slice(0, ring.start))
}

export interface ScheduledEvent {
  key: number
  atMs: number
  order: number
}

/** One indexed event per environment, so repeated warm reuse cannot leak stale idle timers. */
export class EventQueue {
  private heap: ScheduledEvent[] = []
  private positions = new Map<number, number>()

  get size(): number { return this.heap.length }
  peek(): ScheduledEvent | undefined { return this.heap[0] }

  set(event: ScheduledEvent): void {
    this.delete(event.key)
    this.heap.push(event)
    this.positions.set(event.key, this.heap.length - 1)
    this.up(this.heap.length - 1)
  }

  pop(): ScheduledEvent | undefined {
    const event = this.heap[0]
    if (event) this.delete(event.key)
    return event
  }

  delete(key: number): void {
    const position = this.positions.get(key)
    if (position === undefined) return
    this.positions.delete(key)
    const last = this.heap.pop()!
    if (position >= this.heap.length) return
    this.heap[position] = last
    this.positions.set(last.key, position)
    this.down(this.up(position))
  }

  private precedes(a: ScheduledEvent, b: ScheduledEvent): boolean {
    return a.atMs < b.atMs || (a.atMs === b.atMs && a.order < b.order)
  }

  private swap(a: number, b: number): void {
    ;[this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]]
    this.positions.set(this.heap[a].key, a)
    this.positions.set(this.heap[b].key, b)
  }

  private up(position: number): number {
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2)
      if (!this.precedes(this.heap[position], this.heap[parent])) break
      this.swap(parent, position)
      position = parent
    }
    return position
  }

  private down(position: number): void {
    while (position * 2 + 1 < this.heap.length) {
      const left = position * 2 + 1
      const right = left + 1
      const child = right < this.heap.length && this.precedes(this.heap[right], this.heap[left]) ? right : left
      if (!this.precedes(this.heap[child], this.heap[position])) break
      this.swap(position, child)
      position = child
    }
  }
}

/** LIFO warm reuse lets surplus idle environments retire instead of cycling through all of them. */
export class IdlePool {
  private links = new Map<number, { previous: number | null; next: number | null }>()
  private head: number | null = null

  get size(): number { return this.links.size }
  peek(): number | null { return this.head }

  add(key: number): void {
    this.delete(key)
    this.links.set(key, { previous: null, next: this.head })
    if (this.head !== null) this.links.get(this.head)!.previous = key
    this.head = key
  }

  delete(key: number): void {
    const link = this.links.get(key)
    if (!link) return
    if (link.previous === null) this.head = link.next
    else this.links.get(link.previous)!.next = link.next
    if (link.next !== null) this.links.get(link.next)!.previous = link.previous
    this.links.delete(key)
  }
}
