/**
 * 网关：组件与宿主之间唯一的边。组件只认 MemoryGateway 接口（借哪个会话、订阅视图、执行命令），
 * 宿主实现在这里，内存假实现在 gateway.fake.ts（测试唯一的 mock 边界）。
 *
 * 数据通道（spec「数据通道」）：视图是 `<memoryRoot>/.state/gui/*.json`，经文件资源订阅版本、版本变了再读；
 * 动作是 `/memory` 会话命令。浏览器半侧不知道 memoryRoot：首次需要时借会话发一次 `info`，结果缓存到 localStorage；
 * 视图文件不存在时再发一次 `refresh-views` 让服务端生成。
 * 只有两态：一个会话都没有 → none；有会话（历史或在跑，宿主会自动 resume 冷会话）→ ready。
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, encodeMemoryCommand, sessionViewFile,
  deletedViewSchema, healthViewSchema, libraryViewSchema, pendingViewSchema, sessionViewSchema,
  memoryCommandResultSchema,
  type DeletedView, type HealthView, type LibraryView, type MemoryCommand, type MemoryCommandResult,
  type PendingView, type SessionView,
} from '../src/gui/contract.ts'
import type { CommandExecution, HostContext, RemoteResult, RootStandardProps, SessionListState } from './host.ts'

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

function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '')
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

// —— 宿主实现 ——

export const MEMORY_ROOT_KEY = 'dsh-plastic-memory.gui.memoryRoot'

interface RootState { memoryRoot?: string; error?: string }

type RunLine = (sessionId: string, line: string) => Promise<RemoteResult<CommandExecution | undefined>>

/** memoryRoot：localStorage 有就用；没有就借会话发一次 info（并发请求合并成一条），再发一次 refresh-views。 */
function createRootStore(run: RunLine) {
  let state: RootState = {}
  try {
    const saved = localStorage.getItem(MEMORY_ROOT_KEY)
    if (saved) state = { memoryRoot: saved }
  } catch { /* 存储不可用：每次进入发一次 info */ }
  const listeners = new Set<() => void>()
  let infoInflight = false
  let refreshed = false
  const set = (next: RootState) => { state = next; for (const fn of listeners) fn() }
  const store = {
    get: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    ensureRoot(sessionId: string) {
      if (state.memoryRoot !== undefined || state.error !== undefined || infoInflight) return
      infoInflight = true
      void run(sessionId, encodeMemoryCommand({ cmd: 'info' })).then((r) => {
        infoInflight = false
        const result = decodeExecution('info', r)
        if (result.ok && result.info !== undefined) {
          try { localStorage.setItem(MEMORY_ROOT_KEY, result.info.memoryRoot) } catch { /* 只在本页生效 */ }
          set({ memoryRoot: result.info.memoryRoot })
          store.ensureViews(sessionId)
        } else {
          set({ error: result.ok ? 'info returned no paths' : (result.detail ?? result.code) })
        }
      })
    },
    /** 让服务端把视图文件写出来：首次拿到 memoryRoot 之后、或视图文件缺失时，每个页面生命周期一次。 */
    ensureViews(sessionId: string) {
      if (refreshed) return
      refreshed = true
      void run(sessionId, encodeMemoryCommand({ cmd: 'refresh-views' }))
    },
  }
  return store
}

interface ReadState<V> { key: string; view: ViewState<V> }

/**
 * 宿主网关。共享状态（memoryRoot）在外层闭包里，每个插槽根组件用自己的标准 props 绑定一份：
 * `const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])`。
 */
export function createHostGateway(ctx: HostContext): (props: RootStandardProps) => MemoryGateway {
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

  return ({ useSessions, useResource }) => ({
    execute,
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
      const [read, setRead] = useState<ReadState<ViewMap[typeof name]> | undefined>(undefined)
      useEffect(() => {
        if (sessionId === undefined || path === undefined || version === undefined) return
        let live = true
        void ctx.remote.workspaceFiles.read(sessionId, path, {}).then((r) => {
          if (!live) return
          setRead({ key, view: r.ok ? parseView(name, r.value.text) : { status: 'error', message: `${r.error.code}: ${r.error.message}` } })
        }, (err: unknown) => { if (live) setRead({ key, view: { status: 'error', message: String(err) } }) })
        return () => { live = false }
      }, [sessionId, path, version, key, name])

      if (sessionId === undefined) return { status: 'idle' }
      if (rootState.error !== undefined) return { status: 'error', message: rootState.error }
      if (stat.status === 'failed') {
        return isMissing
          ? { status: 'missing' }
          : { status: 'error', message: `${stat.failure?.code}: ${stat.failure?.message}` }
      }
      // 同一文件的新版本还在读时先留着旧内容
      return read !== undefined && read.key === key ? read.view : { status: 'loading' }
    },
  })
}
