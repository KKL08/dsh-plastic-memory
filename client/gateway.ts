/**
 * 网关：组件与宿主之间唯一的边。组件只认 MemoryGateway 接口（借哪个会话、订阅视图、执行命令），
 * 宿主实现在这里，内存假实现在 gateway.fake.ts（测试唯一的 mock 边界）。
 *
 * 数据通道（spec「数据通道」）：视图是 `<memoryRoot>/.state/gui/*.json`，经文件资源订阅版本、版本变了再读；
 * 动作是 `/memory` 会话命令。浏览器半侧不知道 memoryRoot：首次需要时借会话发一次 `info`，结果缓存到 localStorage；
 * 视图文件不存在时再发一次 `refresh-views` 让服务端生成；用的是缓存的根、刷新后还读不到时再问一次 `info`（根可能换了）。
 * 只有两态：一个会话都没有 → none；有会话（历史或在跑，宿主会自动 resume 冷会话）→ ready。
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, encodeMemoryCommand, sessionViewFile,
  deletedViewSchema, healthViewSchema, libraryViewSchema, pendingViewSchema, sessionViewSchema,
  memoryCommandResultSchema,
  type DeletedView, type HealthView, type LibraryView, type MemoryCommand, type MemoryCommandResult,
  type PendingItem, type PendingView, type SessionView,
} from '../src/gui/contract.ts'
import type {
  CommandExecution, ConfigForm, ConfigFormSnapshot, HostContext, RemoteResult, RootStandardProps, SessionListState,
} from './host.ts'
import { ENTRY_ID } from './settings/config.ts'

export interface ViewMap {
  pending: PendingView
  health: HealthView
  library: LibraryView
  deleted: DeletedView
  /** 借来的那个会话自己的「这次对话」视图。 */
  session: SessionView
}
export type ViewName = keyof ViewMap

export type BorrowedSession =
  | { kind: 'none' }
  | { kind: 'ready'; sessionId: string; cwd: string | undefined }

export type ViewState<V> =
  | { status: 'idle' } // 没有会话，什么都读不到
  | { status: 'loading' }
  | { status: 'ready'; data: V }
  | { status: 'missing' } // 视图文件还没生成
  | { status: 'outdated' } // 版本号不认识，需要 refresh-views
  | { status: 'error'; message: string }

