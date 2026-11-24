import { mkdir, readdir, readFile, rm, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
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
}

export const STATE_CHANGE_VERSION = 'state-change'

/** 记忆文件所在的那一层：历史版本跟着它放。 */
export interface HistoryLayer { dir: string; loc: FileLocation }

export function layerOf(found: Pick<LocatedRecord, 'dir' | 'record'>): HistoryLayer {
  const { scope, workspacePath } = found.record
  return { dir: found.dir, loc: scope === 'workspace' && workspacePath !== undefined ? { scope, workspacePath } : { scope: 'global' } }
}

/** 一条记忆的历史版本。读写都在调用方的写入段里做，这里不加锁。 */
export interface VersionHistory {
  /** 按结束时间从早到晚。读不出的版本文件跳过。 */
  list(layer: HistoryLayer, memoryId: string): Promise<HistoryVersion[]>
  /** 按版本 id 整份写下（已有就换掉）。 */
  write(layer: HistoryLayer, version: HistoryVersion): Promise<void>
  remove(layer: HistoryLayer, memoryId: string, versionId: string): Promise<void>
}

/** 版本带的变化原因：各次写入给的原因按先后连起来。 */
export function versionReason(version: Pick<HistoryVersion, 'writes'>): string {
  return version.writes.map(w => w.reason?.trim() ?? '').filter(r => r !== '').join('\n')
}

/** 版本 id：结束时刻的 UTC 紧凑写法（到毫秒）；同一毫秒已有版本时加两位序号。 */
export function newVersionId(endedAt: number, taken: readonly string[]): string {
  const base = new Date(endedAt).toISOString().replace(/[-:.]/g, '')
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base}-${String(n).padStart(2, '0')}`
    if (!taken.includes(id)) return id
  }
}

export const byVersionEnd = (a: HistoryVersion, b: HistoryVersion) => a.endedAt - b.endedAt || (a.versionId < b.versionId ? -1 : 1)

/** 版本自己的键：写在记录的键后面。读回时从不认识的键里取出来，其余的仍是原文件的。 */
const VERSION_KEYS = ['versionOf', 'versionStartedAt', 'versionEndedAt', 'versionKind', 'versionReason', 'versionSessionId', 'versionWrites'] as const

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
  return {
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
  private dirOf(layer: HistoryLayer, memoryId: string): string {
    // 整段是点的 id（`.`、`..`）编码后还是点，会指回上层目录：点也转掉
    const name = encodeURIComponent(memoryId)
    return join(layer.dir, HISTORY_DIR, /^\.+$/.test(name) ? name.replaceAll('.', '%2E') : name)
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
      if (version !== undefined) versions.push(version)
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
}
