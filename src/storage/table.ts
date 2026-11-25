import { dirname } from 'node:path'
import type { MemoryRecord } from '../record-schema.ts'
import type { CodedNote, DirectoryNoteCode } from '../contract-codes.ts'
import { scopeOfMemory, type Scope } from '../scope.ts'
import type { VersionHistory } from './history.ts'
import type { IndexFiles } from '../topic-index.ts'
import type { IndexOp, IndexPlan } from '../topic-ops.ts'

/** 提交之后调用方要补做的一件事：kind 之外的内容由登记这一种的处理器解释，不含字段值和正文。 */
export type OpStep = { kind: string } & Record<string, unknown>

/**
 * 提交之后补做一步的处理器。record 是这次写下的那条（彻底删除、文件已不在时没有）；中断后补做时是文件此刻的内容，
 * isIntact 说它还是不是这次操作写下的原样：之后被手改、被旧版本改过的，按它算指纹会把别人的改动当成这次写的。要能重复执行。
 */
export type OpStepHandler = (step: OpStep, ctx: { op: string; record: MemoryRecord | undefined; isIntact: boolean }) => Promise<void>

/**
 * 一次写入的操作：id 写进记忆文件当提交标记（lastWriteOp），也是操作日志那一行的键。
 * 提交之后还有账要记的写入，调用方建一个带 steps 的传给写方法，写完调 finishOp 做掉这些步骤；
 * 中途被打断，下一个拿到写锁的人按日志补做（FileTable.recoverPending）。不传时表自己建一个、写完自己结。
 * 一个操作只对应一次文件写入。
 */
export interface WriteOp {
  readonly id: string
  /** 谁发起的（前台主会话、子 agent、界面……）。 */
  readonly initiator?: string
  /** 同一批操作共用的批次 id。 */
  readonly batch?: string
  /** 提交之后要补做的事，不含字段值和正文。 */
  readonly steps: readonly OpStep[]
  /** 这次写入之后这条记忆在主题索引里归到哪：随文件表自己的索引行步骤记进操作日志，补做时按那时的索引解析。不给按缺省规则放。 */
  readonly topic?: TopicIntent
}

/**
 * 写入时对主题归属的要求（文件表的索引行步骤按它放这条记忆的行）。
 *  - choose：模型保存时给的主题。name、about 是调用方遮过密钥的原文（about 只在新建主题时用）；maxTopics 是写入那一刻的主题数上限，
 *    补做时照用它。按当下的索引解析：现有主题（名字或曾用名，keyOf 判同）就插到那一页最前；没有就新建；到上限、名字不能用就按缺省规则放。
 *  - carry：换作用域时带上原来的主题：目标作用域里有同名主题（含曾用名）就放进去，没有按缺省规则放；不新建主题。
 * 缺省规则：已经有行的留在原处、同步行里的文字；还没有行的放进「未整理」最前。
 */
export type TopicIntent =
  | { kind: 'choose'; name: string; about?: string; maxTopics: number }
  | { kind: 'carry' }

