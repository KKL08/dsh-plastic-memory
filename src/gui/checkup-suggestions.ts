import type { MemoryLogger, MemoryStore } from '../store.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { hasCriticalSecret } from '../secrets.ts'
import { sameScope, scopeAt, type Scope } from '../scope.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import { isModelUnavailableCode } from '../governance/host-llm.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import { baselineBasisOf, isBaselineCurrent, isBasisCurrent, suggestionBasis, type BaselineBasis, type PendingDecisionsStore } from '../governance/decisions.ts'
import { baselineFor, cacheInstructions, type ReadInstructions } from '../governance/instructions.ts'
import { genId, kindOf, type PendingDecision } from '../governance/schema.ts'
import { SCOPE_KEYS, checkupKey, type GlobalViewName } from './contract.ts'
import type { CheckupRunOutcome } from './checkup-run.ts'
import { generateSuggestion, generateVerticalSuggestion } from './model-suggestion.ts'
import { readSuggestionSources } from './suggestion-source.ts'
import type { ReadEventFn } from '../tools/source.ts'

/** 自动体检一次最多给这么多条冲突生成建议（待测参数）；手动体检不设上限。 */
export const AUTO_SUGGESTION_LIMIT = 10
/** 体检自己发起的生成，同一冲突指纹最多试这么多次（待测参数）；用户点「补上建议」不受它限制。 */
export const SUGGESTION_ATTEMPT_LIMIT = 2

export interface CheckupSuggestionsDeps {
  store: Pick<MemoryStore, 'get'>
  decisions: Pick<PendingDecisionsStore, 'list' | 'get' | 'writeSuggestion'>
  /** 用量补记到这次体检的最近一次结果上。 */
  checkups: Pick<CheckupRecordStore, 'addUsage'>
  /** 重写待处理视图（标记变了、写下一条之后）、体检视图（补记了用量之后）。没有视图写入器时什么都不做。 */
  views: { request: (views: readonly GlobalViewName[]) => Promise<void>; requestCheckups: () => Promise<void> }
  /** 按作用域取指令文件：垂直冲突对照这条记忆对应的那份（项目记忆是它所在项目的，全局记忆是全局层的）。一段内每个作用域只读一次。 */
  instructions: ReadInstructions
  /** 宿主的读事件服务：生成前回查两条的出处。缺省或返回 null 时不带出处。 */
  getReadEvent?: () => ReadEventFn | null
  /** 自动体检一次最多补几条，缺省 AUTO_SUGGESTION_LIMIT。 */
  autoLimit?: number
  now: () => number
  log: MemoryLogger
}

export interface CheckupSuggestionsInput {
  /** 这次体检查的范围：只给范围内的冲突生成。 */
  target: Scope | { kind: 'all' }
  by: 'manual' | 'auto'
  /** 体检用的那个模型：手动体检是借来的会话的模型，自动体检是宿主默认模型。 */
  llm: SemanticLlm
  /** 这次体检的结果：做完了、内容检查没出问题才跑。 */
  outcome: CheckupRunOutcome
  /** 调用方的取消信号（插件卸载）：传进模型调用；触发后不等在途的调用，不再写。 */
  signal?: AbortSignal
}

/**
 * 要体检来生成的一条：横向是两条记忆；垂直是那一条和它对应的指令文件（baseline），side 是依据里的基线一半
 * （undefined = 缺基线：指令文件取不到或不存在，只记原因、不生成）。
 */
type Needing =
  | { shape: 'horizontal'; records: [MemoryRecord, MemoryRecord] }
  | { shape: 'vertical'; records: [MemoryRecord]; baseline: readonly string[] | null; side: BaselineBasis | undefined }

