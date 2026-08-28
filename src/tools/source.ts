import type { MemoryStore } from '../store.ts'

/** ctx.sessionQuery.readEvent 的最小契约（真机验证：2026-08-28 探针，docs/design-evidence-anchor.md §2） */
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
  | { kind: 'ok'; memoryId: string; sessionId: string; range: [number, number]; lines: string[]; skipped: number }
  | { kind: 'not-found'; memoryId: string }
  | { kind: 'forbidden'; memoryId: string }
  | { kind: 'unavailable'; memoryId: string; reason: string }

/** 窗口上限：readEvent 的 readWindowMax=50，我们收紧到 24 控制 token。 */
const WINDOW_CAP = 24
const TEXT_CAP = 400

/** 从事件 data 里提取可读文本（用户/助手消息）；提不出返回 null（结构事件）。 */
export function extractEventText(event: RawEvent): { role: string; text: string } | null {
  const data = event.data as {
    inserted?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>
    content?: Array<{ type?: string; text?: string }>
    text?: string
  } | undefined
  if (!data) return null
  const fromBlocks = (blocks: Array<{ type?: string; text?: string }> | undefined): string =>
    (blocks ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
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
 * memory_source 纯逻辑（设计 §5）：memoryId → store 取锚 → readEvent 单点+窗口 → 紧凑渲染。
 * 锚在工具内部解析，模型构造不出任意 sessionId+seq；可读位置被记忆库枚举死。
 */
export async function executeSource(
  args: { memoryId: string; window?: number },
  context: { workspacePath: string | undefined },
  deps: SourceToolDeps,
): Promise<SourceResult> {
  const record = deps.store.get(args.memoryId)
  if (!record || record.status === 'deleted') return { kind: 'not-found', memoryId: args.memoryId }
  // ⑧ 跨项目隔离：只准解引用当前项目或 global 记忆的锚
  if (record.scope === 'workspace' && record.workspacePath !== context.workspacePath) {
    return { kind: 'forbidden', memoryId: args.memoryId }
  }

  const readEvent = deps.getReadEvent()
  if (!readEvent) return { kind: 'unavailable', memoryId: args.memoryId, reason: '会话查询服务未挂载' }

  const [start, end] = record.source.eventRange
  // 入口 = 当轮 turn/start（start）向后开窗——触发保存的用户原话紧随 turn/start，必在窗内。
  // 真机教训：入口若设在 end（save 时刻）向前开窗，长 turn（宽度 >> cap）会只读到
  // turn 尾部的结构事件，用户原话永远够不着。window 覆盖默认宽度，封顶 WINDOW_CAP。
  const after = Math.min(Math.max(args.window ?? end - start, 1), WINDOW_CAP)
  let win: Awaited<ReturnType<ReadEventFn>>
  try {
    win = await readEvent({ sessionId: record.source.sessionId, seq: start, before: 2, after })
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
    kind: 'ok', memoryId: args.memoryId, sessionId: record.source.sessionId,
    range: [win.startSeq ?? start, win.endSeq ?? end], lines, skipped,
  }
}

export function renderSourceResult(result: SourceResult, memoryName?: string): string {
  switch (result.kind) {
    case 'not-found':
      return `记忆不存在或已删除：${result.memoryId}`
    case 'forbidden':
      return `记忆 ${result.memoryId} 不属于当前项目，不能回查其他项目的会话轨迹。`
    case 'unavailable':
      return `原始证据不可用（${result.reason}）。请把该记忆当作先验使用，并在结论中标注这一点存在不确定性。`
    case 'ok': {
      const head = `记忆 ${result.memoryId}${memoryName ? `（${memoryName}）` : ''} 源自会话 ${result.sessionId} 的 seq ${result.range[0]}–${result.range[1]}：`
      const body = result.lines.length > 0 ? result.lines.join('\n') : '（该窗口内没有可读的对话文本）'
      const tail = result.skipped > 0 ? `（另有 ${result.skipped} 个结构事件未显示）` : ''
      return [head, body, tail].filter(Boolean).join('\n')
    }
  }
}
