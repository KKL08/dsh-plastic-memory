import { DIALOGUE_INTAKE_VERSION, intakeOf, type DialogueRow, type DialogueTurn } from '../search/dialogue-intake.ts'
import type { DialogueTokenizer } from '../search/dialogue-tokenizer.ts'
import { SEGMENT_RULE_VERSION } from '../search/segments.ts'
import {
  DialogueStoreUnavailable, type DialogueCoverage, type DialogueRecordStore, type DialogueStoreState, type DialogueVersions,
} from '../storage/dialogue-records.ts'
import type { MemoryLogger } from '../storage/table.ts'
import type { HostSession, HostSessionEntry } from './host-session.ts'

/**
 * 对话记录库的追赶编排：把宿主会话日志里的消息收进库。
 *
 * - 一次「追」分四步：按当前规则备好库 → 对账（库里有、现在不该有的会话移出；该有、还没收的排队）→ 追点名的会话
 *   （检索前是当前会话和开着的会话）→ 在剩下的时间里推进待建队列。每一步都看时限，到点就停，剩下的留给下一次。
 * - 一个会话的日志整份读一次，按消息条数切批提交；批与批之间让出事件循环。每批提交前都看一眼：功能还开着、
 *   库没被删。同步检查之后紧接着同步提交，中间不让出，所以本进程里删库之后不会再写进去。
 * - 待建队列推进时一次没交完的批留在内存里（只留一个会话），下一次推进先接着交，不再整份重读；交完之后的那次推进
 *   照常整份读一次，收期间新增的事件、没有新事件就出队。库里的代、修订号和水位对不上就不用它，照常整份读。
 * - 几个进程、几次调用同时追同一个会话不加锁：提交时库核对代、修订号和起算水位，对不上的那一批作废，这次不再追它。
 * - 读不到日志的会话留在队尾，不当成会话没了；会话没了只由对账（宿主列得出会话清单时）认定。队里只剩读不到的，这一代照样算建完。
 * - 换了词典：库记下新词典和整词列重算到哪，之后只收按新词典算的批；重算的进度在库里，换进程接着算。
 * - 范围只管收不收：对账只移出宿主那边已经没有的和标了不回看的会话。别的进程按它自己的当前项目收进来的会话，这里不删。
 * - 重建期间新消息写进新的一代，查询读旧的一代，建完才切过去。
 */

/** 一批最多几条消息。 */
export const CATCHUP_BATCH_MESSAGES = 40
/** 换词典后重算 w 列，一批几段。 */
const REWRITE_BATCH_SEGMENTS = 200
/**
 * 后台推进的节奏：每隔一段跑一小段，不和前台抢时间。数值先取保守的，等基准测出来再调。
 * 没有后台计时器时，检索自己花 CATCHUP_QUEUE_BUDGET_MS 推进队列。
 */
export const CATCHUP_BACKGROUND_INTERVAL_MS = 5_000
export const CATCHUP_BACKGROUND_BUDGET_MS = 150
/** 检索前追当前会话和开着的会话最多花这么久。 */
export const CATCHUP_FOCUS_BUDGET_MS = 300
export const CATCHUP_QUEUE_BUDGET_MS = 150
/** 两次对账至少隔这么久：对账要列全部会话，不必每次检索都做。 */
export const RECONCILE_INTERVAL_MS = 60_000

/** 这一次原话能不能用。off：功能关着；unavailable：库这一次用不了，只查记忆。 */
export type DialogueReadiness =
  | { kind: 'off' }
  | { kind: 'unavailable'; isBusy: boolean }
  | {
    kind: 'ready'
    /** 查询读的那一代。 */
    gen: number
    status: 'building' | 'ready' | 'rebuilding'
    coverage: DialogueCoverage
    /** 点名的会话是不是都追到了这一刻；没追完时结果里可能缺最新的几条。 */
    isCaughtUp: boolean
    /** 这一次对过账时列到的会话清单，同一次检索里放行会话直接用它；这次没对账就没有。 */
    listed?: HostSessionEntry[]
  }

/** 一个会话在库里收到了哪：给按会话读原文的入口判断能不能直接用库。 */
export interface SessionCoverage {
  /** 读的那一代。 */
  gen: number
  /** 已经收到的最后一条事件的序号；一条都没收是 -1，整个不收是 SKIPPED_WATERMARK。 */
  watermark: number
  /** 规则变了正在重建：这一代是按旧规则收的，新消息不再进来。 */
  isRebuilding: boolean
}