/**
 * 体检之后的后续段：给这次体检范围内还没有建议的冲突逐条生成处理建议，写到账本条目上。
 * 体检一次运行做完之后才跑（核心已提交、视图已重写、最近一次结果已记、体检认领已放掉），体检结果和冲突卡先出，建议随后逐条补到卡上。
 * 这一段自己兜住异常、只记日志：出错、取消都不影响已经做完的体检，也不进自动体检的失败计数。
 * 这次体检里模型用不了、语义扫描失败时不跑；跑的过程中模型用不了就停下，这一条不写、不计尝试。
 *
 * 对象：范围内未决、双方都在用、都不含高危密钥、没有当前依据的建议、模型没对当前依据答过「判断不了」、尝试次数没到上限的冲突，先旧后新。
 * 手动体检不设上限；自动体检一次最多 AUTO_SUGGESTION_LIMIT 条，没轮到的记成「名额用完」（不调用模型、不算尝试）。
 * 垂直冲突（记忆和指令文件）对照这条记忆对应的指令文件（项目记忆是它所在项目的，全局记忆是全局层的），手动、自动体检都生成，
 * 依据记下指令文件所属和基线指纹；指令文件取不到或不存在的记成「缺基线」（不调用模型、不算尝试）。
 *
 * 每条一次模型调用，生成在条目认领之外；写入时认领、重读、核对（同「补上建议」），写成了就给这次的冲突指纹记一次尝试。
 * 每写一条重写一次待处理视图；正在排队或生成的条目带「正在生成」标记（进程内状态，见 generatingIds），段结束或被取消时清掉。
 * 全部做完后把这一段的用量补记到这次体检的最近一次结果上（被取消、中途出错时，已经回来的调用同样补记）。
 * 同一进程里几段同时跑时，别的段正在生成的条目跳过；别的进程同时在生成的，后写的一方核对时发现已有当前建议，丢掉自己那份。
 */
export class CheckupSuggestions {
  private readonly deps: CheckupSuggestionsDeps
  private readonly generating = new Set<string>()
  private readonly running = new Set<Promise<void>>()

  constructor(deps: CheckupSuggestionsDeps) {
    this.deps = deps
  }

  /** 正在排队或生成建议的条目 id（收集待处理视图时读）。 */
  generatingIds(): ReadonlySet<string> {
    return this.generating
  }

  /** 体检做完后调用；返回这一段跑完（从不抛错）。手动体检不等它，自动体检等它跑完再查下一个范围。 */
  run(input: CheckupSuggestionsInput): Promise<void> {
    const task: Promise<void> = this.follow(input)
      .catch((err: unknown) => { this.deps.log.warn('[plastic-memory] 体检之后生成处理建议出错，这次体检照常算做完', err) })
      .finally(() => { this.running.delete(task) })
    this.running.add(task)
    return task
  }

  /** 卸载时用：清掉全部「正在生成」标记，调用方随后重写一次待处理视图，视图文件里不留标记。 */
  clearMarks(): void {
    this.generating.clear()
  }

