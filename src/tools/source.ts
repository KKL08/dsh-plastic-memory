import type { MemoryStore } from '../store.ts'
import type { SourceRejectCode } from '../contract-codes.ts'
import { HAND_EDITED_NOTE } from '../index-line.ts'

/** ctx.sessionQuery.readEvent 的最小契约（2026-08-28 真机探针核实） */
export interface ReadEventFn {
  (request: { sessionId: string; seq: number; before?: number; after?: number }): Promise<{
    session?: { id?: string; createdAt?: number; cwd?: string }
    target?: RawEvent
    events?: RawEvent[]
    startSeq?: number
    endSeq?: number
  }>
}

interface RawEvent {
  type?: string
  seq?: number
  time?: number
  data?: unknown
}

export interface SourceToolDeps {
  store: MemoryStore
  /** 运行时探测 sessionQuery（ctx.get + try/catch）；null = 服务不可用 → 优雅降级 */
  getReadEvent: () => ReadEventFn | null
}

export type SourceResult =
  | { kind: 'ok'; memoryId: string; sessionId: string; range: [number, number]; lines: string[]; skipped: number; handEdited?: true }
  | { kind: 'not-found'; memoryId: string }
  | { kind: 'no-source'; memoryId: string }
  | { kind: 'forbidden'; memoryId: string }
  | { kind: 'rejected'; memoryId: string; code: SourceRejectCode; reason: string }
  | { kind: 'unavailable'; memoryId: string; reason: string }

/** 窗口上限：readEvent 的 readWindowMax=50，我们收紧到 24 控制 token。 */
const WINDOW_CAP = 24
const TEXT_CAP = 400

