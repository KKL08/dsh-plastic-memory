/**
 * 客户端的命令往返协议，只这一份：一条 `/memory` 命令的结果 → 界面该怎么做（Outcome）。纯函数，不碰网关和界面。
 * - 涉及其他项目时服务端先拒（cross-workspace，什么都没动）：确认后带 allowCrossWorkspace 重发；
 * - forget 的目标含密钥（has-secret，什么都没动）：确认后改发 hard-delete，沿用这条命令指明的那一份；
 * - 直接改、直接合并、整理所选、按要求应用的新内容像密钥（secret-suspected，什么都没动）：确认不是密钥后带 force 重发；
 * - 条目正被别处认领（claimed），或待决项已不在（契约 OPEN_ITEM_COMMANDS 的 not-found）：别处已处理；
 * - 服务端原话只有中文的几种（stale、not-found、secret-critical、target-taken、缺基线、拿不到模型、模型输出不合格式）换本地文案，其余显示原话；
 *   stale、not-found 分单条、整理所选两种口径，失败结果里的 memoryIds 照传。
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
/** 疑似密钥确认后可带 force 重发的命令（按要求应用只在带方案时：采纳建议不等确认）。 */
type ForceCommand = EditCommand | Extract<MemoryCommand, { cmd: 'apply-edits' | 'apply-proposal' }>

/**
 * 失败：isLocalized 时 detail 是文案键，否则是服务端原话（没有原话时是结果码）。
 * code 缺省 = 不是服务端回的（发出前拦下、命令以外的失败）。memoryIds：stale、not-found 时服务端列出的对不上或找不到的那几条。
 */
export type Failure =
  | { kind: 'failed'; code?: GuiErrorCode; detail: LocaleKey; isLocalized: true; memoryIds?: string[] }
  | { kind: 'failed'; code?: GuiErrorCode; detail: string; isLocalized: false; memoryIds?: string[] }

export type Outcome =
  | { kind: 'ok'; result: Ok }
  /** isMove：移到项目，写的是要移去的项目，不是记忆所在的项目。 */
  | { kind: 'confirm-cross'; workspacePath: string; isMove: boolean; resend: MemoryCommand }
  | { kind: 'confirm-secret'; resend: HardDeleteCommand }
  | { kind: 'confirm-suspected'; resend: ForceCommand }
  | { kind: 'handled-elsewhere' }
  | Failure

/** 拿不到模型、模型输出不合格式的本地文案；让模型改的生成（不走这里）也用这几个键。 */
export const LLM_FAILURE_KEYS = {
  'llm-unavailable': 'pending.model.unavailable',
  'llm-failed': 'pending.model.failed',
  'llm-invalid-output': 'pending.model.invalid',
} as const satisfies Partial<Record<GuiErrorCode, LocaleKey>>

const local = (code: GuiErrorCode | undefined, detail: LocaleKey): Failure => ({ kind: 'failed', ...(code === undefined ? {} : { code }), detail, isLocalized: true })

/** 整理所选的三条命令：stale、not-found 都说「计划要重新生成」。 */
const isTidyCommand = (command: MemoryCommand) => command.cmd === 'plan-edits' || command.cmd === 'draft-plan' || command.cmd === 'apply-edits'

