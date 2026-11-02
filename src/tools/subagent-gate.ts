import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { ToolGateCode } from '../contract-codes.ts'
import type { SaveDelegation } from '../pipeline.ts'

// 宿主 subagent 投影（dsh-subagent 注册）的内部状态：插件只读 identity.mode，按宿主形状局部登记这一项，
// 不为一个键把 dsh-subagent 及其一串宿主 peer 拉进开发依赖。无有效描述符时状态是 {}。
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    subagent: { identity?: { mode: SaveDelegation['mode'] } }
  }
}

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

/**
 * 子会话是一次性还是持久型：读宿主 subagent 投影的 identity.mode，不读日志、不落盘。没有 identity（{}）按一次性；
 * 服务缺席、投影未注册、读取抛错也按一次性，fallback 写明原因（由调用方决定怎么留痕）。
 */
export function subagentModeOf(
  projections: Pick<SessionProjectionRegistry, 'stateOf'> | undefined,
  session: Session,
): { mode: SaveDelegation['mode']; fallback?: string } {
  if (projections === undefined) return { mode: 'one-shot', fallback: 'sessionProjections service is absent' }
  try {
    const state = projections.stateOf(session, 'subagent')
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
  resolveContext: (exec: ToolRunContext) => Promise<{ delegationDepth: number }>,
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
      if ((await resolveContext(exec)).delegationDepth < 1 || allowSubagent?.()) return tool.execute(args, exec)
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
