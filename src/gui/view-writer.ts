import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MemoryStore, MemoryLogger } from '../store.ts'
import type { KvTable } from '../kv-table.ts'
import type { LocatedRecord } from '../storage/table.ts'
import type { TypeRegistry } from '../type-registry.ts'
import { isModelChange, kindOf, type PendingDecisionsStore } from '../governance/decisions.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { MemorySnapshot, ScanCacheEntry } from '../governance/schema.ts'
import { staleIgnores, type AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import { lastCheckupAt, type CheckupRecordStore } from '../governance/checkup-records.ts'
import type { AutoCheckupSettingStore } from '../governance/auto-checkups.ts'
import { checkupWorkspaces, listingNotes, prereadScopes } from '../tools/scope-preread.ts'
import {
  GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, GUI_WORKSPACE_MAP_FILE, SCOPE_KEYS, checkupKey, sessionViewFile, workspaceMapViewSchema,
  type CheckupView, type GlobalViewName, type SessionView, type WorkspaceMapView,
} from './contract.ts'
import { GLOBAL_VIEW_NAMES, buildCheckupView, buildGlobalViews, type GlobalViews } from './views.ts'
import { scopeCacheKey, scopeOfLedger, type Scope } from '../scope.ts'

export interface ViewSourceDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  cache: KvTable<ScanCacheEntry>
  /** 快照表：模型改写、替代的改前那份从这里取；缺省不列 modelChanges。 */
  snapshots?: Pick<SnapshotStore, 'get'>
  /** 建议忽略表；缺省按没有忽略算、不做清理。 */
  ignores?: AdviceIgnoreStore
  /** 体检记录表：健康视图的上次体检取它的完成记录；缺省按没有完成记录算、不做清理。 */
  checkups?: CheckupRecordStore
  /** 自动体检设置表：项目目录不在了，它的设置在这里清掉；缺省不做清理。 */
  autoCheckups?: AutoCheckupSettingStore
  registry: TypeRegistry
  memoryRoot: string
  now?: () => number
  /** 体检开关（用时读配置）；缺省视为开启。 */
  isGovernanceEnabled?: () => boolean
  /** 插件本次加载的时刻，写进健康视图（契约 bootedAt）。 */
  bootedAt?: number
  /** 清理忽略表出错时记一条；缺省 console。 */
  log?: MemoryLogger
}

/**
 * 预读 → 四个全局视图。读 global + 全部 workspace 目录（含 .archive/；只剩归档的项目也读，最近删除要用），
 * 健康只列 global + 体检清单，与 memory_health 体检同一批作用域、同一个预读函数。
 * 顺带是建议忽略表的清理点：读的是全部作用域，引用的记忆已不在用（删除、归档、彻底删除）或内容变了的记录在这里删掉；
 * 也是体检记录表、自动体检设置表的清理点：项目目录不在了，它的记录和设置在这里删掉。
 */