export interface DialogueCatchupDeps {
  store: DialogueRecordStore
  host: Pick<HostSession, 'readSessionLog' | 'listSessions'>
  noReview: { isMarkedNoReview(sessionId: string): Promise<boolean>; sessionIds(): Promise<Set<string>> }
  tokenizer(): Promise<DialogueTokenizer>
  /** 会话的工作目录属于哪个项目；没有工作目录或解析不出为 undefined。 */
  workspaceOf(cwd: string | undefined): Promise<string | undefined>
  /** 这个记忆根见过的项目。 */
  knownWorkspaces(): Promise<readonly string[]>
  /** 原话功能现在是不是开着（检索来源含原话，或记忆带原话）。每次现读。 */
  isEnabled(): boolean
  /** 会话日志存在哪：换了地方，库里的行就不是这批会话的了。 */
  sessionStore: string
  log: MemoryLogger
  now?: () => number
  /** 批与批之间让出事件循环；测试注入它来安排交错。 */
  pause?: () => Promise<void>
  batchMessages?: number
}

type SessionOutcome = 'done' | 'partial' | 'superseded' | 'unreadable' | 'removed' | 'stopped'

type Batch = { rows: DialogueRow[]; watermark: number; isLast: boolean }

/**
 * 一个会话整份读过一次、切好但还没提交完的批。键是（代、会话 id、修订号）；next 之前的批都已提交成功，
 * from 是下一批的起算水位，end 是读到的日志末尾（最后一批提交到这里）。
 */
interface Pending {
  gen: number
  sessionId: string
  revision: number
  from: number
  end: number
  turns: DialogueTurn[]
  batches: Batch[]
  next: number
}

interface Prepared { state: Exclude<DialogueStoreState, { status: 'none' }>; tokenizer: DialogueTokenizer }

export class DialogueCatchup {
  private readonly deps: DialogueCatchupDeps
  private readonly now: () => number
  private readonly pause: () => Promise<void>
  private readonly batchMessages: number
  /** 删库、停用一次加一：在途的追赶据此知道自己该停了。 */
  private epoch = 0
  /** 上次对账列到的、范围里该收的会话。 */
  private eligible = new Map<string, HostSessionEntry>()
  /** 上次对账时宿主列得出、没标不回看的全部会话：队里别的进程按它的范围排进来的会话，据此知道还在不在。 */
  private present = new Map<string, HostSessionEntry>()
  private reconciledAt: number | undefined
  private reconciledGen: number | undefined
  /** 本进程里当过当前会话的项目：它们还没有记忆时也在范围里。 */
  private readonly currentWorkspaces = new Set<string>()
  /** 正在等结果的检索有几个：有的话后台让路。 */
  private foreground = 0
  /** 已经警告过的故障：后台每几秒跑一次，同一个故障只记一条。 */
  private readonly warned = new Set<string>()
  /** 检索前追赶上次开始追各个会话的时刻：开着的会话按它从早到晚轮，时限内追不完的下次接着排在前面。 */
  private readonly focusedAt = new Map<string, number>()
  /**
   * 待建队列推进时没交完的批，只留一个会话。推进一个会话时槽里是它的就取走接着交；同一进程里两次推进并发时，
   * 没取到的那一次照常整份读。放回见 keep。检索前追点名的会话不用它。
   */
  private snapshot: Pending | undefined

  /** 共享同一个对话记录库，只向读取入口提供查询方法。 */
  get readStore(): Pick<DialogueRecordStore, 'state' | 'search' | 'segmentsOf' | 'turnsOf' | 'queued' | 'isQueued' | 'session'> {
    return this.deps.store
  }

  constructor(deps: DialogueCatchupDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.pause = deps.pause ?? (() => new Promise(resolve => setImmediate(resolve)))
    this.batchMessages = deps.batchMessages ?? CATCHUP_BATCH_MESSAGES
  }