export function newWriteOp(init: { initiator?: string; batch?: string; steps?: readonly OpStep[]; topic?: TopicIntent } = {}): WriteOp {
  return {
    id: `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    ...(init.initiator !== undefined ? { initiator: init.initiator } : {}),
    ...(init.batch !== undefined ? { batch: init.batch } : {}),
    steps: init.steps ?? [],
    ...(init.topic !== undefined ? { topic: init.topic } : {}),
  }
}

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
  /** duplicate-id：读取时用的那份（path 是没用上的副本）。 */
  keptPath?: string
}

/** 一次按范围读取里的一条记录：带实际文件路径与所在目录，索引行与注入尾注用它，不再从 name 重算。 */
export interface LocatedRecord { record: MemoryRecord; filePath: string; dir: string }
/** 定位结果：比 LocatedRecord 多带 extras（未知 frontmatter 键，写回时保留）。 */
export interface LocatedFile extends LocatedRecord {
  extras: Record<string, unknown>
  /** 文件里的提交标记（最近一次写它的操作 id）。记录里不带它：每次写入都变，不算内容。 */
  writeOp?: string
}

/** 位置即作用域（同 readRaw）：.archive/ 里 status 仍写着 active 的按 deleted 看。 */
export function byPosition(found: LocatedFile): MemoryRecord {
  return found.record.status === 'active' && dirname(found.filePath) !== found.dir ? { ...found.record, status: 'deleted' } : found.record
}

/** 记忆之间的三种显式链接：决定依据的前提（premises）、相关（related）、取代（supersedes）。派生库和反向查询共用这一份取值。 */
export const LINK_KINDS = ['premise', 'related', 'supersedes'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

/** 一条记忆指出去的一条链接；前提带当时的内容摘要。 */
export interface OutgoingLink { kind: LinkKind; targetId: string; digest?: string }

/** 指向某条记忆的一条链接：谁指过来、哪一种；前提带当时的内容摘要。 */
export interface LinkRef { sourceId: string; kind: LinkKind; digest?: string }

/** 一条记忆指出去的全部链接，按前提、相关、取代的顺序，各自保持文件里的先后、去重。 */
export function outgoingLinks(record: Pick<MemoryRecord, 'premises' | 'related' | 'supersedes'>): OutgoingLink[] {
  const out: OutgoingLink[] = []
  const seen = new Set<string>()
  const add = (link: OutgoingLink) => {
    const key = `${link.kind}\u0000${link.targetId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(link)
  }
  for (const p of record.premises ?? []) add({ kind: 'premise', targetId: p.id, digest: p.digest })
  for (const id of record.related ?? []) add({ kind: 'related', targetId: id })
  for (const id of record.supersedes ?? []) add({ kind: 'supersedes', targetId: id })
  return out
}

/**
 * 反向查询的结果：查到的链接，以及查得全不全。目录读不了、文件读不出、派生库没核对过某一层时 isComplete 为假，
 * refs 只是读到的那部分：据此做「没被引用」这类判断的调用方要按被引用处理。
 */
export interface LinkQuery { refs: LinkRef[]; isComplete: boolean }

/**
 * 反向查询的结果排好序、同一来源同一种同一摘要只留一条（同 id 的几份副本都指过来、记的又是同一版时）。
 * 摘要不同的都留着：同 id 的两份决定各引了这条记忆的不同版本，两版都算被引用。
 */
export function sortLinkRefs(refs: readonly LinkRef[]): LinkRef[] {
  const byKey = new Map<string, LinkRef>()
  for (const ref of refs) {
    const key = `${ref.sourceId}\u0000${ref.kind}\u0000${ref.digest ?? ''}`
    if (!byKey.has(key)) byKey.set(key, ref)
  }
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...byKey.values()].sort((a, b) => byText(a.sourceId, b.sourceId) || LINK_KINDS.indexOf(a.kind) - LINK_KINDS.indexOf(b.kind) || byText(a.digest ?? '', b.digest ?? ''))
}

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
   * 不含 .archive/ 里的（includeArchive 为真也只数顶层）。伴生文件形态的名字（paths.isCompanionLikeFileName）例外：不走预筛、
   * 一律解析，解析成合法记忆才数，解析不出的不数。测试用的内存表数范围内顶层条目，同样不受 types 影响。
   * 用途是检索排序 BM25 的 N：它必须与预筛开关、types、后端无关，同一份磁盘内容才得出同一个排序。
   */
  listedCount: number
  quarantined: QuarantineEntry[]
  directoryNotes: DirectoryNote[]
}

/** 会话视角的定位：当前项目（没解析出项目时缺省）。先看全局与当前项目的目录，都没有才扫其他项目；取舍规则见 pickLiveFirst。 */
export interface SessionTarget {
  /** 不带 kind：带了就是 Scope。把作用域写法里可能为空的 workspacePath 挡在类型检查上，而不是在运行时当成会话视角。 */
  kind?: never
  workspacePath?: string | undefined
}

/**
 * 按 id 操作的目标。给 Scope 只认这一份：只看那一个作用域，写与删只清那一个作用域里的同 id 副本（GUI 按页面上那一份操作）。
 * 给 SessionTarget 按会话定位：写清全局加写入目标作用域里的副本，删清全局加定位到的那份所在作用域里的；其他项目的副本都不动。
 */
export type LocateTarget = Scope | SessionTarget

export interface LocateOptions {
  /** 没找到时一律到写锁内再找一次才算没有（据此做不可逆决定的调用方用，也挡住别的进程正在挪的文件）。
   *  不给时只在锁外扫描期间本进程有写入在跑时才进锁确认，只读入口照旧不碰锁库。 */
  isMissRechecked?: boolean
}

