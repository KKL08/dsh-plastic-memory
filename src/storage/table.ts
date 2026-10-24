import type { MemoryRecord } from '../record-schema.ts'
import type { CodedNote, DirectoryNoteCode } from '../contract-codes.ts'

/** 纯逻辑层的日志注入口：接线层（index.ts）传入 ctx.logger，缺省回退 console，
 *  保证测试与独立使用场景仍有输出。file-table.ts / forget.ts 复用此形状，保持三层注入风格一致。 */
export interface MemoryLogger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/** 解析失败的文件：不抛，随本次读取返回（health / scan 据此出 malformed finding）。 */
export interface QuarantineEntry { path: string; error: string }

/** 目录级说明（info 级）：按文件或目录带路径返回，调用方按目录归层。 */
export interface DirectoryNote extends CodedNote<DirectoryNoteCode> {
  level: 'info'
  /** 涉及的文件或目录的绝对路径。 */
  path: string
  /** reserved-keys：被忽略的键。 */
  keys?: string[]
}

/** 一次按范围读取里的一条记录：带实际文件路径与所在目录，索引行与注入尾注用它，不再从 name 重算。 */
export interface LocatedRecord { record: MemoryRecord; filePath: string; dir: string }
/** 定位结果：比 LocatedRecord 多带 extras（未知 frontmatter 键，写回时保留）。 */
export interface LocatedFile extends LocatedRecord { extras: Record<string, unknown> }

/** 多词关键词的匹配模式：all = 全部词项命中，any = 任一词项命中。 */
export type KeywordMatch = 'all' | 'any'

export interface ScopeReadOptions {
  /**
   * 原文预筛词项；预筛是超集，不改变匹配结果。内存实现不预筛。
   * 调用方约束：每个词项应是「命中记录的原文（小写）里必然以子串出现」的小写串，否则预筛会漏掉真命中；
   * 不应包含单个字母与纯数字——它们几乎在每个文件里出现，any 模式下一个就让预筛失效。
   * 实现不替调用方过滤这两类（只小写并去掉空串），由调用方不传入保证。
   */
  prefilterTerms?: string[]
  /** 预筛模式：all（缺省）= 全部词项命中才解析；any = 任一词项命中即解析。与关键词匹配模式一致。 */
  prefilterMatch?: KeywordMatch
  /** 只要这些 type 的记录（解析后过滤）。 */
  types?: string[]
  /** 连同各目录的 .archive/ 一起读。 */
  includeArchive?: boolean
}

export interface ScopeReadResult {
  /** 记录含非 active，同 id 多文件不取舍（resolveDuplicates 由调用方按需做）；由调用方按 status 过滤。 */
  records: LocatedRecord[]
  /**
   * 列出文件数：范围内各目录顶层列出的记忆文件数。FileTable 数 readdir 列出、文件名是记忆文件的条目，
   * 含被预筛跳过的、随后解析失败进 quarantined 的、随后被 types 过滤或调用方按 status / validTo 滤掉的；
   * 不含 .archive/ 里的（includeArchive 为真也只数顶层）。InMemoryTable 数范围内顶层条目，同样不受 types 影响。
   * 用途是检索排序 BM25 的 N：它必须与预筛开关、types、后端无关，同一份磁盘内容才得出同一个排序。
   */
  listedCount: number
  quarantined: QuarantineEntry[]
  directoryNotes: DirectoryNote[]
}

export interface LocateHint {
  /** 当前 workspace：一级定位先看它的目录，取舍时它优先于 global 与其他项目。 */
  workspacePath?: string
}

export interface WorkspaceDirEntry {
  workspacePath: string
  /** 绝对目录路径。 */
  dir: string
  /** 顶层至少一个记忆文件（只看文件名，不解析）；体检清单取为真的，定位用全部。 */
  hasActiveTopLevel: boolean
}

export interface WorkspaceDirListing {
  entries: WorkspaceDirEntry[]
  /** 缺标记 / 不可读 / 空目录。 */
  directoryNotes: DirectoryNote[]
}