export interface MemoryGateway {
  /**
   * hook：借哪个会话。优先 workspacePath 下最近更新的会话，其次当前选中的会话，再其次最近更新的任一会话；
   * 子 agent 会话不借（它们只读）。
   */
  useSession(workspacePath: string | undefined): BorrowedSession
  /** hook：当前选中会话的工作目录，作用域下拉的默认项。 */
  useCurrentWorkspace(): string | undefined
  /** hook：订阅一份视图，版本变化再读。 */
  useView<N extends ViewName>(session: BorrowedSession, name: N): ViewState<ViewMap[N]>
  /** 执行一条 `/memory` 命令，结果按契约解析；宿主或解析层面的失败折成 `failed`。 */
  execute(sessionId: string, command: MemoryCommand): Promise<MemoryCommandResult>
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

/** 当前选中的会话：主视图持有它（retainedBy.mainView > 0）。 */
export function selectedSessionId(list: SessionListState): string | undefined {
  return list.ids.find(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0)
}

export function pickSession(list: SessionListState, workspacePath: string | undefined): BorrowedSession {
  const candidates = list.ids.filter(id => isBorrowable(list, id))
  const inWorkspace = workspacePath === undefined ? [] : candidates.filter(id => samePath(list.byId[id]!.cwd, workspacePath))
  const selected = selectedSessionId(list)
  const id = newest(list, inWorkspace)
    ?? (selected !== undefined && candidates.includes(selected) ? selected : undefined)
    ?? newest(list, candidates)
  return id === undefined ? { kind: 'none' } : { kind: 'ready', sessionId: id, cwd: list.byId[id]!.cwd }
}

/** 两个路径是否同一处（忽略末尾的分隔符）；任一为 undefined 时不同。 */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  const strip = (p: string) => p.replace(/[\\/]+$/, '')
  return a !== undefined && b !== undefined && strip(a) === strip(b)
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
  const file = name === 'session' ? sessionViewFile(sessionId) : GUI_VIEW_FILES[name]
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

export const MEMORY_ROOT_KEY = 'dsh-plastic-memory.gui.memoryRoot'

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
 * info 失败后换了会话可以重试；缓存的根在刷新后仍读不到视图时，由 revalidate 再问一次。
 */
function createRootStore(run: RunLine) {
  let state: RootState = { refreshes: 0 }
  let isCached = false
  try {
    const saved = localStorage.getItem(MEMORY_ROOT_KEY)
    if (saved) { state = { ...state, memoryRoot: saved }; isCached = true }
  } catch { /* 存储不可用：每次进入发一次 info */ }
  const listeners = new Set<() => void>()
  let infoInflight = false
  let failedSessionId: string | undefined
  let refreshed = false
  const set = (next: RootState) => { state = next; for (const fn of listeners) fn() }
  const remember = (memoryRoot: string) => {
    try { localStorage.setItem(MEMORY_ROOT_KEY, memoryRoot) } catch { /* 只在本页生效 */ }
    set({ ...state, memoryRoot, error: undefined })
  }
  const store = {
    get: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    ensureRoot(sessionId: string) {
      if (state.memoryRoot !== undefined || infoInflight || (state.error !== undefined && sessionId === failedSessionId)) return
      infoInflight = true
      void run(sessionId, encodeMemoryCommand({ cmd: 'info' })).then((r) => {
        infoInflight = false
        const result = decodeExecution('info', r)
        if (result.ok && result.info !== undefined) {
          remember(result.info.memoryRoot)
          store.ensureViews(sessionId)
        } else {
          failedSessionId = sessionId
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
    /** 让服务端把视图文件写出来：首次拿到 memoryRoot 之后、或视图文件缺失时，每个页面生命周期一次。 */
    ensureViews(sessionId: string) {
      if (refreshed) return
      refreshed = true
      void run(sessionId, encodeMemoryCommand({ cmd: 'refresh-views' })).then((r) => {
        if (decodeExecution('refresh-views', r).ok) set({ ...state, refreshes: state.refreshes + 1 })
      })
    },
  }
  return store
}

interface ReadState<V> { key: string; trigger: string; view: ViewState<V> }

/** 网关绑定函数：插槽根组件用自己的标准 props 绑定一份网关。 */
export type BindGateway = (props: RootStandardProps) => MemoryGateway

/**
 * 宿主网关。共享状态（memoryRoot）在外层闭包里；每个插件实例只建一份（apply 里），所有插槽根共用，
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
  const execute: MemoryGateway['execute'] = async (sessionId, command) =>
    decodeExecution(command.cmd, await run(sessionId, encodeMemoryCommand(command)))
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

  return ({ useSessions, useResource }) => ({
    execute,
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
      const picked = pickSession(list, workspacePath)
      // 选择结果每次是新对象，按身份字段稳定下来，避免下游 effect 每次渲染都重跑
      const sessionId = picked.kind === 'ready' ? picked.sessionId : undefined
      const cwd = picked.kind === 'ready' ? picked.cwd : undefined
      return useMemo(() => picked, [sessionId, cwd])
    },
    useCurrentWorkspace() {
      return useSessions((s) => {
        const id = selectedSessionId(s)
        return id === undefined ? undefined : s.byId[id]?.cwd
      })
    },
    useView(session, name) {
      const rootState = useSyncExternalStore(root.subscribe, root.get)
      const sessionId = session.kind === 'ready' ? session.sessionId : undefined
      useEffect(() => { if (sessionId !== undefined) root.ensureRoot(sessionId) }, [sessionId, rootState])
      const path = sessionId !== undefined && rootState.memoryRoot !== undefined ? viewPath(rootState.memoryRoot, name, sessionId) : undefined
      const stat = useResource(sessionId !== undefined && path !== undefined ? fileAddress(sessionId, path) : '')
      const version = stat.status === 'live' ? stat.value?.version : undefined
      const isMissing = stat.status === 'failed' && stat.failure?.code === 'workspace-file/not-found'
      useEffect(() => { if (sessionId !== undefined && isMissing) root.ensureViews(sessionId) }, [sessionId, isMissing])
      const key = `${sessionId}\0${path}`
      // 有版本按版本读；资源还停在 not-found、但 refresh-views 已写过文件时，按刷新次数直接读一次
      const trigger = version ?? (isMissing && rootState.refreshes > 0 ? `refresh:${rootState.refreshes}` : undefined)
      const [read, setRead] = useState<ReadState<ViewMap[typeof name]> | undefined>(undefined)
      const isStillMissing = isMissing && trigger !== undefined && read?.key === key && read.trigger === trigger && read.view.status === 'missing'
      useEffect(() => { if (sessionId !== undefined && isStillMissing) root.revalidate(sessionId) }, [sessionId, isStillMissing])
      useEffect(() => {
        if (sessionId === undefined || path === undefined || trigger === undefined) return
        let live = true
        void ctx.remote.workspaceFiles.read(sessionId, path, {}).then((r) => {
          if (!live) return
          const view: ViewState<ViewMap[typeof name]> = r.ok
            ? parseView(name, r.value.text)
            : r.error.code === 'workspace-file/not-found' ? { status: 'missing' } : { status: 'error', message: `${r.error.code}: ${r.error.message}` }
          setRead({ key, trigger, view })
        }, (err: unknown) => { if (live) setRead({ key, trigger, view: { status: 'error', message: String(err) } }) })
        return () => { live = false }
      }, [sessionId, path, trigger, key, name])

      if (sessionId === undefined) return { status: 'idle' }
      if (rootState.error !== undefined) return { status: 'error', message: rootState.error }
      if (stat.status === 'failed') {
        if (!isMissing) return { status: 'error', message: `${stat.failure?.code}: ${stat.failure?.message}` }
        // 只认这次刷新触发的读：文件删掉后不拿旧内容顶上
        return read !== undefined && read.key === key && read.trigger === trigger ? read.view : { status: 'missing' }
      }
      // 同一文件的新版本还在读时先留着旧内容
      return read !== undefined && read.key === key ? read.view : { status: 'loading' }
    },
  })
}
