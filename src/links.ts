import { isMemoryIdShaped, type LinkIds, type MemoryRecord } from './record-schema.ts'
import { computeDigest } from './storage/frontmatter.ts'
import { scopeKey, scopeOfMemory, type Scope } from './scope.ts'
import type { MemoryStore } from './store.ts'

/**
 * 关联（related）和前提（premises）：保存时挂上、换作用域时重验。
 * 作用域规则只有一条：项目记忆可以指向本项目和全局的记忆，全局记忆只能指向全局记忆（全局记忆各项目共用，指向某个项目的记忆到别的项目就悬空）。
 */

/** 保存工具每条记忆的 related 最多挂几个、premises 最多记几个（暂定）：挂得太多，关联图和复查信号就没有重点。 */
export const LINKS_PER_KIND_MAX = 10

type Premise = NonNullable<MemoryRecord['premises']>[number]

/** 前提里记下的「当时的内容摘要」：名称、摘要、正文的指纹，和记忆文件里的 digest 同一算法。以后对不上，说明依据变了。 */
export function premiseDigest(record: Pick<MemoryRecord, 'name' | 'summary' | 'content'>): string {
  return computeDigest(record.name, record.summary, record.content)
}

/** 这个作用域的记忆能指向哪些作用域：项目记忆看本项目和全局，全局记忆只看全局。 */
function reachableScopes(owner: Scope): Scope[] {
  return owner.kind === 'global' ? [owner] : [owner, { kind: 'global' }]
}

/**
 * 保存工具收到的 related、premises 按记忆 id 的形状校验（见 isMemoryIdShaped）：不合形状的不往下查。
 * 原因里只说第几项，不带原值：参数里可能是误填的密钥，回显出去就进了会话。都合形状返回 undefined。
 */
export function linkShapeProblem(input: { related?: unknown; premises?: unknown }): string | undefined {
  const problems: string[] = []
  for (const key of ['related', 'premises'] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) { problems.push(`${key} 要是记忆 id 的列表`); continue }
    const bad = value.flatMap((item, i) => (isMemoryIdShaped(item) ? [] : [i + 1]))
    if (bad.length > 0) problems.push(`${key} 第 ${bad.join('、')} 项不是记忆 id`)
  }
  return problems.length === 0 ? undefined : `${problems.join('；')}（记忆 id 从 memory_search 或保存结果里取）。`
}

/** 一次保存要挂的关联和前提（模型给的 id）。 */
export interface LinkRequest { related?: readonly string[]; premises?: readonly string[] }

/** 按当下的盘面核对过的关联和前提：related 是去重后的 id，premises 带当时的内容摘要。 */
export interface ResolvedLinks { related: string[]; premises: Premise[] }

/**
 * 核对要挂的 id：去重；不能指向自己；要存在、在用，并在 owner 够得着的作用域里。不满足的一并列进原因（给模型看，只有 id；
 * 查不到的只说第几项，填进来的可能根本不是 id）。
 * 调用方在写入段里调：核对和落盘之间别的写入插不进来。
 */
export async function resolveLinks(store: MemoryStore, owner: { id?: string; scope: Scope }, request: LinkRequest): Promise<ResolvedLinks | { problem: string }> {
  const problems: string[] = []
  const resolved: ResolvedLinks = { related: [], premises: [] }
  for (const key of ['related', 'premises'] as const) {
    const seen = new Set<string>()
    for (const [i, id] of (request[key] ?? []).entries()) {
      if (seen.has(id)) continue
      seen.add(id)
      if (id === owner.id) { problems.push(`${key} 里的 ${id} 是这条记忆自己，去掉它`); continue }
      // 够得着的几个作用域里先认在用的那份
      const copies: MemoryRecord[] = []
      for (const scope of reachableScopes(owner.scope)) {
        const copy = await store.get(id, scope)
        if (copy !== undefined) copies.push(copy)
      }
      const found = copies.find(c => c.status === 'active') ?? copies[0]
      if (found === undefined) {
        const elsewhere = await store.get(id, {})
        problems.push(elsewhere === undefined
          ? `${key} 第 ${i + 1} 项查不到记忆，先用 memory_search 找到要挂的那条`
          : owner.scope.kind === 'global'
            ? `${key} 里的 ${id} 是项目记忆；全局记忆只能指向全局记忆，项目记忆到别的项目就找不到了。去掉它，或改挂全局里说同一件事的那条`
            : `${key} 里的 ${id} 属于别的项目；项目记忆只能指向本项目和全局的记忆`)
        continue
      }
      if (found.status !== 'active') { problems.push(`${key} 里的 ${id} 已${found.status === 'superseded' ? '被取代' : '删除'}，挂在用的那条`); continue }
      if (key === 'related') resolved.related.push(id)
      else resolved.premises.push({ id, digest: premiseDigest(found) })
    }
  }
  return problems.length > 0 ? { problem: `${problems.join('；')}。` } : resolved
}

