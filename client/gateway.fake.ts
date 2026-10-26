/**
 * 网关的内存假实现：组件测试唯一的 mock 边界（对应宿主远程调用，属于进程边界）。
 * 测试设定会话两态与视图内容，断言组件渲染出什么、发出了哪些命令。
 */
import { useSyncExternalStore } from 'react'
import type { MemoryCommand, MemoryCommandResult } from '../src/gui/contract.ts'
import { createDeletionStore, type BorrowedSession, type CurrentWorkspace, type MemoryGateway, type PluginConfig, type ViewMap, type ViewName, type ViewState } from './gateway.ts'

export interface FakeGatewayInit {
  session?: BorrowedSession
  /** 当前项目；传 `{ status: 'loading' }` 模拟归属对照还没读到。 */
  currentWorkspace?: string | { status: 'loading' }
  views?: { [N in ViewName]?: ViewMap[N] | ViewState<ViewMap[N]> }
  /** 命令的返回；缺省一律 `{ ok: true, cmd }`。返回 Promise 可模拟进行中。 */
  respond?: (command: MemoryCommand) => MemoryCommandResult | Promise<MemoryCommandResult>
  /** openPath 的返回；缺省 true。 */
  openOk?: boolean
  /** 插件配置；缺省 undefined（宿主还没给出）。 */
  config?: PluginConfig
  /** readFile 能读到的文件（绝对路径 → 全文）。 */
  files?: Record<string, string>
  /** 借来的会话的模型名；null = 拿不到模型；缺省 = 可用但不知道名字。 */
  model?: string | null
}

export interface FakeGateway extends MemoryGateway {
  /** 发出过的命令，按顺序。 */
  readonly executed: Array<{ sessionId: string; command: MemoryCommand }>
  /** 每次 useSession 被问到的作用域（最近一次在最后）。 */
  readonly sessionRequests: Array<string | undefined>
  /** setConfig 写过的字段，按顺序。 */
  readonly configWrites: Array<{ field: string; value: unknown }>
  /** openPath 调用，按顺序（打开只记 path，显示目录带 action）。 */
  readonly opened: Array<{ path: string; action?: 'reveal' }>
  /** readFile 读过的路径。 */
  readonly reads: string[]
  /** 每次 useModel 被问到的会话 id（宿主实现在第一次问时发 model-info）。 */
  readonly modelRequests: string[]
  setConfigValue(config: PluginConfig | undefined): void
  setSession(session: BorrowedSession): void
  setCurrentWorkspace(path: string | undefined | { status: 'loading' }): void
  /** 推一份新视图（等同文件版本变化后读到新内容）；传 ViewState 可模拟 loading / missing / error。 */
  setView<N extends ViewName>(name: N, value: ViewMap[N] | ViewState<ViewMap[N]>): void
}

function toState<V>(value: V | ViewState<V> | undefined): ViewState<V> {
  if (value === undefined) return { status: 'missing' }
  if (typeof value === 'object' && value !== null && 'status' in value) return value as ViewState<V>
  return { status: 'ready', data: value as V }
}

export function createFakeGateway(init: FakeGatewayInit = {}): FakeGateway {
  const toCurrent = (value: string | undefined | { status: 'loading' }): CurrentWorkspace =>
    typeof value === 'object' ? value : { status: 'ready', workspacePath: value }
  let currentWorkspace = toCurrent(init.currentWorkspace)
  let session: BorrowedSession = init.session
    ?? { kind: 'ready', sessionId: 'fake-session', cwd: currentWorkspace.status === 'ready' ? currentWorkspace.workspacePath : undefined }
  const views = new Map<ViewName, ViewState<unknown>>()
  for (const [name, value] of Object.entries(init.views ?? {})) views.set(name as ViewName, toState(value))
  let revision = 0
  const listeners = new Set<() => void>()
  const bump = () => { revision += 1; for (const fn of listeners) fn() }
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
  const useRevision = () => useSyncExternalStore(subscribe, () => revision)

  const executed: FakeGateway['executed'] = []
  const sessionRequests: FakeGateway['sessionRequests'] = []
  const configWrites: FakeGateway['configWrites'] = []
  const opened: FakeGateway['opened'] = []
  const reads: string[] = []
  const modelRequests: string[] = []
  let config = init.config
  // 删除状态和宿主实现同一份逻辑：同一个假网关下的几个界面共用；推来的最近删除、全部记忆视图也进去，等同宿主读到它
  const deletions = createDeletionStore()
  const settle = (name: ViewName) => {
    const view = views.get(name)
    if (view?.status !== 'ready') return
    if (name === 'deleted') deletions.settle({ name, data: view.data as ViewMap['deleted'] })
    if (name === 'library') deletions.settle({ name, data: view.data as ViewMap['library'] })
  }
  settle('library')
  settle('deleted')

  return {
    executed,
    opened,
    sessionRequests,
    configWrites,
    reads,
    modelRequests,
    setConfigValue(next) { config = next; bump() },
    useConfig() {
      useRevision()
      return config
    },
    async setConfig(field, value) {
      configWrites.push({ field, value })
      return true
    },
    async readFile(_sessionId, path) {
      reads.push(path)
      return init.files?.[path]
    },
    setSession(next) { session = next; bump() },
    setCurrentWorkspace(path) { currentWorkspace = toCurrent(path); bump() },
    setView(name, value) {
      views.set(name, toState(value))
      settle(name)
      bump()
    },
    useSession(workspacePath) {
      useRevision()
      sessionRequests.push(workspacePath)
      return session
    },
    useModel(borrowed) {
      if (borrowed.kind === 'none') return { status: 'unknown' }
      modelRequests.push(borrowed.sessionId)
      return init.model === null ? { status: 'unavailable' } : { status: 'ready', model: init.model }
    },
    useCurrentWorkspace() {
      useRevision()
      return currentWorkspace
    },
    useView(borrowed, name) {
      useRevision()
      if (borrowed.kind === 'none') return { status: 'idle' }
      return (views.get(name) ?? { status: 'missing' }) as ViewState<ViewMap[typeof name]>
    },
    async execute(sessionId, command) {
      executed.push({ sessionId, command })
      const result = await (init.respond?.(command) ?? { ok: true, cmd: command.cmd })
      deletions.record(command, result)
      return result
    },
    useDeletions() {
      return useSyncExternalStore(deletions.subscribe, deletions.get)
    },
    async openPath(path, action) {
      opened.push(action === 'reveal' ? { path, action } : { path })
      return init.openOk ?? true
    },
  }
}
