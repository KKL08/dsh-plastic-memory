import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import type { HostModelRoute } from '../governance/host-llm.ts'
import type { HostModelCatalog } from '../governance/background-llm.ts'
import type { SaveDelegation } from '../pipeline.ts'
import type { DelegationHeader } from './subagent-gate.ts'
import type { SessionLog } from '../session-log.ts'
import { UNKNOWN_SESSION_ID } from '../session-id.ts'

/** 宿主没给会话 id 时用的哨兵：会话视图、新写入名单遇到它都跳过。 */
export { UNKNOWN_SESSION_ID }

/** 只要上下文一部分的消费者收的 host：HostSession 结构上满足它，装配处传同一个对象。 */
export interface ContextHost<C> {
  contextOf(exec: ToolRunContext): Promise<C>
}

/** 工具执行时的会话上下文：全部来自宿主，不来自工具参数。 */
export interface HostContext {
  workspacePath: string | undefined
  delegationDepth: number
  /** 子 agent 会话（深度 ≥ 1）才有；saveContextOf 另带沿父链解析出的根会话。 */
  delegation?: SaveDelegation
  session: {
    id: string
    /** 证据锚终点：会话里最后一条事件的位置。 */
    lastSeq: number
    /** 证据锚起点：当轮 turn/start 的位置；读不到为 undefined（锚退回整会话，判发起方时按保存点找当轮）。 */
    turnStartSeq: number | undefined
    /** 宿主 session 对象本身：检索按它找本会话的冻结快照、做召回去重。 */
    handle?: Session
  }
}

/** 宿主登记的一个会话：工作目录（没有为 undefined）、是不是子 agent 会话、此刻是不是开着。 */
export interface HostSessionEntry {
  id: string
  cwd: string | undefined
  isSubagent: boolean
  isLive: boolean
}

/**
 * 插件读宿主会话的唯一入口。宿主服务缺席、键未注册、读取抛错时各方法自己退化（null、0、按一次性），
 * 同一会话同一类退化只警告一次；调用方不处理宿主异常。
 */
export interface HostSession {
  contextOf(exec: ToolRunContext): Promise<HostContext>
  /** contextOf 加一步：子会话沿父链解析根会话（只有保存才读祖先 header）。 */
  saveContextOf(exec: ToolRunContext): Promise<HostContext>
  /** 触发调用的会话所用的模型；拿不到为 null，不改用默认模型。 */
  llmOf(exec: ToolRunContext): SemanticLlm | null
  /** 无会话时（自动体检）用宿主的默认模型选择，每次现读。 */
  defaultLlm(): SemanticLlm | null
  /** 无会话时按一份模型选择（提供方、模型、可选的推理强度）调用；宿主没有 llm 服务、路由不全为 null。 */
  llmForRoute(route: Pick<HostModelRoute, 'provider' | 'model' | 'reasoningEffort'>): SemanticLlm | null
  /** 宿主 llm 服务里列提供方、列模型的部分，每次现取；宿主没有、或服务缺这几个方法时为 undefined。 */
  modelCatalog(): HostModelCatalog | undefined
  modeOf(session: Session): SaveDelegation['mode']
  /** 会话是否已过了第 1 轮（重启续上或插件重载）。 */
  hasEarlierTurns(session: object): boolean
  /** 记下见过的会话 header，根会话解析先查这里。 */
  remember(header: Partial<DelegationHeader> | undefined): void
  /** 持久型子会话（深度 ≥ 1 且可续）自己的会话 id；主会话、一次性子会话为 undefined。 */
  ownSessionIdOf(session: object): string | undefined
  /** 会话所属项目：按会话的 cwd 解析，没有工作目录为 undefined。 */
  workspaceOf(session: object): Promise<string | undefined>
  /** 会话标题；没有标题、服务缺席或读取抛错为 undefined。 */
  sessionTitleOf(sessionId: string): Promise<string | undefined>
  /** 一个会话的整份日志（活会话取当下的样子，没打开的读落盘的）；读不到为 null。 */
  readSessionLog(sessionId: string): Promise<SessionLog | null>
  /** 宿主登记的全部会话（含已存档的）；服务缺席或读取抛错为 null，调用方按「这一次列不出来」处理，不当成一个会话都没有。 */
  listSessions(): Promise<HostSessionEntry[] | null>
  /**
   * 宿主登记为已存档的会话 id（宿主的工作区登记表，各进程共用），每次现读。服务缺席、字段不是字符串数组、读取抛错为 null：
   * 调用方按「这一次不知道」处理，不当成没有存档的会话。
   */
  archivedSessionIds(): Promise<ReadonlySet<string> | null>
  /**
   * 这次工具调用所在 agent 用的工具结果裁剪服务，每次现取（宿主改配置后实例会换）；没有为 undefined。
   * 取服务抛错时照常抛出，调用方按「阈值读不出」处理。
   */
  toolResultPrunerOf(exec: ToolRunContext): unknown
}