  /** 正在跑的后续段都跑完（没有在跑就立刻）。 */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running])
  }

  private async follow(input: CheckupSuggestionsInput): Promise<void> {
    const { outcome, signal } = input
    // 函数读法：中途随时可能被取消，不让类型收窄成开头那一刻的值
    const isAborted = () => signal?.aborted === true
    if (outcome.kind !== 'done' || isAborted()) return
    if (outcome.notes.some(n => n.code === 'model-unavailable' || n.code === 'semantic-failed')) return
    const { deps } = this
    const read = (id: string) => deps.store.get(id, input.target.kind === 'workspace' ? { workspacePath: input.target.workspacePath } : {})
    // 这一段内每个作用域的指令文件只读一次
    const instructions = cacheInstructions(deps.instructions)
    const eligible: Array<{ entry: PendingDecision; need: Needing }> = []
    const lacking: Array<{ entry: PendingDecision; records: [MemoryRecord] }> = []
    for (const entry of await deps.decisions.list()) {
      const need = await this.needing(entry, input, read, instructions)
      if (need?.shape === 'vertical' && need.side === undefined) lacking.push({ entry, records: need.records })
      else if (need !== undefined) eligible.push({ entry, need })
    }
    // 认领和标记放在同一段同步代码里：同一进程里另一段读完列表之后才看标记，不会两段都选中同一条
    const free = eligible.filter(({ entry }) => !this.generating.has(entry.id))
    const limit = input.by === 'auto' ? deps.autoLimit ?? AUTO_SUGGESTION_LIMIT : free.length
    const targets = free.slice(0, limit)
    const mine = new Set(targets.map(({ entry }) => entry.id))
    for (const id of mine) this.generating.add(id)
    let usage = 0
    let isUsageReported = false
    try {
      // 名额用完：没轮到的记一笔，卡上写原因、可以手动补上。已有当前依据的失败原因（上次没生成成）照留
      for (const { entry, need } of free.slice(limit)) {
        const failure = entry.suggestionFailure
        if (failure !== undefined && isBasisCurrent(entry, failure.basis, need.records)) continue
        await deps.decisions.writeSuggestion(entry.id, { failure: { basis: suggestionBasis(entry, need.records), cause: { kind: 'quota-exhausted' }, at: deps.now() } }, read)
      }
      // 缺基线：同名额用完，记一笔原因（已有当前依据的失败原因照留）；别处已有当前建议时 writeSuggestion 不覆盖
      for (const { entry, records } of lacking) {
        const failure = entry.suggestionFailure
        if (failure !== undefined && isBasisCurrent(entry, failure.basis, records)) continue
        await deps.decisions.writeSuggestion(entry.id, { failure: { basis: suggestionBasis(entry, records), cause: { kind: 'no-baseline' }, at: deps.now() } }, read)
      }
      if (mine.size > 0 || free.length > limit || lacking.length > 0) await deps.views.request(['pending'])
      const llm = abortable(input.llm, signal, (tokens) => { usage += tokens; isUsageReported = true })
      for (const { entry: listed } of targets) {
        if (isAborted()) break
        // 排队期间条目和记忆可能已经变了（被处理、被改、别处已生成）：重读后再判一次，免得白花一次调用
        const entry = await deps.decisions.get(listed.id)
        const need = entry === undefined ? undefined : await this.needing(entry, input, read, instructions)
        const side = need?.shape === 'vertical' ? need.side : undefined
        if (entry !== undefined && need !== undefined && (need.shape === 'horizontal' || side !== undefined)) {
          const basis = suggestionBasis(entry, need.records, side)
          // 宿主的读事件请求不受取消信号管：取消时不等它，免得卸载被一次迟迟不回的读取拖住
          const sources = await untilAborted(readSuggestionSources({ workspaces: entry.workspaces, records: need.records }, deps.getReadEvent?.() ?? null), signal)
          if (sources === undefined) break
          const generated = need.shape === 'vertical'
            ? await generateVerticalSuggestion({ summary: entry.summary, baselineRef: entry.baselineRef!, record: need.records[0], baseline: need.baseline!, source: sources[0] }, llm)
            : await generateSuggestion({ summary: entry.summary, records: need.records, sources: [sources[0], sources[1]] }, llm)
          if (isAborted()) break
          if (!generated.ok && generated.cause.kind === 'model-error' && isModelUnavailableCode(generated.cause.hostCode)) {
            deps.log.warn('[plastic-memory] 模型现在用不了，体检之后的处理建议这次不再生成', generated.cause.hostCode)
            break
          }
          const now = deps.now()
          const result = generated.ok
            ? { suggestion: { id: genId('sg'), action: generated.action, reason: generated.reason, ops: generated.ops, basis, isSourced: generated.isSourced, generatedAt: now } }
            : { failure: { basis, cause: generated.cause, at: now } }
          await deps.decisions.writeSuggestion(entry.id, result, read, { isAttempt: true })
        }
        // 处理完的这条不再归这一段：之后别的段给它加的标记，收尾时不去动
        mine.delete(listed.id)
        this.generating.delete(listed.id)
        await deps.views.request(['pending'])
      }
    } finally {
      const hadMarks = [...mine].some(id => this.generating.has(id))
      for (const id of mine) this.generating.delete(id)
      if (hadMarks) await deps.views.request(['pending'])
      // 花掉的就记上：被取消、中途出错时，已经回来的那几次调用同样补记
      if (isUsageReported && outcome.checkupId !== undefined) {
        await deps.checkups.addUsage(input.target.kind === 'all' ? SCOPE_KEYS.all : checkupKey(input.target), outcome.checkupId, usage)
        await deps.views.requestCheckups()
      }
    }
  }

  /**
   * 这一条要不要体检来生成：冲突、在这次体检范围内、双方都在用、都不含高危密钥、没有当前依据的建议、
   * 模型没对当前依据答过「判断不了」（它答了，同样的输入再问多半还是这样）、这个冲突指纹的尝试次数没到上限。
   * 垂直冲突的当前依据还要是同一份指令文件（缺基线时只核对记忆那一半：视图同样只核对这一半）。
   */
  private async needing(
    entry: PendingDecision, input: CheckupSuggestionsInput, read: (id: string) => Promise<MemoryRecord | undefined>, instructions: ReadInstructions,
  ): Promise<Needing | undefined> {
    if (kindOf(entry) !== 'conflict') return undefined
    const isVertical = entry.baselineRef !== undefined && entry.memoryIds.length === 1
    if (!isVertical && (entry.baselineRef !== undefined || entry.memoryIds.length !== 2)) return undefined
    const { suggestionAttempts: attempts } = entry
    if (attempts !== undefined && attempts.fingerprint === entry.fingerprint && attempts.count >= SUGGESTION_ATTEMPT_LIMIT) return undefined
    const records = await Promise.all(entry.memoryIds.map(read))
    if (!records.every(r => r?.status === 'active')) return undefined
    const live = records as MemoryRecord[]
    if (!live.every(r => isInRange(r, input.target)) || live.some(r => hasCriticalSecret(r))) return undefined
    const baseline = isVertical ? await baselineFor(instructions, live[0]!) : null
    const side = isVertical ? baselineBasisOf(live[0]!, baseline, entry.fingerprint) : undefined
    /** 依据里的基线和这次的一致（横向、缺基线时不比）。 */
    const isSameSide = (basis: Parameters<typeof isBaselineCurrent>[0]) => side === undefined || isBaselineCurrent(basis, baseline)
    if (entry.suggestion !== undefined && isBasisCurrent(entry, entry.suggestion.basis, live) && isSameSide(entry.suggestion.basis)) return undefined
    const failure = entry.suggestionFailure
    if (failure?.cause.kind === 'undecided' && isBasisCurrent(entry, failure.basis, live) && isSameSide(failure.basis)) return undefined
    return isVertical ? { shape: 'vertical', records: [live[0]!], baseline, side } : { shape: 'horizontal', records: live as [MemoryRecord, MemoryRecord] }
  }
}

