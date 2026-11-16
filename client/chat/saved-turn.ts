/**
 * 本轮新记、改写的记忆：照宿主定时任务卡的做法（ui-schedule `schedule-turn.ts`），注册一个只产出 Turn 数据、
 * 不产出视图节点的会话事件 Definition（`ctx.uiConversation.events.register`），把本轮成功的 `memory_save`（新建与 update）
 * 挂到 Turn 上；交付卡在 `conversation.chat.turnTail` 里按 `turn.data` 读。数据从会话日志重放得到，
 * 历史会话、刷新后都一样。宿主类型不引包，按结构手写最小子集（0.2.1-rc.2）。
 */
import type { MemoryCard, SaveEdit } from '../../src/gui/contract.ts'
import { parseArgs, parseSaveResult, savedMemoryCard } from './tool-summary.ts'

/** Turn 数据的 key，也是 Definition 的 kind。 */
export const SAVED_TURN_KEY = 'plastic-memory-saved'

export interface SavedMemory {
  callId: string
  /** 结果事件的 seq，按它截到本轮结束。 */
  seq: number
  /** 新记的为新内容；改写的为改后的内容（工具参数），作用域由交付卡按视图校正。 */
  memory: MemoryCard
  /** 这次是改写已有记忆（action: update）；缺省 = 新记。 */
  isUpdate?: true
  /**
   * 改写只传了 edits（没有整条正文）：这次的 edits 和参数里传了的字段。memory 里只有 id 和名称，
   * 交付卡按改前快照应用这些 edits 算出改后的样子。
   */
  edit?: EditArgs
  /** 参数里要替代的旧记忆 id（去重）；视图里认不出这次替代（已过保留窗口）时交付卡据此写过期说明。 */
  supersedes?: readonly string[]
}

export interface EditArgs {
  edits: readonly SaveEdit[]
  /** 参数里传了的字段，覆盖改前那份；没传的沿用改前的。 */
  fields: Partial<Pick<MemoryCard, 'name' | 'type' | 'summary' | 'tags'>>
}

export interface SavedTurnData {
  readonly saved: readonly SavedMemory[]
}

/** 宿主会话事件里用到的字段。 */
interface EventLike {
  type: string
  seq: number
  time: number
  surfaceOp?: unknown
  data?: unknown
}

interface ToolCallData { turn: number; callId: string; name: string; arguments: string }
interface ToolResultData { turn: number; message: { isError?: boolean; content: readonly { type: string; text?: string }[]; source: { callId: string } } }
interface TurnStartData { turn: number }

interface State {
  readonly turn: number
  readonly calls: ReadonlyMap<string, string>
  readonly saved: readonly SavedMemory[]
}

type Match = { event: EventLike }

/** 宿主 ConversationNodeDefinition 的结构子集。 */
export interface SavedTurnDefinition {
  kind: string
  match(event: EventLike): { id: string; role: 'start' | 'update' } | null
  start(context: unknown, match: Match): State
  update(context: { state: State }, match: Match): State
  buildLocationData(context: { state: State | undefined }, scope: string, previous: unknown):
    { kind: 'turn'; turn: number; key: string; value: SavedTurnData } | null
}

/** 参数里的 supersedes：只认字符串数组，去重。 */
const supersedesOf = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : []

const isEdit = (value: unknown): value is SaveEdit => {
  const e = value as Partial<SaveEdit> | null
  return typeof e === 'object' && e !== null && typeof e.oldString === 'string' && typeof e.newString === 'string'
    && (e.replaceAll === undefined || typeof e.replaceAll === 'boolean')
}

/** 只传 edits 的改写参数（没有 content）→ edits 与传了的字段；不是这种改写时 undefined。 */
function editArgsOf(args: Record<string, unknown> | undefined): EditArgs | undefined {
  if (args === undefined || args.content !== undefined || !Array.isArray(args.edits) || !args.edits.every(isEdit)) return undefined
  const fields: EditArgs['fields'] = {}
  if (typeof args.name === 'string') fields.name = args.name
  if (typeof args.type === 'string') fields.type = args.type
  if (typeof args.summary === 'string') fields.summary = args.summary
  if (Array.isArray(args.tags)) fields.tags = args.tags.filter((tag): tag is string => typeof tag === 'string')
  return { edits: args.edits.map(({ oldString, newString, replaceAll }) => ({ oldString, newString, ...(replaceAll === undefined ? {} : { replaceAll }) })), fields }
}

const turnOf = (event: EventLike) => String((event.data as { turn: number }).turn)

export const savedTurnDefinition: SavedTurnDefinition = {
  kind: SAVED_TURN_KEY,
  match(event) {
    if (event.type === 'turn/start' || event.type === 'tool/call') return { id: turnOf(event), role: event.type === 'turn/start' ? 'start' : 'update' }
    // 只认追加进来的结果：被替换（压缩）的副本只给模型看
    if (event.type === 'tool/result' && event.surfaceOp === 'append') return { id: turnOf(event), role: 'update' }
    return null
  },
  start(_context, { event }) {
    return { turn: (event.data as TurnStartData).turn, calls: new Map(), saved: [] }
  },
  update({ state }, { event }) {
    if (event.type === 'tool/call') {
      const call = event.data as ToolCallData
      if (call.name !== 'memory_save') return state
      const calls = new Map(state.calls)
      calls.set(String(call.callId), call.arguments)
      return { ...state, calls }
    }
    if (event.type !== 'tool/result') return state
    const { message } = event.data as ToolResultData
    const argsRaw = state.calls.get(String(message.source.callId))
    if (argsRaw === undefined || message.isError === true) return state
    const text = message.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('\n')
    const args = parseArgs(argsRaw)
    const memory = savedMemoryCard(args, text, event.time)
    if (memory === undefined) return state
    const isUpdate = parseSaveResult(text)?.kind === 'updated'
    const edit = isUpdate ? editArgsOf(args) : undefined
    const supersedes = supersedesOf(args?.supersedes)
    return {
      ...state,
      saved: [...state.saved, {
        callId: String(message.source.callId), seq: event.seq, memory,
        ...(isUpdate ? { isUpdate: true as const } : {}),
        ...(edit !== undefined ? { edit } : {}),
        ...(supersedes.length > 0 ? { supersedes } : {}),
      }],
    }
  },
  buildLocationData({ state }, scope, previous) {
    if (scope !== 'turn' || state === undefined || state.saved.length === 0) return null
    const prev = previous as { kind?: string; turn?: number; key?: string; value?: SavedTurnData } | null
    if (prev?.kind === 'turn' && prev.turn === state.turn && prev.key === SAVED_TURN_KEY && prev.value?.saved === state.saved) {
      return prev as { kind: 'turn'; turn: number; key: string; value: SavedTurnData }
    }
    return { kind: 'turn', turn: state.turn, key: SAVED_TURN_KEY, value: { saved: state.saved } }
  },
}