export async function collectGlobalViews(deps: ViewSourceDeps): Promise<GlobalViews> {
  const now = deps.now?.() ?? Date.now()
  const log = deps.log ?? console
  const listing = await deps.store.listWorkspaceDirs()
  const ws = (workspacePath: string): Scope => ({ kind: 'workspace', workspacePath })
  const readScopes: Scope[] = [{ kind: 'global' }, ...[...new Set(listing.entries.map(e => e.workspacePath))].sort().map(ws)]
  const healthScopes: Scope[] = [{ kind: 'global' }, ...checkupWorkspaces(listing).map(ws)]
  const data = await prereadScopes(deps, readScopes)
  const [open, settled] = await Promise.all([deps.decisions.list(), deps.decisions.listSettled()])
  let modelChangeSnapshots: Map<string, MemorySnapshot> | undefined
  if (deps.snapshots !== undefined) {
    modelChangeSnapshots = new Map()
    for (const id of new Set(settled.filter(isModelChange).map(e => e.settled?.snapshotId))) {
      const snap = id === undefined ? undefined : await deps.snapshots.get(id)
      if (snap !== undefined) modelChangeSnapshots.set(snap.id, snap)
    }
  }
  // 提升候选按条目所在的项目取那一份（与提升命令定位同一份）：预读每个 id 只留一份，同 id 在别的项目也有时可能是那份
  const candidateCopies = new Map<string, LocatedRecord>()
  for (const e of open) {
    const label = e.workspaces?.[0]
    const own = label === undefined ? undefined : scopeOfLedger(label)
    const r = data.byId.get(e.memoryIds[0] ?? '')
    if (kindOf(e) !== 'promote-candidate' || own?.kind !== 'workspace' || r === undefined) continue
    const { workspacePath } = own
    if (r.scope === 'workspace' && r.workspacePath === workspacePath) continue
    const hit = await deps.store.locate(r.id, own)
    if (hit !== undefined && dirname(hit.filePath) === hit.dir) candidateCopies.set(e.id, { record: hit.record, filePath: hit.filePath, dir: hit.dir })
  }
  const notes = listingNotes(listing, { includeEmpty: false })
  // 有缺标记或读不出的目录时，项目可能只是这次没认出来，不按「目录不在了」清它的体检记录
  const isListingComplete = !notes.some(n => n.code === 'marker-missing' || n.code === 'dir-unreadable')
  if (isListingComplete) {
    const present = new Set(listing.entries.map(e => e.workspacePath))
    try {
      await deps.checkups?.removeMissingWorkspaces(present)
    } catch (err) {
      log.warn('[plastic-memory] 体检记录表清理失败，下次生成视图再试', err)
    }
    try {
      await deps.autoCheckups?.removeMissingWorkspaces(present)
    } catch (err) {
      log.warn('[plastic-memory] 自动体检设置表清理失败，下次生成视图再试', err)
    }
  }
  if (deps.ignores !== undefined) {
    // 有读不出的文件或目录时，byId 里没有的 id 可能只是这次没读到，不按「已不在」清
    const isComplete = readScopes.every(s => (data.quarantined.get(scopeCacheKey(s)) ?? []).length === 0)
      && ![...notes, ...data.directoryNotes].some(n => n.code === 'marker-missing' || n.code === 'dir-unreadable')
    // 清理是顺带的：出错只记日志，不挡视图写出（没清掉的记录指纹对不上，本来就不起作用）
    try {
      await deps.ignores.remove(staleIgnores(data.ignores, data.byId, { isComplete, before: now }))
    } catch (err) {
      log.warn('[plastic-memory] 建议忽略表清理失败，下次生成视图再试', err)
    }
  }
  return buildGlobalViews({
    now, memoryRoot: deps.memoryRoot, registry: deps.registry, data, readScopes, healthScopes, open, settled,
    listingNotes: notes,
    governanceEnabled: deps.isGovernanceEnabled?.() ?? true,
    ...(deps.bootedAt !== undefined ? { bootedAt: deps.bootedAt } : {}),
    ...(modelChangeSnapshots !== undefined ? { modelChangeSnapshots } : {}),
    candidateCopies,
  })
}

export interface CheckupSourceDeps {
  store: Pick<MemoryStore, 'listWorkspaceDirs'>
  checkups: Pick<CheckupRecordStore, 'list' | 'isInProgress'>
  autoCheckups: Pick<AutoCheckupSettingStore, 'read'>
  /** 语义缓存：还没有完成记录（升级前体检过）的范围，上次体检暂取缓存的时间。 */
  cache: KvTable<ScanCacheEntry>
  /** 体检开关（用时读配置）；缺省视为开启。 */
  isGovernanceEnabled?: () => boolean
  now?: () => number
}