/** 记忆在这次体检的范围里：全局体检只有全局，项目体检是全局加本项目，全部体检是所有作用域。 */
function isInRange(r: MemoryRecord, target: CheckupSuggestionsInput['target']): boolean {
  if (target.kind === 'all') return true
  const at = scopeAt(r.workspacePath)
  return sameScope(at, target) || (target.kind === 'workspace' && at.kind === 'global')
}

/**
 * 取消信号传进模型调用；触发后立刻以取消结束，不等在途的调用回来（插件卸载时不被一次慢调用拖住）。
 * 宿主报的用量照常累加。
 */
function abortable(llm: SemanticLlm, signal: AbortSignal | undefined, onUsage: (tokens: number) => void): SemanticLlm {
  return {
    ...(llm.model !== undefined ? { model: llm.model } : {}),
    complete: (input) => {
      if (signal === undefined) return llm.complete(input, undefined, onUsage)
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => { reject(signal.reason ?? new DOMException('cancelled', 'AbortError')) }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        // 取消之后才回来的结果（或错误）已经没人等，这里接住
        llm.complete(input, signal, onUsage).then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
      })
    },
  }
}

/** 等到 task 有结果，或取消信号先到（返回 undefined；task 迟到的结果和错误都丢掉）。 */
function untilAborted<T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) return task
  if (signal.aborted) { task.catch(() => {}); return Promise.resolve(undefined) }
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => { resolve(undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}
