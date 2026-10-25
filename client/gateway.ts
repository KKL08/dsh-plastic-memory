/**
 * 网关：组件与宿主之间唯一的边。组件只认 MemoryGateway 接口（借哪个会话、订阅视图、执行命令），
 * 宿主实现在这里，内存假实现在 gateway.fake.ts（测试唯一的 mock 边界）。
 *
 * 数据通道（spec「数据通道」）：视图是 `<memoryRoot>/.state/gui/*.json`，经文件资源订阅版本、版本变了再读；
 * 动作是 `/memory` 会话命令。浏览器半侧不知道 memoryRoot：首次需要时借会话发一次 `info`，结果缓存到 localStorage；
 * 视图文件不存在时再发一次 `refresh-views` 让服务端生成；用的是缓存的根、刷新后还读不到时再问一次 `info`（根可能换了）。
 * 缓存根的同时记下当时配置里的 memoryRoot；宿主给了配置服务、且配置值和记下的不一样（用户改了存储位置，旧目录里
 * 视图文件还在，靠「读不到」发现不了）时丢掉缓存，按首次进入重来。没有配置服务时不比对。
 * 只有两态：一个会话都没有 → none；有会话（历史或在跑，宿主会自动 resume 冷会话）→ ready。
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, GUI_WORKSPACE_MAP_FILE, encodeMemoryCommand, sessionViewFile,
  deletedViewSchema, healthViewSchema, libraryViewSchema, pendingViewSchema, sessionViewSchema, workspaceMapViewSchema,
  memoryCommandResultSchema,
  type DeletedView, type HealthView, type LibraryView, type MemoryCommand, type MemoryCommandResult,
  type PendingItem, type PendingView, type SessionView, type WorkspaceMapView,
} from '../src/gui/contract.ts'
import type {
  CommandExecution, ConfigForm, ConfigFormSnapshot, HostContext, RemoteResult, RootStandardProps, SessionListState,
} from './host.ts'
import { configuredRoot, ENTRY_ID } from './settings/config.ts'

export interface ViewMap {
  pending: PendingView
  health: HealthView
  library: LibraryView
  deleted: DeletedView
  /** 借来的那个会话自己的「这次对话」视图。 */
  session: SessionView
  /** 会话归属对照（原始 cwd → 服务端解析出的项目）。 */
  workspaces: WorkspaceMapView
}
export type ViewName = keyof ViewMap

/** 服务端记下的会话归属对照：原始 cwd → 项目。 */
export type WorkspaceMap = Readonly<Record<string, string>>

export type BorrowedSession =
  | { kind: 'none' }
  /** workspaces：借会话时用的归属对照，判断这个会话属于哪个项目要用同一份（见 belongsTo）；缺省按空表。 */
  | { kind: 'ready'; sessionId: string; cwd: string | undefined; workspaces?: WorkspaceMap }

/** 当前选中会话所属的项目。loading：归属对照还没读到，不拿原始 cwd 先顶上。 */
export type CurrentWorkspace =
  | { status: 'loading' }
  | { status: 'ready'; workspacePath: string | undefined }

export type ViewState<V> =
  | { status: 'idle' } // 没有会话，什么都读不到
  | { status: 'loading' }
  | { status: 'ready'; data: V }
  | { status: 'missing' } // 视图文件还没生成
  | { status: 'outdated' } // 版本号不认识，需要 refresh-views
  | { status: 'error'; message: string }