/** 追加之后的关联和前提，以及这次实际新加的 id。 */
export interface MergedLinks {
  fields: Pick<MemoryRecord, 'related' | 'premises'>
  added: { related: string[]; premises: string[] }
}

/**
 * 把这次要挂的追加到 current 已有的后面：去重，已有的一个不删、顺序不动；已经记着的前提保留当时的摘要。
 * 追加后哪一种超过上限就返回 problem（已有的超了、这次又没加的不算）。没加任何东西时 fields 原样。
 */
export function mergeLinks(current: Pick<MemoryRecord, 'related' | 'premises'>, add: ResolvedLinks): MergedLinks | { problem: string } {
  const related = current.related ?? []
  const premises = current.premises ?? []
  const addedRelated = add.related.filter(id => !related.includes(id))
  const addedPremises = add.premises.filter(p => !premises.some(q => q.id === p.id))
  const problems: string[] = []
  if (addedRelated.length > 0 && related.length + addedRelated.length > LINKS_PER_KIND_MAX) {
    problems.push(`related 已有 ${related.length} 个，再加 ${addedRelated.length} 个超过每条 ${LINKS_PER_KIND_MAX} 个的上限，只挂最要紧的几条`)
  }
  if (addedPremises.length > 0 && premises.length + addedPremises.length > LINKS_PER_KIND_MAX) {
    problems.push(`premises 已有 ${premises.length} 个，再加 ${addedPremises.length} 个超过每条 ${LINKS_PER_KIND_MAX} 个的上限，只记最要紧的几条`)
  }
  if (problems.length > 0) return { problem: `${problems.join('；')}。` }
  const fields: MergedLinks['fields'] = {
    ...(current.related !== undefined || addedRelated.length > 0 ? { related: [...related, ...addedRelated] } : {}),
    ...(current.premises !== undefined || addedPremises.length > 0 ? { premises: [...premises, ...addedPremises] } : {}),
  }
  return { fields, added: { related: addedRelated, premises: addedPremises.map(p => p.id) } }
}

/** 换作用域时要去掉的关联和前提（只有 id）。 */
export type DroppedLinks = LinkIds

export function hasDropped(dropped: DroppedLinks): boolean {
  return dropped.related.length > 0 || dropped.premises.length > 0
}

/**
 * 这条记忆搬到 target 之后越界的关联和前提：指向的记忆只在 target 够不着的作用域里有。哪里都找不到的（悬空）留着，交给体检。
 * movingAlong：和它同一批搬到 target 的 id，按已经在 target 算。
 * 调用方在写入段里调，落盘前用 withoutLinks 去掉。
 */
export async function linksOutside(
  store: MemoryStore, record: Pick<MemoryRecord, 'related' | 'premises'>, target: Scope, opts: { movingAlong?: ReadonlySet<string> } = {},
): Promise<DroppedLinks> {
  const reachable = new Set(reachableScopes(target).map(scopeKey))
  const isOutside = async (id: string) => {
    // 同一批一起搬过去的：搬完就在 target 里，不算越界（不然结果取决于先处理哪一条）
    if (opts.movingAlong?.has(id) === true) return false
    const copies = await store.copiesOf(id)
    return copies.length > 0 && !copies.some(s => reachable.has(scopeKey(s)))
  }
  const dropped: DroppedLinks = { related: [], premises: [] }
  for (const id of new Set(record.related ?? [])) if (await isOutside(id)) dropped.related.push(id)
  for (const id of new Set((record.premises ?? []).map(p => p.id))) if (await isOutside(id)) dropped.premises.push(id)
  return dropped
}

