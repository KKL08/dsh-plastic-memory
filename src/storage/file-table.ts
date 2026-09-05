import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { RecordNotFoundError } from '../errors.ts'
import { join } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import type { MemoryTable, MemoryLogger } from '../store.ts'
import type { KvTable } from '../kv-table.ts'
import type { RecallStats } from './schema.ts'
import { splitFrontmatter, decodeRecord, encodeRecord, type FileLocation } from './frontmatter.ts'
import { WORKSPACE_MARKER, INDEX_FILE, GLOBAL_DIR, workspaceDirName, slugifyName, isReservedFileName } from './paths.ts'
import { formatIndexLine } from '../index-line.ts'
import { RETENTION_MS } from '../retention.ts'

/** 软删记录清扫窗口：与快照保留共用 retention.ts 的单一来源（两者必须一致）。 */
export const DELETED_RETENTION_MS = RETENTION_MS

/** tmp 残留清理的陈旧阈值：写入-rename 窗口是毫秒级，60 秒足够排除任何在途文件。 */
const TMP_STALE_MS = 60_000

/** 原子写临时文件的完整后缀（与 atomicWrite 生成规则一致，锚定结尾）。合法记忆名可以含 ".tmp-"
 *  子串（如 cache.tmp-notes.md），只看子串会把正式 .md 当残留删掉；正式文件永远以 .md 结尾。 */
const TMP_SUFFIX_RE = /\.tmp-(\d+)-[a-z0-9]+$/


export interface FileTableOptions {
  root: string
  stats: KvTable<RecallStats>
  /** 索引行格式器由接线层注入（storage 层不依赖 registry）；缺省用无陈旧度的简版。 */
  formatIndexLine?: (r: MemoryRecord) => string
  now?: () => number
  /** 日志注入口，缺省回退 console（见 store.ts MemoryLogger）。 */
  log?: MemoryLogger
}

interface Slot { record: MemoryRecord; extras: Record<string, unknown>; filePath: string; dir: string }

export class FileTable implements MemoryTable {
  private map = new Map<string, Slot>()
  private quarantine: { path: string; error: string }[] = []
  private wsDirs = new Map<string, string>()   // workspacePath -> 绝对目录
  private fingerprint = ''
  private chain: Promise<unknown> = Promise.resolve()  // 进程内互斥：写与重载串行化
  private readonly log: MemoryLogger
  private opts: FileTableOptions

  constructor(opts: FileTableOptions) {
    this.opts = opts
    this.log = opts.log ?? console
  }

  /** 互斥执行：所有写路径与重载都经过这里串行。 */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  private now() { return this.opts.now?.() ?? Date.now() }

  quarantined(): readonly { path: string; error: string }[] { return this.quarantine }

  /** 绝不 throw：任何失败都降级（隔离/警告），插件加载不能因记忆坏文件而失败。 */
  async load(): Promise<void> {
    await this.locked(() => this.loadInner()).catch(err => {
      ;this.log.warn('[plastic-memory] 记忆目录加载失败，按空库继续：', err)
    })
  }