export function isScopeTarget(target: LocateTarget): target is Scope {
  return target.kind !== undefined
}

export interface WorkspaceDirEntry {
  workspacePath: string
  /** 绝对目录路径。 */
  dir: string
  /** 顶层至少一个记忆文件（只看文件名，不解析；伴生文件形态的名字解析成合法记忆才算）；体检清单取为真的，定位用全部。 */
  hasActiveTopLevel: boolean
}

export interface WorkspaceDirListing {
  entries: WorkspaceDirEntry[]
  /** 缺标记 / 不可读 / 空目录。 */
  directoryNotes: DirectoryNote[]
  /**
   * 标记读得到、记忆目录列不出文件的项目目录（同时有一条 dir-unreadable 说明）：顶层有没有记忆不知道，不进 entries；
   * 体检把它们算进清单、按没读全查（见 tools/scope-preread.ts checkupScanWorkspaces）。缺省没有。
   */
  unreadable?: Array<{ workspacePath: string; dir: string }>
}

/**
 * 记忆表：磁盘是唯一真相，进程里不常驻记忆表。读方法不写盘、不加锁（按 id 的定位没找到时、copiesOf 例外，见各自说明）；写方法在实现内串行。
 * `dirs` 用绝对目录路径标识（global 用 global 目录）；测试用的内存表用同一套目录名（storage/paths），语义是按 scope 过滤。
 * 执行器的读法只有三种：按范围 readScope、按 id locate、listWorkspaceDirs 枚举。
 */
