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
  on('state.get', () => ({ value: { value: percent, version: 1 } }))
  engineDraws(on)
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
