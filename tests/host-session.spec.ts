import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { createCordisHostSession } from '../src/cordis-host-session.ts'
import { UNKNOWN_SESSION_ID } from '../src/tools/host-session.ts'
import { fakeExec } from './helpers/exec.ts'

// 宿主会话适配器：假查找、假投影、假会话查询、假模型都在宿主边界，适配器本身用真的

type Header = Partial<Pick<SessionHeader, 'cwd' | 'delegationDepth'>> & { parentSession?: string }

function session(id: string, { parentSession, ...header }: Header = {}) {
  return Session.create(id as SessionId, [], {
    version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: 0, isSeeded: false, ...header,
    ...(parentSession === undefined ? {} : { parentSession: parentSession as SessionId }),
  }, 0 as never) // 下界宿主是 number、新宿主是带品牌的偏移量，两边都收
}

const execOf = (s?: Session, options: { provider?: string; model?: string } = {}) =>
  fakeExec(s === undefined ? {} : { agent: { session: s, options } as unknown as ToolRunContext['agent'] })

/** services：按名字给的宿主服务；值是函数时每次查找调用它（可以抛错）。 */
function boot(services: Record<string, unknown> = {}) {
  const warnings: string[] = []
  const host = createCordisHostSession({
    lookup: name => {
      const v = services[name]
      return typeof v === 'function' ? (v as () => unknown)() : v
    },
    logger: { warn: message => { warnings.push(message) } },
    resolveCwd: async cwd => (cwd === undefined ? undefined : `/ws${cwd}`),
  })
  return { host, warnings }
}

/** 投影注册表替身：按键给状态；值是函数时调用它（可以抛错）。 */
const projections = (states: Record<string, unknown>) => ({
  stateOf: (_s: object, key: string) => {
    const v = states[key]
    return typeof v === 'function' ? (v as () => unknown)() : v
  },
})
const throwing = () => { throw new Error('boom') }