export interface MemoryGateway {
  /**
   * hook：借哪个会话。优先属于 workspacePath 的会话里最近更新的，其次当前选中的会话，再其次最近更新的任一会话；
   * 同一档里先借空闲的，都在跑才借正在跑的。子 agent 会话不借（它们只读）。归属规则见 belongsTo。
   */
  useSession(workspacePath: string | undefined): BorrowedSession
  /**
   * hook：当前选中会话所属的项目，作用域下拉的默认项。按归属对照定（见 workspaceOf）；对照还在读时是 loading，
   * 读到了、或确认读不到（文件还没有、读失败）之后才 ready。没有选中的会话时直接 ready / undefined。
   */
  useCurrentWorkspace(): CurrentWorkspace
  /** hook：订阅一份视图，版本变化再读。 */
  useView<N extends ViewName>(session: BorrowedSession, name: N): ViewState<ViewMap[N]>
  /** 执行一条 `/memory` 命令，结果按契约解析；宿主或解析层面的失败折成 `failed`。删除、恢复成功后记进删除状态（见 useDeletions）。 */
  execute(sessionId: string, command: MemoryCommand): Promise<MemoryCommandResult>
  /** hook：经本网关删过的记忆（见 createDeletionStore），各处显示同一条记忆时读它，不等视图刷新。 */
  useDeletions(): Deletions
  /** hook：插件配置里界面要用的几项；宿主还没给出（或不服务这份配置）时为 undefined。 */
  useConfig(): PluginConfig | undefined
  /** 写一个配置字段（`configForms.set`，单字段快捷写入）；宿主接受为 true。 */
  setConfig(field: 'snapshotTokenBudget', value: number): Promise<boolean>
  /** 读一个文件的全文（借会话的文件通道，只在本机内存里用）；读不到为 undefined。 */
  readFile(sessionId: string, path: string): Promise<string | undefined>
  /** 用默认应用打开宿主上的文件，或在文件管理器中显示；宿主接受为 true。 */
  openPath(path: string, action?: 'open' | 'reveal'): Promise<boolean>
}

/** 界面用到的配置项（宿主配置段 `plastic-memory` 的子集，值已按 schema 带上默认值）。 */
export interface PluginConfig {
  snapshotTokenBudget: number
  snapshotOverflow: Extract<PendingItem, { kind: 'overflow' }>['mode']
  governanceEnabled: boolean
  globalPromoteTarget: 'plugin-global' | 'agents-md'
}

/** 删过的记忆 id → 删法：soft 进了最近删除、可恢复；hard 是彻底删除。恢复后去掉。 */
export type Deletions = ReadonlyMap<string, 'soft' | 'hard'>

/**
 * 删除状态：forget / hard-delete / restore 成功后按命令记一笔。全部记忆、最近删除、右侧栏、对话交付卡删的是同一条记忆时，
 * 各处读这一份，删除后不会有的地方还留着删除按钮。只记经本网关发出的命令，页面关掉就没了；别的途径删的以视图为准。
 */
export function createDeletionStore() {
  let state: Deletions = new Map()
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    record(command: MemoryCommand, result: MemoryCommandResult) {
      if (!result.ok || (command.cmd !== 'forget' && command.cmd !== 'hard-delete' && command.cmd !== 'restore')) return
      const next = new Map(state)
      if (command.cmd === 'restore') next.delete(command.memoryId)
      else next.set(command.memoryId, command.cmd === 'forget' ? 'soft' : 'hard')
      state = next
      for (const fn of listeners) fn()
    },
  }
}

const GatewayContext = createContext<MemoryGateway | null>(null)

export const GatewayProvider = GatewayContext.Provider

export function useGateway(): MemoryGateway {
  const gateway = useContext(GatewayContext)
  if (gateway === null) throw new Error('plastic-memory: useGateway outside GatewayProvider')
  return gateway
}

// —— 纯函数（宿主实现用，单测直接测） ——

function isBorrowable(list: SessionListState, id: string): boolean {
  return list.byId[id] !== undefined && list.byId[id]!.origin !== 'subagent'
}

function newest(list: SessionListState, ids: readonly string[]): string | undefined {
  let best: string | undefined
  for (const id of ids) {
    if (best === undefined || list.byId[id]!.updatedAt > list.byId[best]!.updatedAt) best = id
  }
  return best
}

/** 一档里挑一个：先挑空闲的（命令会立刻插进正在跑的那一轮），都在跑才退回正在跑的，保证界面总能用。 */
function preferIdle(list: SessionListState, ids: readonly string[]): string | undefined {
  return newest(list, ids.filter(id => !list.byId[id]!.running)) ?? newest(list, ids)
}

/** 当前选中的会话：主视图持有它（retainedBy.mainView > 0）。 */
export function selectedSessionId(list: SessionListState): string | undefined {
  return list.ids.find(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0)
}

