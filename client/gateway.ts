/**
 * 网关：组件与宿主之间唯一的边。组件只认 MemoryGateway 接口（借哪个会话、订阅视图、执行命令），
 * 宿主实现在这里，内存假实现在 gateway.fake.ts（测试唯一的 mock 边界）。
 *
 * 数据通道（spec「数据通道」）：视图是 `<memoryRoot>/.state/gui/*.json`，经文件资源订阅版本、版本变了再读；
 * 动作是 `/memory` 会话命令。浏览器半侧不知道 memoryRoot：首次需要时借会话发一次 `info`，结果缓存到 localStorage；
 * 视图文件不存在、或读到不认识的版本（旧插件写的）时再发一次 `refresh-views` 让服务端生成；用的是缓存的根、刷新后还读不到时再问一次 `info`（根可能换了）。
 * 缓存根的同时记下当时配置里的 memoryRoot；宿主给了配置服务、且配置值和记下的不一样（用户改了存储位置，旧目录里
 * 视图文件还在，靠「读不到」发现不了）时丢掉缓存，按首次进入重来。没有配置服务时不比对。
 * 只有两态：一个会话都没有 → none；有会话（历史或在跑，宿主会自动 resume 冷会话）→ ready。
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, GUI_WORKSPACE_MAP_FILE, encodeMemoryCommand, sessionViewFile,
  checkupViewSchema, deletedViewSchema, healthViewSchema, libraryViewSchema, pendingViewSchema, sessionViewSchema, workspaceMapViewSchema,
  memoryCommandResultSchema, VIEW_BEHIND_CODES,
  type CheckupView, type DeletedView, type HealthView, type LibraryView, type MemoryCommand, type MemoryCommandResult,
  type PendingView, type SessionView, type WorkspaceMapView,
} from '../src/gui/contract.ts'
import type {
  CommandExecution, ConfigForm, ConfigFormSnapshot, HostContext, RemoteResult, RootStandardProps,
} from './host.ts'
import { createDeletionStore, type Deletions } from './deletions.ts'
import { pickSession, selectedSessionId, workspaceOf, type BorrowedSession, type WorkspaceMap } from './session-pick.ts'
import { configuredRoot, ENTRY_ID, toPluginConfig, type PluginConfig } from './settings/config.ts'

export type { BorrowedSession, Deletions, PluginConfig, WorkspaceMap }

export interface ViewMap {
  pending: PendingView
  health: HealthView
  library: LibraryView
  deleted: DeletedView
  /** 体检视图：各范围的自动体检设置、进行中、上次与下次体检（所有窗口共用一份）。 */
  checkups: CheckupView
  /** 借来的那个会话自己的「这次对话」视图。 */
  session: SessionView
  /** 会话归属对照（原始 cwd → 服务端解析出的项目）。 */
  workspaces: WorkspaceMapView
}
export type ViewName = keyof ViewMap

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
  /**
   * hook：记忆页每次打开请服务端按磁盘现状重写一次视图（视图没有文件监听，外面改过的文件靠它显示出来）。
   * 同一次打开只发一次；根还没问到时不另发，拿到根之后那次刷新就算这次的。
   */
  useFreshViews(session: BorrowedSession): void
  /** 执行一条 `/memory` 命令，结果按契约解析；宿主或解析层面的失败折成 `failed`。删除、恢复成功后记进删除状态（见 useDeletions）。 */
  execute(sessionId: string, command: MemoryCommand): Promise<MemoryCommandResult>
  /** hook：删过的记忆（见 createDeletionStore），各处显示同一条记忆时读它。 */
  useDeletions(): Deletions
  /** hook：借来的会话能不能用模型、用的是哪个（「让模型改」面板的提示与「生成修改」）。打开面板时才问，每个会话在页面里只问一次 model-info。 */
  useModel(session: BorrowedSession): ModelState
  /** hook：插件配置里界面要用的几项；宿主还没给出（或不服务这份配置）时为 undefined。 */
  useConfig(): PluginConfig | undefined
  /** 写一个配置字段（`configForms.set`，单字段快捷写入）；宿主接受为 true。 */
  setConfig(field: 'snapshotTokenBudget', value: number): Promise<boolean>
  /** 读一个文件的全文（借会话的文件通道，只在本机内存里用）；读不到为 undefined。 */
  readFile(sessionId: string, path: string): Promise<string | undefined>
  /** 用默认应用打开宿主上的文件，或在文件管理器中显示；宿主接受为 true。 */
  openPath(path: string, action?: 'open' | 'reveal'): Promise<boolean>
}

