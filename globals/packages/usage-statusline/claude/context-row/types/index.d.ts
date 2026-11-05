// Whole percent of the context window in use; null until the session's first response.
export type ContextPercent = number | null

declare module 'claude-code' {
  interface PluginState {
    'context-row': { percent: ContextPercent }
  }
}
