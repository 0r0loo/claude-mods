export type Window = { used: number; resetsAt?: string }

export type Snapshot = {
  folder: string
  branch: string | null
  isDirty: boolean
  startedAt: number
  turns: number
  costUsd: number | null
  contextPercent: number | null
  fiveHour: Window | null
  weekly: Window | null
  // 한도 정보를 받았는지. 받았는데 창이 없으면 그 요금제엔 그 창이 없다(울트라는 5시간 창이 없다)
  hasRateLimits: boolean
}

export type ClearStep = 'idle' | 'confirm' | 'pending'

export type LastTurn = {
  model: string | null
  seconds: number
  cacheHitPercent: number | null
  endedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'statusline-plus': {
      snapshot: Snapshot | null
      lastTurn: LastTurn | null
      compactions: number
      runningAgents: number
      now: number
      busy: boolean
      queuedCompact: boolean
      pendingCompact: boolean
      clearStep: ClearStep
      expanded: boolean
    }
  }
}