export interface MemoryTable {
  /** global 目录的绝对路径。 */
  readonly globalDir: string
  /** 历史版本（状态变化前的整条记录）：和记忆文件放在同一层，不进记忆表。读写在调用方的写入段里做。 */
  readonly history: VersionHistory
  /** 某个 workspace 的目录：确定性目录名的标记匹配就用它，否则经清单找（手工改名的目录）；还没有目录时为空。
   *  经清单找时，清单里读不出的目录（记忆根、标记读不出的目录）带回 dir-unreadable 说明：这个项目的记忆可能就在里面。 */
  workspaceDirs(workspacePath: string): Promise<{ dirs: string[]; directoryNotes: DirectoryNote[] }>
  readScope(dirs: string[], opts?: ScopeReadOptions): Promise<ScopeReadResult>
  /** 按 id 定位。别的写入正在挪这个文件时锁外扫描可能新旧两处都看不到：实现在这种情况下到写锁内再确认，见 LocateOptions。 */
  locate(id: string, target: LocateTarget, opts?: LocateOptions): Promise<LocatedFile | undefined>
  listWorkspaceDirs(): Promise<WorkspaceDirListing>
  /** 新 id：不定位，排他占名落盘（撞名追加 id 片段，不覆盖别的记录）。 */
  create(record: MemoryRecord, op?: WriteOp): Promise<void>
  /** 锁内 locate（from 是现有那份所在的目标；跨 scope 搬家时调用方传原记录的作用域，定位到的才是要搬的那份；写到哪里由 value 自己的作用域决定）→ 写；
   *  scope / workspacePath 变化时搬家删旧；status 离开 active 时文件进 .archive/，回到 active 搬回顶层。清副本见 LocateTarget。
   *  skipIf：对锁内定位到的当前记录求值（按位置看，同 byPosition；定位不到时传 undefined），为真就不写、返回 undefined
   *  （调用方锁外预读过的条件在这里按最新内容再判一次）。返回实际写出的记录（召回统计取现有那份的，deleted 缺 deletedAt 时已补）。 */
  put(value: MemoryRecord, from: LocateTarget, skipIf?: (current: MemoryRecord | undefined) => boolean, op?: WriteOp): Promise<MemoryRecord | undefined>
  /** 锁内 locate（同 id 多副本时与调用方读到的那份一致）→ fn(当前) → 写（同 put 的搬家、归档与清副本规则）；返回实际写出的记录（deleted 缺 deletedAt 时已补）。 */
  update(id: string, from: LocateTarget, fn: (current: MemoryRecord) => MemoryRecord, op?: WriteOp): Promise<MemoryRecord>
  /** 物理删除（含 .archive/ 里的文件）；at 同 update，清副本见 LocateTarget。
   *  召回统计行只在哪个作用域都没有这个 id 了才清。skipIf：对锁内定位到的当前文件求值，为真就不删、返回 false。 */
  delete(id: string, at: LocateTarget, skipIf?: (current: LocatedFile) => boolean, op?: WriteOp, opts?: { /** 带去向的记忆：历史先并到去向那条名下再删（最近删除里的彻底删除）。密钥硬删不给。 */ isHistoryCarried?: boolean }): Promise<boolean>
  /** 这个 id 在哪些作用域有副本（任何状态，含只在 .archive/ 里的）：全局在前，项目按路径排序，同一作用域只算一次。在写锁内扫（理由同 locate）。 */
  copiesOf(id: string): Promise<Scope[]>
  /**
   * 维护点（写路径末尾与快照冻结时调用）：只动给定目录，锁内、幂等。再生索引；顶层非 active 搬 .archive/（.archive/ 里 status 仍为 active
   * 的按位置归一成 deleted）；.archive/ 里 deletedAt 超保留期的物理删除；手建 / 手编文件回写；陈旧 tmp 清理。
   * 写路径末尾对被写的目录自动调用；快照冻结时由调用方对 global + 当前 workspace 调用。不删同 id 副本。
   */
  maintain(dirs: string[]): Promise<void>
  /**
   * 在写入段里执行 fn：一条记忆的一次改动（快照、记忆文件、账本）都在这一段里，段内的读写是再进、不另排队。
   * 没有写锁的实现（内存表）直接执行。
   */
  inSection?<T>(fn: () => Promise<T>): Promise<T>
  /**
   * 调用方传进写方法的操作做完了：written 是那次写方法的返回值（彻底删除不传），提交后的步骤按它做，再结掉日志行。
   * 那次写方法没落盘（skipIf 判中、内容没变）时不用调。没有操作日志的实现（内存表）可以不提供。
   */
  finishOp?(op: WriteOp, written?: MemoryRecord): Promise<void>
  /** 这个作用域里由 opId 那次写入写下的那一份（看文件上的提交标记，含 .archive/ 里的）。软删写完新文件、旧文件还没删时，按 id 定位会挑到旧的那份。 */
  locateWrittenBy?(id: string, target: Scope, opId: string): Promise<LocatedFile | undefined>
  /** 登记提交后某一种步骤的处理器：正常写完和中断后补做走同一个。重复登记以后一次为准。 */
  registerStep?(kind: string, handler: OpStepHandler): void
  /** 一个记忆目录的主题索引文件，masked 为真时遮盖手写文字中的密钥；还没有索引时为空。没有主题索引的实现可以不提供下面三个。 */
  readIndex?(dir: string, masked?: boolean): Promise<IndexFiles | undefined>
  /** 对一个记忆目录的主题索引做一个操作：写入段里按当下的索引和记忆重新核对，对不上的跳过。 */
  applyIndexOp?(dir: string, op: IndexOp, opts: IndexOpOptions): Promise<IndexOpOutcome>
  /** 撤销一个做过的索引操作：这一步写下的效果还在才撤，不在了返回 stale、什么都不动。 */
  undoIndexPlan?(dir: string, plan: IndexPlan, opts?: { steps?: (op: string) => readonly OpStep[] }): Promise<IndexUndoOutcome>
  /** 这个操作是不是提交了、还有步骤等着补做。 */
  isOpPending?(op: string): boolean
  /** 操作日志里还等着补做的步骤有没有一个对得上 match。 */
  hasPendingStep?(match: (step: OpStep) => boolean): boolean
  /**
   * 带着 op 的那次写入里，文件表自己的 kind 那一步当场没做成（留给下一次进写入段补做）。按这一步自己的结果判，
   * 不看整条日志行；没有操作日志时同样记得。调用方在写入返回之后、finishOp 之前问；finishOp 之后不再记得。
   */
  hasUnfinishedOwnStep?(op: string, kind: string): boolean
  /**
   * 这几个记忆目录（各含 .archive/）里指向 id 的链接，按 sortLinkRefs 排好。有派生库的实现先按文件签名核对、以文件为准，
   * 手改了还没整份核对的也查得到；代价是逐层列目录、逐个文件取签名。不提供时由调用方逐个读目录算（结果相同）。
   */
  linksTo?(id: string, dirs: readonly string[]): Promise<LinkQuery>
  /**
   * 只按派生库的目标索引查：不列目录、不取文件签名，写锁内要快的判断用它。库里有的是插件自己写入时记下的和上次整份核对读到的，
   * 之后手改文件加的要到下次整份核对才算进来。哪一层没核对过、库这一次用不了时，退回 linksTo 或报不完整。不提供时调用方用 linksTo。
   */
  indexedLinksTo?(id: string, dirs: readonly string[]): Promise<LinkQuery>
}