/** 对照里记下的项目（cwd 忽略末尾分隔符比较）；没有为 undefined。 */
function lookup(map: WorkspaceMap, cwd: string): string | undefined {
  if (map[cwd] !== undefined) return map[cwd]
  for (const [key, workspacePath] of Object.entries(map)) if (samePath(key, cwd)) return workspacePath
  return undefined
}

/** projects 里包含 cwd 的最深的那个；都不包含为 undefined。 */
function deepestContaining(cwd: string, projects: Iterable<string>): string | undefined {
  let best: string | undefined
  for (const p of projects) {
    if (isWithin(cwd, p) && (best === undefined || stripTrailing(p).length > stripTrailing(best).length)) best = p
  }
  return best
}

/**
 * 会话（按它的原始 cwd）是否属于项目 workspacePath。服务端按 realpath 后最近的已注册项目目录归属会话，
 * 浏览器半侧解析不了软链接，所以：服务端记下过这个 cwd 就以对照为准；没记下过（服务端还没见过这个会话）
 * 就按路径判断，在已知项目（对照里出现过的项目，加上 workspacePath 本身）里取包含 cwd 的最深的那个，
 * 这样嵌套子项目里的会话归子项目，不归外层。
 */
export function belongsTo(cwd: string | undefined, workspacePath: string | undefined, map: WorkspaceMap): boolean {
  if (cwd === undefined || workspacePath === undefined) return false
  const known = lookup(map, cwd)
  if (known !== undefined) return samePath(known, workspacePath)
  const deepest = deepestContaining(cwd, [...Object.values(map), workspacePath])
  return deepest !== undefined && samePath(deepest, workspacePath)
}

/** 会话所属的项目：对照里有就用它，其次包含 cwd 的最深的已知项目，都没有时是原始 cwd（服务端也拿 cwd 本身当桶）。 */
export function workspaceOf(cwd: string | undefined, map: WorkspaceMap): string | undefined {
  if (cwd === undefined) return undefined
  return lookup(map, cwd) ?? deepestContaining(cwd, Object.values(map)) ?? cwd
}

export function pickSession(list: SessionListState, workspacePath: string | undefined, map: WorkspaceMap = {}): BorrowedSession {
  const candidates = list.ids.filter(id => isBorrowable(list, id))
  const inWorkspace = workspacePath === undefined ? [] : candidates.filter(id => belongsTo(list.byId[id]!.cwd, workspacePath, map))
  const selected = selectedSessionId(list)
  const id = preferIdle(list, inWorkspace)
    ?? (selected !== undefined && candidates.includes(selected) ? selected : undefined)
    ?? preferIdle(list, candidates)
  return id === undefined ? { kind: 'none' } : { kind: 'ready', sessionId: id, cwd: list.byId[id]!.cwd }
}

const stripTrailing = (p: string) => p.replace(/[\\/]+$/, '')

/** 两个路径是否同一处（忽略末尾的分隔符）；任一为 undefined 时不同。 */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && stripTrailing(a) === stripTrailing(b)
}

/** path 是否就是 dir 或在它下面（按整段比，/w/app-other 不在 /w/app 下）；任一为 undefined 时否。 */
export function isWithin(path: string | undefined, dir: string | undefined): boolean {
  if (path === undefined || dir === undefined) return false
  const p = stripTrailing(path)
  const d = stripTrailing(dir)
  return p === d || p.startsWith(`${d}/`) || p.startsWith(`${d}\\`)
}

function failed(detail: string, cmd?: string): MemoryCommandResult {
  return { ok: false, code: 'failed', detail, ...(cmd === undefined ? {} : { cmd }) }
}

/** 宿主执行结果 → 契约结果。命令处理器成功、失败都回契约 JSON；不是契约 JSON 的原文进 detail。 */
export function decodeExecution(cmd: string, r: RemoteResult<CommandExecution | undefined>): MemoryCommandResult {
  if (!r.ok) return failed(`${r.error.code}: ${r.error.message}`, cmd)
  if (r.value === undefined) return failed('no command result', cmd)
  const text = r.value.result.text ?? ''
  let json: unknown
  try { json = JSON.parse(text) } catch { return failed(text, cmd) }
  const parsed = memoryCommandResultSchema.safeParse(json)
  return parsed.success ? parsed.data : failed(text, cmd)
}

