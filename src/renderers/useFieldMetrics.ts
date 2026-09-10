import { useCallback, useEffect, useRef, useState } from 'react'

export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const nodeRef = useRef<T | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const apply = useCallback((next: number) => {
    setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next))
  }, [])

  const setNode = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    nodeRef.current = node
    if (!node) return
    apply(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : undefined
      apply(box ? box.inlineSize : entry.contentRect.width)
    })
    observer.observe(node, { box: 'border-box' })
    observerRef.current = observer
  }, [apply])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return [setNode, width]
}

export function usePrefersReducedMotion(override?: boolean): boolean {
  const [prefers, setPrefers] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefers(query.matches)
    if (typeof query.addEventListener !== 'function') return
    const listener = (event: MediaQueryListEvent) => setPrefers(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  return override ?? prefers
}
