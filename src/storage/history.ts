import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, rmdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { mergedIntoOf, type MemoryRecord } from '../record-schema.ts'
import { GLOBAL_SCOPE_KEY, scopeOfLedger, type Scope } from '../scope.ts'
import { linkExclusive } from './exclusive-link.ts'
import { decodeFile, encodeRecord, type FileLocation } from './frontmatter.ts'
import { HISTORY_DIR } from './paths.ts'
import type { LocatedRecord } from './table.ts'

/** 一个历史版本由哪几次写入形成：第一项是留档的那次，后面是合并窗口里并进来的。撤销按快照 id 认是哪一次。 */
export interface VersionWrite {
  op: string
  at: number
  /** 那次写入的改前快照。 */
  snapshot?: string
  /** 那次写入给的变化原因。 */
  reason?: string
}

/** 一条记忆在一段时间里的样子：状态变化前的整条记录原样留着，id 还是状态页的 id。 */
export interface HistoryVersion {
  versionId: string
  record: MemoryRecord
  /** 原文件里这一版不认识的键，原样带着。 */
  extras: Record<string, unknown>
  /** 这一版从什么时候起是当前版、到什么时候被换掉。 */
  startedAt: number
  endedAt: number
  /** 版本种类：开放取值，现在只有状态变化留下的。 */
  kind: string
  /** 留档的那次写入出自哪个会话：合并窗口只对同一个会话开。后台写入没有。 */
  sessionId?: string
  writes: VersionWrite[]
  /**
   * 并进来的版本：原来那条记忆的 id 和作用域键（版本里的记录还是它）。自己的版本没有这两项。搬进来时写进文件；
   * 没写的（解析不了、原样搬来的）读出时按记录 id 和所在目录对不上来认。
   */
  mergedFrom?: string
  mergedFromScope?: string
}

export const STATE_CHANGE_VERSION = 'state-change'
/** 并成版本时，旧状态那条记忆本身成的一版。 */
export const MERGED_VERSION = 'merged'

/** 记忆文件所在的那一层：历史版本跟着它放。 */
export interface HistoryLayer { dir: string; loc: FileLocation }

export function layerOf(found: Pick<LocatedRecord, 'dir' | 'record'>): HistoryLayer {
  const { scope, workspacePath } = found.record
  return { dir: found.dir, loc: scope === 'workspace' && workspacePath !== undefined ? { scope, workspacePath } : { scope: 'global' } }
}

/**
 * 物理删除一条带去向的记忆之前，把它的历史并到去向那条名下；并成版本的，它自己先成一版。locate 给出去向那条所在的层：
 * 按记下的作用域找，确定那里没有再到全局找一次（期间被提升）；都确定没有就什么都不搬，历史随它一起删。能重复执行。
 * locate 分不出「没有」和「读不出」时要抛错：读不出不能当成没有，这条这次不清。
 */
export async function carryMergedHistory(
  history: VersionHistory, record: MemoryRecord, fromDir: string, locate: (id: string, scope: Scope) => Promise<HistoryLayer | undefined>,
): Promise<void> {
  const into = mergedIntoOf(record)
  if (into === undefined) return
  const exact = scopeOfLedger(into.scopeKey)
  const home = (await locate(into.id, exact)) ?? (exact.kind === 'global' ? undefined : await locate(into.id, { kind: 'global' }))
  if (home === undefined) return
  // 并成版本的：它自己先成一版。排他地放，上次搬到一半留下的同一版不会多出来
  if (into.as === 'version') await history.place(home, into.id, versionOfMerged(record))
  await history.absorb({ dir: fromDir, memoryId: record.id, scopeKey: scopeKeyOfRecord(record) }, { dir: home.dir, memoryId: into.id })
}

const scopeKeyOfRecord = (r: Pick<MemoryRecord, 'scope' | 'workspacePath'>) => (r.scope === 'global' ? GLOBAL_SCOPE_KEY : r.workspacePath ?? '')

/** 并成版本的那条记忆本身成的一版：内容是它软删之前的样子，起点是它的状态起点，终点是并入时定好的。版本 id 由调用方按占名情况给。 */
export function versionOfMerged(record: MemoryRecord): HistoryVersion {
  const { deletedAt, mergedInto: _mergedInto, ...rest } = record
  const endedAt = mergedIntoOf(record)?.endedAt ?? deletedAt ?? record.updatedAt
  return {
    versionId: newVersionId(endedAt, []), record: { ...rest, status: 'active' }, extras: {},
    startedAt: record.stateSince ?? record.createdAt, endedAt, kind: MERGED_VERSION, writes: [], mergedFrom: record.id, mergedFromScope: scopeKeyOfRecord(record),
  }
}