  /**
   * build-then-swap：所有可能失败的 I/O 先在局部变量里跑完，只有全部成功后才在末尾
   * 一次性 swap 到 this.map/this.quarantine/this.wsDirs。任何一步中途抛出，this.* 保持
   * 调用前的旧状态不变——这样 refreshIfChanged 的 catch 里"沿用内存态"才是真的。
   */
  private async loadInner(): Promise<void> {
    const map = new Map<string, Slot>()
    const quarantine: { path: string; error: string }[] = []
    const wsDirs = new Map<string, string>()
    await mkdir(join(this.opts.root, GLOBAL_DIR), { recursive: true })
    const dirs: Array<{ dir: string; loc: FileLocation }> = [
      { dir: join(this.opts.root, GLOBAL_DIR), loc: { scope: 'global' } },
    ]
    for (const entry of await readdir(this.opts.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === GLOBAL_DIR) continue
      const dir = join(this.opts.root, entry.name)
      try {
        const wsPath = (await readFile(join(dir, WORKSPACE_MARKER), 'utf8')).trim()
        if (!wsPath) throw new Error('空 .workspace')
        wsDirs.set(wsPath, dir)
        dirs.push({ dir, loc: { scope: 'workspace', workspacePath: wsPath } })
      } catch (err) {
        ;this.log.warn(`[plastic-memory] workspace 目录缺失有效 .workspace 标记，跳过：${dir}`, err)
      }
    }
    for (const { dir, loc } of dirs) {
      let names: string[]
      try { names = await readdir(dir) } catch { this.log.warn(`[plastic-memory] 目录不可读，计空：${dir}`); continue }
      for (const name of names) {
        const tmpMatch = TMP_SUFFIX_RE.exec(name)
        if (tmpMatch) {
          // 只删两类原子写残留：① pid 段是本进程（自家崩溃）② mtime 超 60 秒的陈旧文件。
          // 多进程共用 memoryRoot 时，别的进程在途 tmp（毫秒级窗口）绝不能碰，否则会让对方
          // rename 落空。stat 失败＝竞态已消失，静默跳过。
          const path = join(dir, name)
          if (Number(tmpMatch[1]) === process.pid) {
            await rm(path, { force: true })
          } else {
            try {
              if (this.now() - (await stat(path)).mtimeMs > TMP_STALE_MS) await rm(path, { force: true })
            } catch { /* 竞态消失 */ }
          }
          continue
        }
        if (!name.endsWith('.md') || name === INDEX_FILE) continue
        const filePath = join(dir, name)
        try {
          const raw = await readFile(filePath, 'utf8')
          const { record, extras } = decodeRecord(splitFrontmatter(raw), loc)
          const existing = map.get(record.id)
          if (existing) {
            // 崩溃窗口兜底：同 id 两处取新删旧（scope 移动中断的产物）
            const keepNew = record.updatedAt >= existing.record.updatedAt
            const loser = keepNew ? existing.filePath : filePath
            ;this.log.warn(`[plastic-memory] 发现重复 id ${record.id}，保留较新者，删除：${loser}`)
            await rm(loser, { force: true })
            if (!keepNew) continue
          }
          map.set(record.id, { record, extras, filePath, dir })
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          ;this.log.warn(`[plastic-memory] 记忆文件解析失败，已隔离：${filePath}（${error}）`)
          quarantine.push({ path: filePath, error })
        }
      }
    }
    // sidecar 合并（无行 → decode 已注入默认）
    for (const slot of map.values()) {
      const row = this.opts.stats.get(slot.record.id)
      if (row) slot.record = { ...slot.record, recallCount: row.recallCount, lastRecalledAt: row.lastRecalledAt }
    }
    await this.sweepDeletedInner(map)
    await this.regenerateIndexes(map, wsDirs)
    const fingerprint = await this.computeFingerprint()
    this.map = map; this.quarantine = quarantine; this.wsDirs = wsDirs; this.fingerprint = fingerprint
  }

  /** per-file 指纹：目录 mtime 抓不到就地编辑（sed -i/追加写）。 */
  private async computeFingerprint(): Promise<string> {
    const parts: string[] = []
    let dirNames: string[] = []
    try { dirNames = await readdir(this.opts.root) } catch { return '' }
    for (const d of dirNames.sort()) {
      const dir = join(this.opts.root, d)
      let names: string[] = []
      try { names = (await readdir(dir)).filter(n => n.endsWith('.md') && n !== INDEX_FILE) } catch { continue }
      for (const n of names.sort()) {
        try { const s = await stat(join(dir, n)); parts.push(`${d}/${n}:${s.mtimeMs}:${s.size}`) } catch { /* 竞态删除 */ }
      }
    }
    return parts.join('|')
  }

  async refreshIfChanged(): Promise<void> {
    await this.locked(async () => {
      // 无条件扫描：触发面只有记忆工具（低频），实测热缓存千条级 <10ms，不值得节流——
      // 无条件的入口校准让"外部编辑不被旧态覆盖"成为无注记的硬保证。
      const fp = await this.computeFingerprint()
      if (fp !== this.fingerprint) await this.loadInner()
    // 指纹不同 → 触发 loadInner；loadInner 内部是 build-then-swap，中途失败不会碰
    // this.map/this.quarantine/this.wsDirs，所以"沿用内存态"在这里是真实成立的。
    }).catch(err => this.log.warn('[plastic-memory] 记忆重载失败，沿用内存态：', err))
  }

  private async sweepDeletedInner(map: Map<string, Slot>): Promise<void> {
    const cutoff = this.now() - DELETED_RETENTION_MS
    for (const [id, slot] of [...map]) {
      if (slot.record.status === 'deleted' && slot.record.updatedAt < cutoff) {
        await rm(slot.filePath, { force: true })
        await this.opts.stats.delete(id)
        map.delete(id)
      }
    }
  }

