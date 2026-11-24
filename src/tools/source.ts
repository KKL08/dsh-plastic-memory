import type { MemoryStore } from '../store.ts'
import { anchorsOf, anchorSourceMode } from '../record-schema.ts'
import type { MemoryRecord, SourceAnchor } from '../record-schema.ts'
import type { SourceRejectCode } from '../contract-codes.ts'
import { maskSecretSurface } from '../secrets.ts'
import { isOwnEvent, messageText, relocateByTime } from '../session-log.ts'
import type { RawEvent } from '../session-log.ts'
import { UNKNOWN_SESSION_ID } from '../session-id.ts'
import { byPosition } from '../storage/table.ts'
import { layerOf, byVersionEnd } from '../storage/history.ts'
import { formatValidity } from '../validity.ts'
import type { HostSession } from './host-session.ts'
import { anchorReadPolicy, sessionFacts } from './session-access.ts'

export type { RawEvent }

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

/** 下钻只经宿主适配器读完整日志和标题。 */
export interface SourceToolDeps {
  store: MemoryStore
  host: Pick<HostSession, 'readSessionLog' | 'sessionTitleOf'>
}

/** 模型只能从记忆选择锚，不能指定任意会话。 */
export interface SourceArgs {
  memoryId: string
  window?: number
  anchor?: number
  mode?: 'window' | 'page' | 'find'
  cursor?: string
  query?: string
  include?: 'text' | 'all'
  hop?: 'parent' | 'child'
}

/** 历史标识只在锚确实来自历史版本时提供。 */
export interface ListedAnchor { anchor: SourceAnchor; fromVersion?: string }

/** 定位结果携带放行所需的记忆和选中锚。 */
export type SourceTarget =
  | { via: 'anchor'; record: MemoryRecord; anchors: ListedAnchor[]; anchorIndex: number; sessionId: string; range: [number, number]; anchorTime: number }

type SourceContext = { workspacePath: string | undefined; session?: { id: string }; delegation?: object }

/** 下钻结果：计数只包含本会话、此次范围内的事件。 */
export type SourceResult =
  | { kind: 'ok'; via: 'anchor'; memoryId: string; name: string; sessionId: string
      session: { title?: string; startedAt?: number }
      anchors: Array<{ index: number; at: number; change?: string; by?: string; sessionId: string; isFromHistory: boolean; isSelected: boolean }>
      range: [number, number]; counts: { total: number; given: number; skipped: number }
      lines: string[]; notes: string[]; cursors: { before?: string; after?: string }
      find?: { query: string; hits: number; remaining: number } }
  | { kind: 'not-found'; memoryId: string }
  | { kind: 'no-source'; memoryId: string }
  | { kind: 'forbidden'; memoryId: string }
  | { kind: 'rejected'; memoryId: string; code: SourceRejectCode; reason: string }
  | { kind: 'unavailable'; memoryId: string; reason: string }

type SourceFailure = Exclude<SourceResult, { kind: 'ok' }>

/** 单页限制上下文体积，与已有窗口上限一致。 */
const WINDOW_CAP = 24
/** 单条原文最多展示四百字符。 */
const TEXT_CAP = 400
/** 搜索一次给八处，留出每处节选的空间。 */
const FIND_HIT_CAP = 8

/**
 * 按记忆的出处锚开窗（memory_source 和处理建议的出处回查共用）。
 * 创建者仍是子会话（锚还在子会话里）：入口 = 保存点（end）往前开窗，不越过本轮起点（start），往后多读一条。
 * 子级整个任务常常只有一轮，往后开只看得到委派指令，它的观察在保存点之前的工具结果里；
 * 不越过本轮起点，fork 型子会话就读不到继承来的父会话前缀。
 * 其余（主会话的记录、主会话改写过的子会话记录）：入口 = 当轮 turn/start（start）往后开窗——触发保存的用户原话
 * 紧随 turn/start，必在窗内。真机教训：主会话长 turn（宽度 >> cap）从 end 往前开，只读到 turn 尾部的结构事件，用户原话够不着。
 * window 覆盖默认宽度，封顶 WINDOW_CAP。
 */
export function sourceWindow(
  record: Pick<MemoryRecord, 'delegation'> & { source: NonNullable<MemoryRecord['source']> },
  window?: number,
): Parameters<ReadEventFn>[0] {
  const { source } = record
  const [start, end] = source.eventRange
  const width = Math.min(Math.max(window ?? end - start, 1), WINDOW_CAP)
  return record.delegation?.sessionId === source.sessionId
    ? { sessionId: source.sessionId, seq: end, before: Math.min(width, end - start), after: 1 }
    : { sessionId: source.sessionId, seq: start, before: 2, after: width }
}


const invalid = (memoryId: string, reason: string): SourceFailure => ({ kind: 'rejected', memoryId, code: 'invalid-args', reason })

