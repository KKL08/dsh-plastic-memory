/**
 * 客户端的命令往返协议，只这一份：一条 `/memory` 命令的结果 → 界面该怎么做（Outcome）。纯函数，不碰网关和界面。
 * - 涉及其他项目时服务端先拒（cross-workspace，什么都没动）：确认后带 allowCrossWorkspace 重发；
 * - forget 的目标含密钥（has-secret，什么都没动）：确认后改发 hard-delete，沿用这条命令指明的那一份；
 * - 直接改、直接合并的新内容像密钥（secret-suspected，什么都没动）：确认不是密钥后带 force 重发；
 * - 条目正被别处认领（claimed），或待决项已不在（契约 OPEN_ITEM_COMMANDS 的 not-found）：别处已处理；
 * - 服务端原话只有中文的几种（stale、secret-critical、target-taken、拿不到模型、模型输出不合格式）换本地文案，其余显示原话。
 * 确认类 Outcome 自带要重发的命令，面板不碰命令形状。
 */
import {
  CROSS_WORKSPACE_COMMANDS, detectSecrets, OPEN_ITEM_COMMANDS,
  type CrossWorkspaceCommand, type GuiErrorCode, type MemoryCommand, type MemoryCommandResult,
} from '../../src/gui/contract.ts'
import type { LocaleKey } from '../locales.ts'

export type Ok = Extract<MemoryCommandResult, { ok: true }>
export type EditCommand = Extract<MemoryCommand, { cmd: 'edit-memory' | 'merge-memories' }>
type HardDeleteCommand = Extract<MemoryCommand, { cmd: 'hard-delete' }>

/**
 * 失败：isLocalized 时 detail 是文案键，否则是服务端原话（没有原话时是结果码）。
 * code 缺省 = 不是服务端回的（发出前拦下、命令以外的失败）。
 */
export type Failure =
  | { kind: 'failed'; code?: GuiErrorCode; detail: LocaleKey; isLocalized: true }
  | { kind: 'failed'; code?: GuiErrorCode; detail: string; isLocalized: false }

export type Outcome =
  | { kind: 'ok'; result: Ok }
  /** isMove：移到项目，写的是要移去的项目，不是记忆所在的项目。 */
  | { kind: 'confirm-cross'; workspacePath: string; isMove: boolean; resend: MemoryCommand }
  | { kind: 'confirm-secret'; resend: HardDeleteCommand }
  | { kind: 'confirm-suspected'; resend: EditCommand }
  | { kind: 'handled-elsewhere' }
  | Failure

/** 拿不到模型、模型输出不合格式的本地文案；让模型改的生成（不走这里）也用这几个键。 */
export const LLM_FAILURE_KEYS = {
  'llm-unavailable': 'pending.model.unavailable',
  'llm-failed': 'pending.model.failed',
  'llm-invalid-output': 'pending.model.invalid',
} as const satisfies Partial<Record<GuiErrorCode, LocaleKey>>

const local = (code: GuiErrorCode | undefined, detail: LocaleKey): Failure => ({ kind: 'failed', ...(code === undefined ? {} : { code }), detail, isLocalized: true })

function localKeyOf(command: MemoryCommand, code: GuiErrorCode): LocaleKey | undefined {
  switch (code) {
    case 'stale': return command.cmd === 'undo' || command.cmd === 'restore' ? 'pending.undo.stale' : 'pending.edit.stale'
    case 'secret-critical': return 'pending.edit.secretCritical'
    case 'target-taken':
      return command.cmd === 'undo' ? 'pending.move.undoTaken'
        : command.cmd === 'promote' || command.cmd === 'promote-memory' ? 'pending.promote.taken' : 'pending.move.taken'
    case 'llm-unavailable':
    case 'llm-invalid-output': return LLM_FAILURE_KEYS[code]
    // 模型报错的原话照常显示
    default: return undefined
  }
}

const isCrossWorkspace = (command: MemoryCommand): command is CrossWorkspaceCommand => CROSS_WORKSPACE_COMMANDS.has(command.cmd as CrossWorkspaceCommand['cmd'])

export function interpret(command: MemoryCommand, result: MemoryCommandResult): Outcome {
  if (result.ok) return { kind: 'ok', result }
  const { code } = result
  if (code === 'cross-workspace' && isCrossWorkspace(command) && command.allowCrossWorkspace !== true) {
    const workspacePath = result.rejected?.[0]?.workspacePath
    if (workspacePath !== undefined) {
      return { kind: 'confirm-cross', workspacePath, isMove: command.cmd === 'move-memory', resend: { ...command, allowCrossWorkspace: true } }
    }
  }
  if (code === 'has-secret' && command.cmd === 'forget') return { kind: 'confirm-secret', resend: { ...command, cmd: 'hard-delete' } }
  if (code === 'secret-suspected' && (command.cmd === 'edit-memory' || command.cmd === 'merge-memories')) {
    return { kind: 'confirm-suspected', resend: { ...command, force: true } }
  }
  if (code === 'claimed' || (code === 'not-found' && OPEN_ITEM_COMMANDS.has(command.cmd))) return { kind: 'handled-elsewhere' }
  const key = localKeyOf(command, code)
  return key !== undefined ? local(code, key) : { kind: 'failed', code, detail: result.detail ?? code, isLocalized: false }
}

/**
 * 发出之前就拦下的：直接改、直接合并的新内容四个面拼起来含高危密钥（与服务端同口径）。命令文本会进借用会话的日志，
 * 高危的不能发出去；疑似的照常发，由服务端回 secret-suspected 再确认。
 */
export function refuseBeforeSend(command: MemoryCommand): Failure | undefined {
  if (command.cmd !== 'edit-memory' && command.cmd !== 'merge-memories') return undefined
  const { content, name, summary, tags } = command
  const isCritical = detectSecrets(`${content}\n${name}\n${summary}\n${tags.join(' ')}`).some(h => h.severity === 'critical')
  return isCritical ? local('secret-critical', 'pending.edit.secretCritical') : undefined
}
