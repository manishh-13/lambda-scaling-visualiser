export type VisualEnvironmentState = 'INITIALIZING' | 'RUNNING' | 'WARM_IDLE' | 'PROVISIONED_IDLE' | 'RETIRING'

export interface VisualEnvironment {
  id: string
  type: 'ON_DEMAND' | 'PROVISIONED'
  state: VisualEnvironmentState
  activeRequestId?: string
  stateSinceMs: number
  totalInvocations: number
  coldStarts: number
  progress: number
  recentHistory: Array<{ state: string; atMs: number }>
  initProgress?: number
}

export interface EnvironmentRendererProps {
  environments: VisualEnvironment[]
  onInspect: (environment: VisualEnvironment) => void
  nowMs?: number
  laneLabel?: string
  reducedMotion?: boolean
  paused?: boolean
}
