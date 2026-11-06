/**
 * 删除状态：网关记下经它发出的删除与恢复，再拿读到的视图核对。宿主网关和假网关共用这一份实现。
 */
import { scopeKey, scopeOfMemory, type DeletedView, type LibraryView, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type Scope } from '../src/gui/contract.ts'

/** 删除状态的一份快照：soft 进了最近删除、可恢复；hard 是彻底删除；undefined = 没删或看不出来。 */
export interface Deletions {
  /**
   * scope：页面上这一份所在的作用域（同 id 在几个作用域各有一份时各算各的）；不知道作用域时按 id 判，任一份删了都算。
   * savedAt：记下这条记忆的时刻；给了才可能按视图判彻底删除（见 createDeletionStore 第 3 条）。
   */
  of(id: string, scope?: Scope, savedAt?: number): 'soft' | 'hard' | undefined
}

/** 一份副本的键：id + 作用域的标准键。不知道作用域时没有键。 */
function copyKey(id: string, scope: Scope | undefined): string | undefined {
  return scope === undefined ? undefined : JSON.stringify([id, scopeKey(scope)])
}

/** 经本网关的一次动作。copy 缺省 = 命令没带作用域，同 id 各作用域都算。 */
interface LocalDeletion { id: string; copy: string | undefined; how: 'soft' | 'hard' | 'restored' }

/**
 * 删除状态，全部记忆、最近删除、右侧栏、对话交付卡显示同一条记忆时都读这一份，删除后不会有的地方还留着删除按钮。
 * 软删与恢复按 id + 作用域记：同 id 在几个作用域各有一份时，删掉其中一份不影响别处那份的显示。三个来源：
 * 1. 经本网关发出的 forget / hard-delete / restore 成功后记一笔，不等视图刷新。
 * 2. 读到的视图：在最近删除里、全部记忆里同一作用域又没有在用副本的，算软删（对话里 agent 自己删的也在这里）。别的作用域同 id 副本还在用时
 *    删掉的那份也列在最近删除里，所以要两份视图都读到过才判断。
 * 3. 彻底删除要有正面证据：本页读到的视图里出现过这条，之后两份视图出自同一次收集（generatedAt 相同）、晚于这条记忆记下的
 *    时刻，而全部记忆、最近删除、不在用的 id（已取代等）里都没有它，也没有读不全的地方（读不出的文件可能就是它）。
 *    只是缺席算不知道：从没在视图里出现过（收集落在记下与写盘之间）、视图早于记下的时刻、两份不是同一次收集、
 *    旧视图文件缺这些字段，都不判。这一条按 id 判。
 * 第 1 条记的软删 / 恢复在视图确认之前优先（视图可能还是动作之前的）：软删要出现在最近删除里、恢复要重新出现在全部记忆里，
 * 确认后去掉，之后以视图为准；有本地记录时不按第 3 条判；
 * 彻底删除一直记着。页面关掉就没了。
 */
