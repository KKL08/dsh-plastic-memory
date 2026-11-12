import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import type { SaveDelegation } from '../pipeline.ts'
import type { DelegationHeader } from './subagent-gate.ts'

/** 宿主没给会话 id 时用的哨兵：会话视图、新写入名单遇到它都跳过。 */
export const UNKNOWN_SESSION_ID = 'unknown'

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
    /** 证据锚起点：当轮 turn/start 的位置；读不到为 0（整会话锚）。 */
    turnStartSeq: number
    /** 宿主 session 对象本身：检索按它找本会话的冻结快照、做召回去重。 */
    handle?: Session
  }
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
  modeOf(session: Session): SaveDelegation['mode']
  /** 会话是否已过了第 1 轮（重启续上或插件重载）。 */
  hasEarlierTurns(session: object): boolean
  /** 记下见过的会话 header，根会话解析先查这里。 */
  remember(header: Partial<DelegationHeader> | undefined): void
  /** 持久型子会话（深度 ≥ 1 且可续）自己的会话 id；主会话、一次性子会话为 undefined。 */
  ownSessionIdOf(session: object): string | undefined
  /** 会话所属项目：按会话的 cwd 解析，没有工作目录为 undefined。 */
  workspaceOf(session: object): Promise<string | undefined>
}
