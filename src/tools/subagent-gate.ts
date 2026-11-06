import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolGateCode } from '../contract-codes.ts'
import type { SaveDelegation } from '../pipeline.ts'

/**
 * 宿主投影注册表里插件用到的读法：按键读状态。宿主 0.2.2 起这个读法的状态类型是 unknown（0.2.1 按键表给具体类型），
 * 插件按自己读的字段局部写类型，两版宿主都能编译。
 */
export interface ProjectionReader {
  stateOf(session: Session, key: string): unknown
}

// 宿主 subagent 投影（dsh-subagent 注册）的内部状态：插件只读 identity.mode，按宿主形状局部写这一项，
// 不为一个键把 dsh-subagent 及其一串宿主 peer 拉进开发依赖。无有效描述符时状态是 {}。
type SubagentState = { identity?: { mode: SaveDelegation['mode'] } }

/**
 * 子 agent 只读门：子 agent 的上下文是裁剪过的任务切片，写出的记忆缺主会话语境、出处锚也指向子会话，
 * 所以写入与治理工具在子 agent 会话里拒绝；search、source、health 与注入不经过这道门。
 * 例外只有 memory_save：注册时给放行条件（治理开启），子 agent 写入的记录落待确认，由主会话决定去留。
 * 门在注册处统一套上，各工具的参数与执行器不感知它。
 */

const SUBAGENT_READONLY: ToolGateCode = 'subagent-readonly'
const BRING_BACK = '把要记的事实或治理动作带回主会话'

export interface SubagentReadonlyResult {
  kind: 'rejected'
  code: ToolGateCode
  message: string
}

/** 宿主会话 header 的 delegationDepth：子 agent 为父深度 + 1，主会话缺省（按 0）。 */
export function delegationDepthOf(session: { header: { delegationDepth?: number } } | undefined): number {
  return session?.header.delegationDepth ?? 0
}

/** 宿主会话 header 里根会话解析用到的三项（宿主写入后不变）。 */
export interface DelegationHeader {
  id: string
  delegationDepth?: number
  parentSession?: string
}

/**
 * 根会话：沿 parentSession 往上走，遇到深度为 0（或缺省）的会话即停，它就是根——用户 fork 出来的主会话也在这里停，
 * 是它自己那棵树的根。最多走 start 的深度那么多跳；任何一跳读不到、或走满仍没到深度 0，返回 undefined（记录照存、不带根）。
 */
export async function resolveRootSessionId(
  start: DelegationHeader,
  lookup: (id: string) => Promise<DelegationHeader | undefined>,
): Promise<string | undefined> {
  let current = start
  for (let hop = 0; hop < delegationDepthOf({ header: start }); hop++) {
    if (current.parentSession === undefined) return undefined
    const parent = await lookup(current.parentSession)
    if (parent === undefined) return undefined
    if (delegationDepthOf({ header: parent }) < 1) return parent.id
    current = parent
  }
  return undefined
}

/**
 * 子会话是一次性还是持久型：读宿主 subagent 投影的 identity.mode，不读日志、不落盘。没有 identity（{}）按一次性；
 * 服务缺席、投影未注册、读取抛错也按一次性，fallback 写明原因（由调用方决定怎么留痕）。
 */
export function subagentModeOf(
  projections: ProjectionReader | undefined,
  session: Session,
): { mode: SaveDelegation['mode']; fallback?: string } {
  if (projections === undefined) return { mode: 'one-shot', fallback: 'sessionProjections service is absent' }
  try {
    const state = projections.stateOf(session, 'subagent') as SubagentState | undefined
    if (state === undefined) return { mode: 'one-shot', fallback: 'subagent projection is not registered' }
    return { mode: state.identity?.mode ?? 'one-shot' }
  } catch (error) {
    return { mode: 'one-shot', fallback: `projection read threw: ${String(error)}` }
  }
}

/**
 * 给写工具套上只读门：depth ≥ 1 时不进执行器，直接返回 subagent-readonly；工具说明补一句。
 * allowSubagent 是放行条件，每次调用现读（开关热切换后下一次调用即生效）；工具说明按注册时的取值写，条件变了由调用方重注册。
 */
export function gateSubagentWrites(
  tool: ToolDefinition,
  host: { contextOf(exec: ToolRunContext): Promise<{ delegationDepth: number }> },
  allowSubagent?: () => boolean,
): ToolDefinition {
  return {
    ...tool,
    description: allowSubagent?.()
      ? tool.description
      : `${tool.description}\n子 agent 会话里不可用（返回 ${SUBAGENT_READONLY}）：${BRING_BACK}。`,
    output: {
      ...tool.output,
      render: (args, value) => isSubagentReadonly(value)
        ? [{ type: 'text', text: value.message }]
        : tool.output.render(args, value),
    },
    execute: async (args, exec) => {
      if ((await host.contextOf(exec)).delegationDepth < 1 || allowSubagent?.()) return tool.execute(args, exec)
      const result: SubagentReadonlyResult = {
        kind: 'rejected',
        code: SUBAGENT_READONLY,
        message: `子 agent 会话只读，${tool.name} 不可用。请${BRING_BACK}，由主会话保存或处理。`,
      }
      return result
    },
  }
}

function isSubagentReadonly(value: unknown): value is SubagentReadonlyResult {
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === SUBAGENT_READONLY
}
