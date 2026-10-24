/**
 * 宿主浏览器侧接口的最小结构子集（对照 dsh 0.2.1-rc.2 源码手写）。walking skeleton 只用到这几样，
 * 不引宿主客户端契约包做开发依赖；后续票需要更多接口时再换成宿主类型。
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

export interface SessionSummary {
  id: string
  displayTitle: string
  running: boolean
  cwd?: string
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

export interface HostContext {
  slots: {
    inject(name: string, fn: () => (() => void) | void): () => void
    register<P>(options: SlotRegisterOptions, component: ComponentType<P>): () => void
  }
  remote: {
    commands: {
      execute(sessionId: string, line: string, attachments: readonly unknown[]): Promise<RemoteResult<CommandExecution | undefined>>
    }
    workspaceFiles: {
      read(sessionId: string, path: string, range: { offset?: number; limit?: number }): Promise<RemoteResult<WorkspaceFileText>>
    }
  }
}
