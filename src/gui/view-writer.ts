import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryStore, MemoryLogger } from '../store.ts'
import type { KvTable } from '../kv-table.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { ScanCacheEntry } from '../governance/schema.ts'
import type { LayerRef } from '../governance/layer-health.ts'
import { checkupWorkspaces, listingNotes, prereadLayers } from '../tools/layer-preread.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, GUI_WORKSPACE_MAP_FILE, sessionViewFile, workspaceMapViewSchema,
  type GlobalViewName, type SessionView, type WorkspaceMapView,
} from './contract.ts'
import { GLOBAL_VIEW_NAMES, buildGlobalViews, type GlobalViews } from './views.ts'

export interface ViewSourceDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  cache: KvTable<ScanCacheEntry>
  registry: TypeRegistry
  memoryRoot: string
  now?: () => number
  /** 体检开关（用时读配置）；缺省视为开启。 */
  isGovernanceEnabled?: () => boolean
  /** 插件本次加载的时刻，写进健康视图（契约 bootedAt）。 */
  bootedAt?: number
}

/**
 * 预读 → 四个全局视图。读 global + 全部 workspace 目录（含 .archive/；只剩归档的项目也读，最近删除要用），
 * 健康只列 global + 体检清单，与 memory_health 体检同一批层、同一个预读函数。
 */
export async function collectGlobalViews(deps: ViewSourceDeps): Promise<GlobalViews> {
  const now = deps.now?.() ?? Date.now()
  const listing = await deps.store.listWorkspaceDirs()
  const ws = (path: string): LayerRef => ({ kind: 'workspace', path })
  const readLayers: LayerRef[] = [{ kind: 'global' }, ...[...new Set(listing.entries.map(e => e.workspacePath))].sort().map(ws)]
  const healthLayers: LayerRef[] = [{ kind: 'global' }, ...checkupWorkspaces(listing).map(ws)]
  const data = await prereadLayers(deps, readLayers)
  const [open, settled] = await Promise.all([deps.decisions.list(), deps.decisions.listSettled()])
  return buildGlobalViews({
    now, memoryRoot: deps.memoryRoot, registry: deps.registry, data, readLayers, healthLayers, open, settled,
    listingNotes: listingNotes(listing, { includeEmpty: false }),
    governanceEnabled: deps.isGovernanceEnabled?.() ?? true,
    ...(deps.bootedAt !== undefined ? { bootedAt: deps.bootedAt } : {}),
  })
}

/**
 * 视图写入器：把视图写成 `<memoryRoot>/.state/gui/*.json`（tmp + rename 原子替换）。
 * 节流：同一 tick 内的多次请求合并成一次收集、每个受影响的文件只写一遍；写入串行，进行中再来的请求排到下一轮。
 * 视图是派生缓存，写失败只记日志，不影响触发它的操作。
 */
export class ViewWriter {
  private readonly dir: string
  private readonly queued = new Set<GlobalViewName>()
  private readonly sessions = new Map<string, SessionView>()
  /** 待写进归属对照的条目（原始 cwd → 项目）。 */
  private readonly cwds = new Map<string, string>()
  /** 已落盘的归属对照；首次写入前从磁盘读回（插件重载后接着记，不丢之前见过的会话）。 */
  private workspaceMap: Record<string, string> | undefined
  private scheduled: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()
  private readonly log: MemoryLogger

  constructor(private readonly opts: { memoryRoot: string; collect: () => Promise<GlobalViews>; log?: MemoryLogger }) {
    this.dir = join(opts.memoryRoot, GUI_VIEW_DIR)
    this.log = opts.log ?? console
  }

  /** 请求重写这些全局视图（缺省四个都写）。 */
  request(views: readonly GlobalViewName[] = GLOBAL_VIEW_NAMES): Promise<void> {
    for (const v of views) this.queued.add(v)
    return this.schedule()
  }

  /** 请求写一个会话的视图；同一 tick 内同一会话以最后一份为准。 */
  requestSession(view: SessionView): Promise<void> {
    this.sessions.set(view.sessionId, view)
    return this.schedule()
  }

  /** 记一笔会话归属（原始 cwd → 服务端解析出的项目）；和已落盘的一样就不写。 */
  requestWorkspace(cwd: string, workspacePath: string): Promise<void> {
    if (this.workspaceMap?.[cwd] === workspacePath && !this.cwds.has(cwd)) return Promise.resolve()
    this.cwds.set(cwd, workspacePath)
    return this.schedule()
  }

  /** 全量重写入口：不等节流，排在进行中的写入之后立即收集并写出四个全局视图。 */
  rewriteAll(): Promise<void> {
    return this.enqueue(() => this.writeGlobal(GLOBAL_VIEW_NAMES))
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
    const run = this.tail.then(job).catch(err => this.log.warn('[plastic-memory] GUI 视图写入失败', err))
    this.tail = run
    return run
  }

  private async writeGlobal(names: readonly GlobalViewName[]): Promise<void> {
    const views = await this.opts.collect()
    for (const name of names) await this.writeFile(GUI_VIEW_FILES[name], views[name])
  }

  private async writeWorkspaceMap(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
    const map = this.workspaceMap ?? await this.readWorkspaceMap()
    const next = { ...map }
    for (const [cwd, workspacePath] of entries) next[cwd] = workspacePath
    if (entries.every(([cwd, workspacePath]) => map[cwd] === workspacePath)) { this.workspaceMap = next; return }
    const view: WorkspaceMapView = { version: GUI_VIEW_VERSION, cwds: next }
    await this.writeFile(GUI_WORKSPACE_MAP_FILE, view)
    this.workspaceMap = next
  }

  /** 磁盘上的旧对照；没有、读不懂（坏 JSON、版本不对）都从空表开始。 */
  private async readWorkspaceMap(): Promise<Record<string, string>> {
    try {
      const parsed = workspaceMapViewSchema.safeParse(JSON.parse(await readFile(join(this.dir, GUI_WORKSPACE_MAP_FILE), 'utf8')))
      return parsed.success ? { ...parsed.data.cwds } : {}
    } catch {
      return {}
    }
  }

  private async writeFile(fileName: string, view: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, fileName)
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmp, JSON.stringify(view), 'utf8')
    await rename(tmp, path)
  }
}
