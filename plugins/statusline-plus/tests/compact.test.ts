import { expect, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const props = (isWorking: boolean) =>
  ({ hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 120 }) as RenderPropsOf['AbovePrompt']

const engine = (on: On) => {
  const toasts: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } }) as never)
  on('session.root', () => ({ value: '/tmp/proj' }) as never)
  on('session.turns', () => ({ value: 3 }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  return toasts
}

const countCompacts = (on: On) => {
  engine(on)
  const calls = { n: 0 }
  on('session.compact', () => {
    calls.n += 1
    return { skip: 'test' }
  })
  return calls
}

const TURN = { turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' } as const

test('응답 중에 누르면 예약했다가 턴이 끝나면 컴팩트한다', async ($, on) => {
  const calls = countCompacts(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    calls.n = 0
    const ui = await $.ui.mount({ plugin: 'statusline-plus', surface, component: 'AbovePrompt', props: props(true) })
    await ui.press({ key: 'compact' })
    expect(calls.n).toBe(0)
    expect((await ui.find({ key: 'compact' }))?.text ?? '').toContain('예약됨')

    await $.turn.complete({ ...TURN })
    expect(calls.n).toBe(1)
    await ui.unmount()
  }
})

test('예약을 한 번 더 누르면 취소된다', async ($, on) => {
  const calls = countCompacts(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(true) })
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact' })
  await $.turn.complete({ ...TURN })
  expect(calls.n).toBe(0)
  await ui.unmount()
})

test('응답이 없을 때는 바로 컴팩트한다', async ($, on) => {
  const calls = countCompacts(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  await ui.press({ key: 'compact' })
  expect(calls.n).toBe(1)
  await ui.unmount()
})