const SCHEMAS = {
  pending: pendingViewSchema,
  health: healthViewSchema,
  library: libraryViewSchema,
  deleted: deletedViewSchema,
  session: sessionViewSchema,
  workspaces: workspaceMapViewSchema,
} as const

/** 视图文件内容 → ViewState。版本号不认识按「需要刷新」处理。 */
export function parseView<N extends ViewName>(name: N, text: string): ViewState<ViewMap[N]> {
  let json: unknown
  try { json = JSON.parse(text) } catch (err) { return { status: 'error', message: String(err) } }
  if (typeof json !== 'object' || json === null || (json as { version?: unknown }).version !== GUI_VIEW_VERSION) {
    return { status: 'outdated' }
  }
  const parsed = SCHEMAS[name].safeParse(json)
  if (!parsed.success) return { status: 'error', message: parsed.error.message }
  return { status: 'ready', data: parsed.data as ViewMap[N] }
}

/** 视图文件的绝对路径。 */
export function viewPath(memoryRoot: string, name: ViewName, sessionId: string): string {
  const file = name === 'session' ? sessionViewFile(sessionId) : name === 'workspaces' ? GUI_WORKSPACE_MAP_FILE : GUI_VIEW_FILES[name]
  return `${memoryRoot.replace(/[\\/]+$/, '')}/${GUI_VIEW_DIR}/${file}`
}

/** 与宿主 sessionFileAddress 同一语法：逐段 encodeURIComponent，绝对路径的前导 / 留成空段。 */
export function fileAddress(sessionId: string, path: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':')
  return `dsh-resource://file/session/${enc(sessionId)}/${path.replace(/\\/g, '/').split('/').map(enc).join('/')}`
}

/** 宿主配置段（schema 解析后的值）→ 界面用到的几项；结构不对为 undefined。 */
export function toPluginConfig(value: unknown): PluginConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as { snapshotTokenBudget?: unknown; snapshotOverflow?: unknown; governance?: { enabled?: unknown; globalPromoteTarget?: unknown } }
  const g = v.governance
  if (typeof v.snapshotTokenBudget !== 'number' || (v.snapshotOverflow !== 'relax' && v.snapshotOverflow !== 'strict')
    || typeof g?.enabled !== 'boolean' || (g.globalPromoteTarget !== 'plugin-global' && g.globalPromoteTarget !== 'agents-md')) return undefined
  return { snapshotTokenBudget: v.snapshotTokenBudget, snapshotOverflow: v.snapshotOverflow, governanceEnabled: g.enabled, globalPromoteTarget: g.globalPromoteTarget }
}

// —— 宿主实现 ——

const NO_MAP: WorkspaceMap = Object.freeze({})

export const MEMORY_ROOT_KEY = 'dsh-plastic-memory.gui.memoryRoot'
/** 缓存 memoryRoot 时配置里写的 memoryRoot（原样，空 = 默认位置）。 */
export const MEMORY_ROOT_CONFIG_KEY = 'dsh-plastic-memory.gui.memoryRootConfig'

interface ConfigBinding {
  form: ConfigForm | undefined
  get: () => ConfigFormSnapshot | undefined
  subscribe: (fn: () => void) => () => void
}

const NO_CONFIG: ConfigBinding = { form: undefined, get: () => undefined, subscribe: () => () => {} }

type ConfigFormsService = NonNullable<HostContext['configForms']>

/** refreshes：refresh-views 成功的次数。文件资源起步就是 not-found 时，宿主在文件写出后未必再推一帧，靠它触发重读。 */
interface RootState { memoryRoot?: string; error?: string; refreshes: number }

type RunLine = (sessionId: string, line: string) => Promise<RemoteResult<CommandExecution | undefined>>

/**
 * memoryRoot：localStorage 有就用；没有就借会话发一次 info（并发请求合并成一条），再发一次 refresh-views。
 * info 失败后同一会话不再重试（两个挂着不同会话的视图不能来回触发），换了会话可以试一次；缓存的根在刷新后仍读不到视图时，由 revalidate 再问一次。
 */
