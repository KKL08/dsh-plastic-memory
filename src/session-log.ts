/**
 * 读宿主会话日志的一层：纯函数，只吃数据。事件归属、是不是用户本人、取文本、所属轮、按时间找回，
 * 保存、下钻、回看补记、原话检索都用这里的同一套判断。宿主读取经适配器（HostSession.readSessionLog），这里不碰宿主。
 */

/** 宿主日志里的一条事件（只取插件读的字段）。 */
export interface RawEvent {
  type?: string
  seq?: number
  time?: number
  data?: unknown
}

/** 会话 header 里插件读的字段。 */
export interface SessionHeaderLike {
  id?: string
  cwd?: string
  /** 带着从别的会话继承来的事件前缀（fork）。 */
  isSeeded?: boolean
  parentSession?: string
  delegationDepth?: number
  origin?: string
}

/** 适配器一次读取的结果。 */
export interface SessionLog {
  header: SessionHeaderLike
  /** fork 继承前缀的精确长度，宿主读会话时直接给；给不出为 undefined。 */
  inheritedEventCount: number | undefined
  events: RawEvent[]
}

/** 用户本人开一轮时消息带的来源标记：直接发的消息，和界面上的重试。 */
export const USER_INITIATORS: readonly string[] = ['user', 'retry']

export function isUserInitiator(kind: string | undefined): boolean {
  return kind !== undefined && USER_INITIATORS.includes(kind)
}

/**
 * 宿主在一轮里注入给模型、不是谁发来的消息：运行环境、时间、指令文件、技能目录、模式切换提示、插件快照这类。
 * 它们和用户消息同样落成 user/message，靠来源区分；form 是快照、指令、目录的一律算上下文，钩子的输出（来源以 hooks- 开头）也是。
 */
const CONTEXT_SOURCES = new Set([
  'runtime-context', 'time-context', 'agent-instructions', 'tmux-context', 'model-selection', 'compact-checkpoint',
  'session-reference', 'skill-catalog', 'skill-invocation', 'plan-mode', 'ptc-mode', 'repeat-tool-reminder',
  'tool-registry', 'tool-jobs', 'tool-goal', 'dsh-session-title-llm', 'cordis-host-runner',
])
const CONTEXT_FORMS = new Set(['snapshot', 'instructions', 'catalog'])

type Block = { type?: string; text?: string }
type MessageData = { content?: Block[]; source?: { kind?: string; form?: string }; isError?: boolean; toolCallId?: string }

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' ? v as Record<string, unknown> : undefined

const textOf = (blocks: unknown): string => (Array.isArray(blocks) ? blocks as Block[] : [])
  .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')

/** user/message 的来源标记；不是用户消息或没有来源时为 undefined。 */
export function sourceKindOf(event: RawEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const kind = (asObject(event.data) as MessageData | undefined)?.source?.kind
  return typeof kind === 'string' ? kind : undefined
}

function isInjectedContext(event: RawEvent): boolean {
  const source = (asObject(event.data) as MessageData | undefined)?.source
  const kind = source?.kind
  return (kind !== undefined && (CONTEXT_SOURCES.has(kind) || kind.startsWith('hooks-'))) || (source?.form !== undefined && CONTEXT_FORMS.has(source.form))
}

/**
 * 事件是不是这个会话自己的。边界只认宿主给的 inheritedEventCount：fork 会把父会话的 turn/start 一起复制过来，
 * 按 turn/start 猜边界会把继承的轮当成自己的。header 标了 seeded（或没说）却给不出边界时返回 unknown，调用方按拒绝处理。
 */
export function isOwnEvent(log: SessionLog, event: RawEvent): boolean | 'unknown' {
  if (typeof event.seq !== 'number') return 'unknown'
  if (log.inheritedEventCount !== undefined) return event.seq >= log.inheritedEventCount
  return log.header.isSeeded === false ? true : 'unknown'
}

const isDelegated = (header: SessionHeaderLike) => (header.delegationDepth ?? 0) >= 1 || header.origin === 'subagent'

/**
 * 子 agent 会话里委派来的任务：宿主把它标成 user，和用户本人发的分不开，所以按位置认——会话自己的第一条 user 消息。
 * 只对确定是这个会话自己的事件调用。
 */
function isDelegatedTask(log: SessionLog, event: RawEvent): boolean {
  if (!isDelegated(log.header)) return false
  const first = log.events.find(e => isOwnEvent(log, e) === true && sourceKindOf(e) === 'user')
  return first?.seq === event.seq
}

