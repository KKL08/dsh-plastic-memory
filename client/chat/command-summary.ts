/**
 * 面板发的 `/memory` 命令在对话里那一行的摘要。宿主每执行一条命令都在会话日志里记下参数原文和结果文本，
 * 对话界面默认把结果 JSON 原样摊开；这里按子命令写成一句话，失败原因和面板走同一套文案（interpret）。纯函数，不碰 React。
 */
import { maskSecrets, memoryCommandResultSchema, parseMemoryCommand, type MaskOptions, type MemoryCommand } from '../../src/gui/contract.ts'
import { interpret } from '../command/protocol.ts'
import { baseName } from '../path.ts'
import type { Summary } from './tool-summary.ts'

/** 宿主 CommandNode.outcome：还在跑时为 null。 */
export type CommandOutcome = { kind: 'success' | 'error'; text?: string } | null

/**
 * action 缺省 = 参数认不出。note：没失败也没做成——要用户确认、别处已处理、已有体检在跑。
 * reason：字符串是原话（可能为空），否则是文案。
 */
export type CommandLine =
  | { state: 'running' | 'ok'; action?: Summary | undefined; note?: 'awaiting' | 'elsewhere' | 'busy' }
  | { state: 'error'; action?: Summary | undefined; reason: Summary | string }

function actionOf(command: MemoryCommand): Summary {
  switch (command.cmd) {
    case 'info': return { key: 'chat.command.info' }
    case 'model-info': return { key: 'chat.command.modelInfo' }
    case 'refresh-views': return { key: 'chat.command.refreshViews' }
    case 'draft-edit': return { key: 'chat.command.draftEdit' }
    case 'plan-edits': return { key: 'chat.command.planEdits' }
    case 'draft-plan': return { key: 'chat.command.draftPlan' }
    case 'resolve': return { key: command.verdict === 'keep-both' ? 'chat.command.resolve.both' : 'chat.command.resolve.one' }
    case 'undo': return { key: 'chat.command.undo' }
    case 'promote':
    case 'promote-memory': return { key: command.target === 'agents-md' ? 'chat.command.promote.agentsMd' : 'chat.command.promote.global' }
    case 'keep-local':
    case 'keep-local-memory': return { key: 'chat.command.keepLocal' }
    case 'move-memory': return { key: 'chat.command.move', params: { name: baseName(command.workspacePath) } }
    case 'forget': return { key: 'chat.command.forget' }
    case 'restore': return { key: 'chat.command.restore' }
    case 'hard-delete': return { key: 'chat.command.hardDelete' }
    case 'confirm': return { key: 'chat.command.confirm' }
    case 'edit-memory': return { key: 'chat.command.edit' }
    case 'merge-memories': return { key: 'chat.command.merge' }
    case 'apply-edits': return { key: 'chat.command.applyEdits', params: { n: command.ops.length } }
    case 'dismiss-overflow': return { key: 'chat.command.dismissOverflow' }
    case 'ignore-advice': return { key: 'chat.command.ignoreAdvice' }
    case 'unignore-advice': return { key: 'chat.command.unignoreAdvice' }
    case 'scan': return { key: 'chat.command.scan' }
    case 'set-auto-checkup': return { key: 'chat.command.autoCheckup' }
    case 'migrate-type': return { key: 'chat.command.migrateType', params: { name: command.from } }
  }
}

const firstLine = (text: string) => text.split('\n', 1)[0]!

/** 页面自己发、不是用户动作的命令：查记忆根、刷新视图、查模型。请求被中断时服务端照常做完，下次打开会再发。 */
const MAINTENANCE: ReadonlySet<MemoryCommand['cmd']> = new Set(['info', 'refresh-views', 'model-info'])

/**
 * 结果文本是不是「请求被中断」。宿主在请求连接关掉时只把中断错误的 message 写进结果文本，不带错误名或错误码，
 * 只能按文本认：Node 的 AbortError 原话（含 fetch 那句）、浏览器的默认原因、宿主自己的兜底句。运行时换了措辞就认不出，
 * 认不出时照旧显示失败。
 */
