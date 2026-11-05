import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const SHOW_FROM_PERCENT = 20

const percent = atom({ plugin: 'context-row', key: 'percent' } as const, null)

// The usage call is free: it reads the figures the status line has, with no model or token-count call.
// A failure keeps the last figure, because this also runs after tool calls that must not be affected.
async function refresh($: EngineInterface) {
  try {
    const { context } = await $.session.usage()
    await update($, percent, () => context.percent ?? null)
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  // A long turn can fill the window well before it ends, so each tool call refreshes too.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const used = await read($, percent)

    // The terminal already has this figure in its status line, which the desktop app does not draw.
    if (e.surface !== 'desktop' || e.props.hasSurvey || used === null || used < SHOW_FROM_PERCENT) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)

    return <Text dimColor>Context {used}%</Text>
  })
}