export function createDeletionStore() {
  /** 经本网关的动作，视图确认前优先。键是副本键，命令没带作用域时是 id；后记的排在后面。 */
  const local = new Map<string, LocalDeletion>()
  /** 最近一次读到的两份视图：最近删除里的、全部记忆里在用的（id 与副本键），和各自的生成时刻。 */
  let deleted: { ids: ReadonlySet<string>; copies: ReadonlySet<string>; at: number | undefined } | undefined
  /** inactive：不在用的 id；全部记忆视图没给出、或有读不全的地方时为 undefined（判不了彻底删除）。 */
  let library: { ids: ReadonlySet<string>; copies: ReadonlySet<string>; inactive: ReadonlySet<string> | undefined; at: number | undefined } | undefined
  /** 本页读到的视图里出现过的 id（在用、最近删除、不在用都算）：判彻底删除的前提。 */
  const seen = new Set<string>()
  /** 视图证明是软删的副本键，和不知道作用域时用的 id。 */
  let viewSoft: { copies: ReadonlySet<string>; ids: ReadonlySet<string> } = { copies: new Set(), ids: new Set() }
  const listeners = new Set<() => void>()
  const snapshot = (): Deletions => {
    const mine = [...local.values()].reverse()   // 最近的在前
    const soft = viewSoft
    const seenIds = new Set(seen)
    // 两份视图出自同一次收集才拿来判彻底删除
    const at = deleted?.at !== undefined && deleted.at === library?.at ? deleted.at : undefined
    const lib = library
    const del = deleted
    return {
      of(id, scope, savedAt) {
        const copy = copyKey(id, scope)
        // 本地记录：知道作用域时取这一份的，没有再取命令没带作用域的那笔；不知道作用域时取这个 id 最近的一笔
        const own = mine.find(e => e.id === id && (copy === undefined || e.copy === copy))
          ?? (copy === undefined ? undefined : mine.find(e => e.id === id && e.copy === undefined))
        if (own !== undefined) return own.how === 'restored' ? undefined : own.how
        if (copy !== undefined ? soft.copies.has(copy) : soft.ids.has(id)) return 'soft'
        if (savedAt === undefined || at === undefined || at <= savedAt || lib?.inactive === undefined || del === undefined || !seenIds.has(id)) return undefined
        return lib.ids.has(id) || del.ids.has(id) || lib.inactive.has(id) ? undefined : 'hard'
      },
    }
  }
  let state = snapshot()
  const publish = () => {
    state = snapshot()
    for (const fn of listeners) fn()
  }
  return {
    get: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    record(command: MemoryCommand, result: MemoryCommandResult) {
      if (!result.ok || (command.cmd !== 'forget' && command.cmd !== 'hard-delete' && command.cmd !== 'restore')) return
      const copy = copyKey(command.memoryId, command.layer)
      const key = copy ?? command.memoryId
      local.delete(key)   // 重新排到最后：不知道作用域时取最近的一笔
      local.set(key, { id: command.memoryId, copy, how: command.cmd === 'forget' ? 'soft' : command.cmd === 'hard-delete' ? 'hard' : 'restored' })
      publish()
    },
    /** 读到一份最近删除或全部记忆视图：重算视图证明的软删，去掉视图已经确认的本地记录。 */
    settle(view: { name: 'deleted'; data: DeletedView } | { name: 'library'; data: LibraryView }) {
      const keysOf = (memories: readonly MemoryCard[]) => new Set(memories.flatMap(m => copyKey(m.id, scopeOfMemory(m)) ?? []))
      if (view.name === 'deleted') {
        const memories = view.data.items.map(item => item.memory)
        deleted = { ids: new Set(memories.map(m => m.id)), copies: keysOf(memories), at: view.data.generatedAt }
        for (const id of deleted.ids) seen.add(id)
      } else {
        const { inactiveIds, hasUnreadFiles } = view.data
        const memories = view.data.layers.flatMap(s => s.items)
        library = {
          ids: new Set(memories.map(m => m.id)),
          copies: keysOf(memories),
          inactive: inactiveIds === undefined || hasUnreadFiles !== false ? undefined : new Set(inactiveIds),
          at: view.data.generatedAt,
        }
        for (const id of [...library.ids, ...inactiveIds ?? []]) seen.add(id)
      }
      if (deleted === undefined || library === undefined) { publish(); return }
      const active = library
      viewSoft = {
        copies: new Set([...deleted.copies].filter(copy => !active.copies.has(copy))),
        ids: new Set([...deleted.ids].filter(id => !active.ids.has(id))),
      }
      // 视图确认：软删的出现在最近删除里，恢复的重新出现在全部记忆里
      for (const [key, e] of local) {
        const isSoft = e.copy !== undefined ? viewSoft.copies.has(e.copy) : viewSoft.ids.has(e.id)
        const isActive = e.copy !== undefined ? active.copies.has(e.copy) : active.ids.has(e.id)
        if ((e.how === 'soft' && isSoft) || (e.how === 'restored' && isActive && !isSoft)) local.delete(key)
      }
      publish()
    },
  }
}