  /**
   * 检索前调：追当前会话和开着的会话（最多花 focusBudgetMs），再推进待建队列（最多再花 queueBudgetMs，
   * 有后台计时器在推进时传 0）。超时不等，用已有的，返回覆盖情况。
   */
  async beforeSearch(
    current: { sessionId: string; cwd: string | undefined; isSubagent: boolean }, focusBudgetMs: number, queueBudgetMs: number,
  ): Promise<DialogueReadiness> {
    this.foreground += 1
    try {
      return await this.guarded(async () => {
        const started = this.now()
        const alive = this.aliveCheck()
        const prepared = await this.prepare(alive)
        if (prepared === undefined) return { kind: 'off' }
        const gen = prepared.state.write.gen
        const workspace = await this.deps.workspaceOf(current.cwd)
        if (workspace !== undefined && !this.currentWorkspaces.has(workspace)) {
          this.currentWorkspaces.add(workspace)
          // 范围多了一个项目：上次对账没算它的会话，这一次重新对
          this.reconciledAt = undefined
        }
        const listed = await this.reconcile(prepared, alive)
        const isFocusOver = () => this.now() >= started + focusBudgetMs
        // 当前会话不等对账：对账这一次没做成时，它也要能搜到自己的原话
        // 当前会话认不出属于哪个项目（没有工作目录）时不在范围里，不收；结果里如实说没追到
        // 其余开着的会话按上次开始追的时刻从早到晚排，没追过的最前，同一时刻按宿主清单的顺序
        const focus = new Map<string, HostSessionEntry>()
        if (workspace !== undefined) focus.set(current.sessionId, { id: current.sessionId, cwd: workspace, isSubagent: current.isSubagent, isLive: true })
        const live = [...this.eligible.values()].filter(e => e.isLive && !focus.has(e.id))
        const focusedAt = (id: string) => this.focusedAt.get(id) ?? Number.MIN_SAFE_INTEGER
        live.sort((a, b) => focusedAt(a.id) - focusedAt(b.id))
        for (const entry of live) focus.set(entry.id, entry)
        let isCaughtUp = workspace !== undefined
        for (const entry of focus.values()) {
          if (!alive()) return { kind: 'off' }
          if (isFocusOver()) { isCaughtUp = false; break }
          this.focusedAt.set(entry.id, this.now())
          const outcome = await this.catchUpSession(prepared, entry, isFocusOver, alive, false)
          if (outcome !== 'done' && outcome !== 'removed') isCaughtUp = false
        }
        if (queueBudgetMs > 0) {
          // 没有后台在推进：换词典的重算和待建队列都由检索自己带一段
          const queueDeadline = this.now() + queueBudgetMs
          const isQueueOver = () => this.now() >= queueDeadline
          await this.rewriteDictionary(prepared, isQueueOver, alive)
          await this.advanceQueue(prepared, isQueueOver, alive)
        }
        if (!alive()) return { kind: 'off' }
        const state = this.deps.store.state()
        if (state.status === 'none') return { kind: 'unavailable', isBusy: false }
        // 重建期间点名的会话写进了新的一代，查询读的旧一代里没有它们的新消息
        return {
          kind: 'ready', gen: state.read.gen, status: state.status, coverage: this.deps.store.coverage(state.read.gen),
          isCaughtUp: isCaughtUp && state.read.gen === gen, ...(listed !== undefined ? { listed } : {}),
        }
      })
    } finally {
      this.foreground -= 1
    }
  }

  /** 后台调：对账，重算换了词典的 w 列，推进待建队列，最多花 budgetMs；有检索在等时提前停。 */
  async advance(budgetMs: number): Promise<DialogueReadiness> {
    return this.guarded(async () => {
      const deadline = this.now() + budgetMs
      // 有检索在等结果就让路，剩下的下一拍再做
      const isOver = () => this.now() >= deadline || this.foreground > 0
      const alive = this.aliveCheck()
      const prepared = await this.prepare(alive)
      if (prepared === undefined) return { kind: 'off' }
      await this.reconcile(prepared, alive)
      await this.rewriteDictionary(prepared, isOver, alive)
      await this.advanceQueue(prepared, isOver, alive)
      if (!alive()) return { kind: 'off' }
      const state = this.deps.store.state()
      if (state.status === 'none') return { kind: 'unavailable', isBusy: false }
      return { kind: 'ready', gen: state.read.gen, status: state.status, coverage: this.deps.store.coverage(state.read.gen), isCaughtUp: true }
    })
  }

