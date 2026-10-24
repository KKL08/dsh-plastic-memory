/**
 * 网关的内存假实现：组件测试唯一的 mock 边界（对应宿主远程调用，属于进程边界）。
 * 测试设定会话两态与视图内容，断言组件渲染出什么、发出了哪些命令。
 */
import { useSyncExternalStore } from 'react'
import type { MemoryCommand, MemoryCommandResult } from '../src/gui/contract.ts'
import type { BorrowedSession, MemoryGateway, ViewMap, ViewName, ViewState } from './gateway.ts'

export interface FakeGatewayInit {
  session?: BorrowedSession
  currentWorkspace?: string
  views?: { [N in ViewName]?: ViewMap[N] | ViewState<ViewMap[N]> }
  /** 命令的返回；缺省一律 `{ ok: true, cmd }`。 */
  respond?: (command: MemoryCommand) => MemoryCommandResult
}

export interface FakeGateway extends MemoryGateway {
  /** 发出过的命令，按顺序。 */
  readonly executed: Array<{ sessionId: string; command: MemoryCommand }>
  /** 每次 useSession 被问到的作用域（最近一次在最后）。 */
  readonly sessionRequests: Array<string | undefined>
  setSession(session: BorrowedSession): void
  setCurrentWorkspace(path: string | undefined): void
  /** 推一份新视图（等同文件版本变化后读到新内容）；传 ViewState 可模拟 loading / missing / error。 */
  setView<N extends ViewName>(name: N, value: ViewMap[N] | ViewState<ViewMap[N]>): void
}

function toState<V>(value: V | ViewState<V> | undefined): ViewState<V> {
  if (value === undefined) return { status: 'missing' }
  if (typeof value === 'object' && value !== null && 'status' in value) return value as ViewState<V>
  return { status: 'ready', data: value as V }
}

export function createFakeGateway(init: FakeGatewayInit = {}): FakeGateway {
  let session: BorrowedSession = init.session ?? { kind: 'ready', sessionId: 'fake-session', cwd: init.currentWorkspace }
  let currentWorkspace = init.currentWorkspace
  const views = new Map<ViewName, ViewState<unknown>>()
  for (const [name, value] of Object.entries(init.views ?? {})) views.set(name as ViewName, toState(value))
  let revision = 0
  const listeners = new Set<() => void>()
  const bump = () => { revision += 1; for (const fn of listeners) fn() }
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
  const useRevision = () => useSyncExternalStore(subscribe, () => revision)

  const executed: FakeGateway['executed'] = []
  const sessionRequests: FakeGateway['sessionRequests'] = []

  return {
    executed,
    sessionRequests,
    setSession(next) { session = next; bump() },
    setCurrentWorkspace(path) { currentWorkspace = path; bump() },
    setView(name, value) { views.set(name, toState(value)); bump() },
    useSession(workspacePath) {
      useRevision()
      sessionRequests.push(workspacePath)
      return session
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
      return init.respond?.(command) ?? { ok: true, cmd: command.cmd }
    },
  }
}