function createRootStore(run: RunLine) {
  let state: RootState = { refreshes: 0 }
  let isCached = false
  /** 缓存的根对应的配置值；undefined = 不知道（旧缓存没记，或拿到根时配置还没到）。 */
  let cachedConfig: string | undefined
  /** 最近一次看到的配置值。 */
  let liveConfig: string | undefined
  /** 根是这个页面生命周期里 info 拿到的（不是 localStorage 里的旧值）。 */
  let isFresh = false
  try {
    const saved = localStorage.getItem(MEMORY_ROOT_KEY)
    if (saved) { state = { ...state, memoryRoot: saved }; isCached = true }
    cachedConfig = localStorage.getItem(MEMORY_ROOT_CONFIG_KEY) ?? undefined
  } catch { /* 存储不可用：每次进入发一次 info */ }
  const listeners = new Set<() => void>()
  let infoInflight = false
  const failedSessions = new Set<string>()
  let refreshed = false
  const set = (next: RootState) => { state = next; for (const fn of listeners) fn() }
  const rememberConfig = (configured: string | undefined) => {
    cachedConfig = configured
    try {
      if (configured === undefined) localStorage.removeItem(MEMORY_ROOT_CONFIG_KEY)
      else localStorage.setItem(MEMORY_ROOT_CONFIG_KEY, configured)
    } catch { /* 只在本页生效 */ }
  }
  const remember = (memoryRoot: string) => {
    try { localStorage.setItem(MEMORY_ROOT_KEY, memoryRoot) } catch { /* 只在本页生效 */ }
    rememberConfig(liveConfig)
    isFresh = true
    set({ ...state, memoryRoot, error: undefined })
  }
  const store = {
    get: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    /** 配置里的 memoryRoot（宿主还没给出或不服务配置时为 undefined，不比对）。和缓存时的值不同就丢掉缓存，useView 随后按首次进入发 info。 */
    syncConfig(configured: string | undefined) {
      if (configured === undefined) return
      liveConfig = configured
      if (state.memoryRoot === undefined || configured === cachedConfig) return
      // 根是本页刚问到的、当时配置还没到：配置值补记上，不再问
      if (isFresh && cachedConfig === undefined) { rememberConfig(configured); return }
      isCached = false
      isFresh = false
      refreshed = false
      failedSessions.clear()
      try { localStorage.removeItem(MEMORY_ROOT_KEY) } catch { /* 只在本页生效 */ }
      rememberConfig(undefined)
      set({ ...state, memoryRoot: undefined, error: undefined })
    },
    ensureRoot(sessionId: string) {
      if (state.memoryRoot !== undefined || infoInflight || failedSessions.has(sessionId)) return
      infoInflight = true
      void run(sessionId, encodeMemoryCommand({ cmd: 'info' })).then((r) => {
        infoInflight = false
        const result = decodeExecution('info', r)
        if (result.ok && result.info !== undefined) {
          remember(result.info.memoryRoot)
          store.ensureViews(sessionId)
        } else {
          failedSessions.add(sessionId)
          set({ ...state, error: result.ok ? 'info returned no paths' : (result.detail ?? result.code) })
        }
      })
    },
    /** 缓存的根刷新后仍读不到视图：再发一次 info（每个页面生命周期一次），根变了就换掉缓存，视图跟着换路径。 */
    revalidate(sessionId: string) {
      if (!isCached) return
      isCached = false
      void run(sessionId, encodeMemoryCommand({ cmd: 'info' })).then((r) => {
        const result = decodeExecution('info', r)
        if (result.ok && result.info !== undefined && result.info.memoryRoot !== state.memoryRoot) remember(result.info.memoryRoot)
      })
    },
    /** 让服务端把视图文件写出来：首次拿到 memoryRoot 之后、或视图文件缺失时，每个页面生命周期成功一次；同一时间只发一条，失败了下次再试。 */
    ensureViews(sessionId: string) {
      if (refreshed) return
      refreshed = true
      void run(sessionId, encodeMemoryCommand({ cmd: 'refresh-views' })).then((r) => {
        if (decodeExecution('refresh-views', r).ok) set({ ...state, refreshes: state.refreshes + 1 })
        else refreshed = false
      })
    },
  }
  return store
}

interface ReadState<V> { key: string; trigger: string; view: ViewState<V> }

/** 网关绑定函数：插槽根组件用自己的标准 props 绑定一份网关。 */
export type BindGateway = (props: RootStandardProps) => MemoryGateway

