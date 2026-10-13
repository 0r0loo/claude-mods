import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { ClearStep, LastTurn, Snapshot, Window } from '../types'

const snapshot = atom({ plugin: 'statusline-plus', key: 'snapshot' } as const, null)
const lastTurn = atom({ plugin: 'statusline-plus', key: 'lastTurn' } as const, null)
const compactions = atom({ plugin: 'statusline-plus', key: 'compactions' } as const, 0)
const runningAgents = atom({ plugin: 'statusline-plus', key: 'runningAgents' } as const, 0)
const clockNow = atom({ plugin: 'statusline-plus', key: 'now' } as const, 0)
const busy = atom({ plugin: 'statusline-plus', key: 'busy' } as const, false)
const pendingCompact = atom({ plugin: 'statusline-plus', key: 'pendingCompact' } as const, false)
const expanded = atom({ plugin: 'statusline-plus', key: 'expanded' } as const, false)
const clearStep = atom({ plugin: 'statusline-plus', key: 'clearStep' } as const, 'idle')

const WARN_AT = [80, 95]
const CACHE_TTL_MS = 5 * 60 * 1000
const warned = new Set<string>()

const EMPTY: Snapshot = {
  folder: '',
  branch: null,
  isDirty: false,
  startedAt: Date.now(),
  turns: 0,
  costUsd: 0,
  contextPercent: 0,
  fiveHour: null,
  weekly: null,
}