/** 从事件 data 里提取可读文本（用户/助手消息、工具结果）；提不出返回 null（结构事件）。 */
export function extractEventText(event: RawEvent): { role: string; text: string } | null {
  const data = event.data as {
    inserted?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>
    content?: Array<{ type?: string; text?: string }>
    text?: string
    message?: { content?: Array<{ type?: string; text?: string }> }
  } | undefined
  if (!data) return null
  const fromBlocks = (blocks: Array<{ type?: string; text?: string }> | undefined): string =>
    (blocks ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
  // 宿主工具结果：tool/result 的 data.message 是工具角色消息，文本在它的 content 里（对齐宿主 agent-loop 的落盘形状）
  if (event.type === 'tool/result') {
    const text = fromBlocks(data.message?.content)
    return text.length > 0 ? { role: 'tool', text } : null
  }
  if (Array.isArray(data.inserted)) {
    const texts = data.inserted
      .map(m => ({ role: m.role ?? '?', text: fromBlocks(m.content) }))
      .filter(m => m.text.length > 0)
    if (texts.length === 0) return null
    return { role: texts[0].role, text: texts.map(t => t.text).join('\n') }
  }
  const direct = fromBlocks(data.content) || (typeof data.text === 'string' ? data.text : '')
  return direct.length > 0 ? { role: event.type ?? '?', text: direct } : null
}

/**
 * memory_source 纯逻辑：memoryId → store 取锚 → readEvent 单点+窗口 → 紧凑渲染。
 * 锚在工具内部解析，模型构造不出任意 sessionId+seq；可读位置被记忆库枚举死。
 */
export async function executeSource(
  args: { memoryId: string; window?: number },
  context: {
    workspacePath: string | undefined
    session?: { id: string }
    /** 宿主 header 给出的委派信息：存在即子 agent 会话 */
    delegation?: object
  },
  deps: SourceToolDeps,
): Promise<SourceResult> {
  // 预读范围：按 id 两级定位单条（一级 global + 当前 workspace，含 .archive/），已删的按不存在处理
  const record = await deps.store.get(args.memoryId, { workspacePath: context.workspacePath })
  if (!record || record.status === 'deleted') return { kind: 'not-found', memoryId: args.memoryId }
  // 跨项目隔离：只准解引用当前项目或 global 记忆的锚
  if (record.scope === 'workspace' && record.workspacePath !== context.workspacePath) {
    return { kind: 'forbidden', memoryId: args.memoryId }
  }

  // 子 agent 只能回查出处是本会话的记录：委派方裁剪过它的上下文，溯源不能绕过裁剪去读别的会话
  const source = record.source
  if (context.delegation !== undefined && source?.sessionId !== context.session?.id) {
    return { kind: 'rejected', memoryId: args.memoryId, code: 'subagent-restricted', reason: '这条记忆的出处在别的会话，带回主会话查' }
  }

  // 手编/手建文件没有出处锚：没有可回查的会话
  if (!source) return { kind: 'no-source', memoryId: args.memoryId }

  const readEvent = deps.getReadEvent()
  if (!readEvent) return { kind: 'unavailable', memoryId: args.memoryId, reason: '会话查询服务未挂载' }

  const [start, end] = source.eventRange
  const width = Math.min(Math.max(args.window ?? end - start, 1), WINDOW_CAP)
  // 创建者仍是子会话（锚还在子会话里）：入口 = 保存点（end）往前开窗，不越过本轮起点（start），往后多读一条。
  // 子级整个任务常常只有一轮，往后开只看得到委派指令，它的观察在保存点之前的工具结果里；
  // 不越过本轮起点，fork 型子会话就读不到继承来的父会话前缀。
  // 其余（主会话的记录、主会话改写过的子会话记录）：入口 = 当轮 turn/start（start）往后开窗——触发保存的用户原话
  // 紧随 turn/start，必在窗内。真机教训：主会话长 turn（宽度 >> cap）从 end 往前开，只读到 turn 尾部的结构事件，用户原话够不着。
  // window 覆盖默认宽度，封顶 WINDOW_CAP。
  const request = record.delegation?.sessionId === source.sessionId
    ? { sessionId: source.sessionId, seq: end, before: Math.min(width, end - start), after: 1 }
    : { sessionId: source.sessionId, seq: start, before: 2, after: width }
  let win: Awaited<ReturnType<ReadEventFn>>
  try {
    win = await readEvent(request)
  } catch (e) {
    return { kind: 'unavailable', memoryId: args.memoryId, reason: `原始会话不可读（${e instanceof Error ? e.message : String(e)}）` }
  }

  const lines: string[] = []
  let skipped = 0
  for (const ev of win.events ?? []) {
    const extracted = extractEventText(ev)
    if (!extracted) { skipped++; continue }
    const text = extracted.text.length > TEXT_CAP ? extracted.text.slice(0, TEXT_CAP) + '…' : extracted.text
    lines.push(`- [${ev.seq}] ${extracted.role}: ${text}`)
  }
  return {
    kind: 'ok', memoryId: args.memoryId, sessionId: source.sessionId,
    range: [win.startSeq ?? start, win.endSeq ?? end], lines, skipped,
    ...(record.handEdited ? { handEdited: true as const } : {}),
  }
}

export function renderSourceResult(result: SourceResult, memoryName?: string): string {
  switch (result.kind) {
    case 'not-found':
      return `记忆不存在或已删除：${result.memoryId}`
    case 'no-source':
      return `记忆 ${result.memoryId} 无出处（手写或手改的记忆文件），没有可回查的会话轨迹。请把它当作用户写下的内容使用。`
    case 'forbidden':
      return `记忆 ${result.memoryId} 不属于当前项目，不能回查其他项目的会话轨迹。`
    case 'rejected':
      return `未回查：${result.reason}`
    case 'unavailable':
      return `原始证据不可用（${result.reason}）。请把该记忆当作先验使用，并在结论中标注这一点存在不确定性。`
    case 'ok': {
      const head = `记忆 ${result.memoryId}${memoryName ? `（${memoryName}）` : ''} 源自会话 ${result.sessionId} 的 seq ${result.range[0]}–${result.range[1]}：`
      const body = result.lines.length > 0 ? result.lines.join('\n') : '（该窗口内没有可读的对话文本）'
      const tail = result.skipped > 0 ? `（另有 ${result.skipped} 个结构事件未显示）` : ''
      const edited = result.handEdited ? `注意：这条记忆${HAND_EDITED_NOTE}——保存后被手工改过，下面的对话可能已不是现在内容的来源。` : ''
      return [head, edited, body, tail].filter(Boolean).join('\n')
    }
  }
}