/** 体检视图：只读目录清单、两张小侧表、各范围的认领文件和缓存的时间，不读记忆文件，调度器每次检查都可以读。 */
export async function collectCheckupView(deps: CheckupSourceDeps): Promise<CheckupView> {
  const now = deps.now?.() ?? Date.now()
  const listing = await deps.store.listWorkspaceDirs()
  const scopes: Scope[] = [{ kind: 'global' }, ...checkupWorkspaces(listing).map(workspacePath => ({ kind: 'workspace' as const, workspacePath }))]
  const [settings, records] = await Promise.all([deps.autoCheckups.read(), deps.checkups.list()])
  const byKey = new Map(records.map(r => [r.id, r]))
  const last = new Map<Scope, number | null>()
  const inProgress = new Set<Scope>()
  for (const scope of scopes) {
    const record = byKey.get(checkupKey(scope))
    last.set(scope, lastCheckupAt(record, record?.completed === undefined ? await deps.cache.get(scopeCacheKey(scope)) : undefined))
    if (await deps.checkups.isInProgress(scope)) inProgress.add(scope)
  }
  return buildCheckupView({
    now, governanceEnabled: deps.isGovernanceEnabled?.() ?? true, settings, scopes,
    lastCheckupAt: scope => last.get(scope) ?? null, isInProgress: scope => inProgress.has(scope), record: scope => byKey.get(checkupKey(scope)),
    allRecord: byKey.get(SCOPE_KEYS.all),
  })
}

/**
 * 视图写入器：把视图写成 `<memoryRoot>/.state/gui/*.json`（tmp + rename 原子替换）。
 * 节流：同一 tick 内的多次请求合并成一次收集、每个受影响的文件只写一遍；写入串行，进行中再来的请求排到下一轮。
 * 同一个文件两次替换至少隔开 VIEW_REPLACE_GAP_MS：宿主的文件观察对同一文件约 50ms 内的变更只通知第一次，
 * 紧挨着的第二次替换会被漏掉，浏览器半侧就停在上一版，直到下一次变化或刷新。
 * 几个进程（桌面版与 `dsh web`）同开时：全局视图和体检视图替换前比生成时刻，早收集的不盖晚收集的（见 writeText）；
 * 归属对照每次等完替换间隔、写前重读磁盘再合并。
 * 视图是派生缓存，写失败只记日志，不影响触发它的操作。
 * 卸载（dispose）后不再写：之后的请求直接返回，排队未开始的丢弃，进行中的那次写完才返回。
 */
/** 同一视图文件两次替换的最小间隔（ms）。宿主节流窗口约 50ms，文件事件送达还有抖动：实测隔 100ms 仍偶有漏推，150ms 不再漏。 */
export const VIEW_REPLACE_GAP_MS = 150

export class ViewWriter {
  private readonly dir: string
  private readonly queued = new Set<GlobalViewName>()
  private readonly sessions = new Map<string, SessionView>()
  /** 待写进归属对照的条目（原始 cwd → 项目）。 */
  private readonly cwds = new Map<string, string>()
  /** 最近一次落盘或读到的归属对照，只用来跳过和它一样的请求；写时总是重读磁盘再合并。 */
  private workspaceMap: Record<string, string> | undefined
  private scheduled: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly log: MemoryLogger
  private readonly collect: () => Promise<GlobalViews>
  private readonly collectCheckups: (() => Promise<CheckupView>) | undefined
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** 每个视图文件上次替换的时刻。 */
  private readonly replacedAt = new Map<string, number>()

  /** collectCheckups：体检视图的收集；缺省不写体检视图。 */
  constructor(opts: {
    memoryRoot: string
    collect: () => Promise<GlobalViews>
    collectCheckups?: () => Promise<CheckupView>
    log?: MemoryLogger
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }) {
    this.dir = join(opts.memoryRoot, GUI_VIEW_DIR)
    this.log = opts.log ?? console
    this.collect = opts.collect
    this.collectCheckups = opts.collectCheckups
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  }

  /** 只重写体检视图（设置改了、调度检查时）：不等节流，排在进行中的写入之后；内容和磁盘上的一样就不写。 */
  requestCheckups(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.enqueue(() => this.writeCheckups())
  }

  /** 请求重写这些全局视图（缺省四个都写；写健康视图时体检视图跟着重写）。 */
  request(views: readonly GlobalViewName[] = GLOBAL_VIEW_NAMES): Promise<void> {
    if (this.disposed) return Promise.resolve()
    for (const v of views) this.queued.add(v)
    return this.schedule()
  }

