import { randomUUID } from 'node:crypto'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SaveDelegation } from './pipeline.ts'
import { UNKNOWN_SESSION_ID, type HostContext, type HostSession } from './tools/host-session.ts'
import { delegationDepthOf, resolveRootSessionId, subagentModeOf, type DelegationHeader, type ProjectionReader } from './tools/subagent-gate.ts'
import type { SemanticLlm } from './governance/semantic-scan.ts'
import type { RawEvent, SessionHeaderLike, SessionLog } from './session-log.ts'
import { hostSemanticLlm, type HostLlmService, type HostModelRoute } from './governance/host-llm.ts'
import type { HostModelCatalog } from './governance/background-llm.ts'

export interface CordisHostSessionDeps {
  /** 按名字查宿主服务：生产传 name => ctx.get(name)，测试传假查找。 */
  lookup: (name: string) => unknown
  logger: { warn(message: string): void }
  /** cwd → 项目路径（装配入口顺带记会话归属对照）。 */
  resolveCwd: (cwd: string | undefined) => Promise<string | undefined>
}

type SessionHeader = { id?: string; cwd?: string; delegationDepth?: number; parentSession?: string }

/** dsh-agent turnBoundary 投影里插件读的两个字段（宿主形状的子集）。 */
type TurnBoundaryState = { lastTurn?: number; openTurnStartSeq?: number | null }

/** sessionQuery.readSession 的最小契约：下界和钉版宿主都返回 header、继承前缀长度和全部事件。 */
type LogQuery = { readSession?(sessionId: string): Promise<{ session?: SessionHeaderLike; inheritedEventCount?: number; events?: RawEvent[] }> }

type HeaderQuery = { filterSessions?(filters: ReadonlyArray<{ kind: 'id'; values: readonly string[] }>): Promise<Array<{ header: DelegationHeader }>> }

/**
 * 宿主会话适配器（cordis 宿主）。服务一律按调用经 lookup 探测、不进 inject：cordis 的 Context 是 proxy，
 * 未 inject 的服务名走属性访问会抛错，ctx.get 是安全查找、未注册返回 undefined；下面的 try/catch 防宿主行为变化。
 * 服务缺席（如不带 agent-loop 的 profile）、投影未注册、读取抛错都退化，但不能悄无声息：同一会话同一原因第一次退化时打 warn。
 */
