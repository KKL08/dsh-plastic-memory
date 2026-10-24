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

/** dsh-token-meter 的 ContextPressureProjection：宿主 ContextMeter 的分母 contextWindow 从这里来。 */
export interface ContextPressureProjection {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

/** 会话作用域插槽（如 conversation.composer.dock）在根作用域之外多拿到的标准 props 子集。 */
export interface SessionStandardProps extends RootStandardProps {
  sessionId: string
  useProjection: (key: 'contextPressure') => ContextPressureProjection | undefined
}

/** ui-sidebar-right 的 SidebarRightGuideEntry 子集（「开始」页入口）。 */
export interface SidebarGuideEntry {
  id: string
  order: number
  title: () => string
  description?: () => string
  icon?: ComponentType<{ size?: number | undefined; className?: string | undefined }>
}

/** ui-sidebar-right 的 SidebarRightTabDefinition 子集：页面类 tab（不认地址，按 kind 打开）。 */
export interface SidebarTabDefinition {
  /** 实现身份，也是正文与标题插槽的 key。 */
  id: string
  /** `openTab` 认的类型名。 */
  kind: string
  title: (address: string) => string
  guide?: readonly SidebarGuideEntry[]
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

/** ui-settings 的配置写入操作（config-form-types.ts，0.2.1-rc.2）。 */
export type ConfigPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** ui-settings ConfigFormSnapshot 子集。 */
export interface ConfigFormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  /** 按 schema 解析后的配置段（含默认值）；首次接受前为 undefined。 */
  value: unknown
  /** 下一次写入用来防冲突的版本号。 */
  revision: number | undefined
  writable: boolean
}

/** ui-settings ConfigForm 子集：单字段快捷写入用 `set`，设置页整批提交用 `mutate`（宿主接受为 true）。 */
export interface ConfigForm {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  /** 一次原子提交；false = 宿主拒绝（版本冲突或校验不过），宿主已重读最新值。传输失败 reject。 */
  mutate(ops: readonly ConfigPathOp[], expectedRevision?: number): Promise<boolean>
}

export interface HostContext {
  /** cordis 可选依赖：服务全部就位后在子上下文里执行 fn，服务离开时子上下文连同其注册一起撤掉。 */
  inject(deps: string[], fn: (child: HostContext) => void): unknown
  slots: {
    inject(name: string, fn: () => (() => void) | void): () => void
    register<P>(options: SlotRegisterOptions, component: ComponentType<P>): () => void
  }
  locale: HostLocale
  layout: {
    /** 只收面板 id、不带参数；面板未注册会抛错。 */
    selectPanel(panelId: string | null): void
  }
  sidebarRight: {
    /** 按 kind 打开右侧栏页面类型；kind 没注册会抛错。 */
    openTab(kind: string): void
  }
  /** ui-plugin-manager 提供：切到插件页并打开某个包的详情，不换当前会话。 */
  pluginNavigation: {
    openBundle(packageName: string): void
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
  /** 插件配置（profile 行 id 即 entryId）。 */
  configForms?: { get(entryId: string): ConfigForm }
}

/** 右侧栏 tab 用到的宿主服务（ui-sidebar-right）与 cordis effect。 */
export interface SidebarHost {
  /** cordis：登记一个随插件卸载而撤销的副作用。 */
  effect(execute: () => () => void, label?: string): void
  sidebarRightTabs: {
    /** 静态登记 tab 类型；返回撤销函数。登记挂在宿主注册表自己的上下文上，所以调用方要包进自己的 effect。 */
    register(definition: SidebarTabDefinition): () => void
  }
  sidebarRight: {
    /** 在当前会话的右侧栏打开（或聚焦）一个页面类 tab；没有会话在屏幕上时抛错。 */
    openTab(kind: string, options?: { params?: unknown }): void
  }
}