/**
 * 这条消息是谁开的：用户本人，或别的（定时任务、别的 agent、插件投递、委派任务）。给不出来按 non-user。
 * 消息要确定是这个会话自己的：继承来的是别的会话里的事，归属分不清的（seeded 会话拿不到边界）同样不算用户本人。
 */
export function initiatorOf(log: SessionLog, turnStartMessage: RawEvent | undefined): 'user' | 'non-user' {
  if (turnStartMessage === undefined) return 'non-user'
  if (!isUserInitiator(sourceKindOf(turnStartMessage))) return 'non-user'
  if (isOwnEvent(log, turnStartMessage) !== true) return 'non-user'
  return isDelegatedTask(log, turnStartMessage) ? 'non-user' : 'user'
}

/** 用户本人说的话：发起方是用户、内容不是空的（界面重试、空内容的重发不算说过话）。 */
export function isRealUserMessage(log: SessionLog, event: RawEvent): boolean {
  if (initiatorOf(log, event) !== 'user') return false
  return textOf((asObject(event.data) as MessageData | undefined)?.content).trim() !== ''
}

/** 一轮的第一步在这些事件处结束：起点只在第一步送进模型的那批消息里找。 */
const STEP_BOUNDARIES = new Set(['step/end', 'turn/end', 'turn/start', 'assistant/message', 'tool/call'])

const INBOX_TARGETS = new Set(['next-turn', 'next-step'])

/** 宿主收件队列的一次改动（agent/inbox/spliced），只留折队列要用的；形状不对为 undefined。 */
function spliceOf(event: RawEvent): { target: string; start: number; removedCount: number; insertedIds: string[]; isCanceled: boolean } | undefined {
  const d = asObject(event.data)
  if (d === undefined || typeof d.target !== 'string' || !INBOX_TARGETS.has(d.target)) return undefined
  const removedCount = d.removedCount ?? 0
  if (!Number.isSafeInteger(d.start) || (d.start as number) < 0 || !Number.isSafeInteger(removedCount) || (removedCount as number) < 0) return undefined
  if (d.outcome !== undefined && d.outcome !== 'canceled') return undefined
  if (!Array.isArray(d.inserted)) return undefined
  const insertedIds = d.inserted.map(m => asObject(m)?.id)
  if (!insertedIds.every(id => typeof id === 'string')) return undefined
  return { target: d.target, start: d.start as number, removedCount: removedCount as number, insertedIds: insertedIds as string[], isCanceled: d.outcome === 'canceled' }
}

/**
 * 当轮从 next-turn 取走的那条消息的 id。宿主开一轮时先取走整个 next-step（空闲时注入的通知：审批模式、工作目录、
 * 定时任务的变更），再从 next-turn 取走一条，两批按这个顺序落成第一步的 user/message——next-turn 的那条才是开这一轮的消息。
 * 把整份日志的收件记录按宿主的折法（对队列做 toSpliced(start, removedCount, ...inserted)）折成 next-turn 队列，
 * turnStart 之后、第一步开始之前那次不是取消的移除就是取走。
 * 记录形状不对、和折出的队列对不上、或这一轮没从 next-turn 取消息时为 undefined，调用方退回旧规则。
 */
function claimedOpenerId(events: readonly RawEvent[], turnStart: number): string | undefined {
  let queue: string[] = []
  for (const [i, e] of events.entries()) {
    if (i > turnStart && (e.type === 'step/start' || STEP_BOUNDARIES.has(e.type ?? ''))) return undefined
    if (e.type !== 'agent/inbox/spliced') continue
    const splice = spliceOf(e)
    if (splice === undefined) return undefined
    if (splice.target !== 'next-turn') continue
    const { start, removedCount } = splice
    if (start + removedCount > queue.length) return undefined
    const removed = queue.slice(start, start + removedCount)
    queue = queue.toSpliced(start, removedCount, ...splice.insertedIds)
    if (i > turnStart && !splice.isCanceled && removed.length > 0) return removed[0]
  }
  return undefined
}

const messageIdOf = (event: RawEvent): unknown => asObject(event.data)?.id

/**
 * 当轮起点那条消息。当轮 turn/start：给了轮起点且它确实是 turn/start 就用它，否则取不晚于 lastSeq 的最后一个
 * turn/start（宿主读不到轮边界时）；日志里一个都没有时找不到起点。
 * 起点先按收件队列认：这一轮从 next-turn 取走的那条，按消息 id 对回第一步里的 user/message。
 * 折不出队列、对不回、这一轮不是 next-turn 的消息叫醒的，退回旧规则：第一步送进模型的那批里第一条不是注入上下文的 user/message。
 * 同一轮后来的插话不改变起点。
 */
