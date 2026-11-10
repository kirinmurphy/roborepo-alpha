import { expect, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

function band(surface: RenderSurface) {
  return {
    plugin: 'context-row',
    component: 'AbovePrompt',
    surface,
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as const
}

function engineDraws(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

function seed(on: On, percent: number | null) {
  on('state.get', (_, e) => ({
    value: { value: e.key === 'percent' ? percent : null, version: 1 },
  }))
  engineDraws(on)
}

// Drives the figure through real usage reads, so closing the row writes real state.
function usageReports(on: On) {
  let reported: number | null = null

  engineDraws(on)
  on('tool.call', () => ({ result: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1000, percent: reported ?? undefined }, rateLimits: [] },
  }))

  return (percent: number | null) => {
    reported = percent
  }
}

test('the row shows the percentage at exactly 20%', async ($, on) => {
  seed(on, 20)
  const ui = await $.ui.mount(band('desktop'))

  expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toBe('Context 20%')
  await ui.unmount()
})

test('the row stays hidden just below 20%', async ($, on) => {
  seed(on, 19)
  const ui = await $.ui.mount(band('desktop'))

  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await ui.unmount()
})

test('the row stays hidden before the first response', async ($, on) => {
  seed(on, null)
  const ui = await $.ui.mount(band('desktop'))

  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await ui.unmount()
})

test('the terminal keeps its status line and gets no row', async ($, on) => {
  seed(on, 50)
  const ui = await $.ui.mount(band('terminal'))

  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await ui.unmount()
})

test('a tool call refreshes the figure the row draws', async ($, on) => {
  engineDraws(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1000, percent: 33 }, rateLimits: [] },
  }))

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount(band('desktop'))

  expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toBe('Context 33%')
  await ui.unmount()
})

test('a failed usage read leaves the tool call alone', async ($, on) => {
  engineDraws(on)
  on('tool.call', () => ({ result: { ok: true } }))
  on('session.usage', () => {
    throw new Error('usage unavailable')
  })

  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(result).toEqual({ result: { ok: true } })
})

const COLORS = [
  [20, '#EAB308'],
  [30, '#EAB308'],
  [31, '#F97316'],
  [40, '#F97316'],
  [41, '#EF4444'],
  [90, '#EF4444'],
] as const

for (const [used, color] of COLORS) {
  test(`the figure is ${color} at ${used}%`, async ($, on) => {
    seed(on, used)
    const ui = await $.ui.mount(band('desktop'))
    const figure = await ui.find({ type: 'Text', text: new RegExp(`^${used}%$`) })

    expect(figure?.props.color).toBe(color)
    await ui.unmount()
  })
}

test('closing hides the row and it stays hidden within the same color', async ($, on) => {
  const report = usageReports(on)

  report(25)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount(band('desktop'))

  expect((await ui.find({ key: 'close' }))?.props.role).toBe('dismiss')
  await ui.press({ key: 'close' })
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()

  report(30)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await ui.unmount()
})

test('a closed row comes back at the next color', async ($, on) => {
  const report = usageReports(on)

  report(30)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount(band('desktop'))

  await ui.press({ key: 'close' })
  report(31)
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(await ui.find({ type: 'Text', text: '31%' })).toBeDefined()
  await ui.unmount()
})

test('a closed row comes back after the figure drops below its color', async ($, on) => {
  const report = usageReports(on)

  report(35)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount(band('desktop'))

  await ui.press({ key: 'close' })
  report(25)
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
  await ui.unmount()
})

// Five days into the week (5/7 = 71% elapsed) with 90% used: a 19-point debt.
const NOW = Date.parse('2026-11-09T12:00:00.000Z')
const WEEKLY_RESET = new Date(NOW + 2 * 24 * 60 * 60 * 1000).toISOString()

function limitsReport(on: On, rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  engineDraws(on)
  on('clock.now', () => ({ value: NOW }))
  on('tool.call', () => ({ result: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1000, percent: 42 }, rateLimits },
  }))
}

test('the row adds 5h and weekly usage as the status line renders them', async ($, on) => {
  limitsReport(on, [
    { kind: 'five_hour', percentUsed: 18 },
    { kind: 'seven_day', percentUsed: 90, resetsAt: WEEKLY_RESET },
  ])

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount(band('desktop'))

  expect((await ui.find({ type: 'Text', text: /^Context/ }))?.text).toBe(
    'Context 42% · 5h: 18% · Weekly: 90% (19% debt)',
  )
  expect((await ui.find({ type: 'Text', text: /^90%$/ }))?.props.color).toBe('#EF4444')
  expect((await ui.find({ type: 'Text', text: /^19% debt$/ }))?.props.color).toBe('#F97316')
  await ui.unmount()
})

test('the row shows only context when no rate limit is reported', async ($, on) => {
  limitsReport(on, [])

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount(band('desktop'))

  expect((await ui.find({ type: 'Text', text: /^Context/ }))?.text).toBe('Context 42%')
  await ui.unmount()
})
