import { mkdir, readFile, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import type { ZodType } from 'zod'
import type { MemoryLogger } from './table.ts'
import { kvImportMarkerSchema, type KvImportMarker } from './schema.ts'
import { SAFE_KEY_RE, atomicWrite, breakStaleLock, createExclusive, describeError, errnoCode, isStaleLock, lockOwner } from './state-files.ts'

/**
 * 旧宿主 KV 导入（0.1.x → 0.2.0 升级用，0.3.0 整个模块删掉）：把旧 KV 里的快照与待决账本搬进侧表的两个目录。
 *
 *   .state/kv-import.json           导入的完成标记
 *   .state/kv-import.lock           导入期间的跨进程锁，导完即删
 *
 * 侧表（sidecar.ts）的快照、待决账本、扫描缓存每个读写方法先 await 一次 ensureImported（memoize；在侧表的进程内锁里、
 * 再持跨进程锁文件执行，锁内重查标记）。导入只碰那两个目录和自己的标记、锁文件。
 */

export const KV_IMPORT_MARKER = 'kv-import.json'
export const KV_IMPORT_LOCK = 'kv-import.lock'

/** 持锁期间每隔这么久刷新一次锁的时间戳；超过 STALE 没刷新按残留处理（兜底持锁进程崩溃后 pid 被复用）。 */
const IMPORT_LOCK_REFRESH_MS = 10_000
const IMPORT_LOCK_STALE_MS = 60_000
const IMPORT_LOCK_POLL_MS = 50

/** 旧宿主 KV 里要导入的两张表的 [key, value] 全量；值未经校验，导入时逐条过 schema。 */
export interface LegacyKvTables {
  snapshots: Array<[string, unknown]>
  pending: Array<[string, unknown]>
  /** 删掉旧 KV 里这两张表的全部行。标记写下后调用：宿主不再留明文副本，标记丢失后重导也找不到旧行。
   *  失败或中途崩溃时标记记为待清理，后续启动重试。 */
  discard: () => Promise<void>
}

export interface LegacyKvImportOptions<S, P> {
  /** `<memoryRoot>/.state`；标记与锁文件住这里，两张表导进它下面的 dirs。 */
  stateDir: string
  dirs: { snapshots: string; pending: string }
  schemas: { snapshots: ZodType<S>; pending: ZodType<P> }
  /** 见 SidecarOptions.openLegacyKv。 */
  openLegacyKv: (() => Promise<LegacyKvTables | undefined>) | undefined
  /** 侧表的进程内锁：导入与侧表写串行。 */
  locked: <R>(fn: () => Promise<R>) => Promise<R>
  log: MemoryLogger
  now: () => number
}

/** 标记在且无需再清理旧 KV 行。 */
function isSettled(marker: KvImportMarker): boolean {
  return marker.source === 'none' || marker.discarded === true
}

export class LegacyKvImport<S extends { id: string }, P extends { id: string }> {
  private readonly opts: LegacyKvImportOptions<S, P>
  private imported: Promise<void> | undefined
  private markerWarned = false // 坏标记每个实例只告警一次（锁外、锁内各读一次）

  constructor(opts: LegacyKvImportOptions<S, P>) {
    this.opts = opts
  }

  /** 锁内初始化屏障，memoize 成一个 Promise。失败或服务缺席都不写标记：本进程不再重试，
   *  下次启动标记仍缺失，续传（排他创建保证已迁入的条目不被覆盖）。 */
  ensureImported(): Promise<void> {
    this.imported ??= this.opts.locked(() => this.importInner()).catch(err => {
      this.opts.log.warn(`[plastic-memory] 旧 KV 侧表导入失败，下次启动续传：${describeError(err)}`)
    })
    return this.imported
  }

  private async importInner(): Promise<void> {
    const markerPath = join(this.opts.stateDir, KV_IMPORT_MARKER)
    const seen = await this.readMarker(markerPath)
    if (seen !== undefined && isSettled(seen)) return // 常态：不抢锁
    const release = await this.acquireImportLock()
    try {
      await this.importLocked(markerPath)
    } finally {
      await release()
    }
  }

  /** 持跨进程锁执行。等锁期间别的进程可能已导完：锁内重查标记，标记在就一条不写，只补做未完成的清理。
   *  旧行也在锁内现取，不用锁外拿到的旧副本。 */
  private async importLocked(markerPath: string): Promise<void> {
    const existing = await this.readMarker(markerPath)
    if (existing !== undefined) {
      if (isSettled(existing)) return
      const legacy = await this.opts.openLegacyKv?.()
      if (legacy !== undefined) await this.discardLegacy(markerPath, existing, legacy) // 服务缺席：保持待清理
      return
    }
    let legacy: LegacyKvTables | undefined
    if (this.opts.openLegacyKv !== undefined) {
      legacy = await this.opts.openLegacyKv()
      if (legacy === undefined) return   // 服务缺席：不写「没东西可导」的标记，旧数据可能还在 KV 里
      if (legacy.snapshots.length === 0 && legacy.pending.length === 0) legacy = undefined
    }
    const counts = { snapshots: 0, pending: 0 }
    if (legacy !== undefined) {
      counts.snapshots = await this.importTable(legacy.snapshots, this.opts.dirs.snapshots, this.opts.schemas.snapshots)
      counts.pending = await this.importTable(legacy.pending, this.opts.dirs.pending, this.opts.schemas.pending)
    }
    const marker: KvImportMarker = {
      version: 1,
      importedAt: this.opts.now(),
      source: legacy === undefined ? 'none' : 'kv',
      counts,
      ...(legacy === undefined ? {} : { discarded: false }),
    }
    await mkdir(this.opts.stateDir, { recursive: true })
    await atomicWrite(markerPath, JSON.stringify(marker))
    if (legacy !== undefined) {
      this.opts.log.info(`[plastic-memory] 旧 KV 侧表已导入：快照 ${counts.snapshots} 条，待决 ${counts.pending} 条`)
      await this.discardLegacy(markerPath, marker, legacy)
    }
  }

  /** 删旧 KV 行，成功后把标记改成已清理。标记已挡住重导，失败不影响本次操作，只留痕、下次启动重试。 */
  private async discardLegacy(markerPath: string, marker: KvImportMarker, legacy: LegacyKvTables): Promise<void> {
    try {
      await legacy.discard()
    } catch (err) {
      this.opts.log.warn(`[plastic-memory] 旧 KV 侧表已导入，但删除旧行失败，下次启动重试：${describeError(err)}`)
      return
    }
    await atomicWrite(markerPath, JSON.stringify({ ...marker, discarded: true }))
  }

  /** 排他创建锁文件；已被占用就轮询等待。持锁进程已退出或锁久未刷新按残留清掉。
   *  持锁期间定时刷新时间戳，慢导入不会被当成残留。返回释放函数。 */
  private async acquireImportLock(): Promise<() => Promise<void>> {
    const lockPath = join(this.opts.stateDir, KV_IMPORT_LOCK)
    await mkdir(this.opts.stateDir, { recursive: true })
    const id = Math.random().toString(36).slice(2)
    const lockText = () => JSON.stringify({ pid: process.pid, at: this.opts.now(), id })
    for (;;) {
      if (await createExclusive(lockPath, lockText())) {
        // 刷新串成一条链，释放时等它跑完，免得删锁之后又被在途的刷新写回来
        let refreshing: Promise<void> = Promise.resolve()
        const timer = setInterval(() => {
          refreshing = refreshing.then(async () => {
            if (await lockOwner(lockPath) === id) await atomicWrite(lockPath, lockText())
          }).catch(err => {
            this.opts.log.warn(`[plastic-memory] 刷新旧 KV 导入锁失败：${describeError(err)}`)
          })
        }, IMPORT_LOCK_REFRESH_MS)
        timer.unref() // 不因这个计时器拖住进程退出
        return async () => {
          clearInterval(timer)
          await refreshing
          // 只删自己的锁：被当成残留清掉并重建时不误删对方的
          if (await lockOwner(lockPath) === id) await rm(lockPath, { force: true })
        }
      }
      let held: string
      try {
        held = await readFile(lockPath, 'utf8')
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') continue // 刚被释放
        throw err
      }
      if (!isStaleLock(held, this.opts.now(), IMPORT_LOCK_STALE_MS)) {
        await delay(IMPORT_LOCK_POLL_MS)
        continue
      }
      this.opts.log.warn(`[plastic-memory] 旧 KV 导入锁残留（持有进程已退出或超时），清理后重试：${lockPath}`)
      await breakStaleLock(lockPath, held)
    }
  }

  private async readMarker(path: string): Promise<KvImportMarker | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return undefined
      throw err
    }
    try {
      return kvImportMarkerSchema.parse(JSON.parse(text))
    } catch (err) {
      if (!this.markerWarned) this.opts.log.warn(`[plastic-memory] 导入标记损坏，按缺失处理、重新导入：${path}（${describeError(err)}）`)
      this.markerWarned = true
      return undefined
    }
  }

  /** 逐条排他创建；已存在不覆盖（中断后续传不会盖掉迁移后产生的新状态）。返回落成文件的条数。 */
  private async importTable<T extends { id: string }>(entries: Array<[string, unknown]>, dirName: string, schema: ZodType<T>): Promise<number> {
    const dir = join(this.opts.stateDir, dirName)
    await mkdir(dir, { recursive: true })
    let count = 0
    for (const [key, value] of entries) {
      if (!SAFE_KEY_RE.test(key)) {
        this.opts.log.warn(`[plastic-memory] 旧 KV 条目的键不能当文件名，跳过：${dirName}/${key}`)
        continue
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success || parsed.data.id !== key) {
        this.opts.log.warn(`[plastic-memory] 旧 KV 条目不合 schema，跳过：${dirName}/${key}`)
        continue
      }
      await createExclusive(join(dir, `${key}.json`), JSON.stringify(parsed.data))
      count++
    }
    return count
  }
}
