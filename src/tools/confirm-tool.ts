import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeConfirm, type ConfirmResult, type ConfirmToolDeps } from './confirm.ts'
import { toToolOutput } from './output.ts'
import { ALLOW_CROSS_WORKSPACE_PARAM, type GovernanceContext } from './workspace-gate.ts'
import type { ContextHost } from './host-session.ts'
import { VERDICTS_BY_KIND } from '../governance/schema.ts'

export interface ConfirmToolBindingDeps extends ConfirmToolDeps {
  host: ContextHost<GovernanceContext>
}

/**
 * 把 memory_confirm 接到 dsh 框架上。测试只测 confirm.ts 纯逻辑，
 * 本文件由 typecheck + 真机冒烟保证。
 */
export function createConfirmTool(deps: ConfirmToolBindingDeps): ToolDefinition {
  return defineTool({
    name: 'memory_confirm',
    description: '裁决按发现种类选择：conflict 可用全部 verdict；missed-change 可用 as-versions、not-conflict、dismiss；premise-changed、exception、cross-duplicate 可用 dismiss。not-conflict 表示确实不冲突，exception 表示记成例外；as-versions 将旧状态那条并为 current 的历史版本，当前页保留，可撤销。跨项目重复要提升时用 memory_promote。三个用途：action=refresh 确认某条记忆仍然准确（刷新新鲜度）；action=resolve 裁决 memory_scan 发现的待决冲突及其他发现；action=accept-subagent 接受子 agent 存的待确认记忆，接受后和本项目其他记忆一样注入、检索（只改确认状态，内容和有效期不变；要改内容用 memory_save update，不要就 memory_forget）。裁决约定：横向冲突 left/right 对应待决项 memoryIds 的第一/第二条；垂直冲突 left=记忆、right=AGENTS.md 基线，其中 keep-left 保留记忆（不删除任何内容），keep-right 是基线胜出、会删除该记忆——选错会误删记忆，请谨慎判断。keep-both=并存不冲突，dismiss=忽略这条发现；裁决会被记住，判断依据不变时体检沿用结论。裁决删除会自动快照。拿不准时先用 memory_source 回查冲突双方的原始出处（横向冲突看当时谁说的什么语境；垂直冲突核对当前基线内容即可，不必回查旧会话）。',
    parameters: {
      action: { type: 'string', enum: ['refresh', 'resolve', 'accept-subagent'], required: true },
      memoryId: { type: 'string', description: 'action=refresh、accept-subagent 时必填' },
      decisionId: { type: 'string', description: 'action=resolve 时必填，待决项 id（pd_ 开头）' },
      verdict: { type: 'string', enum: [...VERDICTS_BY_KIND.conflict], description: 'action=resolve 时必填' },
      current: { type: 'string', description: 'as-versions 时必填，指定这一对里留作当前状态页的记忆 id' },
      allowCrossWorkspace: ALLOW_CROSS_WORKSPACE_PARAM,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: (value as unknown as ConfirmResult).message }],
    },
    execute: async (args, exec) => toToolOutput(await executeConfirm(args, await deps.host.contextOf(exec), deps)),
  })
}
