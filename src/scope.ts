import { z } from 'zod'

/**
 * 作用域的身份：一个作用域在代码里只有这一种形状、一套键。叶子，浏览器半侧经 GUI 契约转出使用，不碰 node:*。
 * 形状与 wire、记忆记录同形（字段 workspacePath）。缓存、侧表、待决账本按作用域存东西时，键都由标准键组合得到；
 * 这些键已经落盘，组合方式改了就读不到旧数据。
 */
export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('workspace'), workspacePath: z.string() }),
])
export type Scope = z.infer<typeof scopeSchema>

export const GLOBAL_SCOPE_KEY = 'global'

/** 标准键（作用域键）：全局为 `global`，项目为它的绝对路径（取原路径，不规范化）。 */
export function scopeKey(scope: Scope): string {
  return scope.kind === 'global' ? GLOBAL_SCOPE_KEY : scope.workspacePath
}

/** 语义缓存的键：`cache_` + 标准键。项目路径是绝对路径，不会与 `cache_global` 撞名。 */
export function scopeCacheKey(scope: Scope): string {
  return `cache_${scopeKey(scope)}`
}

/** 待决账本条目 `workspaces` 里的作用域标签：就是标准键，全局记哨兵 `global`。 */
export function ledgerLabel(scope: Scope): string {
  return scopeKey(scope)
}

/** 账本标签还原成作用域，与 ledgerLabel 互逆。 */
export function scopeOfLedger(label: string): Scope {
  return label === GLOBAL_SCOPE_KEY ? { kind: 'global' } : { kind: 'workspace', workspacePath: label }
}

/** 记忆所在的作用域。项目记忆缺 workspacePath 时为 undefined（定位不到）。 */
export function scopeOfMemory(memory: { scope: 'global' | 'workspace'; workspacePath?: string | undefined }): Scope | undefined {
  if (memory.scope === 'global') return { kind: 'global' }
  return memory.workspacePath === undefined ? undefined : { kind: 'workspace', workspacePath: memory.workspacePath }
}

/** 两个作用域是否同一个：都是全局，或同一个项目路径（末尾带不带分隔符都算同一个）。 */
export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind === 'global' || b.kind === 'global') return a.kind === b.kind
  return trimTrailingSeparator(a.workspacePath) === trimTrailingSeparator(b.workspacePath)
}

/** 记忆是否属于这个作用域：按标准键精确比较。存储层按目录区分项目，末尾分隔符不同就是另一个目录，规范化只用于界面判等（sameScope）。 */
export function isInScope(memory: { scope: 'global' | 'workspace'; workspacePath?: string | undefined }, scope: Scope): boolean {
  const own = scopeOfMemory(memory)
  return own !== undefined && scopeKey(own) === scopeKey(scope)
}

/** 去掉末尾的 `/` 或 `\`；根目录本身保留。 */
function trimTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '' ? path.slice(0, 1) : trimmed
}
