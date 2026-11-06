/**
 * 借哪个会话、会话属于哪个项目：网关借会话时用，界面判断「这个会话是不是这个项目的」也用同一套规则。纯函数，单测直接测。
 */
import type { SessionListState } from './host.ts'

/** 服务端记下的会话归属对照：原始 cwd → 项目。 */
export type WorkspaceMap = Readonly<Record<string, string>>

export type BorrowedSession =
  | { kind: 'none' }
  /** workspaces：借会话时用的归属对照，判断这个会话属于哪个项目要用同一份（见 belongsTo）；缺省按空表。 */
  | { kind: 'ready'; sessionId: string; cwd: string | undefined; workspaces?: WorkspaceMap }

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

/** 会话所属的项目：对照里有就用它，其次包含 cwd 的最深的已知项目，都没有时是原始 cwd（服务端也拿 cwd 本身当作用域）。 */
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
