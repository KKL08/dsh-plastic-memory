import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { anchorReadPolicy, sessionFacts } from '../src/tools/session-access.ts'
import { sourceHost, sessionLog, user } from './helpers/source-host.ts'

describe('出处读取策略', () => {
  it('跨项目记忆先返回禁止访问', () => {
    expect(anchorReadPolicy({ scope: 'workspace', workspacePath: '/other' }, 's', { workspacePath: '/proj', session: { id: 'child' }, delegation: {} })).toEqual({ ok: false, kind: 'forbidden' })
  })
  it('子会话读其他会话的锚返回固定限制原因', () => {
    expect(anchorReadPolicy({ scope: 'global' }, 's', { workspacePath: '/proj', session: { id: 'child' }, delegation: {} })).toEqual({ ok: false, kind: 'rejected', code: 'subagent-restricted', reason: '这条记忆的出处在别的会话，带回主会话查' })
  })
  it('全局与本项目记忆放行且子会话可以读自己的锚', () => {
    for (const record of [{ scope: 'global' as const }, { scope: 'workspace' as const, workspacePath: '/proj' }]) {
      expect(anchorReadPolicy(record, 's', { workspacePath: '/proj' })).toEqual({ ok: true })
      expect(anchorReadPolicy(record, 's', { workspacePath: '/proj', session: { id: 's' }, delegation: {} })).toEqual({ ok: true })
    }
  })
  it('读取事实每次现查并把原日志带回', async () => {
    const log = sessionLog([user(1, '正文')])
    const host = sourceHost({ s: log })
    expect(await sessionFacts('s', host)).toEqual({ exists: true, log, isMarkedNoReview: false })
    expect(await sessionFacts('missing', host)).toEqual({ exists: false, log: null, isMarkedNoReview: false })
    await sessionFacts('s', host)
    expect(host.readSessionLog).toHaveBeenCalledTimes(3)
  })
  it('策略源码不依赖回看原话或检索模块', () => {
    const source = readFileSync(new URL('../src/tools/session-access.ts', import.meta.url), 'utf8')
    expect(source.match(/(?:import|export)[\s\S]*?from\s*['"][^'"]*['"]/g)?.filter(line => /['"][^'"]*(?:review|dialogue|search)[^'"]*['"]/.test(line)) ?? []).toEqual([])
  })
})