  /** 一个会话在读的那一代里收到了哪；功能关着、库用不了、没收过都是 undefined。 */
  coverageOf(sessionId: string): SessionCoverage | undefined {
    if (!this.deps.isEnabled()) return undefined
    try {
      const state = this.deps.store.state()
      if (state.status === 'none') return undefined
      const session = this.deps.store.session(state.read.gen, sessionId)
      if (session === undefined || session.isRemoved) return undefined
      return { gen: state.read.gen, watermark: session.watermark, isRebuilding: state.status === 'rebuilding' }
    } catch (err) {
      if (err instanceof DialogueStoreUnavailable) return undefined
      throw err
    }
  }

  /** 上次对账时这个会话在宿主的会话清单里，但不属于收录范围里的项目。没对过账、清单里没有它（比如新开的会话）都不算。 */
  isOutOfScope(sessionId: string): boolean {
    return this.present.has(sessionId) && !this.eligible.has(sessionId)
  }

  /** 用户把一个会话标成不回看之后调：在途的批次作废，已收的行清掉。 */
  dropSession(sessionId: string): void {
    this.eligible.delete(sessionId)
    this.present.delete(sessionId)
    // 不回看的原文不留在内存里；在途的批放回前会查到它已经不在队里
    this.forget(sessionId)
    try {
      if (this.deps.store.state().status !== 'none') this.deps.store.removeSession(sessionId)
    } catch (err) {
      if (!(err instanceof DialogueStoreUnavailable)) throw err
    }
  }

  /** 删库：在途的追赶先作废，再关连接、删文件。下次用到时从会话日志重建。 */
  destroy(): void {
    this.stop()
    this.deps.store.destroy()
  }

  /** 停用（功能关掉、插件卸载）：在途的追赶作废，关连接，库文件留着。 */
  stop(): void {
    this.epoch += 1
    this.snapshot = undefined
    this.eligible = new Map()
    this.present = new Map()
    this.reconciledAt = undefined
    this.reconciledGen = undefined
    this.deps.store.close()
  }

  private aliveCheck(): () => boolean {
    const epoch = this.epoch
    return () => this.epoch === epoch && this.deps.isEnabled()
  }

  private async guarded(run: () => Promise<DialogueReadiness>): Promise<DialogueReadiness> {
    if (!this.deps.isEnabled()) return { kind: 'off' }
    try {
      return await run()
    } catch (err) {
      if (err instanceof DialogueStoreUnavailable) return { kind: 'unavailable', isBusy: err.isBusy }
      const reason = String(err)
      if (!this.warned.has(reason)) {
        this.warned.add(reason)
        this.deps.log.warn(`[plastic-memory] 收对话记录时出错，这一次只查记忆：${reason}`)
      }
      return { kind: 'unavailable', isBusy: false }
    }
  }

  /** 按当前的规则版本备好库。功能关了返回 undefined。 */
  private async prepare(alive: () => boolean): Promise<Prepared | undefined> {
    const tokenizer = await this.deps.tokenizer()
    // 加载分词器是异步的：回来之后再看一眼，关了就不打开、不新建库
    if (!alive()) return undefined
    const versions: DialogueVersions = { segmentRule: SEGMENT_RULE_VERSION, tokenizer: tokenizer.tokenizerVersion, intake: DIALOGUE_INTAKE_VERSION }
    const dictionary = dictionaryOf(tokenizer)
    let state = this.deps.store.prepare(versions, dictionary, this.deps.sessionStore)
    if (state.status === 'none') throw new DialogueStoreUnavailable('备好之后库仍是空的')
    // 词典换了：让库记下新词典，从此只收按它算的批，已有的段在后面分批重算。分词器降级时没有词典可换
    if (!tokenizer.degraded && state.write.dictionary !== dictionary) {
      this.deps.store.beginDictionary(state.write.gen, dictionary)
      state = this.deps.store.state()
      if (state.status === 'none') throw new DialogueStoreUnavailable('备好之后库仍是空的')
    }
    return { state, tokenizer }
  }