  private async regenerateIndexes(map: Map<string, Slot>, wsDirs: Map<string, string>, onlyDirs?: Iterable<string>): Promise<void> {
    const byDir = new Map<string, MemoryRecord[]>()
    for (const slot of map.values()) {
      if (slot.record.status !== 'active') continue // 索引只列 active
      const list = byDir.get(slot.dir) ?? []
      list.push(slot.record); byDir.set(slot.dir, list)
    }
    // 缺省格式器与注入侧同源（src/index-line.ts）。磁盘索引不带陈旧度：静态文件里的
    // 时间相对标注会随时间失真——这是对 docs/p15-storage-search-redesign.md §6"同源同格式"的有意偏离，已回写设计稿登记。
    const fmt = this.opts.formatIndexLine ?? ((r: MemoryRecord) => formatIndexLine(r, { passive: false }))
    // onlyDirs 给出时只再生这几个目录（byDir 仍取自全量 map，分组正确）；写路径只动到自己的目录，
    // 全量再生纯属浪费。缺省（加载路径）仍再生所有目录。
    const targetDirs = onlyDirs ?? new Set<string>([join(this.opts.root, GLOBAL_DIR), ...wsDirs.values()])
    for (const dir of targetDirs) {
      // 索引行序必须确定：Map 插入序取决于 readdir 序，跨设备不确定，多设备同步下会造成
      // 索引文件 churn。按 name 排序（不用 localeCompare——locale 依赖环境），name 相同用 id 决胜。
      const records = (byDir.get(dir) ?? []).slice().sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      const lines = records.map(fmt)
      const text = `# Memory Index\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`
      try {
        const prev = await readFile(join(dir, INDEX_FILE), 'utf8').catch(() => '')
        if (prev !== text) await this.atomicWrite(join(dir, INDEX_FILE), text) // 内容不变不写：refresh 触发的重载不得空转写盘
      } catch { /* 索引是生成物，失败不致命 */ }
    }
  }