/**
 * 记忆表：磁盘是唯一真相，进程里不常驻记忆表（设计稿 §0 §3）。读方法不加锁、不写盘；写方法在实现内串行。
 * `dirs` 用绝对目录路径标识（global 用 global 目录）；InMemoryTable 用同一套目录名（storage/paths），语义是按 scope 过滤。
 * 执行器的读法只有三种：按范围 readScope、按 id locate、listWorkspaceDirs 枚举。
 */
export interface MemoryTable {
  /** global 目录的绝对路径。 */
  readonly globalDir: string
  /** 某个 workspace 的目录：确定性目录名的标记匹配就用它，否则经清单找（手工改名的目录）；还没有目录时为空。 */
  workspaceDirs(workspacePath: string): Promise<string[]>
  readScope(dirs: string[], opts?: ScopeReadOptions): Promise<ScopeReadResult>
  locate(id: string, hint?: LocateHint): Promise<LocatedFile | undefined>
  listWorkspaceDirs(): Promise<WorkspaceDirListing>
  /** 新 id：不定位，排他占名落盘（撞名追加 id 片段，不覆盖别的记录）。 */
  create(record: MemoryRecord): Promise<void>
  /** 锁内 locate（hint 缺省取 value 自己的 workspace；跨 scope 搬家时调用方传原记录的 workspace，定位到的才是要搬的那份）→ 写；
   *  scope / workspacePath 变化时搬家删旧；status 离开 active 时文件进 .archive/，回到 active 搬回顶层。
   *  skipIf：对锁内定位到的当前记录求值，为真就不写、返回 false（调用方锁外预读过的条件在这里按最新内容再判一次）。 */
  put(key: string, value: MemoryRecord, hint?: LocateHint, skipIf?: (current: MemoryRecord) => boolean): Promise<boolean>
  /** 锁内 locate（带 hint，同 id 多副本时与调用方读到的那份一致）→ fn(当前) → 写（同 put 的搬家与归档规则）；返回实际写出的记录（deleted 缺 deletedAt 时已补）。 */
  update(key: string, fn: (current: MemoryRecord) => MemoryRecord, hint?: LocateHint): Promise<MemoryRecord>
  /** 物理删除（含 .archive/ 里的文件）；hint 同 update。可见集合（global + 该记录目录）里同 id 的其余副本一并删除。 */
  delete(key: string, hint?: LocateHint): Promise<boolean>
  /**
   * 维护点（设计稿 §5）：只动给定目录，锁内、幂等。再生索引；顶层非 active 搬 .archive/（.archive/ 里 status 仍为 active
   * 的按位置归一成 deleted）；.archive/ 里 deletedAt 超保留期的物理删除；手建 / 手编文件回写；陈旧 tmp 清理。
   * 写路径末尾对被写的目录自动调用；快照冻结时由调用方对 global + 当前 workspace 调用。不删同 id 副本。
   */
  maintain(dirs: string[]): Promise<void>
}

/**
 * 同 id 多文件的取舍（ARCHITECTURE.md ⑥-6d）：updatedAt 新者 → 提示的 workspace 目录 → global → 其他项目 → 文件路径字典序。
 * 只在内存取舍，不动磁盘。返回每个 id 一份，保持首次出现的顺序。
 */
export function resolveDuplicates<T extends LocatedRecord>(candidates: readonly T[], hint?: LocateHint): T[] {
  const rank = (r: MemoryRecord) =>
    r.scope === 'workspace' && hint?.workspacePath !== undefined && r.workspacePath === hint.workspacePath ? 0
      : r.scope === 'global' ? 1 : 2
  const better = (a: T, b: T) =>
    a.record.updatedAt !== b.record.updatedAt ? a.record.updatedAt > b.record.updatedAt
      : rank(a.record) !== rank(b.record) ? rank(a.record) < rank(b.record)
        : a.filePath < b.filePath
  const byId = new Map<string, T>()
  for (const c of candidates) {
    const cur = byId.get(c.record.id)
    if (cur === undefined || better(c, cur)) byId.set(c.record.id, c)
  }
  return [...byId.values()]
}
