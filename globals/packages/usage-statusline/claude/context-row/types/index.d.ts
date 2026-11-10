// Whole percent of the context window in use; null until the session's first response.
export type ContextPercent = number | null

// Index of the color level the person closed the row at; null while the row is open.
export type ClosedLevel = number | null

// One piece of a status-line segment and the tone the shared renderer gives it.
export type LimitFragment = { text: string; tone: string }

// The 5h and weekly segments as the terminal status line renders them; null off a subscription or
// before the first response reports a rate limit.
export type LimitSegments = LimitFragment[][] | null

declare module 'claude-code' {
  interface PluginState {
    'context-row': { percent: ContextPercent; closedLevel: ClosedLevel; limits: LimitSegments }
  }
}