describe('PA-28 宿主服务缺席、未注册、调用抛错时各自退化，同一会话同一类退化只警告一次', () => {
  const turnAnchorCases: Array<[string, Record<string, unknown>, string]> = [
    ['服务缺席', {}, 'service is absent'],
    ['投影未注册', { sessionProjections: projections({}) }, 'not registered'],
    ['查找抛错', { sessionProjections: throwing }, 'threw'],
    ['读取抛错', { sessionProjections: projections({ turnBoundary: throwing }) }, 'threw: Error: boom'],
    ['没有开着的轮', { sessionProjections: projections({ turnBoundary: { openTurnStartSeq: null } }) }, 'no open turn'],
    ['投影缺字段', { sessionProjections: projections({ turnBoundary: {} }) }, 'undefined'],
  ]
  it.each(turnAnchorCases)('证据锚读不到 turnBoundary（%s）：起点为 0，每个会话警告一次', async (_label, services, reason) => {
    const { host, warnings } = boot(services)
    const a = session('sess-a')
    expect((await host.contextOf(execOf(a))).session.turnStartSeq).toBe(0)
    await host.contextOf(execOf(a))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('sess-a')
    expect(warnings[0]).toContain(reason)
    await host.contextOf(execOf(session('sess-b')))
    expect(warnings).toHaveLength(2)
  })

  it('证据锚读得到：起点取投影的 openTurnStartSeq，终点是 seq - 1，不警告', async () => {
    const { host, warnings } = boot({ sessionProjections: projections({ turnBoundary: { openTurnStartSeq: 3 } }) })
    const at = (seq: number) => ({ header: { id: 'sess-a' }, seq }) as unknown as Session
    expect((await host.contextOf(execOf(at(7)))).session).toMatchObject({ turnStartSeq: 3, lastSeq: 6 })
    expect((await host.contextOf(execOf(at(0)))).session.lastSeq).toBe(0)
    expect(warnings).toEqual([])
  })

  const modeCases: Array<[string, Record<string, unknown>, string]> = [
    ['服务缺席', {}, 'service is absent'],
    ['投影未注册', { sessionProjections: projections({ turnBoundary: { openTurnStartSeq: 0 } }) }, 'not registered'],
    ['读取抛错', { sessionProjections: projections({ turnBoundary: { openTurnStartSeq: 0 }, subagent: throwing }) }, 'threw'],
  ]
  it.each(modeCases)('子会话 mode 读不到（%s）：按一次性，每个会话警告一次', async (_label, services, reason) => {
    const { host, warnings } = boot(services)
    const child = session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    expect(host.modeOf(child)).toBe('one-shot')
    expect((await host.contextOf(execOf(child))).delegation?.mode).toBe('one-shot')
    const modeWarnings = warnings.filter(w => w.includes('subagent'))
    expect(modeWarnings).toHaveLength(1)
    expect(modeWarnings[0]).toContain('sess-child')
    expect(modeWarnings[0]).toContain(reason)
    expect(modeWarnings[0]).toContain('one-shot')
  })

  it('子会话 mode 读得到（可续、一次性、空状态）：照读，不警告', () => {
    const child = session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    for (const [state, mode] of [[{ identity: { mode: 'continuable' } }, 'continuable'], [{ identity: { mode: 'one-shot' } }, 'one-shot'], [{}, 'one-shot']] as const) {
      const { host, warnings } = boot({ sessionProjections: projections({ subagent: state }) })
      expect(host.modeOf(child)).toBe(mode)
      expect(warnings).toEqual([])
    }
  })

  it('同一会话不同原因各警告一次：证据锚与 mode 互不吞掉', async () => {
    const { host, warnings } = boot()
    const child = session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    await host.contextOf(execOf(child))
    await host.contextOf(execOf(child))
    expect(warnings.filter(w => w.includes('turnBoundary'))).toHaveLength(1)
    expect(warnings.filter(w => w.includes('subagent'))).toHaveLength(1)
  })

  it('基线：读取抛错为 null，每个会话警告一次；服务缺席、查找抛错、键未注册为 null 且不警告', () => {
    const s = session('sess-a')
    const broken = boot({ sessionProjections: projections({ plasticMemoryBaseline: throwing }) })
    expect(broken.host.baselineOf(execOf(s))).toBeNull()
    expect(broken.host.baselineOf(execOf(s))).toBeNull()
    expect(broken.warnings).toHaveLength(1)
    expect(broken.warnings[0]).toContain('plasticMemoryBaseline')
    expect(broken.warnings[0]).toContain('sess-a')
    expect(broken.warnings[0]).toContain('boom')
    for (const services of [{}, { sessionProjections: throwing }, { sessionProjections: projections({}) }]) {
      const quiet = boot(services)
      expect(quiet.host.baselineOf(execOf(s))).toBeNull()
      expect(quiet.warnings).toEqual([])
    }
    expect(boot().host.baselineOf(execOf())).toBeNull()
  })

  it('基线：取当前生效的正文；状态里的形状漂移每个会话每个 seq 只警告一次', () => {
    const state = { entries: [{ text: '用 pnpm', scopes: ['.'] }], baselineScopes: ['.'], drift: [{ seq: 0, kind: 'no-changes' }] }
    const { host, warnings } = boot({ sessionProjections: projections({ plasticMemoryBaseline: state }) })
    const a = session('sess-a')
    expect(host.baselineOf(execOf(a))).toEqual(['用 pnpm'])
    expect(host.baselineOf(execOf(a))).toEqual(['用 pnpm'])
    expect(warnings).toEqual(['agent-instructions message at seq 0 carries no changes array; keeping its text without scope tracking'])
    host.baselineOf(execOf(session('sess-b')))
    expect(warnings).toHaveLength(2)
    const empty = boot({ sessionProjections: projections({ plasticMemoryBaseline: { entries: [], baselineScopes: [], drift: [] } }) })
    expect(empty.host.baselineOf(execOf(a))).toBeNull()
  })

  it('更早的轮：读不到（缺席、抛错）按没有；lastTurn 大于 1 才算', () => {
    const s = session('sess-a')
    expect(boot().host.hasEarlierTurns(s)).toBe(false)
    expect(boot({ sessionProjections: throwing }).host.hasEarlierTurns(s)).toBe(false)
    expect(boot({ sessionProjections: projections({ turnBoundary: { lastTurn: 1 } }) }).host.hasEarlierTurns(s)).toBe(false)
    expect(boot({ sessionProjections: projections({ turnBoundary: { lastTurn: 2 } }) }).host.hasEarlierTurns(s)).toBe(true)
  })

  it('模型：会话的模型按路由请求配置优先、agent 选项兜底；llm 服务缺席或路由不全为 null', () => {
    const llm = { stream: async function* () {} }
    const routed = Object.assign(session('sess-a'), { requestHeader: () => ({ config: { provider: 'p1', model: 'm1' } }) })
    expect(boot({ llm }).host.llmOf(execOf(routed, { provider: 'p2', model: 'm2' }))?.model).toBe('m1')
    expect(boot({ llm }).host.llmOf(execOf(session('sess-b'), { provider: 'p2', model: 'm2' }))?.model).toBe('m2')
    expect(boot({ llm }).host.llmOf(execOf(session('sess-b'), { provider: 'p2' }))).toBeNull()
    expect(boot().host.llmOf(execOf(session('sess-b'), { provider: 'p2', model: 'm2' }))).toBeNull()
    expect(boot({ llm: throwing }).host.llmOf(execOf(session('sess-b'), { provider: 'p2', model: 'm2' }))).toBeNull()
  })

  it('默认模型：取 agentDefaultModel 的当前选择；服务缺席或读取抛错为 null', () => {
    const llm = { stream: async function* () {} }
    expect(boot({ llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }).host.defaultLlm()?.model).toBe('m')
    expect(boot({ llm }).host.defaultLlm()).toBeNull()
    expect(boot({ llm, agentDefaultModel: { currentSelection: throwing } }).host.defaultLlm()).toBeNull()
  })

  it('没有会话：会话 id 用哨兵，证据锚全为 0，不带委派、不警告', async () => {
    const { host, warnings } = boot()
    const context = await host.contextOf(execOf())
    expect(context).toEqual({ workspacePath: undefined, delegationDepth: 0, session: { id: UNKNOWN_SESSION_ID, lastSeq: 0, turnStartSeq: 0 } })
    expect(warnings).toEqual([])
  })
})