/** 一条记忆的历史版本。读写都在调用方的写入段里做，这里不加锁。 */
export interface VersionHistory {
  /** 按结束时间从早到晚。读不出的版本文件跳过。 */
  list(layer: HistoryLayer, memoryId: string): Promise<HistoryVersion[]>
  /** 按版本 id 整份写下（已有就换掉）。只用于这条记忆自己的版本。 */
  write(layer: HistoryLayer, version: HistoryVersion): Promise<void>
  /**
   * 把一版排他地放到一条记忆名下（并进来的版本用）：按实际文件名占名，不盖掉已有的文件（读不出的也算占着）。
   * 同名且内容相同是上次放过的，不再放；同名不同内容换一个版本 id。
   */
  place(layer: HistoryLayer, ownerId: string, version: HistoryVersion): Promise<void>
  remove(layer: HistoryLayer, memoryId: string, versionId: string): Promise<void>
  /** 删掉一条记忆在这一层（记忆目录）的全部历史版本。没有就什么都不做。 */
  removeAll(dir: string, memoryId: string): Promise<void>
  /**
   * 把一条记忆的历史版本从一层搬到另一层。目标层已有这条记忆的历史时逐个并进去，排他地占名、不盖掉已有的版本：
   * 同名且内容相同的去掉源头那份，同名不同内容的换一个版本 id。能重复执行：源头已经没有就什么都不做。
   */
  move(fromDir: string, toDir: string, memoryId: string): Promise<void>
  /**
   * 把一条记忆的全部历史版本并到另一条名下（合并进另一条，被合并方物理删除时做）。读得出的版本写上来源（原记忆的 id 和作用域键）再放过去，
   * 读不出的文件原样搬。占名规则同 place；能重复执行，源头已经没有就什么都不做。
   */
  absorb(from: { dir: string; memoryId: string; scopeKey: string }, to: { dir: string; memoryId: string }): Promise<void>
  /** 这一层里有历史版本的记忆 id。 */
  memoryIds(dir: string): Promise<string[]>
}

/** 版本带的变化原因：各次写入给的原因按先后连起来。 */
export function versionReason(version: Pick<HistoryVersion, 'writes'>): string {
  return version.writes.map(w => w.reason?.trim() ?? '').filter(r => r !== '').join('\n')
}

/** 版本 id：结束时刻的 UTC 紧凑写法（到毫秒）；同一毫秒已有版本时加两位序号。 */
export function newVersionId(endedAt: number, taken: readonly string[]): string {
  return freeVersionId(new Date(endedAt).toISOString().replace(/[-:.]/g, ''), taken)
}

/** 版本 id 被占了就在基础写法后面加两位序号；已带序号的按基础写法重新数。 */
export function freeVersionId(versionId: string, taken: readonly string[]): string {
  if (!taken.includes(versionId)) return versionId
  const base = versionId.replace(/-\d{2}$/, '')
  for (let n = 2; ; n++) {
    const id = `${base}-${String(n).padStart(2, '0')}`
    if (!taken.includes(id)) return id
  }
}

export const byVersionEnd = (a: HistoryVersion, b: HistoryVersion) => a.endedAt - b.endedAt || (a.versionId < b.versionId ? -1 : 1)

/** 版本自己的键：写在记录的键后面。读回时从不认识的键里取出来，其余的仍是原文件的。 */
const VERSION_KEYS = ['versionOf', 'versionStartedAt', 'versionEndedAt', 'versionKind', 'versionReason', 'versionSessionId', 'versionWrites', 'versionMergedFrom'] as const

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}
const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

function readWrites(value: unknown): VersionWrite[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((w: unknown) => {
    if (typeof w !== 'object' || w === null) return []
    const { op, at, snapshot, reason } = w as Record<string, unknown>
    const time = ms(at)
    if (typeof op !== 'string' || time === undefined) return []
    return [{ op, at: time, ...(text(snapshot) !== undefined ? { snapshot: text(snapshot) } : {}), ...(text(reason) !== undefined ? { reason: text(reason) } : {}) }]
  })
}