  /**
   * 对账：按宿主此刻的会话清单，把宿主那边已经没有的、标了不回看的会话移出，范围里还没收的排进待建队列。
   * 范围是记忆根见过的项目加上本进程里当过当前会话的项目。宿主列不出清单时这一次不对账。返回这次对账列到的会话清单。
   */
  private async reconcile(prepared: Prepared, alive: () => boolean): Promise<HostSessionEntry[] | undefined> {
    const { store } = this.deps
    const gen = prepared.state.write.gen
    const isDue = this.reconciledGen !== gen || this.reconciledAt === undefined || this.now() - this.reconciledAt >= RECONCILE_INTERVAL_MS
    if (!isDue) return undefined
    const [listed, known, marked] = await Promise.all([this.deps.host.listSessions(), this.deps.knownWorkspaces(), this.deps.noReview.sessionIds()])
    if (listed === null) return undefined
    const scope = new Set([...known, ...this.currentWorkspaces])
    const workspaces = new Map<string | undefined, Promise<string | undefined>>()
    const workspaceOf = (cwd: string | undefined) => {
      let found = workspaces.get(cwd)
      if (found === undefined) workspaces.set(cwd, found = this.deps.workspaceOf(cwd))
      return found
    }
    const eligible = new Map<string, HostSessionEntry>()
    const present = new Map<string, HostSessionEntry>()
    for (const entry of listed) {
      if (marked.has(entry.id)) continue
      const workspace = await workspaceOf(entry.cwd)
      present.set(entry.id, { ...entry, cwd: workspace })
      if (workspace !== undefined && scope.has(workspace)) eligible.set(entry.id, { ...entry, cwd: workspace })
    }
    if (!alive()) return undefined
    const stored = new Set(store.sessionIds(gen))
    const everStored = new Set([...stored, ...(prepared.state.read.gen === gen ? [] : store.sessionIds(prepared.state.read.gen))])
    const removed = [...everStored].filter(id => !present.has(id))
    for (const id of removed) {
      store.removeSession(id)
      this.forget(id)
    }
    // 没收过的要建；现在开着的后面还有新消息；上次收的时候开着、现在关了的要收一次尾巴
    const wasOpen = store.openSessionIds(gen)
    const toQueue = [...eligible.values()].filter(e => !stored.has(e.id) || e.isLive).map(e => e.id)
    store.enqueue(gen, [...new Set([...toQueue, ...wasOpen.filter(id => eligible.has(id))])])
    this.eligible = eligible
    this.present = present
    this.reconciledAt = this.now()
    this.reconciledGen = gen
    return listed
  }

  /** 整词列要重算的段（换了词典，或分词器降级时收的）分批重算。进度记在库里，到点没算完下次、别的进程接着算。 */
  private async rewriteDictionary(prepared: Prepared, isOver: () => boolean, alive: () => boolean): Promise<void> {
    const { store } = this.deps
    const { tokenizer } = prepared
    const gen = prepared.state.write.gen
    // 分词器降级时算不出整词列：留给词典加载得起来的时候
    if (tokenizer.degraded) return
    const dictionary = dictionaryOf(tokenizer)
    // 每次碰库之前都看一眼还该不该做：让出的时候库可能已经被删了，再碰会把空库建回来
    while (alive() && !isOver()) {
      const state = store.state()
      if (state.status === 'none' || state.write.gen !== gen || state.write.dictionary !== dictionary) return
      const after = state.write.wRewriteAfter
      if (after === undefined) return
      const rows = store.segmentsAfter(gen, after, REWRITE_BATCH_SEGMENTS)
      if (rows.length === 0) {
        store.rewriteW(gen, dictionary, [])
        return
      }
      if (!store.rewriteW(gen, dictionary, rows.map(r => ({ id: r.id, w: tokenizer.columns(r.text).w })), rows[rows.length - 1]!.id)) return
      await this.pause()
    }
  }

  /**
   * 推进待建队列到时限为止。队列空了、或只剩这一趟读不到日志的会话，这一代还没标成建完的就标上
   * （重建出来的新一代从此接手查询）：读不到的留在队里以后再试，不让它们一直挡着切换。
   */
  private async advanceQueue(prepared: Prepared, isOver: () => boolean, alive: () => boolean): Promise<void> {
    const { store } = this.deps
    const gen = prepared.state.write.gen
    // 没对过账就不知道队里的会话该不该收、是谁的
    if (this.reconciledGen !== gen) return
    // 槽里的会话已经不在这一代的队里（别的进程建完或移出了它，或换了代）：原文不再留着
    const held = this.snapshot
    if (held !== undefined && (held.gen !== gen || !store.isQueued(gen, held.sessionId))) this.snapshot = undefined
    const isFresh = this.reconciledAt !== undefined && this.now() - this.reconciledAt < RECONCILE_INTERVAL_MS
    const unreadable = new Set<string>()
    let position = 0
    while (alive() && !isOver()) {
      const next = store.queuedAfter(gen, position, 1)[0]
      if (next === undefined) break
      position = next.position
      if (unreadable.has(next.sessionId)) continue
      // 队里也有别的进程按它的范围排进来的会话：宿主那边还在、没标不回看就照收
      const entry = this.eligible.get(next.sessionId) ?? this.present.get(next.sessionId)
      if (entry === undefined) {
        // 清单里没有它：清单是新的就是会话没了；清单旧了可能是刚开的会话，留着，下一次先对账
        if (isFresh) store.dequeue(gen, next.sessionId)
        else this.reconciledAt = undefined
        continue
      }
      const outcome = await this.catchUpSession(prepared, entry, isOver, alive, true)
      if (outcome === 'stopped') return
      if (outcome === 'unreadable') {
        unreadable.add(next.sessionId)
        // 读不到的挪到队尾，不挡后面的
        store.dequeue(gen, next.sessionId)
        store.enqueue(gen, [next.sessionId])
      }
    }
    if (!alive()) return
    const state = store.state()
    // 队里有没有别的会话由库在切换的同一个事务里看：别的进程刚排进来的不会被漏掉
    if (state.status !== 'none' && state.write.gen === gen && !state.write.isComplete) store.completeBuild(gen, [...unreadable])
  }