function invalidArgs(args: SourceArgs): string | undefined {
  const mode = args.mode ?? 'window'
  if (args.hop !== undefined && (mode !== 'window' || args.cursor !== undefined || args.query !== undefined || args.window !== undefined)) return 'hop 单独用，不和开窗、翻页、关键词一起'
  if (mode === 'find' && (!args.query?.trim() || args.query.trim().length > 200)) return '按关键词找要给 query（1–200 个字符）'
  if (args.query !== undefined && mode !== 'find') return 'query 只在 mode=find 时用'
  if (mode === 'page' && args.cursor === undefined) return '接着翻要给上一次返回末尾的 cursor'
  if (args.cursor !== undefined && !/^(before|after):[0-9]+$/.test(args.cursor)) return 'cursor 取上一次返回末尾给出的值'
  if (args.cursor !== undefined && mode === 'window') return 'cursor 只在 mode=page 或 find 时用'
  if (args.window !== undefined && mode !== 'window') return 'window 只在围绕出处开窗时用'
  if (mode === 'find' && args.cursor?.startsWith('before:')) return '按关键词找只能往后接着找（after:）'
  return undefined
}

/** 先校验纯参数，再定位可见记忆及锚；失败时不读会话。 */
export async function locateSource(args: SourceArgs, context: SourceContext, deps: SourceToolDeps): Promise<SourceTarget | SourceFailure> {
  const reason = invalidArgs(args)
  if (reason) return invalid(args.memoryId, reason)
  const found = await deps.store.locate(args.memoryId, { workspacePath: context.workspacePath })
  const record = found === undefined ? undefined : byPosition(found)
  if (!record || record.status === 'deleted') return { kind: 'not-found', memoryId: args.memoryId }
  const project = anchorReadPolicy(record, '', { workspacePath: context.workspacePath })
  if (!project.ok) return { kind: 'forbidden', memoryId: args.memoryId }
  const anchors: ListedAnchor[] = anchorsOf(record).map(anchor => ({ anchor }))
  try {
    if (found) {
      const versions = await deps.store.history.list(layerOf(found), args.memoryId)
      for (const version of versions.sort(byVersionEnd).reverse()) {
        anchors.push(...anchorsOf(version.record).map(anchor => ({ anchor, fromVersion: version.versionId })))
      }
    }
  } catch { /* 历史版本不可读时，当前版本仍能回查。 */ }
  const seen = new Set<string>()
  const unique = anchors.filter(({ anchor }) => {
    const key = JSON.stringify([anchor.sessionId, anchor.eventRange])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const anchorIndex = (args.anchor ?? 1) - 1
  const selected = unique[anchorIndex]?.anchor
  if (args.hop && context.delegation !== undefined) return { kind: 'rejected', memoryId: args.memoryId, code: 'subagent-restricted', reason: '父子会话之间的追溯带回主会话做' }
  const policy = anchorReadPolicy(record, selected?.sessionId ?? unique[0]?.anchor.sessionId ?? '', context)
  if (!policy.ok) {
    const { ok: _ok, ...failure } = policy
    return { ...failure, memoryId: args.memoryId }
  }
  if (unique.length === 0) return { kind: 'no-source', memoryId: args.memoryId }
  if (!Number.isInteger(anchorIndex) || anchorIndex < 0 || !selected) return invalid(args.memoryId, `这条记忆只有 ${unique.length} 个出处，anchor 取 1–${unique.length}`)
  if (args.hop && !record.delegation) return invalid(args.memoryId, '这条记忆不是子 agent 写的，没有父子会话可追溯')
  if (args.hop === 'child' && selected.sessionId === record.delegation?.sessionId) return invalid(args.memoryId, '这个出处就在子会话里，直接读即可')
  return { via: 'anchor', record, anchors: unique, anchorIndex, sessionId: selected.sessionId, range: selected.eventRange, anchorTime: selected.at }
}

function eventText(event: RawEvent, include: SourceArgs['include']) {
  if (event.type === 'tool/call') {
    const data = event.data as { name?: unknown; arguments?: unknown } | undefined
    return include === 'all' && typeof data?.name === 'string' && typeof data.arguments === 'string'
      ? { role: 'tool-call', text: `${data.name} ${data.arguments}` } : null
  }
  if (event.type === 'tool/result' && include !== 'all') return null
  return messageText(event)
}

/** 读取、筛选与渲染只用一次读取所得的日志；同一调用内复用父子会话的读取结果。 */
export async function readSource(target: SourceTarget, args: SourceArgs, deps: SourceToolDeps): Promise<SourceResult> {
  const { record } = target
  const unavailable = (reason: string): SourceFailure => ({ kind: 'unavailable', memoryId: args.memoryId, reason })
  const unknownReason = '这个会话分不清哪些内容是它自己的，只能围绕出处读'
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof load>>>>()
  async function load(id: string) {
    const { log } = await sessionFacts(id, deps.host)
    if (!log) return null
    let unknown = false
    let startedAt: number | undefined
    const events = []
    for (const event of log.events) {
      if (typeof event.seq !== 'number') continue
      const own = isOwnEvent(log, event)
      if (own === true && startedAt === undefined && typeof event.time === 'number') startedAt = event.time
      if (own === 'unknown') unknown = true
      if (own !== false) {
        const text = eventText(event, args.include)
        events.push({ event, seq: event.seq, text, injected: event.type === 'user/message' && text === null })
      }
    }
    return { events, unknown, startedAt }
  }
  const get = (id: string) => {
    if (!cache.has(id)) cache.set(id, load(id))
    return cache.get(id)!
  }
  let sessionId = target.sessionId
  const mode = args.mode ?? 'window'
  let parentAt: number | undefined
  if (args.hop) {
    const delegation = record.delegation!
    if (args.hop === 'parent') {
      if (!delegation.parentSessionId || delegation.parentSessionId === UNKNOWN_SESSION_ID) return unavailable('记录里没有父会话')
      const child = await get(delegation.sessionId)
      if (child?.unknown) return unavailable(unknownReason)
      parentAt = child?.startedAt ?? record.createdAt
      sessionId = delegation.parentSessionId
    } else sessionId = delegation.sessionId
  }
  const loaded = await get(sessionId)
  if (!loaded) return unavailable('原始会话读不到（可能已删除）')
  if (loaded.unknown && (mode !== 'window' || args.hop)) return unavailable(unknownReason)
  const { events } = loaded
  const readable = events.filter(e => e.text !== null)
  let requested: [number, number] = [...target.range]
  let selected = events
  const notes: string[] = []
  let find: Extract<SourceResult, { kind: 'ok' }>['find']
  const cursorSeq = args.cursor === undefined ? undefined : Number(args.cursor.split(':')[1])
  if (args.hop === 'child') {
    requested = [events[0]?.seq ?? 0, events.at(-1)?.seq ?? 0]
    selected = readable.slice(-WINDOW_CAP)
  } else if (args.hop === 'parent') {
    const start = relocateByTime({ at: parentAt! }, events.map(e => e.event)) ?? events[0]?.seq ?? 0
    requested = [start, events.at(-1)?.seq ?? start]
    selected = readable.filter(e => e.seq >= start).slice(0, WINDOW_CAP)
  } else if (mode === 'page') {
    selected = args.cursor!.startsWith('before:') ? readable.filter(e => e.seq < cursorSeq!).slice(-WINDOW_CAP) : readable.filter(e => e.seq > cursorSeq!).slice(0, WINDOW_CAP)
    requested = [cursorSeq!, cursorSeq!]
  } else if (mode === 'find') {
    const query = args.query!.trim()
    const matches = readable.filter(e => (cursorSeq === undefined || e.seq > cursorSeq) && e.text!.text.toLowerCase().includes(query.toLowerCase()))
    selected = matches.slice(0, FIND_HIT_CAP)
    find = { query, hits: selected.length, remaining: matches.length - selected.length }
  } else {
    let [start, end] = target.range
    const anchor = target.anchors[target.anchorIndex]!.anchor
    const startTime = events.find(e => e.seq === start)?.event.time
    const nextTime = events.find(e => e.seq > end && typeof e.event.time === 'number')?.event.time
    const validRange = !loaded.unknown && typeof startTime === 'number' && startTime <= target.anchorTime
      && (nextTime === undefined || target.anchorTime <= nextTime)
    // 旧锚的时间来自记录更新时间，不能拿它重定位原始出处。
    if (anchor.change !== undefined && !validRange) {
      const relocated = relocateByTime({ at: target.anchorTime }, events.map(e => e.event))
      if (relocated !== null && relocated !== start) {
        end = Math.min(relocated + end - start, events.at(-1)?.seq ?? end)
        start = relocated
        notes.push('（序号和记录的时间对不上，已按时间重新定位）')
      }
    }
    const request = sourceWindow({ delegation: record.delegation, source: { sessionId, eventRange: [start, end], sourceMode: anchorSourceMode(anchor) } }, args.window)
    let low = request.seq - (request.before ?? 0)
    let high = request.seq + (request.after ?? 0)
    const backward = record.delegation?.sessionId === sessionId
    // 注入上下文占了序号却不是对话，沿原窗口方向补齐；补到的上下文也继续补。
    let debt = events.filter(e => e.seq >= low && e.seq <= high && e.injected).length
    const extra = backward ? events.filter(e => e.seq < low && e.seq >= start).reverse() : events.filter(e => e.seq > high)
    for (const e of extra) {
      if (debt === 0) break
      if (backward) low = e.seq
      else high = e.seq
      if (!(e.injected)) debt--
    }
    requested = [low, high]
    selected = events.filter(e => e.seq >= low && e.seq <= high)
  }
  const given = selected.filter(e => e.text !== null)
  const range: [number, number] = given.length ? [given[0]!.seq, given.at(-1)!.seq] : requested
  // 翻页和追溯按可读条数截取，计数仍包含首尾之间略过的结构事件。
  const total = selected.length === 0 || mode === 'find' ? selected.length : (mode === 'window' && !args.hop ? selected.length : events.filter(e => e.seq >= range[0] && e.seq <= range[1]).length)
  const lines = given.map(e => {
    let text = e.text!.text
    if (find && text.length > TEXT_CAP) {
      const hit = text.toLowerCase().indexOf(find.query.toLowerCase())
      const start = Math.max(0, hit - Math.floor((TEXT_CAP - find.query.length - 2) / 2))
      const end = Math.min(text.length, start + TEXT_CAP - 2)
      text = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
    } else if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP) + '…'
    return `- [${e.seq}] ${e.text!.role}: ${text}`
  })
  const cursors: { before?: string; after?: string } = {}
  if (find) {
    if (find.remaining > 0) cursors.after = `after:${range[1]}`
  } else if (!args.hop && !loaded.unknown) {
    // 普通游标只指向锚会话，追溯结果不给会跳回另一会话的提示。
    if (readable.some(e => e.seq < range[0])) cursors.before = `before:${range[0]}`
    if (readable.some(e => e.seq > range[1])) cursors.after = `after:${range[1]}`
  }
  return { kind: 'ok', via: 'anchor', memoryId: args.memoryId, name: maskSecretSurface(record).name, sessionId,
    session: { title: await deps.host.sessionTitleOf(sessionId), startedAt: loaded.startedAt },
    anchors: target.anchors.map(({ anchor, fromVersion }, i) => ({ index: i + 1, at: anchor.at, change: anchor.change, by: anchor.by, sessionId: anchor.sessionId, isFromHistory: fromVersion !== undefined, isSelected: i === target.anchorIndex })),
    range, counts: { total, given: given.length, skipped: total - given.length }, lines, notes, cursors, ...(find ? { find } : {}) }
}

/** 定位和放行成功才读取原文。 */
export async function executeSource(args: SourceArgs, context: SourceContext, deps: SourceToolDeps): Promise<SourceResult> {
  const target = await locateSource(args, context, deps)
  return 'via' in target ? readSource(target, args, deps) : target
}

/** 返回开头的会话行：标题、时间、这一段的事件计数。 */
export function renderSessionHead(session: { sessionId: string; title?: string; startedAt?: number }, counts: { total: number; given: number; skipped: number }): string {
  const time = session.startedAt === undefined ? '' : formatValidity(session.startedAt)
  const label = session.title ? `会话「${session.title}」（${session.sessionId}${time ? `，${time}` : ''}）` : `会话 ${session.sessionId}${time ? `（${time}）` : ''}`
  return `${label}：这一段共 ${counts.total} 个事件，给了 ${counts.given} 条，略过 ${counts.skipped} 个。`
}

/** 将结构化下钻结果渲染成带出处和翻页提示的文本。 */
export function renderSourceResult(result: SourceResult): string {
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
      const anchors = result.anchors.length > 1 ? result.anchors.map(a => `  ${a.index}. ${[formatValidity(a.at), a.change, a.by, `会话 ${a.sessionId}`].filter(Boolean).join(' ')}${a.isFromHistory ? '（历史版本）' : ''}${a.isSelected ? ' ← 这次读的' : ''}`) : []
      const tail: string[] = []
      if (result.find) {
        if (result.find.remaining > 0) tail.push(`还有 ${result.find.remaining} 处，接着找：cursor=${result.cursors.after}`)
        if (result.find.hits > 0) {
          const seq = result.range[0]
          tail.push(`看某一处的前后文：mode=page，cursor=before:${seq + 1}${seq > 0 ? ` 或 after:${seq - 1}` : ''}`)
        }
      } else {
        const directions = [result.cursors.before && `往前：cursor=${result.cursors.before}`, result.cursors.after && `往后：cursor=${result.cursors.after}`].filter(Boolean)
        if (directions.length) tail.push(`${directions.join('　')}（mode=page）`)
      }
      const empty = result.find ? `（这个会话里没有找到「${result.find.query}」）` : '（这一段没有可读的对话文本）'
      return [`记忆 ${result.memoryId}（${result.name}）的出处：`, ...anchors,
        renderSessionHead({ sessionId: result.sessionId, ...result.session }, result.counts), ...result.notes,
        ...(result.lines.length ? result.lines : [empty]), ...tail].join('\n')
    }
  }
}