describe('PA-29 子 agent 的保存上下文沿父链解析到根会话；父链读不到时根会话留空、不报错', () => {
  const continuable = projections({ turnBoundary: { openTurnStartSeq: 0 }, subagent: { identity: { mode: 'continuable' } } })
  /** sessionQuery 替身：filterSessions 按 id 给出 header，记下问过哪些 id。 */
  function fakeQuery(headers: Array<{ id: string; delegationDepth?: number; parentSession?: string }>) {
    const asked: string[] = []
    return {
      asked,
      async filterSessions(filters: ReadonlyArray<{ kind: 'id'; values: readonly string[] }>) {
        const ids = filters.flatMap(f => f.values)
        asked.push(...ids)
        return headers.filter(h => ids.includes(h.id)).map(header => ({ header }))
      },
    }
  }

  it('深度 2：问 sessionQuery 走到深度 0 的根；委派带深度、直接父会话、mode', async () => {
    const query = fakeQuery([{ id: 'sess-mid', delegationDepth: 1, parentSession: 'sess-root' }, { id: 'sess-root' }])
    const { host } = boot({ sessionProjections: continuable, sessionQuery: query })
    const leaf = session('sess-leaf', { cwd: '/a', delegationDepth: 2, parentSession: 'sess-mid' })
    const context = await host.saveContextOf(execOf(leaf))
    expect(context.workspacePath).toBe('/ws/a')
    expect(context.delegation).toEqual({ depth: 2, parentSessionId: 'sess-mid', mode: 'continuable', rootSessionId: 'sess-root' })
    expect(query.asked).toEqual(['sess-mid', 'sess-root'])
  })

  it('见过的 header 先查缓存：记住过的父会话不再问 sessionQuery', async () => {
    const query = fakeQuery([])
    const { host } = boot({ sessionProjections: continuable, sessionQuery: query })
    host.remember({ id: 'sess-main' })
    const child = session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    expect((await host.saveContextOf(execOf(child))).delegation?.rootSessionId).toBe('sess-main')
    expect(query.asked).toEqual([])
  })

  it('任一跳读不到（服务缺席、查无此会话、第二跳断、查询抛错、宿主没有 filterSessions）：根会话留空，其余照常', async () => {
    const child = session('sess-d2', { delegationDepth: 2, parentSession: 'sess-d1' })
    const broken = { async filterSessions() { throw new Error('boom') } }
    const secondHopGone = fakeQuery([{ id: 'sess-d1', delegationDepth: 1, parentSession: 'sess-gone' }])
    for (const sessionQuery of [undefined, fakeQuery([]), secondHopGone, broken, throwing, { readEvent: async () => ({ events: [] }) }]) {
      const { host } = boot({ sessionProjections: continuable, sessionQuery })
      const context = await host.saveContextOf(execOf(child))
      expect(context.delegation).toEqual({ depth: 2, parentSessionId: 'sess-d1', mode: 'continuable' })
    }
  })

  it('用户 fork 出来的主会话是它自己那棵树的根，不再往上走', async () => {
    const query = fakeQuery([{ id: 'sess-orig' }, { id: 'sess-fork', parentSession: 'sess-orig' }])
    const { host } = boot({ sessionProjections: continuable, sessionQuery: query })
    const child = session('sess-child', { delegationDepth: 1, parentSession: 'sess-fork' })
    expect((await host.saveContextOf(execOf(child))).delegation).toMatchObject({ parentSessionId: 'sess-fork', rootSessionId: 'sess-fork' })
    expect(query.asked).toEqual(['sess-fork'])
  })

  it('最多走「深度」跳：父链深度不降（宿主数据异常）时停下，根会话留空', async () => {
    const query = fakeQuery([
      { id: 'sess-p', delegationDepth: 1, parentSession: 'sess-q' },
      { id: 'sess-q', delegationDepth: 1, parentSession: 'sess-p' },
    ])
    const { host } = boot({ sessionProjections: continuable, sessionQuery: query })
    const child = session('sess-child', { delegationDepth: 1, parentSession: 'sess-p' })
    expect((await host.saveContextOf(execOf(child))).delegation).not.toHaveProperty('rootSessionId')
    expect(query.asked).toEqual(['sess-p'])
  })

  it('主会话、用户 fork 的会话（深度 0 带 parentSession）不带委派，不读父链，也不读 subagent 投影', async () => {
    const query = fakeQuery([{ id: 'sess-main' }])
    const { host, warnings } = boot({ sessionProjections: projections({ turnBoundary: { openTurnStartSeq: 0 } }), sessionQuery: query })
    expect((await host.saveContextOf(execOf(session('sess-fork', { parentSession: 'sess-main' })))).delegation).toBeUndefined()
    expect(query.asked).toEqual([])
    expect(warnings).toEqual([])
  })

  it('持久型子会话自己的会话 id：深度 ≥ 1 且可续才有', () => {
    const { host } = boot({ sessionProjections: continuable })
    expect(host.ownSessionIdOf(session('sess-child', { delegationDepth: 1 }))).toBe('sess-child')
    expect(host.ownSessionIdOf(session('sess-main'))).toBeUndefined()
    const oneShot = boot({ sessionProjections: projections({ subagent: { identity: { mode: 'one-shot' } } }) })
    expect(oneShot.host.ownSessionIdOf(session('sess-child', { delegationDepth: 1 }))).toBeUndefined()
  })

  it('会话所属项目按 cwd 解析，没有工作目录为 undefined', async () => {
    const { host } = boot()
    expect(await host.workspaceOf(session('sess-a', { cwd: '/a' }))).toBe('/ws/a')
    expect(await host.workspaceOf(session('sess-b'))).toBeUndefined()
  })
})
