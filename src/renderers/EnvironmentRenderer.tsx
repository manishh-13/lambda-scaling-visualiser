import { useRef } from 'react'
import './renderers.css'
import { CanvasEnvironmentRenderer } from './CanvasEnvironmentRenderer'
import { DomEnvironmentRenderer } from './DomEnvironmentRenderer'
import { nextRendererMode } from './grid'
import type { RendererMode } from './grid'
import type { EnvironmentRendererProps } from './types'

export function EnvironmentRenderer(props: EnvironmentRendererProps) {
  const modeRef = useRef<RendererMode | null>(null)
  const mode = nextRendererMode(modeRef.current, props.environments.length)
  modeRef.current = mode
  if (mode === 'canvas') return <CanvasEnvironmentRenderer {...props} />
  return <DomEnvironmentRenderer {...props} />
}