export function meter(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function duration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`
  return `${mins}m`
}

export function untilReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  return duration(Date.parse(resetsAt) - now + 30_000)
}

export function elapsed(ms: number): string {
  return duration(ms)
}

export function levelColor(percent: number): 'success' | 'warning' | 'error' {
  return percent >= 80 ? 'error' : percent >= 60 ? 'warning' : 'success'
}

export function cacheHitPercent(usage: TurnUsage | undefined): number | null {
  if (!usage) return null
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return total > 0 ? Math.round((usage.cache_read_input_tokens / total) * 100) : null
}

export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
}

async function readBranch($: EngineInterface, root: string): Promise<{ branch: string | null; isDirty: boolean }> {
  try {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })
    if (head.exitCode !== 0) return { branch: null, isDirty: false }
    const status = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: root, timeoutMs: 5000 })
    return { branch: head.stdout.trim(), isDirty: status.exitCode === 0 && status.stdout.trim() !== '' }
  } catch {
    return { branch: null, isDirty: false }
  }
}

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  const root = await $.session.root()
  const pick = (kind: string): Window | null => {
    const w = usage.rateLimits.find(r => r.kind === kind)
    return w ? { used: w.percentUsed, resetsAt: w.resetsAt } : null
  }
  const git = await readBranch($, root)
  const next: Snapshot = {
    folder: root.split('/').filter(Boolean).at(-1) ?? root,
    branch: git.branch,
    isDirty: git.isDirty,
    startedAt: usage.startedAt,
    turns: await $.session.turns(),
    costUsd: usage.cost?.usd ?? null,
    contextPercent: usage.context.percent ?? null,
    fiveHour: pick('five_hour'),
    weekly: pick('seven_day'),
  }
  await update($, snapshot, () => next)
  await update($, clockNow, () => Date.now())

  for (const [label, w] of [['5시간', next.fiveHour], ['주간', next.weekly]] as const) {
    if (!w) continue
    for (const at of WARN_AT) {
      const key = `${label}:${at}`
      if (w.used >= at && !warned.has(key)) {
        warned.add(key)
        $.ui.toast(`${label} 한도 ${Math.round(w.used)}% 사용`)
      }
    }
  }
}

async function compactNow($: EngineInterface) {
  if (await read($, busy)) return
  await update($, busy, () => true)
  try {
    const r = await $.session.compact()
    if (r && 'skip' in r && r.skip) $.ui.toast('컴팩트가 취소됐어요')
  } catch {
    // 누르는 사이에 턴이 시작돼 거절됐다: 예약해 두고 턴이 끝나면 실행한다
    await update($, pendingCompact, () => true)
    $.ui.toast('응답이 끝나면 컴팩트할게요')
  } finally {
    await update($, busy, () => false)
    await refresh($)
  }
}

// 예약된 /compact·/clear 를 실행한다. turn.complete 훅 안에서는 턴이 그 훅을 기다리고 있어
// 컴팩트도 명령도 거절되므로, 시계로 훅 밖으로 빼낸 뒤 command.run 에 맡긴다(세션이 한가해지면 실행된다).
function runAfterTurn($: EngineInterface, command: 'compact' | 'clear') {
  $.clock.after(1, async () => {
    try {
      await $.command.run({ command })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      $.prompt.fill({ text: `/${command}` }).catch(() => {})
      $.ui.toast(`예약한 /${command}를 실행하지 못했어요 (${reason}). 입력창에 넣었으니 Enter로 실행하세요`)
    }
  })
}

async function clearNow($: EngineInterface) {
  await update($, clearStep, () => 'idle')
  await update($, pendingCompact, () => false)
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    $.prompt.fill({ text: '/clear' }).catch(() => {})
    $.ui.toast(`클리어하지 못했어요 (${reason}). 입력창에 /clear를 넣었으니 Enter로 실행하세요`)
  }
}

async function countAgents($: EngineInterface) {
  const agents = await $.agent.list()
  const running = agents.filter(a => a.status === 'running' || a.status === 'pending').length
  await update($, runningAgents, () => running)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    $.clock.every(30_000, async () => {
      await update($, clockNow, () => Date.now())
      await countAgents($)
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const turn: LastTurn = {
        model: e.usage ? shortModel(e.usage.model) : null,
        seconds: Math.round(e.durationMs / 1000),
        cacheHitPercent: cacheHitPercent(e.usage),
        endedAt: Date.now(),
      }
      await update($, lastTurn, () => turn)
      await refresh($)
      // 클리어가 예약돼 있으면 컴팩트는 의미가 없으니 클리어만 한다
      if ((await read($, clearStep)) === 'pending') {
        await update($, clearStep, () => 'idle')
        await update($, pendingCompact, () => false)
        runAfterTurn($, 'clear')
      } else if (await read($, pendingCompact)) {
        await update($, pendingCompact, () => false)
        runAfterTurn($, 'compact')
      }
    }
    await countAgents($)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!('skip' in result && result.skip)) {
      await update($, compactions, n => n + 1)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = (await read($, snapshot)) ?? EMPTY

    const now = (await read($, clockNow)) || Date.now()
    const turn = await read($, lastTurn)
    const compacted = await read($, compactions)
    const agents = await read($, runningAgents)
    const isBusy = await read($, busy)
    const isPending = await read($, pendingCompact)
    const clear = await read($, clearStep)
    const isOpen = await read($, expanded)
    const { Box, Button, Text } = $.ui.resolve(e)

    const barWidth = e.props.bodyColumns >= 70 ? 8 : 5
    const idleMs = turn ? now - turn.endedAt : null
    const isCacheCold = idleMs !== null && idleMs > CACHE_TTL_MS

    const Gauge = (id: string, label: string, percent: number | null, resetsAt?: string) => {
      const p = Math.round(percent ?? 0)
      const color = percent === null ? 'subtle' : levelColor(p)
      const reset = untilReset(resetsAt, now)
      return (
        <Box key={id} flexDirection="row" gap={1} flexShrink={0}>
          <Box width={3} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Text color={color}>{meter(p, barWidth)}</Text>
          <Text key={`${id}-value`} color={color} bold>{`${p}%`}</Text>
          {reset ? <Text dimColor>{`↻${reset}`}</Text> : null}
        </Box>
      )
    }

    const where = [
      s.folder ? <Text key="folder" bold wrap="truncate-middle">{s.folder}</Text> : null,
      s.branch ? (
        <Box key="branch" flexDirection="row" flexShrink={1}>
          <Text color="suggestion" wrap="truncate-middle">{`⎇ ${s.branch}`}</Text>
          {s.isDirty ? <Text color="warning">{' ●'}</Text> : null}
        </Box>
      ) : null,
    ].filter(Boolean)

    const stat = (key: string, label: string, value: string, color?: string) => (
      <Box key={key} flexDirection="row" gap={1} flexShrink={0}>
        <Text dimColor>{label}</Text>
        <Text color={color}>{value}</Text>
      </Box>
    )
    const stats = [
      stat('cost', '비용', `$${(s.costUsd ?? 0).toFixed(2)}`, 'claude'),
      stat('time', '세션', `${elapsed(now - s.startedAt)} · ${s.turns}턴`),
      turn ? stat('turn', '직전', [turn.model, `${turn.seconds}s`].filter(Boolean).join(' ')) : null,
      turn?.cacheHitPercent != null ? stat('cache', '캐시', `${turn.cacheHitPercent}%`) : null,
      idleMs !== null ? stat('idle', '대기', `${elapsed(idleMs)}${isCacheCold ? ' (캐시 만료)' : ''}`, isCacheCold ? 'warning' : undefined) : null,
      compacted > 0 ? stat('compacted', '컴팩트', `${compacted}회`) : null,
      agents > 0 ? stat('agents', '에이전트', `${agents}개 실행 중`, 'permission') : null,
    ].filter(Boolean)

    const onCompact = async () => {
      if (await read($, pendingCompact)) {
        await update($, pendingCompact, () => false)
        $.ui.toast('컴팩트 예약을 취소했어요')
        return
      }
      if (e.props.isWorking) {
        await update($, pendingCompact, () => true)
        $.ui.toast('응답이 끝나면 컴팩트할게요')
        return
      }
      await compactNow($)
    }

    const onClear = async () => {
      const step = await read($, clearStep)
      if (step === 'pending') {
        await update($, clearStep, () => 'idle')
        $.ui.toast('클리어 예약을 취소했어요')
        return
      }
      if (step === 'idle') {
        await update($, clearStep, () => 'confirm')
        return
      }
      if (e.props.isWorking) {
        await update($, clearStep, () => 'pending')
        $.ui.toast('응답이 끝나면 클리어할게요')
        return
      }
      await clearNow($)
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {Gauge('ctx', 'ctx', s.contextPercent)}
          {Gauge('5h', '5h', s.fiveHour?.used ?? null, s.fiveHour?.resetsAt)}
          {Gauge('1w', '1w', s.weekly?.used ?? null, s.weekly?.resetsAt)}
        </Box>
        {isOpen ? (
          <Box key="details" flexDirection="column" marginTop={1}>
            {where.length > 0 ? (
              <Box flexDirection="row" columnGap={2}>
                {where}
              </Box>
            ) : null}
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {stats}
            </Box>
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={isOpen ? 1 : 0}>
          <Button
            key="toggle"
            hotkey="d"
            label={isOpen ? '접기 ▴' : '상세 ▾'}
            onPress={() => update($, expanded, v => !v)}
          />
          <Button
            key="compact"
            hotkey="c"
            label={isBusy ? '컴팩트 중…' : isPending ? '컴팩트 예약됨 · 취소' : '컴팩트'}
            variant={isPending ? 'primary' : 'secondary'}
            onPress={onCompact}
          />
          <Button
            key="clear"
            hotkey="x"
            label={clear === 'confirm' ? '정말 클리어?' : clear === 'pending' ? '클리어 예약됨 · 취소' : '클리어'}
            variant={clear === 'idle' ? 'secondary' : 'primary'}
            onPress={onClear}
          />
          {clear === 'confirm' ? (
            <Button key="clear-cancel" hotkey="n" label="취소" onPress={() => update($, clearStep, () => 'idle')} />
          ) : null}
        </Box>
      </Box>
    )
  })
}
