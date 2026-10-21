import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ToolGateCode } from '../contract-codes.ts'

/**
 * 子 agent 只读门：子 agent 的上下文是裁剪过的任务切片，写出的记忆缺主会话语境、出处锚也指向子会话，
 * 所以写入与治理工具在子 agent 会话里一律拒绝；search、source、health 与注入不经过这道门。
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

/** 给写工具套上只读门：depth ≥ 1 时不进执行器，直接返回 subagent-readonly；工具说明补一句。 */
export function gateSubagentWrites(
  tool: ToolDefinition,
  resolveContext: (exec: ToolRunContext) => Promise<{ delegationDepth: number }>,
): ToolDefinition {
  return {
    ...tool,
    description: `${tool.description}\n子 agent 会话里不可用（返回 ${SUBAGENT_READONLY}）：${BRING_BACK}。`,
    output: {
      ...tool.output,
      render: (args, value) => isSubagentReadonly(value)
        ? [{ type: 'text', text: value.message }]
        : tool.output.render(args, value),
    },
    execute: async (args, exec) => {
      if ((await resolveContext(exec)).delegationDepth < 1) return tool.execute(args, exec)
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