  /** 请求写一个会话的视图；同一 tick 内同一会话以最后一份为准。 */
  requestSession(view: SessionView): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.sessions.set(view.sessionId, view)
    return this.schedule()
  }

  /** 记一笔会话归属（原始 cwd → 服务端解析出的项目）；和已落盘的一样就不写。 */
  requestWorkspace(cwd: string, workspacePath: string): Promise<void> {
    if (this.disposed || (this.workspaceMap?.[cwd] === workspacePath && !this.cwds.has(cwd))) return Promise.resolve()
    this.cwds.set(cwd, workspacePath)
    return this.schedule()
  }

  /**
   * 全量重写入口：不等节流，排在进行中的写入之后立即收集并写出四个全局视图。返回本次收集的视图（已卸载或写失败时为 undefined）；
   * 盘上已有别的进程写的更晚的视图时，对应文件不写，返回的仍是本次收集的那份。
   */
  async rewriteAll(): Promise<GlobalViews | undefined> {
    if (this.disposed) return undefined
    let written: GlobalViews | undefined
    await this.enqueue(async () => { written = await this.writeGlobal(GLOBAL_VIEW_NAMES) })
    return written
  }

  /** 只收集、不写视图文件（体检前记下当时的待处理，和体检后比出新增）；收集本身照常清理建议忽略表里失效的记录。 */
  collectViews(): Promise<GlobalViews> {
    return this.collect()
  }

  /** 插件卸载时调用：此后不再落盘；等进行中的写入结束再返回，免得旧实例的迟到写入盖掉新实例的视图。 */
  dispose(): Promise<void> {
    this.disposed = true
    this.queued.clear()
    this.sessions.clear()
    this.cwds.clear()
    return this.tail
  }

  private schedule(): Promise<void> {
    this.scheduled ??= new Promise<void>(resolve => setImmediate(resolve)).then(() => this.enqueue(async () => {
      this.scheduled = undefined
      const views = [...this.queued]
      const sessions = [...this.sessions.values()]
      const cwds = [...this.cwds]
      this.queued.clear()
      this.sessions.clear()
      this.cwds.clear()
      if (views.length > 0) await this.writeGlobal(views)
      for (const s of sessions) await this.writeFile(sessionViewFile(s.sessionId), s)
      if (cwds.length > 0) await this.writeWorkspaceMap(cwds)
    }))
    return this.scheduled
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    // 排队时还没卸载、轮到时已卸载的，跳过不写
    const run = this.tail.then(() => this.disposed ? undefined : job()).catch(err => this.log.warn('[plastic-memory] GUI 视图写入失败', err))
    this.tail = run
    return run
  }

  private async writeGlobal(names: readonly GlobalViewName[]): Promise<GlobalViews> {
    const views = await this.collect()
    for (const name of names) await this.writeText(GUI_VIEW_FILES[name], JSON.stringify(views[name]), views[name].generatedAt)
    // 上次体检和健康视图同源：写健康视图的时机（体检、写工具、配置热更新、刷新）体检视图也跟着重写
    if (names.includes('health')) await this.writeCheckups()
    return views
  }

  private async writeCheckups(): Promise<void> {
    if (this.collectCheckups === undefined) return
    const view = await this.collectCheckups()
    // 比内容时去掉生成时刻：每次收集都换新时刻，只差它就重写会让界面白收一次文件事件
    const content = (v: unknown) => JSON.stringify({ ...(v as object), generatedAt: undefined })
    const current = await readFile(join(this.dir, GUI_CHECKUP_VIEW_FILE), 'utf8').then(t => JSON.parse(t) as unknown).catch(() => undefined)
    if (current === undefined || content(current) !== content(view)) await this.writeText(GUI_CHECKUP_VIEW_FILE, JSON.stringify(view), view.generatedAt)
  }

  private async writeWorkspaceMap(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
    // 等完替换间隔再重读磁盘合并：几个进程同开时各记各的会话，手里的旧对照、等待之前读到的对照都会盖掉别的进程刚记下的
    let merged: Record<string, string> | undefined
    await this.replace(GUI_WORKSPACE_MAP_FILE, async () => {
      const onDisk = await this.readWorkspaceMap()
      merged = { ...onDisk.cwds }
      for (const [cwd, workspacePath] of entries) merged[cwd] = workspacePath
      // 磁盘上是旧版本号的：客户端按版本认，不认就退回原始 cwd，内容没变也重写一次
      if (!onDisk.isOutdated && entries.every(([cwd, workspacePath]) => onDisk.cwds[cwd] === workspacePath)) return undefined
      const view: WorkspaceMapView = { version: GUI_VIEW_VERSION, cwds: merged }
      return JSON.stringify(view)
    })
    this.workspaceMap = merged
  }

  /**
   * 磁盘上的旧对照；没有、读不懂（坏 JSON、形状不对）都从空表开始。读时不看版本号，只按 cwds 的形状读：视图版本升级时
   * 对照的形状没变，整份丢掉会让之前见过的会话都失去归属（写出时照旧写当前版本）。isOutdated：读到了、但版本号不是当前的。
   * 其他读错（权限、I/O）往外抛，本次不写：当空表合并会把别的会话的归属都清掉。
   */
  private async readWorkspaceMap(): Promise<{ cwds: Record<string, string>; isOutdated: boolean }> {
    let text: string
    try {
      text = await readFile(join(this.dir, GUI_WORKSPACE_MAP_FILE), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { cwds: {}, isOutdated: false }
      throw err
    }
    try {
      const json: unknown = JSON.parse(text)
      const parsed = workspaceMapViewSchema.pick({ cwds: true }).safeParse(json)
      const isOutdated = (json as { version?: unknown } | null)?.version !== GUI_VIEW_VERSION
      return parsed.success ? { cwds: { ...parsed.data.cwds }, isOutdated } : { cwds: {}, isOutdated: false }
    } catch {
      return { cwds: {}, isOutdated: false }
    }
  }

  private async writeFile(fileName: string, view: unknown): Promise<void> {
    await this.writeText(fileName, JSON.stringify(view))
  }

  private writeText(fileName: string, text: string, generatedAt?: number): Promise<void> {
    return this.replace(fileName, async () => text, generatedAt)
  }

  /**
   * 替换一个视图文件。render 在替换间隔等完之后才调用，返回 undefined 就不写：要按盘上现状合并的（归属对照）在这里读盘。
   * generatedAt：这份视图的生成时刻。给了就紧贴 rename 读盘上那份，盘上的更晚就不写（删掉临时文件）：
   * 几个进程同开时，早收集、晚写完的视图不盖掉别的进程刚写的新视图。
   */
  private async replace(fileName: string, render: () => Promise<string | undefined>, generatedAt?: number): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, fileName)
    const last = this.replacedAt.get(fileName)
    // 封顶：时钟往回调过时 last 在此刻之后，不封顶就要多等回调的那段
    const wait = last === undefined ? 0 : Math.min(last + VIEW_REPLACE_GAP_MS - this.now(), VIEW_REPLACE_GAP_MS)
    if (wait > 0) await this.sleep(wait)
    const text = await render()
    if (text === undefined) return
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmp, text, 'utf8')
    if (generatedAt !== undefined && await this.generatedAtOnDisk(path) > generatedAt) {
      await rm(tmp, { force: true })
      return
    }
    await rename(tmp, path)
    this.replacedAt.set(fileName, this.now())
  }

  /** 盘上那份视图的生成时刻：读不到、没有这个字段、版本号不是当前的，或晚于此刻（时钟往回调过）的按 0 算。 */
  private async generatedAtOnDisk(path: string): Promise<number> {
    const onDisk = await readFile(path, 'utf8').then(t => JSON.parse(t) as { version?: unknown; generatedAt?: unknown } | null).catch(() => undefined)
    const at = onDisk?.version === GUI_VIEW_VERSION ? onDisk.generatedAt : undefined
    return typeof at === 'number' && at <= this.now() ? at : 0
  }
}