  /**
   * 把一个会话追到日志此刻的末尾，或追到时限为止。isFromQueue：待建队列推进调的，先接着交上次没交完的批，
   * 没交完的留给下一次；交完上次的批返回 partial、不出队，下一次推进再整份读一次。
   */
  private async catchUpSession(
    prepared: Prepared, entry: HostSessionEntry, isOver: () => boolean, alive: () => boolean, isFromQueue: boolean,
  ): Promise<SessionOutcome> {
    const { store } = this.deps
    const gen = prepared.state.write.gen
    // 先拿修订号，再看有没有标不回看，最后才读日志。拿到修订号之后会话被移出（标了不回看、宿主那边删了），
    // 修订号就换了，后面的提交对不上，不会把它写回来；在那之前标的，下面这一查查得到
    const session = store.startSession(gen, entry.id, { cwd: entry.cwd, isSubagent: entry.isSubagent, isOpen: entry.isLive })
    if (session === undefined) return 'superseded'
    if (await this.deps.noReview.isMarkedNoReview(entry.id)) {
      if (!alive()) return 'stopped'
      this.eligible.delete(entry.id)
      this.present.delete(entry.id)
      store.removeSession(entry.id)
      this.forget(entry.id)
      return 'removed'
    }
    const kept = isFromQueue ? this.takeSnapshot(gen, entry.id, session) : undefined
    if (kept !== undefined) {
      // 没付出读的成本：第一批也看时限
      const outcome = await this.commitPending(prepared, kept, isOver, alive, false)
      if (outcome === 'partial') this.keep(kept, alive)
      return outcome === 'done' ? 'partial' : outcome
    }
    const log = await this.deps.host.readSessionLog(entry.id)
    if (!alive()) return 'stopped'
    if (log === null) return 'unreadable'
    const intake = intakeOf(log, session.watermark)
    if (intake.kind === 'skipped') {
      // 分不清哪些消息是它自己的：整个会话不收，记下来（检索据此说没有收录），也不再排队
      if (!alive()) return 'stopped'
      store.markSkipped(gen, entry.id, session.revision)
      store.dequeue(gen, entry.id)
      return 'done'
    }
    if (intake.rows.length === 0 && intake.turns.length === 0 && intake.watermark === session.watermark) {
      // 这次没有新事件：不写库；在队里的照常出队
      if (store.isQueued(gen, entry.id)) store.dequeue(gen, entry.id)
      return 'done'
    }
    const pending: Pending = {
      gen, sessionId: entry.id, revision: session.revision, from: session.watermark, end: intake.watermark,
      turns: intake.turns, batches: batchesOf(intake.rows, this.batchMessages), next: 0,
    }
    // 第一批不看时限：读日志已经花了时间，一批都不交的话，日志大的会话每次都白读
    const outcome = await this.commitPending(prepared, pending, isOver, alive, true)
    if (outcome === 'partial' && isFromQueue) this.keep(pending, alive)
    if (outcome !== 'done') return outcome
    if (!alive()) return 'stopped'
    // 开着的会话留在队里的事由对账管：这里追完就出队，下次对账见它还开着会再排进来
    store.dequeue(gen, entry.id)
    return 'done'
  }