export function turnOpenerOf(log: SessionLog, turnStartSeq: number | undefined, lastSeq = Number.POSITIVE_INFINITY): RawEvent | undefined {
  const { events } = log
  let start = turnStartSeq === undefined ? -1 : events.findIndex(e => e.seq === turnStartSeq)
  if (events[start]?.type !== 'turn/start') start = events.findLastIndex(e => e.type === 'turn/start' && (e.seq ?? 0) <= lastSeq)
  if (start < 0) return undefined
  const claimed = claimedOpenerId(events, start)
  let firstNonContext: RawEvent | undefined
  for (let i = start + 1; i < events.length; i++) {
    const e = events[i]!
    if ((e.seq ?? 0) > lastSeq || STEP_BOUNDARIES.has(e.type ?? '')) break
    if (e.type !== 'user/message') continue
    if (claimed !== undefined && messageIdOf(e) === claimed) return e
    if (firstNonContext === undefined && !isInjectedContext(e)) firstNonContext = e
  }
  return firstNonContext
}

/**
 * 取消息文本：用户消息（角色是 user；别的来源开的写来源，如 schedule）、助手正文、工具结果。
 * 推理块、宿主注入的上下文、排队记录、结构事件返回 null。
 */
export function messageText(event: RawEvent): { role: string; text: string } | null {
  const data = asObject(event.data)
  if (data === undefined) return null
  let role: string
  let text: string
  if (event.type === 'user/message') {
    if (isInjectedContext(event)) return null
    const kind = sourceKindOf(event)
    role = kind === undefined || isUserInitiator(kind) ? 'user' : kind
    text = textOf((data as MessageData).content)
  } else if (event.type === 'assistant/message' || event.type === 'tool/result') {
    role = event.type === 'tool/result' ? 'tool' : 'assistant'
    text = textOf((asObject(data.message) as MessageData | undefined)?.content)
  } else {
    return null
  }
  return text.trim() === '' ? null : { role, text }
}

/** seq 落在哪一轮：turnStarts 是各轮 turn/start 的序号（升序），返回下标；在第一轮之前或没有轮时为 null。 */
export function turnOf(seq: number, turnStarts: readonly number[]): number | null {
  let found: number | null = null
  for (const [i, start] of turnStarts.entries()) {
    if (start > seq) break
    found = i
  }
  return found
}

/**
 * 按锚时间找回它那一轮的起点：时间不晚于 anchor.at 的最后一个 turn/start 的序号。
 * 会话被改写过、序号对不上时用；时间早于所有轮或日志为空返回 null。
 */
export function relocateByTime(anchor: { at: number }, events: readonly RawEvent[]): number | null {
  let found: number | null = null
  for (const e of events) {
    if (e.type !== 'turn/start' || typeof e.seq !== 'number' || typeof e.time !== 'number') continue
    if (e.time <= anchor.at) found = e.seq
  }
  return found
}

/** 产生一条工具结果的那次调用。 */
export interface ToolCallInfo {
  name: string
  /** 模型给的原始参数（JSON 字符串）。 */
  arguments: string
}

/** 锚范围里的证据类别。 */
export interface Evidence { user: boolean; tool: boolean }

/**
 * 锚范围里有没有用户本人的消息、有没有工具结果。只算确定是这个会话自己的事件：继承来的、归属分不清的都不算。
 * 失败的工具调用、isExcluded 认出的调用（本插件自己的工具、读记忆的）不算：那些结果来自记忆本身，拿来佐证记忆就成了自证。
 * 按日志顺序扫到范围终点为止，工具结果配它之前最近的同 id 调用：宿主不保证整个会话里调用 id 不重复。
 */