/** unknown：还没问到、或没有会话，按可用处理；unavailable：服务端说借来的会话拿不到模型；model 缺省 = 不知道名字。 */
export type ModelState = { status: 'unknown' } | { status: 'ready'; model: string | undefined } | { status: 'unavailable' }

const GatewayContext = createContext<MemoryGateway | null>(null)

export const GatewayProvider = GatewayContext.Provider

export function useGateway(): MemoryGateway {
  const gateway = useContext(GatewayContext)
  if (gateway === null) throw new Error('plastic-memory: useGateway outside GatewayProvider')
  return gateway
}

// —— 纯函数（宿主实现用，单测直接测） ——

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
  checkups: checkupViewSchema,
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
  const file = name === 'session' ? sessionViewFile(sessionId) : name === 'workspaces' ? GUI_WORKSPACE_MAP_FILE
    : name === 'checkups' ? GUI_CHECKUP_VIEW_FILE : GUI_VIEW_FILES[name]
  return `${memoryRoot.replace(/[\\/]+$/, '')}/${GUI_VIEW_DIR}/${file}`
}

/** 与宿主 sessionFileAddress 同一语法：逐段 encodeURIComponent，绝对路径的前导 / 留成空段。 */
export function fileAddress(sessionId: string, path: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':')
  return `dsh-resource://file/session/${enc(sessionId)}/${path.replace(/\\/g, '/').split('/').map(enc).join('/')}`
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

/**
 * refreshes：refresh-views 成功的次数。文件资源起步就是 not-found 时，宿主在文件写出后未必再推一帧，靠它触发重读。
 * isRefreshFailed：最近一次 refresh-views 失败，版本不认识的视图不再等重写、直接显示过时。
 */
interface RootState { memoryRoot?: string; error?: string; refreshes: number; isRefreshFailed?: boolean }

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
  let refreshing = false
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
  /** 发一次 refresh-views：成功后刷新次数加一（挂着的视图据此重读），失败了 ensureViews 下次再试。 */
  const refresh = (sessionId: string) => {
    refreshed = true
    refreshing = true
    if (state.isRefreshFailed === true) set({ ...state, isRefreshFailed: false })
    void run(sessionId, encodeMemoryCommand({ cmd: 'refresh-views' })).then((r) => {
      refreshing = false
      if (decodeExecution('refresh-views', r).ok) set({ ...state, refreshes: state.refreshes + 1 })
      else { refreshed = false; set({ ...state, isRefreshFailed: true }) }
    })
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
    /** 让服务端把视图文件写出来：首次拿到 memoryRoot 之后、视图文件缺失或版本不认识时，每个页面生命周期成功一次；同一时间只发一条，失败了下次再试。 */
    ensureViews(sessionId: string) {
      if (refreshed) return
      refresh(sessionId)
    },
    /** 记忆页打开：根已知就再刷新一次（这次页面里刷新过也发）；根还没问到时由拿到根之后的 ensureViews 发；正在刷新时不重复发。 */
    refreshOnOpen(sessionId: string) {
      if (state.memoryRoot === undefined || refreshing) return
      refresh(sessionId)
    },
  }
  return store
}

const MODEL_UNKNOWN: ModelState = Object.freeze({ status: 'unknown' })