export function createCordisHostSession(deps: CordisHostSessionDeps): HostSession {
  const { logger, resolveCwd } = deps
  const probe = <T>(name: string): T | undefined => {
    try {
      return deps.lookup(name) as T | undefined
    } catch {
      return undefined
    }
  }

  const warned = new WeakMap<object, Set<string>>()
  const warnOnce = (session: object, key: string, message: string) => {
    let keys = warned.get(session)
    if (keys === undefined) warned.set(session, keys = new Set())
    if (keys.has(key)) return
    keys.add(key)
    logger.warn(message)
  }

  // 有会话（memory_scan、借用会话的 /memory 命令）：用这个会话的模型。解析顺序对齐宿主 compaction 摘要器：
  // session.requestHeader()?.config（最近一次路由请求的配置）→ agent.options.provider/model；拿不到就是 null，
  // 体检和「让模型改」回 llm-unavailable——用户在那个会话里选的模型才是这次该用的。
  // 会话 id 由借用会话派生、不用原 id：宿主按原 id 会把这次请求当成那个对话的一轮（附带上传它的会话日志、往里追加事件），
  // 派生 id 查不到会话，这些都不发生；同一对话里的请求仍共用一个 id，路由和缓存照样认得。
  const llmOf = (exec: ToolRunContext): SemanticLlm | null => {
    const session = exec.agent?.session as { header?: SessionHeader; requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined } | undefined
    const routed = session?.requestHeader?.()?.config
    return hostSemanticLlm(probe<HostLlmService>('llm'), {
      provider: routed?.provider ?? exec.agent?.options?.provider,
      model: routed?.model ?? exec.agent?.options?.model,
      sessionId: session?.header?.id === undefined ? undefined : `plastic-memory-${session.header.id}`,
    })
  }

  // 无会话（自动体检）：用宿主的默认模型选择（agentDefaultModel 的当前选择：新建 agent 用它，
  // 用户在对话里换模型时它通常跟着变）。每次开跑现读、不缓存；服务缺席或读取抛错就是 null，自动体检记「模型用不了」。
  // 没有会话 id 可借，每次开跑另起一个，满足要求带会话头的提供方。
  const defaultLlm = (): SemanticLlm | null => {
    let route: HostModelRoute | undefined
    try {
      route = probe<{ currentSelection(): HostModelRoute }>('agentDefaultModel')?.currentSelection()
    } catch {
      return null
    }
    return hostSemanticLlm(probe<HostLlmService>('llm'), route && { ...route, sessionId: `plastic-memory-checkup-${randomUUID()}` })
  }

  // 无会话、按选中的模型（自动体检、梦境选了模型时）：同默认模型，每次另起一个派生的会话 id
  const llmForRoute = (route: Pick<HostModelRoute, 'provider' | 'model' | 'reasoningEffort'>): SemanticLlm | null =>
    hostSemanticLlm(probe<HostLlmService>('llm'), { ...route, sessionId: `plastic-memory-background-${randomUUID()}` })

  // 列模型：宿主 llm 服务的 listProviders / listModels / resolveModelInfo，缺一个就当没有
  const modelCatalog = (): HostModelCatalog | undefined => {
    const llm = probe<Partial<HostModelCatalog>>('llm')
    return typeof llm?.listProviders === 'function' && typeof llm.listModels === 'function' && typeof llm.resolveModelInfo === 'function'
      ? llm as HostModelCatalog
      : undefined
  }

  /**
   * 读不到 turnBoundary 投影一律 undefined：锚退回整会话，判发起方时按保存点找当轮，不把 0 当成轮起点。
   * 证据锚终点 = session.seq - 1（seq 是下一条事件的位置）。
   */
  const openTurnStartSeq = (session: Session): number | undefined => {
    let reason: string
    try {
      const projections = deps.lookup('sessionProjections') as ProjectionReader | undefined
      if (projections === undefined) {
        reason = 'sessionProjections service is absent'
      } else {
        const turn = projections.stateOf(session, 'turnBoundary') as TurnBoundaryState | undefined
        if (turn === undefined) reason = 'turnBoundary projection is not registered'
        else if (typeof turn.openTurnStartSeq === 'number') return turn.openTurnStartSeq
        else reason = `openTurnStartSeq is ${String(turn.openTurnStartSeq)} (no open turn)`
      }
    } catch (error) {
      reason = `projection read threw: ${String(error)}`
    }
    warnOnce(session, 'turn-anchor', `[plastic-memory] 会话 "${session.header.id}" 读不到 turnBoundary 投影，出处锚到整个会话：${reason}`)
    return undefined
  }

  /** 子会话的 mode：读不到按一次性。 */
  const modeOf = (session: Session): SaveDelegation['mode'] => {
    const { mode, fallback } = subagentModeOf(probe<ProjectionReader>('sessionProjections'), session)
    if (fallback !== undefined) {
      warnOnce(session, 'subagent-mode', `[plastic-memory] 会话 "${session.header.id}" 读不到 subagent 投影，按一次性子会话（one-shot）处理：${fallback}`)
    }
    return mode
  }

  /** 读 turnBoundary 投影的 lastTurn（宿主按事件增量折叠，不读日志）；读不到按没有。 */
  const hasEarlierTurns = (session: object): boolean => {
    try {
      const projections = deps.lookup('sessionProjections') as ProjectionReader | undefined
      return ((projections?.stateOf(session as Session, 'turnBoundary') as TurnBoundaryState | undefined)?.lastTurn ?? 0) > 1
    } catch {
      return false
    }
  }

  // 进程内见过的会话 header（委派三项宿主写入后不变）：根会话解析先查这里，查不到再问 sessionQuery
  const knownHeaders = new Map<string, DelegationHeader>()
  const remember = (header: Partial<DelegationHeader> | undefined) => {
    if (header?.id === undefined) return
    knownHeaders.set(header.id, { id: header.id, delegationDepth: header.delegationDepth, parentSession: header.parentSession })
  }
  /** 缓存优先，再问 sessionQuery（filterSessions 按 id，只读 header、不读事件）；读不到返回 undefined（根会话留空）。 */
  const lookupHeader = async (id: string): Promise<DelegationHeader | undefined> => {
    const known = knownHeaders.get(id)
    if (known !== undefined) return known
    try {
      const records = await probe<HeaderQuery>('sessionQuery')?.filterSessions?.([{ kind: 'id', values: [id] }])
      const header = records?.find(r => r.header.id === id)?.header
      remember(header)
      return header
    } catch {
      return undefined
    }
  }

  // 子 agent 会话（深度 ≥ 1）另带委派上下文：直接父会话取 header.parentSession（深度 0 的会话也可能带它，那是用户 fork，不算委派）
  const contextOf = async (exec: ToolRunContext): Promise<HostContext> => {
    const session = exec.agent?.session
    remember(session?.header)
    const delegationDepth = delegationDepthOf(session)
    const delegation: SaveDelegation | undefined = session && delegationDepth >= 1
      ? { depth: delegationDepth, parentSessionId: session.header.parentSession ?? UNKNOWN_SESSION_ID, mode: modeOf(session) }
      : undefined
    return {
      workspacePath: await resolveCwd(session?.header.cwd),
      delegationDepth,
      ...(delegation ? { delegation } : {}),
      session: {
        id: session?.header.id ?? UNKNOWN_SESSION_ID,
        lastSeq: session ? Math.max(session.seq - 1, 0) : 0,
        turnStartSeq: session ? openTurnStartSeq(session) : undefined,
        ...(session ? { handle: session } : {}),
      },
    }
  }

  const saveContextOf = async (exec: ToolRunContext): Promise<HostContext> => {
    const context = await contextOf(exec)
    const header = exec.agent?.session?.header
    if (context.delegation === undefined || header === undefined) return context
    const rootSessionId = await resolveRootSessionId(header, lookupHeader)
    return rootSessionId === undefined ? context : { ...context, delegation: { ...context.delegation, rootSessionId } }
  }

  // 持久型子会话的注入带上它自己创建的待确认记录；mode 每次现读 subagent 投影
  const ownSessionIdOf = (session: object): string | undefined => {
    const s = session as Session
    return delegationDepthOf(s) >= 1 && modeOf(s) === 'continuable' ? s.header.id : undefined
  }

  const workspaceOf = (session: object) => resolveCwd((session as { header?: SessionHeader }).header?.cwd)

  // 读整份日志：继承前缀长度原样交回，宿主没给就留空——调用方据此判「分不清归属」，不能补成 0 当成都是自己的。
  // 读不到的原因按会话 id 只警告一次：保存时每次都读，坏掉的服务不该刷屏
  const warnedLogs = new Set<string>()
  const readSessionLog = async (sessionId: string): Promise<SessionLog | null> => {
    if (sessionId === UNKNOWN_SESSION_ID) return null
    let reason: string
    try {
      const query = probe<LogQuery>('sessionQuery')
      if (query === undefined) reason = 'sessionQuery service is absent'
      else if (typeof query.readSession !== 'function') reason = 'sessionQuery has no readSession'
      else {
        const read = await query.readSession(sessionId)
        if (Array.isArray(read?.events)) {
          return {
            header: read.session ?? {},
            inheritedEventCount: typeof read.inheritedEventCount === 'number' ? read.inheritedEventCount : undefined,
            events: read.events,
          }
        }
        reason = 'readSession returned no event list'
      }
    } catch (error) {
      reason = `readSession threw: ${String(error)}`
    }
    const key = `${sessionId}\u0000${reason}`
    if (!warnedLogs.has(key)) {
      warnedLogs.add(key)
      logger.warn(`[plastic-memory] 读不到会话 "${sessionId}" 的日志：${reason}`)
    }
    return null
  }

  const sessionTitleOf = async (sessionId: string): Promise<string | undefined> => {
    try {
      return (await probe<{ readTitle?(id: string): Promise<{ title: string } | undefined> }>('sessionQuery')?.readTitle?.(sessionId))?.title || undefined
    } catch {
      return undefined
    }
  }

  return { sessionTitleOf, contextOf, saveContextOf, llmOf, defaultLlm, llmForRoute, modelCatalog, modeOf, hasEarlierTurns, remember, ownSessionIdOf, workspaceOf, readSessionLog }
}
