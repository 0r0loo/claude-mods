import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On, RenderPropsOf } from 'claude-code'

import { compactNow, runAfterTurn, runCompact, settleQueuedCompact } from '../hooks/register'

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
// clock.after 는 콜백을 바로 돌리지 않고 모아 두었다가 runTimers 로 실행한다
const headless = ({ error = HEADLESS, submitResult = {} as { drop?: string } } = {}) => {
  const submitted: { text: string; asUser?: boolean }[] = []
  const filled: string[] = []
  const toasts: string[] = []
  const timers: (() => Promise<unknown>)[] = []
  // 테스트 엔진의 $ 에는 state 가 없어 atom 이 쓰는 get/set(ifVersion) 만 흉내 낸다
  const store = new Map<string, { value: unknown; version: number }>()
  const $ = {
    state: {
      get: async (ref: { key: string }) => store.get(ref.key) ?? { value: undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown, opts?: { ifVersion?: number }) => {
        const version = store.get(ref.key)?.version ?? 0
        if (opts?.ifVersion !== undefined && opts.ifVersion !== version) return { isSet: false }
        store.set(ref.key, { value, version: version + 1 })
        return { isSet: true }
      },
    },
    session: {
      usage: async () => ({ startedAt: Date.now(), context: { window: 200000, percent: 10 }, rateLimits: [] }),
      root: async () => '/tmp/proj',
      turns: async () => 3,
    },
    process: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
    command: { run: async () => { throw new Error(error) } },
    prompt: {
      submit: async (args: { text: string; asUser?: boolean }) => {
        submitted.push(args)
        return 'drop' in submitResult ? submitResult : { text: args.text }
      },
      fill: async (args: { text: string }) => {
        filled.push(args.text)
        // headless 에는 입력창이 없다
        return { isFilled: false }
      },
    },
    ui: { toast: (text: string) => toasts.push(text) },
    clock: { after: (_ms: number, fn: () => Promise<unknown>) => timers.push(fn) },
  } as unknown as EngineInterface
  const runTimers = () => Promise.all(timers.splice(0).map(fn => fn()))
  return { $, submitted, filled, toasts, timers, runTimers }
}

const rejection = (p: Promise<unknown>) => p.then(() => undefined, (err: Error) => err.message)

test('한가할 때 headless 라 거절되면 /compact 를 턴으로 제출한다', async () => {
  const { $, submitted } = headless()
  await runCompact($)
  expect(submitted).toEqual([{ text: '/compact', asUser: true }])
})

test('headless 가 아닌 오류면 /compact 를 제출하지 않고 그대로 던진다', async () => {
  const { $, submitted } = headless({ error: 'nope' })
  expect(await rejection(runCompact($))).toBe('nope')
  expect(submitted).toEqual([])
})

test('제출이 drop 되면 사유로 실패하고, 사유가 비어도 실패로 본다', async () => {
  expect(await rejection(runCompact(headless({ submitResult: { drop: '거절' } }).$))).toBe('거절')
  expect(await rejection(runCompact(headless({ submitResult: { drop: '' } }).$))).toBe('/compact 제출이 거절됐어요')
})

test('예약한 컴팩트는 타이머로 미룬 뒤에야 /compact 를 제출한다', async () => {
  const { $, submitted, filled, toasts, timers, runTimers } = headless()
  runAfterTurn($, 'compact')
  expect(timers.length).toBe(1)
  expect(submitted).toEqual([])
  await runTimers()
  expect(submitted).toEqual([{ text: '/compact', asUser: true }])
  expect(filled).toEqual([])
  expect(toasts.join(' ')).not.toContain('Enter')
})

test('예약한 컴팩트 제출이 drop 되면 입력창에 넣고 안내한다', async () => {
  const { $, filled, toasts, runTimers } = headless({ submitResult: { drop: '거절' } })
  runAfterTurn($, 'compact')
  await runTimers()
  expect(filled).toEqual(['/compact'])
  expect(toasts.join(' ')).toContain('거절')
})

test('headless 로 제출한 컴팩트는 그 턴이 끝날 때까지 다시 제출하지 않는다', async () => {
  const { $, submitted } = headless()
  await compactNow($)
  await compactNow($)
  expect(submitted).toHaveLength(1)

  await settleQueuedCompact($)
  await compactNow($)
  expect(submitted).toHaveLength(2)
})

test('headless 제출이 drop 되면 busy 를 풀고 직접 입력하라고 알린다', async () => {
  const { $, submitted, toasts } = headless({ submitResult: { drop: '거절' } })
  await compactNow($)
  expect(toasts.join(' ')).toContain('거절')
  expect(toasts.join(' ')).toContain('직접 입력')

  await compactNow($)
  expect(submitted).toHaveLength(2)
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