/** 各会话的模型：第一次用到时问一次 model-info，几处同时用只发一条，结果记到页面关掉。 */
function createModelStore(run: RunLine) {
  const states = new Map<string, ModelState>()
  const listeners = new Set<() => void>()
  return {
    get: (sessionId: string | undefined) => (sessionId === undefined ? undefined : states.get(sessionId)) ?? MODEL_UNKNOWN,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    probe(sessionId: string) {
      if (states.has(sessionId)) return
      states.set(sessionId, MODEL_UNKNOWN)
      void run(sessionId, encodeMemoryCommand({ cmd: 'model-info' })).then((r) => {
        const result = decodeExecution('model-info', r)
        // 别的失败（宿主出错、旧插件不认这条命令）不当成拿不到模型：「生成修改」照常可点，真拿不到时生成会写原因
        states.set(sessionId, result.ok ? { status: 'ready', model: result.model }
          : result.code === 'llm-unavailable' ? { status: 'unavailable' } : { status: 'ready', model: undefined })
        for (const fn of listeners) fn()
      })
    },
  }
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
  /**
   * 本页成功执行的命令次数（含因界面落后于磁盘而失败的：服务端同样重写了视图）。命令回结果前服务端已写好视图，
   * 但宿主的文件观察会漏掉紧挨着的第二次替换、版本停在上一版，所以它也算进读视图的触发：本页的命令一成功，挂着的视图都重读一次。
   */
  let succeeded = 0
  const succeededListeners = new Set<() => void>()
  const subscribeSucceeded = (fn: () => void) => { succeededListeners.add(fn); return () => { succeededListeners.delete(fn) } }
  const getSucceeded = () => succeeded
  const execute: MemoryGateway['execute'] = async (sessionId, command) => {
    const result = decodeExecution(command.cmd, await run(sessionId, encodeMemoryCommand(command)))
    deletions.record(command, result)
    if (result.ok || VIEW_BEHIND_CODES.has(result.code)) { succeeded++; for (const fn of succeededListeners) fn() }
    return result
  }
  const root = createRootStore(run)
  const models = createModelStore(run)
  /**
   * 同一份视图文件、同一次触发（版本 + 刷新次数）只读一次、解析一次：几处同时挂着同一视图（每张对话交付卡一个）时共用结果。
   * 每个文件只留最近一次触发；读失败的不留，下一个来读的再试。
   */
  const viewReads = new Map<string, { trigger: string; result: Promise<ViewState<unknown>> }>()
  /** 每个视图文件最近读到的可用内容：后挂上的（切视图、换范围时重挂的列表）第一帧就拿它画，不先闪读取中，同时照常按当前版本读。 */
  const lastReads = new Map<string, ReadState<unknown>>()
  const readView = <N extends ViewName>(sessionId: string, path: string, trigger: string, name: N): Promise<ViewState<ViewMap[N]>> => {
    const cached = viewReads.get(path)
    if (cached?.trigger === trigger) return cached.result as Promise<ViewState<ViewMap[N]>>
    const result = ctx.remote.workspaceFiles.read(sessionId, path, {}).then((r): ViewState<ViewMap[N]> => {
      const view: ViewState<ViewMap[N]> = r.ok
        ? parseView(name, r.value.text)
        : r.error.code === 'workspace-file/not-found' ? { status: 'missing' } : { status: 'error', message: `${r.error.code}: ${r.error.message}` }
      if (view.status === 'ready' && name === 'deleted') deletions.settle({ name, data: view.data as DeletedView })
      if (view.status === 'ready' && name === 'library') deletions.settle({ name, data: view.data as LibraryView })
      if (view.status === 'ready') lastReads.set(path, { key: path, trigger, view })
      else lastReads.delete(path)
      return view
    }, (err: unknown): ViewState<ViewMap[N]> => ({ status: 'error', message: String(err) }))
    const entry = { trigger, result: result as Promise<ViewState<unknown>> }
    viewReads.set(path, entry)
    void result.then((view) => { if (view.status === 'error' && viewReads.get(path) === entry) viewReads.delete(path) })
    return result
  }
  // configForms 是可选服务：就位时记下，离开时清掉（根上下文没 inject 它，不能直接读）。
  // 服务可能在组件读过之后才到、或运行中换新的：每次变动递增版本号，读配置的 hook 订阅它，重新绑定新表单
  let configForms: ConfigFormsService | undefined
  let binding: ConfigBinding | undefined
  let serviceVersion = 0
  const serviceListeners = new Set<() => void>()
  const serviceChanged = () => { serviceVersion++; for (const fn of serviceListeners) fn() }
  const subscribeService = (fn: () => void) => { serviceListeners.add(fn); return () => { serviceListeners.delete(fn) } }
  const getServiceVersion = () => serviceVersion
  ctx.inject(['configForms'], (scope) => {
    scope.effect(() => {
      const service = scope.configForms
      configForms = service
      binding = undefined
      serviceChanged()
      // 只清自己那一份：新服务先就位、旧的后离开时，不把新的清掉
      return () => { if (configForms !== service) return; configForms = undefined; binding = undefined; serviceChanged() }
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
  /** 配置表单当前快照：服务换了就重新绑定，订阅新表单。 */
  function useConfigSnapshot() {
    useSyncExternalStore(subscribeService, getServiceVersion)
    const { get, subscribe } = config()
    return useSyncExternalStore(subscribe, get)
  }

  return ({ useSessions, useResource }) => {
    /** isPassive：只读不催，不为它发 info / refresh-views（读的会话可能正在跑；根由页面自己的视图问到）。 */
    function useViewState<N extends ViewName>(session: BorrowedSession, name: N, isPassive: boolean): ViewState<ViewMap[N]> {
      const rootState = useSyncExternalStore(root.subscribe, root.get)
      const configSnapshot = useConfigSnapshot()
      const configured = configSnapshot?.status === 'ready' ? configuredRoot(configSnapshot.value) : undefined
      useEffect(() => { root.syncConfig(configured) }, [configured])
      const sessionId = session.kind === 'ready' ? session.sessionId : undefined
      useEffect(() => { if (!isPassive && sessionId !== undefined) root.ensureRoot(sessionId) }, [isPassive, sessionId, rootState])
      const path = sessionId !== undefined && rootState.memoryRoot !== undefined ? viewPath(rootState.memoryRoot, name, sessionId) : undefined
      const stat = useResource(sessionId !== undefined && path !== undefined ? fileAddress(sessionId, path) : '')
      const version = stat.status === 'live' ? stat.value?.version : undefined
      const isMissing = stat.status === 'failed' && stat.failure?.code === 'workspace-file/not-found'
      // refresh-views 只重写四个全局视图和体检视图：缺失、版本不认识时只为这几个请服务端重写。「这次对话」视图在快照冻结时写
      // （新对话发第一条消息前一定缺），归属对照在解析会话归属时写，为它们发刷新写不出文件，只会在借来的会话里白留一行
      const isRegenerable = !isPassive && (name in GUI_VIEW_FILES || name === 'checkups')
      useEffect(() => { if (isRegenerable && sessionId !== undefined && isMissing) root.ensureViews(sessionId) }, [isRegenerable, sessionId, isMissing])
      // 读到的内容按文件认，不按经哪个会话读：借来的会话中途换了（它开始跑一轮、换了更新的会话），全局视图还是同一个文件，
      // 沿用已读到的内容，不回到读取中（否则整页列表重挂，卡片上正在进行的编辑、生成都丢了）；「这次对话」视图的路径带会话 id，换会话照样重读
      const key = path ?? ''
      // 有版本按版本读，refresh-views 或本页的命令成功后也重读一次（宿主推新版本之前、或漏推时先读到重写的内容）；
      // 资源还停在 not-found、但 refresh-views 已写过文件时，按刷新次数直接读一次；宿主之后未必再推版本，命令成功后同样重读
      const commands = useSyncExternalStore(subscribeSucceeded, getSucceeded)
      const trigger = version !== undefined ? `${version}#${rootState.refreshes}#${commands}` : isMissing && rootState.refreshes > 0 ? `refresh:${rootState.refreshes}#${commands}` : undefined
      const [read, setRead] = useState(() => (path === undefined ? undefined : lastReads.get(path)) as ReadState<ViewMap[N]> | undefined)
      // 刷新后仍读不到才说明缓存的根可能过期；刷新本来就写不出的视图仍缺失是常态，不据此再问 info
      const isStillMissing = isMissing && trigger !== undefined && read?.key === key && read.trigger === trigger && read.view.status === 'missing'
      useEffect(() => { if (isRegenerable && sessionId !== undefined && isStillMissing) root.revalidate(sessionId) }, [isRegenerable, sessionId, isStillMissing])
      // 版本不认识（旧插件写的、或刷新前留下的）：可重写的视图请服务端重写一次，这次页面里已全量重写过就不再发；
      // 重写完重读，仍不认识才显示过时。不轮询
      const isOutdated = read !== undefined && read.key === key && read.view.status === 'outdated'
      useEffect(() => { if (isRegenerable && sessionId !== undefined && isOutdated) root.ensureViews(sessionId) }, [isRegenerable, sessionId, isOutdated])
      const isAwaitingRewrite = isRegenerable && isOutdated
        && (rootState.refreshes === 0 ? rootState.isRefreshFailed !== true : read.trigger !== trigger)
      useEffect(() => {
        if (sessionId === undefined || path === undefined || trigger === undefined) return
        let live = true
        void readView(sessionId, path, trigger, name).then((view) => { if (live) setRead({ key, trigger, view }) })
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
      if (isAwaitingRewrite) return { status: 'loading' }
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
      useModel(session) {
        const sessionId = session.kind === 'ready' ? session.sessionId : undefined
        const state = useSyncExternalStore(models.subscribe, () => models.get(sessionId))
        useEffect(() => { if (sessionId !== undefined) models.probe(sessionId) }, [sessionId])
        return state
      },
      useConfig() {
        const snapshot = useConfigSnapshot()
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
      useFreshViews(session) {
        const sessionId = session.kind === 'ready' ? session.sessionId : undefined
        // 借来的会话中途换了不算再打开一次
        const isRequested = useRef(false)
        useEffect(() => {
          if (sessionId === undefined || isRequested.current) return
          isRequested.current = true
          root.refreshOnOpen(sessionId)
        }, [sessionId])
      },
    }
  }
}
