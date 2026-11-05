// Whole percent of the context window in use; null until the session's first response.
export type ContextPercent = number | null

// Index of the color level the person closed the row at; null while the row is open.
export type ClosedLevel = number | null

declare module 'claude-code' {
  interface PluginState {
    'context-row': { percent: ContextPercent; closedLevel: ClosedLevel }
  }
}