function isAbortedText(text: string | undefined): boolean {
  if (text === undefined) return false
  const head = text.trim()
  return /^(this|the) operation was aborted\.?$/i.test(head) || head === 'signal is aborted without reason' || head === 'command aborted'
}

function parseResult(text: string | undefined) {
  if (text === undefined) return undefined
  try { return memoryCommandResultSchema.safeParse(JSON.parse(text)).data } catch { return undefined }
}

export function commandLine(args: string | null, outcome: CommandOutcome): CommandLine {
  const parsed = args === null ? undefined : parseMemoryCommand(args)
  const command = parsed?.ok === true ? parsed.command : undefined
  const action = command === undefined ? undefined : actionOf(command)
  if (outcome === null) return { state: 'running', action }
  const result = parseResult(outcome.text)
  if (result === undefined) {
    if (outcome.kind === 'error' && command !== undefined && MAINTENANCE.has(command.cmd) && isAbortedText(outcome.text)) return { state: 'ok', action }
    return outcome.kind === 'success' ? { state: 'ok', action } : { state: 'error', action, reason: firstLine(outcome.text ?? '') }
  }
  if (result.ok) return { state: 'ok', action }
  // 和体检面板一致：已有体检在跑不算失败；体检关闭、体检拿不到模型用面板的文案
  if (result.code === 'busy') return { state: 'ok', action, note: 'busy' }
  if (result.code === 'governance-disabled') return { state: 'error', action, reason: { key: 'settings.governanceOff' } }
  if (result.code === 'llm-unavailable' && command?.cmd === 'scan') return { state: 'error', action, reason: { key: 'checkup.result.llmUnavailable' } }
  if (command === undefined) return { state: 'error', action, reason: firstLine(result.detail ?? result.code) }
  const handled = interpret(command, result)
  switch (handled.kind) {
    case 'confirm-cross':
    case 'confirm-secret':
    case 'confirm-suspected': return { state: 'ok', action, note: 'awaiting' }
    case 'handled-elsewhere': return { state: 'ok', action, note: 'elsewhere' }
    case 'ok': return { state: 'ok', action }
    case 'failed': return { state: 'error', action, reason: handled.isLocalized ? { key: handled.detail } : firstLine(handled.detail) }
  }
}

/** 点开后的输入：子命令加排好版的参数 JSON（参数不是 JSON 时原样），遮过密钥。没有参数原文时为 null。 */
export function commandInput(args: string | null): string | null {
  const text = args?.trim() ?? ''
  if (text === '') return null
  const space = text.search(/\s/)
  if (space === -1) return maskCard(text)
  return maskCard(`${text.slice(0, space)} ${maskedBody(text.slice(space).trim())}`)
}

/** 点开后的输出：结果文本，是 JSON 就排版，遮过密钥。还在跑或没有文本时为 null。 */
export function commandOutput(outcome: CommandOutcome): string | null {
  const text = outcome?.text ?? ''
  return text === '' ? null : maskedBody(text)
}

const CARD_MASK: MaskOptions = { severity: 'suspected' }
/** 对话卡里的密钥一律遮掉，疑似的也遮（带 force 存下的 password= / api_key= 赋值）。 */
export const maskCard = (text: string) => maskSecrets(text, CARD_MASK)

const maskStrings = (value: unknown): unknown =>
  typeof value === 'string' ? maskCard(value)
    : Array.isArray(value) ? value.map(maskStrings)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v)]))
        : value

/**
 * 卡里展开的正文（工具行的输入也用它）：是 JSON 就先遮每个字符串的原值再排版——排版后换行成了 `\n`，
 * 跨行的密钥（`Bearer` 换行接 token）就认不出了；排完再整体遮一遍，键名里的也遮到。不是 JSON 就原样遮。
 */
export function maskedBody(text: string): string {
  try { return maskCard(JSON.stringify(maskStrings(JSON.parse(text)), null, 2)) } catch { return maskCard(text) }
}