export function evidenceOf(log: SessionLog, range: readonly [number, number], isExcluded: (call: ToolCallInfo) => boolean): Evidence {
  const calls = new Map<string, ToolCallInfo>()
  const evidence: Evidence = { user: false, tool: false }
  for (const e of log.events) {
    if (typeof e.seq === 'number' && e.seq > range[1]) break
    if (e.type === 'tool/call') {
      const d = asObject(e.data)
      if (typeof d?.callId === 'string' && typeof d.name === 'string') {
        calls.set(d.callId, { name: d.name, arguments: typeof d.arguments === 'string' ? d.arguments : '' })
      }
      continue
    }
    if (typeof e.seq !== 'number' || e.seq < range[0] || isOwnEvent(log, e) !== true) continue
    if (isRealUserMessage(log, e)) evidence.user = true
    if (e.type === 'tool/result') {
      const message = asObject(asObject(e.data)?.message) as MessageData | undefined
      const call = message?.toolCallId === undefined ? undefined : calls.get(message.toolCallId)
      if (call !== undefined && message?.isError !== true && !isExcluded(call)) evidence.tool = true
    }
  }
  return evidence
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 参数里的路径先还原成常见写法：JSON 里转义的斜杠 \/ 还原成 /，/./ 折成 /。 */
const normalizePaths = (args: string) => args.replace(/\\\//g, '/').replace(/\/(?:\.\/)+/g, '/')

/**
 * 不算工具证据的调用：本插件的工具；参数里提到记忆根目录的调用，读文件、shell 都一样。
 * 认得的写法：绝对路径；家目录下的 ~、$HOME、${HOME} 写法；记忆根相对家目录的那一段（如 .dsh/memories），
 * 出现在路径边界处（行首、空白、引号、=、/ 之后）也算，所以别的目录下同名的 .dsh/memories 同样排除，不加区分。
 * 路径后面只要不是名字里能有的字符（字母数字、下划线、点、连字符）就算到头，同名前缀的别的目录（memories-backup）照常算。
 * 认不了的：符号链接、cwd 在记忆根里面时的相对路径、shell 里拼出来的路径。这里只做字符串比对，不碰文件系统。
 */
export function excludesPluginEvidence(opts: { toolNames: readonly string[]; memoryRoot: string; homeDir?: string }): (call: ToolCallInfo) => boolean {
  const root = opts.memoryRoot.replace(/\/+$/, '')
  const forms = [escapeRegExp(root)]
  if (opts.homeDir !== undefined) {
    const home = opts.homeDir.replace(/\/+$/, '')
    if (home !== '' && root.startsWith(`${home}/`)) {
      const rel = escapeRegExp(root.slice(home.length + 1))
      forms.push(`(?:~|\\$HOME|\\$\\{HOME\\})/${rel}`)
      // 参数是 JSON 字符串，命令里的换行落成 \n 两个字符，也当行首
      forms.push(`(?:^|(?<=[\\s"'=/])|(?<=\\\\[nrt]))${rel}`)
    }
  }
  const mentionsRoot = new RegExp(`(?:${forms.join('|')})(?![\\w.-])`, 'm')
  const names = new Set(opts.toolNames)
  return call => names.has(call.name) || (root !== '' && mentionsRoot.test(normalizePaths(call.arguments)))
}

/** 保存时记进锚的事实。initiator、evidence 读不到日志时缺省；startTime 是锚起点事件的时间。 */
export interface AnchorFacts {
  initiator?: string
  isUserInitiated: boolean
  evidence?: Evidence
  startTime?: number
}

/**
 * 证据锚的事件范围：[当轮 turn/start, 保存时刻]，两个数都是机械事实。读不到轮起点时退回整会话。
 * 管线落锚、保存时读会话日志算当轮事实用同一个范围。
 */
export function anchorRangeOf(session: { lastSeq: number; turnStartSeq?: number | undefined }): [number, number] {
  return [Math.min(session.turnStartSeq ?? 0, session.lastSeq), session.lastSeq]
}

/**
 * 保存时从会话日志读出锚的事实：当轮起点的来源标记原样记下，是不是用户本人另判（委派任务的标记也是 user）。
 * turnStartSeq 是宿主读到的当轮起点，读不到为 undefined：这时按 lastSeq 找当轮，不拿整会话锚的起点 0 当轮起点。
 * 证据类别和起点时间按 anchorRangeOf 的范围算，和落盘的锚一致。读不到日志（宿主给不出发起方）按非用户发起。
 */
export function anchorFactsOf(
  log: SessionLog | null,
  anchor: { turnStartSeq: number | undefined; lastSeq: number },
  isExcluded: (call: ToolCallInfo) => boolean,
): AnchorFacts {
  if (log === null) return { isUserInitiated: false }
  const range = anchorRangeOf(anchor)
  const opener = turnOpenerOf(log, anchor.turnStartSeq, anchor.lastSeq)
  const initiator = opener === undefined ? undefined : sourceKindOf(opener)
  const startTime = log.events.find(e => e.seq === range[0])?.time
  return {
    ...(initiator !== undefined ? { initiator } : {}),
    isUserInitiated: initiatorOf(log, opener) === 'user',
    evidence: evidenceOf(log, range, isExcluded),
    ...(startTime !== undefined ? { startTime } : {}),
  }
}
