import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, RenderPropsOf } from 'claude-code'

import { runAfterTurn, runCompact } from '../hooks/register'

const props = (isWorking: boolean) =>
  ({ hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 120 }) as RenderPropsOf['AbovePrompt']

const engine = (on: On) => {
  const toasts: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('session.usage', () => ({ value: { startedAt: Date.now(), context: { window: 200000, percent: 10 }, rateLimits: [] } }) as never)
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

const recordClears = (on: On) => {
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  return ran
}

const TURN = { turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' } as const

test('응답 중에 누르면 예약했다가 턴이 끝난 뒤 /compact 를 실행한다', async ($, on) => {
  countCompacts(on)
  const ran = recordClears(on)
  const clock = mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    ran.length = 0
    const ui = await $.ui.mount({ plugin: 'statusline-plus', surface, component: 'AbovePrompt', props: props(true) })
    await ui.press({ key: 'compact' })
    expect((await ui.find({ key: 'compact' }))?.text ?? '').toContain('예약됨')

    await $.turn.complete({ ...TURN })
    expect(ran).toEqual([])
    await clock.advance(10)
    expect(ran).toEqual(['compact'])
    expect((await ui.find({ key: 'compact' }))?.text ?? '').not.toContain('예약됨')
    await ui.unmount()
  }
})

test('예약한 명령이 거절되면 입력창에 넣고 알린다', async ($, on) => {
  const toasts = engine(on)
  const filled: string[] = []
  on('command.run', () => {
    throw new Error('nope')
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  const clock = mock.clock(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(true) })
  await ui.press({ key: 'compact' })
  await $.turn.complete({ ...TURN })
  await clock.advance(10)
  expect(filled).toEqual(['/compact'])
  expect(toasts.join(' ')).toContain('Enter')
  await ui.unmount()
})

const HEADLESS = '$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'

// 테스트 엔진은 hook 이 던진 오류를 건너뛰고 'no implementation' 으로만 거절하므로, headless 거절은 가짜 $ 로 흉내 낸다
const headless = () => {
  const submitted: { text: string; asUser?: boolean }[] = []
  const filled: string[] = []
  const toasts: string[] = []
  const timers: Promise<unknown>[] = []
  const $ = {
    command: { run: async () => { throw new Error(HEADLESS) } },
    prompt: {
      submit: async (args: { text: string; asUser?: boolean }) => {
        submitted.push(args)
        return { text: args.text }
      },
      fill: async (args: { text: string }) => {
        filled.push(args.text)
        return { isFilled: true }
      },
    },
    ui: { toast: (text: string) => toasts.push(text) },
    clock: { after: (_ms: number, fn: () => Promise<unknown>) => timers.push(fn()) },
  } as unknown as EngineInterface
  return { $, submitted, filled, toasts, timers }
}

test('한가할 때 headless 라 거절되면 /compact 를 턴으로 제출한다', async () => {
  const { $, submitted } = headless()
  await runCompact($)
  expect(submitted).toEqual([{ text: '/compact', asUser: true }])
})

test('예약한 컴팩트도 headless 면 턴이 끝난 뒤 /compact 를 제출한다', async () => {
  const { $, submitted, filled, toasts, timers } = headless()
  runAfterTurn($, 'compact')
  await Promise.all(timers)
  expect(submitted).toEqual([{ text: '/compact', asUser: true }])
  expect(filled).toEqual([])
  expect(toasts.join(' ')).not.toContain('Enter')
})

test('입력창이 없으면 Enter 대신 직접 입력하라고 알린다', async ($, on) => {
  const toasts = engine(on)
  on('command.run', () => {
    throw new Error('nope')
  })
  on('prompt.fill', () => ({ isFilled: false }))
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  await ui.press({ key: 'compact' })
  expect(toasts.join(' ')).not.toContain('Enter')
  expect(toasts.join(' ')).toContain('직접 입력')
  await ui.unmount()
})

test('예약을 한 번 더 누르면 취소된다', async ($, on) => {
  countCompacts(on)
  const ran = recordClears(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(true) })
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact' })
  await $.turn.complete({ ...TURN })
  await clock.advance(10)
  expect(ran).toEqual([])
  await ui.unmount()
})

test('응답이 없을 때는 바로 /compact 를 실행하고 예약으로 남기지 않는다', async ($, on) => {
  countCompacts(on)
  const ran = recordClears(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  await ui.press({ key: 'compact' })
  expect(ran).toEqual(['compact'])
  expect((await ui.find({ key: 'compact' }))?.text ?? '').not.toContain('예약됨')
  await ui.unmount()
})

test('ctx·5h·1w 라벨과 퍼센트를 띄운다', async ($, on) => {
  engine(on)
  await $.turn.complete({ ...TURN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'statusline-plus', surface, component: 'AbovePrompt', props: props(false) })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(texts).toContain('ctx')
    expect(texts).toContain('5h')
    expect(texts).toContain('1w')
    expect(texts).toContain('10%')
    await ui.unmount()
  }
})

test('클리어는 두 번 눌러야 실행된다', async ($, on) => {
  engine(on)
  const ran = recordClears(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  await ui.press({ key: 'clear' })
  expect(ran).toEqual([])
  expect((await ui.find({ key: 'clear' }))?.text ?? '').toContain('정말')
  await ui.press({ key: 'clear' })
  expect(ran).toEqual(['clear'])
  await ui.unmount()
})

test('응답 중 클리어는 예약했다가 턴이 끝나면 실행하고, 예약된 컴팩트는 버린다', async ($, on) => {
  countCompacts(on)
  const ran = recordClears(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(true) })
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear' })
  expect(ran).toEqual([])
  expect((await ui.find({ key: 'clear' }))?.text ?? '').toContain('예약됨')
  await $.turn.complete({ ...TURN })
  await clock.advance(10)
  expect(ran).toEqual(['clear'])
  await ui.unmount()
})

test('클리어 확인 중 취소를 누르면 원래대로 돌아간다', async ($, on) => {
  engine(on)
  const ran = recordClears(on)
  const ui = await $.ui.mount({ plugin: 'statusline-plus', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear-cancel' })
  expect((await ui.find({ key: 'clear' }))?.text ?? '').not.toContain('정말')
  expect(ran).toEqual([])
  await ui.unmount()
})

test('상세는 접혀 있다가 누르면 펼쳐진다', async ($, on) => {
  engine(on)
  await $.turn.complete({ ...TURN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'statusline-plus', surface, component: 'AbovePrompt', props: props(false) })
    const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(await text()).not.toContain('비용')
    await ui.press({ key: 'toggle' })
    expect(await text()).toContain('비용')
    expect(await text()).toContain('proj')
    await ui.press({ key: 'toggle' })
    expect(await text()).not.toContain('비용')
    await ui.unmount()
  }
})
