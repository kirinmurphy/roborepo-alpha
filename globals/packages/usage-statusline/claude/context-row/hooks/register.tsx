import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const SHOW_FROM_PERCENT = 20

// Each level covers figures up to and including its limit; the last has no ceiling.
const LEVELS = [
  { upTo: 30, color: '#EAB308' },
  { upTo: 40, color: '#F97316' },
  { upTo: Infinity, color: '#EF4444' },
]

const percent = atom({ plugin: 'context-row', key: 'percent' } as const, null)
const closedLevel = atom({ plugin: 'context-row', key: 'closedLevel' } as const, null)

function levelOf(used: number) {
  return LEVELS.findIndex(level => used <= level.upTo)
}

// The usage call is free: it reads the figures the status line has, with no model or token-count call.
// A failure keeps the last figure, because this also runs after tool calls that must not be affected.
async function refresh($: EngineInterface) {
  try {
    const { context } = await $.session.usage()
    const used = context.percent ?? null

    await update($, percent, () => used)
    // Dropping below the closed level (a compaction, a cleared session) re-arms the row.
    await update($, closedLevel, closed =>
      closed !== null && (used === null || levelOf(used) < closed) ? null : closed,
    )
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

    const level = levelOf(used)
    const closed = await read($, closedLevel)

    // Closing silences the current color only, so a later, more urgent level still shows.
    if (closed !== null && level <= closed) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text>
          <Text dimColor>Context </Text>
          <Text color={LEVELS[level].color}>{used}%</Text>
        </Text>
        <Button
          key="close"
          label="Close"
          role="dismiss"
          onPress={() => update($, closedLevel, () => level)}
        />
      </Box>
    )
  })
}