  protected async atomicWrite(filePath: string, text: string): Promise<void> {
    const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, filePath)
  }

  get(key: string): MemoryRecord | undefined { return this.map.get(key)?.record }
  entries(): IterableIterator<[string, MemoryRecord]> {
    return [...this.map.entries()].map(([k, s]) => [k, s.record] as [string, MemoryRecord]).values()
  }

  // —— 写侧 ——

  private volatileEqual(a: MemoryRecord, b: MemoryRecord): boolean {
    return a.recallCount === b.recallCount && a.lastRecalledAt === b.lastRecalledAt
  }
  /** 非易变投影相等性（含 scope/workspacePath——不等即触发移动）。字段有限且纯数据，JSON 比较足够——
   * 前提是键序稳定：写路径都经 zod 归一或 spread 保序，若引入键序不定的构造需改深比较。 */
  private stableEqual(a: MemoryRecord, b: MemoryRecord): boolean {
    const proj = (r: MemoryRecord) => { const { recallCount, lastRecalledAt, ...rest } = r; return rest }
    return JSON.stringify(proj(a)) === JSON.stringify(proj(b))
  }

  private async dirFor(record: MemoryRecord): Promise<string> {
    if (record.scope === 'global') return join(this.opts.root, GLOBAL_DIR)
    const wsPath = record.workspacePath!
    let dir = this.wsDirs.get(wsPath)
    if (!dir) {
      dir = join(this.opts.root, workspaceDirName(wsPath))
      await mkdir(dir, { recursive: true })
      await this.atomicWrite(join(dir, WORKSPACE_MARKER), wsPath + '\n')
      this.wsDirs.set(wsPath, dir)
    }
    return dir
  }

  /** 盘上已有文件的 frontmatter id。null=不存在（可写）；'unreadable'=读不出 id（一律视为占用）。 */
  private async readIdOnDisk(path: string): Promise<string | null> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      return 'unreadable'
    }
    const frontmatter = text.startsWith('---\n') ? text.slice(4).split('\n---')[0] ?? '' : ''
    const m = /^id:\s*(\S+)\s*$/m.exec(frontmatter)
    return m ? m[1] : 'unreadable'
  }

  /**
   * 撞名检查必须同时看内存态和磁盘：this.map 看不到隔离文件、也看不到 .workspace 标记
   * 缺失而整目录跳过的文件——只查 map 会把用户手写/隔离中的内容静默覆盖（实测复现过）。
   */
  private async filePathFor(record: MemoryRecord, dir: string): Promise<string> {
    const base = slugifyName(record.name)
    const idFrag = record.id.slice(-6)
    // 依次尝试：基础名 → id 片段名 → 全 id 名（全 id 全局唯一，兜底必然可用）
    for (const name of [`${base}.md`, `${base}-${idFrag}.md`]) {
      if (isReservedFileName(name)) continue // memory.md ≈ MEMORY.md，索引再生会覆盖它
      const path = join(dir, name)
      const takenInMap = [...this.map.values()].some(slot => slot.filePath === path && slot.record.id !== record.id)
      if (takenInMap) continue
      const onDisk = await this.readIdOnDisk(path)
      if (onDisk !== null && onDisk !== record.id) continue
      return path
    }
    return join(dir, `${base}-${record.id}.md`)
  }

  private async persist(key: string, next: MemoryRecord): Promise<void> {
    const prev = this.map.get(key)
    const volatileChanged = !prev || !this.volatileEqual(prev.record, next)
    const stableChanged = !prev || !this.stableEqual(prev.record, next)
    let slot: Slot
    if (stableChanged) {
      const dir = await this.dirFor(next)
      const moved = prev !== undefined && prev.dir !== dir
      // 改名后文件名要跟着变，否则磁盘文件仍叫旧 slug，用户浏览/grep 被误导。比较 slug 而非
      // name（空白等变化不折腾文件），且忽略大小写：APFS 等大小写不敏感文件系统上，仅大小写
      // 不同的新旧路径是同一个文件——若触发重命名，"先写新后删旧"会把刚写的文件删掉，丢数据。
      const renamed = prev !== undefined
        && slugifyName(next.name).toLowerCase() !== slugifyName(prev.record.name).toLowerCase()
      const filePath = moved || renamed || !prev ? await this.filePathFor(next, dir) : prev.filePath
      const extras = prev?.extras ?? {}
      await this.atomicWrite(filePath, encodeRecord(next, extras))   // 易变字段由 encodeRecord 剔除
      // 先写新后删旧；崩溃窗口由加载去重兜底。filePathFor 撞名回退可能落回原路径，故加
      // prev.filePath !== filePath 保护，不能删掉刚写的自己。
      if ((moved || renamed) && prev!.filePath !== filePath) await rm(prev!.filePath, { force: true })
      slot = { record: next, extras, filePath, dir }
      this.map.set(key, slot)
      // status 变为 deleted 时顺手清扫（"forget 工具路径顺手做"的落点）
      if (next.status === 'deleted') await this.sweepDeletedInner(this.map)
      await this.regenerateIndexes(this.map, this.wsDirs, moved ? [dir, prev!.dir] : [dir])
    } else {
      slot = { ...prev!, record: next }
      this.map.set(key, slot)
    }
    if (volatileChanged) {
      await this.opts.stats.put(key, { id: key, recallCount: next.recallCount, lastRecalledAt: next.lastRecalledAt })
    }
    if (stableChanged) this.fingerprint = await this.computeFingerprint() // 自写后刷新基线，防假重载
  }

  async put(key: string, value: MemoryRecord): Promise<void> {
    await this.locked(() => {
      // put 不承载召回统计（docs/p15-storage-search-redesign.md §3 登记：快照恢复不恢复召回统计）。唯一写入方是
      // markRecalled 走的 update 路径；prev 在时以内存态现值为准，restore 旧记录不回退 sidecar。
      const prev = this.map.get(key)
      const next = prev
        ? { ...value, recallCount: prev.record.recallCount, lastRecalledAt: prev.record.lastRecalledAt }
        : value
      return this.persist(key, next)
    })
  }

  async update(key: string, fn: (current: MemoryRecord) => MemoryRecord): Promise<MemoryRecord> {
    return this.locked(async () => {
      const current = this.map.get(key)
      if (!current) throw new RecordNotFoundError(key)
      const next = fn(current.record)
      await this.persist(key, next)
      return next
    })
  }

  async delete(key: string): Promise<boolean> {
    return this.locked(async () => {
      const slot = this.map.get(key)
      if (!slot) return false
      await rm(slot.filePath, { force: true })
      await this.opts.stats.delete(key)
      this.map.delete(key)
      await this.regenerateIndexes(this.map, this.wsDirs, [slot.dir])
      this.fingerprint = await this.computeFingerprint()
      return true
    })
  }
}
