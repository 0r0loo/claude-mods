import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { LastTurn, Snapshot, Window } from '../types'

const snapshot = atom({ plugin: 'statusline-plus', key: 'snapshot' } as const, null)
const lastTurn = atom({ plugin: 'statusline-plus', key: 'lastTurn' } as const, null)
const compactions = atom({ plugin: 'statusline-plus', key: 'compactions' } as const, 0)
const runningAgents = atom({ plugin: 'statusline-plus', key: 'runningAgents' } as const, 0)
const clockNow = atom({ plugin: 'statusline-plus', key: 'now' } as const, 0)
const busy = atom({ plugin: 'statusline-plus', key: 'busy' } as const, false)

const WARN_AT = [80, 95]
const CACHE_TTL_MS = 5 * 60 * 1000
const warned = new Set<string>()

export function meter(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function untilReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}일 ${hours}시간`
  if (hours > 0) return `${hours}시간 ${mins}분`
  return `${mins}분`
}

export function elapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`
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
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)

    const now = (await read($, clockNow)) || Date.now()
    const turn = await read($, lastTurn)
    const compacted = await read($, compactions)
    const agents = await read($, runningAgents)
    const isBusy = await read($, busy)
    const { Box, Button, Text } = $.ui.resolve(e)

    const limit = (label: string, w: Window | null) =>
      w ? `${label} ${meter(w.used, 8)} ${Math.round(w.used)}%${w.resetsAt ? ` (${untilReset(w.resetsAt, now)} 뒤 리셋)` : ''}` : `${label} —`

    const ctx = s.contextPercent
    const idleMs = turn ? now - turn.endedAt : null
    const line1 = [
      `📁 ${s.folder}`,
      s.branch ? `⎇ ${s.branch}${s.isDirty ? ' ●' : ''}` : null,
      `⏱ ${elapsed(now - s.startedAt)}`,
      `💬 ${s.turns}회`,
      s.costUsd !== null ? `$${s.costUsd.toFixed(2)}` : null,
    ].filter(Boolean).join('  ·  ')
    const line2 = [
      ctx !== null ? `컨텍스트 ${meter(ctx, 8)} ${ctx}%` : '컨텍스트 —',
      limit('5시간', s.fiveHour),
      limit('주간', s.weekly),
    ].join('  ·  ')
    const line3 = [
      turn ? `직전 턴 ${turn.model ?? ''} ${turn.seconds}초`.replace('  ', ' ') : null,
      turn?.cacheHitPercent != null ? `캐시 ${turn.cacheHitPercent}%` : null,
      idleMs !== null ? `대기 ${elapsed(idleMs)}${idleMs > CACHE_TTL_MS ? ' (캐시 만료)' : ''}` : null,
      compacted > 0 ? `컴팩트 ${compacted}회` : null,
      agents > 0 ? `에이전트 ${agents}개 실행 중` : null,
    ].filter(Boolean).join('  ·  ')

    return (
      <Box flexDirection="column">
        <Text dimColor>{line1}</Text>
        <Text color={ctx !== null && ctx >= 80 ? 'warning' : undefined}>{line2}</Text>
        <Box>
          {line3 ? <Text dimColor>{line3} </Text> : null}
          <Button
            key="compact"
            label={isBusy ? '컴팩트 중…' : '컴팩트'}
            onPress={async () => {
              if (await read($, busy)) return
              await update($, busy, () => true)
              try {
                const r = await $.session.compact()
                if (r && 'skip' in r && r.skip) $.ui.toast('컴팩트가 취소됐어요')
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err)
                void $.prompt.fill({ text: '/compact' })
                $.ui.toast(`버튼으로는 컴팩트하지 못했어요 (${reason}). 입력창에 /compact를 넣었으니 Enter로 실행하세요`)
              } finally {
                await update($, busy, () => false)
                await refresh($)
              }
            }}
          />
          <Button
            key="clear"
            label="클리어"
            onPress={() => {
              void $.prompt.fill({ text: '/clear' })
              $.ui.toast('입력창에 /clear를 넣었어요. Enter로 확정하세요')
            }}
          />
        </Box>
      </Box>
    )
  })
}
