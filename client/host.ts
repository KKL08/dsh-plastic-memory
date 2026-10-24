/**
 * 宿主浏览器侧接口的最小结构子集（对照 dsh 0.2.1-rc.2 源码手写）。只列客户端用到的字段，
 * 不引宿主客户端契约包做开发依赖；组件不直接碰这些接口，只认 gateway.ts 的网关。
 */
import type { ComponentType } from 'react'

/** Typert Remote 调用结果。 */
export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** dsh-commands 的 CommandExecution。 */
export interface CommandExecution {
  commandId: string
  result: { kind: 'success'; text?: string } | { kind: 'error'; text: string }
}

/** dsh-api-workspace-files 的 WorkspaceFileText（只列用到的字段）。 */
export interface WorkspaceFileText {
  absolutePath: string
  version: string
  text: string
}

/** dsh-api-workspace-files 的 WorkspaceFileStat。 */
export interface WorkspaceFileStat {
  absolutePath: string
  version: string
  bytes?: number
}

/** dsh-client-resources 的 ResourceSnapshot。 */
export interface ResourceSnapshot<V> {
  status: 'none' | 'loading' | 'live' | 'failed'
  value: V | undefined
  failure: { code: string; message: string } | undefined
}

/** dsh-api-session-controller 的 SessionSummary（只列用到的字段）。 */
export interface SessionSummary {
  id: string
  displayTitle: string
  running: boolean
  cwd?: string
  origin?: 'subagent'
  updatedAt: number
  /** 本地持有计数；mainView > 0 的那个就是当前选中（主视图里显示）的会话。 */
  retainedBy: Readonly<Record<string, number | undefined>>
}

export interface SessionListState {
  ids: string[]
  byId: Record<string, SessionSummary>
  phase: string
}

/** 根作用域插槽（main、sidebar.panellist）都拿得到的标准 props 子集。 */
export interface RootStandardProps {
  useResource: (address: string) => ResourceSnapshot<WorkspaceFileStat>
  useSessions: <S>(selector: (state: SessionListState) => S, equal?: (a: S, b: S) => boolean) => S
}

export interface SlotRegisterOptions {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
}

/** 宿主 locale 服务（ui-slots LocaleFace 子集）。 */
export interface HostLocale {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  getSnapshot(): unknown
  subscribe(fn: () => void): () => void
}

export interface HostContext {
  slots: {
    inject(name: string, fn: () => (() => void) | void): () => void
    register<P>(options: SlotRegisterOptions, component: ComponentType<P>): () => void
  }
  locale: HostLocale
  layout: {
    /** 只收面板 id、不带参数；面板未注册会抛错。 */
    selectPanel(panelId: string | null): void
  }
  remote: {
    commands: {
      execute(sessionId: string, line: string, attachments: readonly unknown[]): Promise<RemoteResult<CommandExecution | undefined>>
    }
    workspaceFiles: {
      read(sessionId: string, path: string, range: { offset?: number; limit?: number }): Promise<RemoteResult<WorkspaceFileText>>
    }
    /** dsh-api-session-controller 的 openWorkspacePath：不带会话，宿主核对路径后交给本机打开或在文件管理器里显示。 */
    session: {
      openWorkspacePath(request: { path: string; action?: 'reveal' }): Promise<RemoteResult<unknown>>
    }
  }
}