export type IndexOpOutcome =
  /** 做了：op 是这次操作的 id，plan 是做下去的计划（带撤销要用的改前数据，手写的文字已经遮过密钥）。 */
  | { kind: 'applied'; op: string; plan: IndexPlan }
  | { kind: 'skipped'; reason: string }
export type IndexUndoOutcome = { kind: 'undone'; op: string } | { kind: 'stale'; reason: string }
export interface IndexOpOptions {
  /** 主题数上限。 */
  maxTopics: number
  /**
   * 写第一个文件之前调一次（在写入段里）：op 是这次操作的 id，plan 带着撤销要用的改前数据。调用方在这里把回执先记下，
   * 返回提交之后要做的步骤（确认回执之类）。步骤进操作日志，里面只放 id，不放 plan。索引文件正被别处改、要重来时会再调一次（换新的 id）。
   */
  prepare?: (op: string, plan: IndexPlan) => Promise<readonly OpStep[]>
}

/**
 * 同 id 多文件的取舍：updatedAt 新者 → 会话的当前项目目录 → global → 其他项目 → 文件路径字典序。
 * 只在内存取舍，不动磁盘。返回每个 id 一份，保持首次出现的顺序。
 */
export function resolveDuplicates<T extends LocatedRecord>(candidates: readonly T[], session?: SessionTarget): T[] {
  const rank = (r: MemoryRecord) =>
    r.scope === 'workspace' && session?.workspacePath !== undefined && r.workspacePath === session.workspacePath ? 0
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

/**
 * 读路径的同 id 取舍：先在 active 副本里按 resolveDuplicates 取一份，没有 active 副本的 id 才从其余副本里取。
 * 已删、已取代的副本（比如同 id 在 global 与项目各一份、删了其中一份）不遮住别处仍在用的那份。返回顺序同 resolveDuplicates。
 */
export function resolveLiveFirst<T extends LocatedRecord>(candidates: readonly T[], session?: SessionTarget): T[] {
  const live = resolveDuplicates(candidates.filter(c => c.record.status === 'active'), session)
  const liveIds = new Set(live.map(c => c.record.id))
  const chosen = new Map([...live, ...resolveDuplicates(candidates.filter(c => !liveIds.has(c.record.id)), session)].map(c => [c.record.id, c]))
  return [...new Set(candidates.map(c => c.record.id))].map(id => chosen.get(id)!)
}

/**
 * 按 id 定位的同 id 取舍（copies 是同一个 id 的全部候选）：规则同 resolveLiveFirst，先在在用副本里取一份，没有才从其余副本里取。
 * 位置即作用域：.archive/ 里 status 仍写着 active 的不算在用。
 */
export function pickLiveFirst<T extends LocatedRecord>(copies: readonly T[], session?: SessionTarget): T | undefined {
  const live = copies.filter(c => c.record.status === 'active' && dirname(c.filePath) === c.dir)
  return resolveDuplicates(live.length > 0 ? live : copies, session)[0]
}

/** copiesOf 的共用收尾：同一个 id 的各份记录（作用域按位置）→ 去重后的作用域，全局在前、项目按路径排序。 */
export function scopesOf(copies: readonly MemoryRecord[]): Scope[] {
  let hasGlobal = false
  const workspaces = new Set<string>()
  for (const copy of copies) {
    const scope = scopeOfMemory(copy)
    if (scope?.kind === 'global') hasGlobal = true
    else if (scope !== undefined) workspaces.add(scope.workspacePath)
  }
  return [...(hasGlobal ? [{ kind: 'global' } as const] : []), ...[...workspaces].sort().map(workspacePath => ({ kind: 'workspace' as const, workspacePath }))]
}