function encodeVersion(v: HistoryVersion): string {
  const reason = versionReason(v)
  return encodeRecord(v.record, {
    ...v.extras,
    versionOf: v.record.id,
    versionStartedAt: iso(v.startedAt),
    versionEndedAt: iso(v.endedAt),
    versionKind: v.kind,
    ...(reason !== '' ? { versionReason: reason } : {}),
    ...(v.sessionId !== undefined ? { versionSessionId: v.sessionId } : {}),
    versionWrites: v.writes.map(w => ({ ...w, at: iso(w.at) })),
    ...(v.mergedFrom !== undefined && v.mergedFromScope !== undefined ? { versionMergedFrom: { id: v.mergedFrom, scopeKey: v.mergedFromScope } } : {}),
  })
}

function decodeVersion(raw: string, path: string, versionId: string, loc: FileLocation): HistoryVersion | undefined {
  const decoded = decodeFile(raw, { path, loc })
  if (!decoded.ok) return undefined
  const extras = { ...decoded.extras }
  const own: Record<string, unknown> = {}
  for (const key of VERSION_KEYS) {
    own[key] = extras[key]
    delete extras[key]
  }
  const endedAt = ms(own.versionEndedAt)
  if (endedAt === undefined) return undefined
  const writes = readWrites(own.versionWrites)
  const sessionId = text(own.versionSessionId)
  const from = typeof own.versionMergedFrom === 'object' && own.versionMergedFrom !== null ? own.versionMergedFrom as Record<string, unknown> : {}
  const mergedFrom = text(from.id) !== undefined && typeof from.scopeKey === 'string' ? { mergedFrom: text(from.id)!, mergedFromScope: from.scopeKey } : {}
  return {
    ...mergedFrom,
    versionId,
    record: decoded.record,
    extras,
    startedAt: ms(own.versionStartedAt) ?? decoded.record.createdAt,
    endedAt,
    kind: text(own.versionKind) ?? STATE_CHANGE_VERSION,
    ...(sessionId !== undefined ? { sessionId } : {}),
    // 手工放进来的版本没有写入清单：原因按整段留着
    writes: writes.length > 0 || text(own.versionReason) === undefined ? writes : [{ op: '', at: endedAt, reason: text(own.versionReason) }],
  }
}

const VERSION_FILE_RE = /^([0-9A-Za-z-]+)\.md$/

/** 历史版本落在磁盘上：`<层目录>/.history/<记忆 id>/<版本 id>.md`，内容是改前的整个记忆文件加版本自己的几个键。 */
export class FileVersionHistory implements VersionHistory {
  private dirOf(layer: Pick<HistoryLayer, 'dir'>, memoryId: string): string {
    // 空 id 会落到 `.history/` 本身，删它就删了这一层所有记忆的历史：不收
    if (memoryId === '') throw new Error('历史版本要有记忆 id，空 id 不收')
    // 整段是点的 id（`.`、`..`）编码后还是点，会指回上层目录：点也转掉
    const name = encodeURIComponent(memoryId)
    const dir = join(layer.dir, HISTORY_DIR, /^\.+$/.test(name) ? name.replaceAll('.', '%2E') : name)
    // 删除和搬移只动 `.history/` 下面直接的那一层
    if (dirname(dir) !== join(layer.dir, HISTORY_DIR) || basename(dir) === '') throw new Error(`历史目录不在 ${HISTORY_DIR}/ 下面：${dir}`)
    return dir
  }

  async list(layer: HistoryLayer, memoryId: string): Promise<HistoryVersion[]> {
    const dir = this.dirOf(layer, memoryId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const versions: HistoryVersion[] = []
    for (const name of names) {
      const versionId = VERSION_FILE_RE.exec(name)?.[1]
      if (versionId === undefined) continue
      const path = join(dir, name)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        continue
      }
      const version = decodeVersion(raw, path, versionId, layer.loc)
      // 没写来源的（原样搬来的）：记录 id 和目录对不上就是并进来的
      if (version !== undefined) versions.push(version.mergedFrom !== undefined || version.record.id === memoryId ? version : { ...version, mergedFrom: version.record.id })
    }
    return versions.sort(byVersionEnd)
  }