function localKeyOf(command: MemoryCommand, code: GuiErrorCode): LocaleKey | undefined {
  if ((code === 'stale' || code === 'not-found') && isTidyCommand(command)) return 'library.batch.stale'
  switch (code) {
    case 'stale':
      return command.cmd === 'undo' || command.cmd === 'restore' ? 'pending.undo.stale'
        : command.cmd === 'ignore-advice' ? 'pending.ignore.stale' : 'pending.edit.stale'
    // 按记忆动手的：要动的记忆已经不在（多半在外面删了），服务端已重写视图。待决项的在前面算别处已处理；撤销的是快照没了，照常显示原话
    case 'not-found': return 'memoryId' in command || 'memories' in command ? 'pending.memory.gone' : undefined
    case 'secret-critical': return 'pending.edit.secretCritical'
    // 垂直冲突的补上建议、按要求生成：这条记忆对应的指令文件读不到，或在体检后改过
    case 'no-baseline': return 'pending.suggestion.noBaseline'
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
  if (code === 'secret-suspected' && (command.cmd === 'edit-memory' || command.cmd === 'merge-memories' || command.cmd === 'apply-edits' || (command.cmd === 'apply-proposal' && command.proposal !== undefined))) {
    return { kind: 'confirm-suspected', resend: { ...command, force: true } }
  }
  if (code === 'claimed' || (code === 'not-found' && OPEN_ITEM_COMMANDS.has(command.cmd))) return { kind: 'handled-elsewhere' }
  const key = localKeyOf(command, code)
  const ids = result.memoryIds !== undefined ? { memoryIds: result.memoryIds } : {}
  return key !== undefined ? { ...local(code, key), ...ids } : { kind: 'failed', code, detail: result.detail ?? code, isLocalized: false, ...ids }
}

const hasCritical = (texts: readonly string[]) => detectSecrets(texts.join('\n')).some(h => h.severity === 'critical')
/** 改写项写进去的四个面。 */
const editTexts = (ops: ReadonlyArray<{ kind: string } & Partial<{ content: string; name: string; summary: string; tags: string[] }>>) =>
  ops.flatMap(op => (op.kind === 'edit' ? [op.content ?? '', op.name ?? '', op.summary ?? '', (op.tags ?? []).join(' ')] : []))

/**
 * 发出之前就拦下的（与服务端同口径）：直接改、直接合并的新内容四个面，整理所选、按要求应用每个改写项的四个面；让模型改的要求、此前的要求、计划的文字、上一稿四个面；
 * 整理计划的要求；按计划出稿的要求和每项的理由、提问、回答；补充要求的要求、此前的要求、上一份方案的说明和稿。
 * 命令文本会进借用会话的日志，含高危密钥的不能发出去；疑似的照常发，改写由服务端回 secret-suspected 再确认。
 */
export function refuseBeforeSend(command: MemoryCommand): Failure | undefined {
  if (command.cmd === 'edit-memory' || command.cmd === 'merge-memories') {
    const { content, name, summary, tags } = command
    return hasCritical([content, name, summary, tags.join(' ')]) ? local('secret-critical', 'pending.edit.secretCritical') : undefined
  }
  if (command.cmd === 'apply-edits' || (command.cmd === 'apply-proposal' && command.proposal !== undefined)) {
    const ops = command.cmd === 'apply-edits' ? command.ops : command.proposal!.ops
    return hasCritical(editTexts(ops)) ? local('secret-critical', 'pending.edit.secretCritical') : undefined
  }
  if (command.cmd === 'draft-proposal') {
    const { previous } = command
    const texts = [command.request, ...(command.priorRequests ?? []), ...(previous !== undefined ? [previous.reason, ...editTexts(previous.ops)] : [])]
    return hasCritical(texts) ? local('secret-critical', 'pending.model.secretCritical') : undefined
  }
  if (command.cmd === 'draft-edit') {
    const { previous, planNote } = command
    const texts = [
      command.request ?? '', ...(command.priorRequests ?? []),
      ...(planNote !== undefined ? [planNote.reason, planNote.question?.text ?? '', planNote.question?.placeholder ?? '', planNote.answer ?? ''] : []),
      ...(previous !== undefined ? [previous.content, previous.name ?? '', previous.summary, ...(previous.tags ?? [])] : []),
    ]
    return hasCritical(texts) ? local('secret-critical', 'pending.model.secretCritical') : undefined
  }
  if (command.cmd === 'plan-edits') return hasCritical([command.request]) ? local('secret-critical', 'pending.model.secretCritical') : undefined
  if (command.cmd === 'draft-plan') {
    const texts = [command.request, ...command.ops.flatMap(op => [op.reason, op.question?.text ?? '', op.question?.placeholder ?? '', op.answer ?? ''])]
    return hasCritical(texts) ? local('secret-critical', 'pending.model.secretCritical') : undefined
  }
  return undefined
}