/**
 * 宿主网关。共享状态（memoryRoot、删除状态）在外层闭包里；每个插件实例只建一份（apply 里），所有插槽根共用，
 * 每个插槽根组件用自己的标准 props 绑定：`const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])`。
 */
export function createHostGateway(ctx: HostContext): BindGateway {
  const run: RunLine = async (sessionId, line) => {
    try {
      return await ctx.remote.commands.execute(sessionId, line, [])
    } catch (err) {
      return { ok: false, error: { code: 'thrown', message: String(err) } }
    }
  }
  const deletions = createDeletionStore()
  const execute: MemoryGateway['execute'] = async (sessionId, command) => {
    const result = decodeExecution(command.cmd, await run(sessionId, encodeMemoryCommand(command)))
    deletions.record(command, result)
    return result
  }
  const root = createRootStore(run)
  // configForms 是可选服务：就位时记下，离开时清掉（根上下文没 inject 它，不能直接读）
  let configForms: ConfigFormsService | undefined
  let binding: ConfigBinding | undefined
  ctx.inject(['configForms'], (scope) => {
    scope.effect(() => {
      configForms = scope.configForms
      return () => { configForms = undefined; binding = undefined }
    }, 'plastic-memory: gateway config form')
  })
  // 第一次用到时才向宿主要表单（get 会触发配置镜像加载）；服务在时绑定一次，订阅函数身份稳定
  const config = (): ConfigBinding => {
    if (binding !== undefined) return binding
    if (configForms === undefined) return NO_CONFIG
    const form = configForms.get(ENTRY_ID)
    binding = { form, get: () => form.getSnapshot(), subscribe: fn => form.subscribe(fn) }
    return binding
  }

  return ({ useSessions, useResource }) => {
    /** isPassive：只读不催，不为它发 info / refresh-views（读的会话可能正在跑；根由页面自己的视图问到）。 */
    function useViewState<N extends ViewName>(session: BorrowedSession, name: N, isPassive: boolean): ViewState<ViewMap[N]> {
      const rootState = useSyncExternalStore(root.subscribe, root.get)
      const { get: getConfig, subscribe: subscribeConfig } = config()
      const configSnapshot = useSyncExternalStore(subscribeConfig, getConfig)
      const configured = configSnapshot?.status === 'ready' ? configuredRoot(configSnapshot.value) : undefined
      useEffect(() => { root.syncConfig(configured) }, [configured])
      const sessionId = session.kind === 'ready' ? session.sessionId : undefined
      useEffect(() => { if (!isPassive && sessionId !== undefined) root.ensureRoot(sessionId) }, [isPassive, sessionId, rootState])
      const path = sessionId !== undefined && rootState.memoryRoot !== undefined ? viewPath(rootState.memoryRoot, name, sessionId) : undefined
      const stat = useResource(sessionId !== undefined && path !== undefined ? fileAddress(sessionId, path) : '')
      const version = stat.status === 'live' ? stat.value?.version : undefined
      const isMissing = stat.status === 'failed' && stat.failure?.code === 'workspace-file/not-found'
      useEffect(() => { if (!isPassive && sessionId !== undefined && isMissing) root.ensureViews(sessionId) }, [isPassive, sessionId, isMissing])
      const key = `${sessionId}\0${path}`
      // 有版本按版本读；资源还停在 not-found、但 refresh-views 已写过文件时，按刷新次数直接读一次
      const trigger = version ?? (isMissing && rootState.refreshes > 0 ? `refresh:${rootState.refreshes}` : undefined)
      const [read, setRead] = useState<ReadState<ViewMap[N]> | undefined>(undefined)
      const isStillMissing = isMissing && trigger !== undefined && read?.key === key && read.trigger === trigger && read.view.status === 'missing'
      useEffect(() => { if (!isPassive && sessionId !== undefined && isStillMissing) root.revalidate(sessionId) }, [isPassive, sessionId, isStillMissing])
      useEffect(() => {
        if (sessionId === undefined || path === undefined || trigger === undefined) return
        let live = true
        void ctx.remote.workspaceFiles.read(sessionId, path, {}).then((r) => {
          if (!live) return
          const view: ViewState<ViewMap[N]> = r.ok
            ? parseView(name, r.value.text)
            : r.error.code === 'workspace-file/not-found' ? { status: 'missing' } : { status: 'error', message: `${r.error.code}: ${r.error.message}` }
          setRead({ key, trigger, view })
        }, (err: unknown) => { if (live) setRead({ key, trigger, view: { status: 'error', message: String(err) } }) })
        return () => { live = false }
      }, [sessionId, path, trigger, key, name])

      if (sessionId === undefined) return { status: 'idle' }
      if (rootState.error !== undefined) return { status: 'error', message: rootState.error }
      // 根还没问到：还在读（不看空地址的资源状态）
      if (path === undefined) return { status: 'loading' }
      if (stat.status === 'failed') {
        if (!isMissing) return { status: 'error', message: `${stat.failure?.code}: ${stat.failure?.message}` }
        // 只认这次刷新触发的读：文件删掉后不拿旧内容顶上
        return read !== undefined && read.key === key && read.trigger === trigger ? read.view : { status: 'missing' }
      }
      // 同一文件的新版本还在读时先留着旧内容
      return read !== undefined && read.key === key ? read.view : { status: 'loading' }
    }

    /**
     * 归属对照（只读不催）。经选中的会话、没有就经最近的会话读：和要判断的项目无关，借会话的结果不会反过来改变读法。
     * 对照文件由服务端在解析会话归属时写出；读不到时调用方按路径判断。
     */
    function useWorkspaceMap(): ViewState<WorkspaceMapView> {
      const anchor = useSessions((s) => {
        const picked = pickSession(s, undefined)
        return picked.kind === 'ready' ? picked.sessionId : undefined
      })
      const session = useMemo<BorrowedSession>(
        () => anchor === undefined ? { kind: 'none' } : { kind: 'ready', sessionId: anchor, cwd: undefined }, [anchor])
      return useViewState(session, 'workspaces', true)
    }

    return {
      execute,
      useDeletions() {
        return useSyncExternalStore(deletions.subscribe, deletions.get)
      },
      useConfig() {
        const { get, subscribe } = config()
        const snapshot = useSyncExternalStore(subscribe, get)
        return useMemo(() => snapshot?.status === 'ready' ? toPluginConfig(snapshot.value) : undefined, [snapshot])
      },
      async setConfig(field, value) {
        try { return (await config().form?.set(field, value)) ?? false } catch { return false }
      },
      async readFile(sessionId, path) {
        try {
          const r = await ctx.remote.workspaceFiles.read(sessionId, path, {})
          return r.ok ? r.value.text : undefined
        } catch { return undefined }
      },
      async openPath(path, action) {
        try {
          const r = await ctx.remote.session?.openWorkspacePath(action === 'reveal' ? { path, action } : { path })
          return r?.ok ?? false
        } catch { return false }
      },
      useSession(workspacePath) {
        const list = useSessions(s => s)
        const mapState = useWorkspaceMap()
        const map = mapState.status === 'ready' ? mapState.data.cwds : NO_MAP
        const picked = pickSession(list, workspacePath, map)
        // 选择结果每次是新对象，按身份字段稳定下来，避免下游 effect 每次渲染都重跑
        const sessionId = picked.kind === 'ready' ? picked.sessionId : undefined
        const cwd = picked.kind === 'ready' ? picked.cwd : undefined
        return useMemo(() => picked.kind === 'ready' ? { ...picked, workspaces: map } : picked, [sessionId, cwd, map])
      },
      useCurrentWorkspace() {
        const id = useSessions(selectedSessionId)
        const cwd = useSessions(s => id === undefined ? undefined : s.byId[id]?.cwd)
        const mapState = useWorkspaceMap()
        const isLoading = id !== undefined && mapState.status === 'loading'
        const map = mapState.status === 'ready' ? mapState.data.cwds : NO_MAP
        const workspacePath = id === undefined ? undefined : workspaceOf(cwd, map)
        return useMemo<CurrentWorkspace>(() => isLoading ? { status: 'loading' } : { status: 'ready', workspacePath }, [isLoading, workspacePath])
      },
      useView(session, name) {
        return useViewState(session, name, false)
      },
    }
  }
}