  async write(layer: HistoryLayer, version: HistoryVersion): Promise<void> {
    const dir = this.dirOf(layer, version.record.id)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${version.versionId}.md`)
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmp, encodeVersion(version), 'utf8')
    await rename(tmp, path)
  }

  async remove(layer: HistoryLayer, memoryId: string, versionId: string): Promise<void> {
    await rm(join(this.dirOf(layer, memoryId), `${versionId}.md`), { force: true })
  }

  async removeAll(dir: string, memoryId: string): Promise<void> {
    await rm(this.dirOf({ dir }, memoryId), { recursive: true, force: true })
  }

  async move(fromDir: string, toDir: string, memoryId: string): Promise<void> {
    const from = this.dirOf({ dir: fromDir }, memoryId)
    const to = this.dirOf({ dir: toDir }, memoryId)
    if (from === to) return
    let names: string[]
    try {
      names = await readdir(from)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    await mkdir(dirname(to), { recursive: true })
    try {
      // 目标层还没有这条记忆的历史：整个目录一次搬过去（rename 只会换掉空目录）
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err
    }
    for (const name of names) {
      const versionId = VERSION_FILE_RE.exec(name)?.[1]
      if (versionId === undefined) await rm(join(from, name), { force: true })   // 写到一半的临时文件
      else await this.transfer(join(from, name), to, versionId)
    }
    // 只删这时已经空了的源目录：列目录之后才写进来的版本留着，下次再搬
    await rmdir(from).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err })
  }

  async place(layer: HistoryLayer, ownerId: string, version: HistoryVersion): Promise<void> {
    const dir = this.dirOf(layer, ownerId)
    await mkdir(dir, { recursive: true })
    // 先写成临时文件再排他地放过去：目标要么没有、要么是完整的一份
    const tmp = join(dir, `${version.versionId}.md.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    await writeFile(tmp, encodeVersion(version), 'utf8')
    await this.transfer(tmp, dir, version.versionId)
  }

  async absorb(from: { dir: string; memoryId: string; scopeKey: string }, to: { dir: string; memoryId: string }): Promise<void> {
    const source = this.dirOf(from, from.memoryId)
    const target = this.dirOf(to, to.memoryId)
    if (source === target) return
    let names: string[]
    try {
      names = await readdir(source)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    await mkdir(target, { recursive: true })
    const loc: FileLocation = from.scopeKey === GLOBAL_SCOPE_KEY ? { scope: 'global' } : { scope: 'workspace', workspacePath: from.scopeKey }
    for (const name of names) {
      const versionId = VERSION_FILE_RE.exec(name)?.[1]
      // 不是版本文件的（写到一半的临时文件）不搬，留给删除清掉
      if (versionId === undefined) continue
      const path = join(source, name)
      const version = await readFile(path, 'utf8').then(raw => decodeVersion(raw, path, versionId, loc), () => undefined)
      // 读不出、解不开的原样搬；读得出的写上来源：同 id 的另一份副本并进来时，凭记录 id 认不出它是并进来的
      if (version === undefined) await this.transfer(path, target, versionId)
      else {
        await this.place({ dir: to.dir, loc }, to.memoryId, { ...version, mergedFrom: version.mergedFrom ?? from.memoryId, mergedFromScope: version.mergedFromScope ?? from.scopeKey })
        await rm(path, { force: true })
      }
    }
    await rmdir(source).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err })
  }

  /**
   * 把一个版本文件放进目标目录：排他地占名（不盖掉别人刚写下的版本），占到了才删源头那份。
   * 同名的已在：内容相同是上次搬到一半留下的同一份，删掉源头；不同就换一个版本 id 再占。
   */
  private async transfer(source: string, to: string, versionId: string): Promise<void> {
    const tried: string[] = []
    for (let candidate = versionId; ; candidate = freeVersionId(versionId, tried)) {
      const target = join(to, `${candidate}.md`)
      try {
        await linkExclusive(source, target)
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      const [mine, theirs] = await Promise.all([readFile(source, 'utf8'), readFile(target, 'utf8').catch(() => undefined)])
      if (mine === theirs) break
      tried.push(candidate)
    }
    await rm(source, { force: true })
  }

  async memoryIds(dir: string): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(join(dir, HISTORY_DIR), { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return entries.filter(e => e.isDirectory()).flatMap(e => {
      try {
        return [decodeURIComponent(e.name)]
      } catch {
        return []   // 不是插件写下的目录名
      }
    })
  }
}
