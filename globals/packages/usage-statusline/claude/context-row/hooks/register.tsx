import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { LimitFragment, LimitSegments } from '../types'
// Linked from the package's scripts, so the row computes 5h and weekly exactly as the terminal does.
import { adaptClaudeSessionUsage } from '../lib/usage-adapters.mjs'
import { assessUsage, usageSeverity } from '../lib/usage-domain.mjs'
import { statusLineSegments } from '../lib/usage-render.mjs'

// The context severities the row shows, in order; its index is the level a close is stored at.
// Below caution (20%) the row stays hidden, as the shared severity calls that normal.
const LEVELS = ['caution', 'warning', 'critical']

const percent = atom({ plugin: 'context-row', key: 'percent' } as const, null)
const closedLevel = atom({ plugin: 'context-row', key: 'closedLevel' } as const, null)
const limits = atom({ plugin: 'context-row', key: 'limits' } as const, null)

// The shared renderer's tones and severities, in the row's colors; label and unavailable text is
// drawn dim, and normal text in the surface's own color.
const TONE_COLORS: Record<string, string | undefined> = {
  caution: '#EAB308',
  warning: '#F97316',
  critical: '#EF4444',
}

function limitSegments(usage: Awaited<ReturnType<EngineInterface['session']['usage']>>, now: number): LimitSegments {
  const assessed = assessUsage(adaptClaudeSessionUsage(usage, { now }), { now })
  if (!assessed.windows.fiveHour.available && !assessed.windows.weekly.available) return null
  const { fiveHour, weekly } = statusLineSegments(assessed)

  return [fiveHour, weekly]
}

// -1 while the figure is below the first level the row shows.
function levelOf(used: number) {
  return LEVELS.indexOf(usageSeverity(used))
}

// The usage call is free: it reads the figures the status line has, with no model or token-count call.
// A failure keeps the last figure, because this also runs after tool calls that must not be affected.
async function refresh($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    const used = usage.context.percent ?? null

    await update($, percent, () => used)
    // Limits are refreshed on their own, so a failure there never holds back the context figure.
    try {
      const segments = limitSegments(usage, await $.clock.now())
      await update($, limits, () => segments)
    } catch {}
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
    const level = used === null ? -1 : levelOf(used)

    if (e.surface !== 'desktop' || e.props.hasSurvey || used === null || level < 0) {
      return next(e)
    }
    const closed = await read($, closedLevel)

    // Closing silences the current color only, so a later, more urgent level still shows.
    if (closed !== null && level <= closed) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const segments = (await read($, limits)) ?? []
    const fragment = ({ text, tone }: LimitFragment, index: number) =>
      tone === 'label' || tone === 'unavailable' ? (
        <Text key={`fragment-${index}`} dimColor>{text}</Text>
      ) : (
        <Text key={`fragment-${index}`} color={TONE_COLORS[tone]}>{text}</Text>
      )

    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text>
          <Text dimColor>Context </Text>
          <Text color={TONE_COLORS[usageSeverity(used)]}>{used}%</Text>
          {segments.map((segment, index) => (
            <Text key={`limit-${index}`}>
              <Text dimColor> · </Text>
              {segment.map(fragment)}
            </Text>
          ))}
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