  /** 槽里是这个会话的批就丢掉：本进程移出它时调。 */
  private forget(sessionId: string): void {
    if (this.snapshot?.sessionId === sessionId) this.snapshot = undefined
  }

  /**
   * 槽里是这个会话的批就取走。别的会话的批留着：队首的会话交完留下的批之后还要再读一次，期间不该丢掉排在它后面、
   * 已经留下批的会话。取走的批库里的代、修订号对不上，或水位不是下一批的起算水位（别人提交过），就丢掉、返回 undefined。
   */
  private takeSnapshot(gen: number, sessionId: string, session: { revision: number; watermark: number }): Pending | undefined {
    const held = this.snapshot
    if (held?.sessionId !== sessionId) return undefined
    this.snapshot = undefined
    return held.gen === gen && held.revision === session.revision && held.from === session.watermark ? held : undefined
  }

  /**
   * 一次推进没交完时把批放进槽，槽里别的会话的批被换掉。放之前向库核对会话此刻仍在这一代的待建队列里：
   * 别处移出它、标了不回看、换掉这一代，队列里那一行都跟着删了，这时不放。槽里已有同一会话、游标更靠后的
   * 一份（同一进程里并发的另一次推进留下的）也不放，不用旧游标盖掉新的。
   */
  private keep(pending: Pending, alive: () => boolean): void {
    if (!alive() || !this.deps.store.isQueued(pending.gen, pending.sessionId)) return
    const held = this.snapshot
    if (held?.sessionId === pending.sessionId && held.gen === pending.gen && held.from >= pending.from) return
    this.snapshot = pending
  }

  /**
   * 从 pending.next 起逐批提交，每提交成功一批才把 from、next 往后挪。到点停下返回 partial；
   * isFirstFree 时这一次的第一批不看时限。全部交完返回 done，被别人抢先（提交对不上）返回 superseded。
   */
  private async commitPending(
    prepared: Prepared, pending: Pending, isOver: () => boolean, alive: () => boolean, isFirstFree: boolean,
  ): Promise<'done' | 'partial' | 'superseded' | 'stopped'> {
    const { store } = this.deps
    const first = pending.next
    while (pending.next < pending.batches.length) {
      if ((!isFirstFree || pending.next !== first) && isOver()) return 'partial'
      const batch = pending.batches[pending.next]!
      const from = pending.from
      const watermark = batch.isLast ? pending.end : batch.watermark
      const segments = batch.rows.map(r => ({
        turnSeq: r.turnSeq, seq: r.seq, segment: r.segment, ...(r.at === undefined ? {} : { at: r.at }), speaker: r.speaker, text: r.text,
        ...prepared.tokenizer.columns(r.text),
      }))
      const turns = pending.turns.filter(t => t.turnSeq > from && t.turnSeq <= watermark).map(t => ({ turnSeq: t.turnSeq, ...(t.at === undefined ? {} : { at: t.at }) }))
      // 检查和提交之间不让出：本进程里删库、关功能之后不会再写进去
      if (!alive()) return 'stopped'
      if (!store.commitBatch({ gen: pending.gen, sessionId: pending.sessionId, revision: pending.revision, dictionary: dictionaryOf(prepared.tokenizer), fromWatermark: from, watermark, segments, turns })) return 'superseded'
      pending.from = watermark
      pending.next += 1
      if (!batch.isLast) await this.pause()
    }
    return 'done'
  }
}

/** 这个分词器算整词列用的词典；降级时没有，给空串。 */
const dictionaryOf = (tokenizer: DialogueTokenizer) => tokenizer.degraded ? '' : tokenizer.dictionaryVersion ?? ''

/**
 * 把一个会话待收的行切成批：一条消息的全部段在同一批里，一批最多 size 条消息。
 * 没有行也给一批空的：水位和没有文本的空轮照样要提交。
 */
function batchesOf(rows: readonly DialogueRow[], size: number): Batch[] {
  const batches: Batch[] = []
  let current: DialogueRow[] = []
  let messages = 0
  let lastSeq: number | undefined
  for (const row of rows) {
    if (row.seq !== lastSeq) {
      if (messages === size) {
        batches.push({ rows: current, watermark: lastSeq!, isLast: false })
        current = []
        messages = 0
      }
      messages += 1
      lastSeq = row.seq
    }
    current.push(row)
  }
  batches.push({ rows: current, watermark: lastSeq ?? -1, isLast: true })
  return batches
}