/** 去掉给定的关联和前提；去空了就不留这个键（和从没挂过的记忆一样）。 */
export function withoutLinks<T extends Pick<MemoryRecord, 'related' | 'premises'>>(record: T, dropped: DroppedLinks): T {
  const { related, premises, ...rest } = record
  const keptRelated = related?.filter(id => !dropped.related.includes(id))
  const keptPremises = premises?.filter(p => !dropped.premises.includes(p.id))
  return {
    ...rest,
    ...(keptRelated !== undefined && (keptRelated.length > 0 || related!.length === 0) ? { related: keptRelated } : {}),
    ...(keptPremises !== undefined && (keptPremises.length > 0 || premises!.length === 0) ? { premises: keptPremises } : {}),
  } as T
}

/**
 * 撤销换作用域时把当时去掉的关联和前提放回去：before 是换作用域前的那一版（改前快照），dropped 是当时去掉的 id。
 * 按 before 里的先后放回；之后新挂上的接在后面。放回之后调用方照常按要回到的作用域重验。
 */
export function restoreLinks<T extends Pick<MemoryRecord, 'related' | 'premises'>>(record: T, before: Pick<MemoryRecord, 'related' | 'premises'>, dropped: DroppedLinks): T {
  const related = record.related ?? []
  const premises = record.premises ?? []
  const backRelated = (before.related ?? []).filter(id => dropped.related.includes(id) && !related.includes(id))
  const backPremises = (before.premises ?? []).filter(p => dropped.premises.includes(p.id) && !premises.some(q => q.id === p.id))
  if (backRelated.length === 0 && backPremises.length === 0) return record
  const order = <V>(items: V[], key: (v: V) => string, ref: string[]) => [...items].sort((a, b) => {
    const [ia, ib] = [ref.indexOf(key(a)), ref.indexOf(key(b))]
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib)
  })
  return {
    ...record,
    ...(backRelated.length > 0 ? { related: order([...related, ...backRelated], id => id, before.related ?? []) } : {}),
    ...(backPremises.length > 0 ? { premises: order([...premises, ...backPremises], p => p.id, (before.premises ?? []).map(p => p.id)) } : {}),
  }
}

/** 换作用域的结果里列出去掉的关联和前提，一条记忆一句（给模型和用户看，只有 id）。 */
export function droppedLinksNote(entries: ReadonlyArray<{ id: string } & DroppedLinks>): string {
  if (entries.length === 0) return ''
  const lines = entries.map(e => [
    e.related.length > 0 ? `关联 ${e.related.join('、')}` : '',
    e.premises.length > 0 ? `前提 ${e.premises.join('、')}` : '',
  ].filter(s => s !== '').join('，')).map((what, i) => `${entries[i]!.id} 去掉了${what}`)
  return `换了作用域之后够不着原来指向的记忆，${lines.join('；')}；撤销这次搬家时会一起还原。`
}

/**
 * 这条记忆的当前版本有没有被某条决定引用为前提（前提记下的摘要等于它现在的内容）：被引用的版本做状态变化时一定留档。
 * 在写锁内调，按派生库的目标索引查（MemoryStore.indexedLinksTo），范围含归档里被取代的决定。查不全时按被引用算：多留一版无害，漏留就丢了依据。
 */
export async function isCurrentPremise(store: MemoryStore, record: MemoryRecord): Promise<boolean> {
  const scope = scopeOfMemory(record)
  if (scope === undefined) return true
  const digest = premiseDigest(record)
  const found = await store.indexedLinksTo(record.id, scope)
  return !found.isComplete || found.refs.some(ref => ref.kind === 'premise' && ref.digest === digest)
}
