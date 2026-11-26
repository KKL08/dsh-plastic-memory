import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { DreamsStore } from '../governance/dreams-records.ts'
import { drillAnchorKey, type DrillAnchor } from '../governance/drill-down.ts'
import {
  buildTierPrompt, contentAnchorOf, dispositionOf, isImportant, judgeConfidence, olderBoundNote, pairBasis, parseTierReply,
  resolveTier, tierConclusion, tierPlan, TIER_EXCERPT_MAX, TIER_MAX_PER_RUN, TIER_REASON_DEFAULT, TIER_REASON_MAX,
  TIER_WINDOW_MAX_CHARS, TIER_WINDOW_MAX_MESSAGES, TIER_WINDOW_MESSAGE_MAX_CHARS, type EvidenceKind,
} from '../governance/dreams-tiers.ts'
import { isDeepStrictEqual } from 'node:util'
import { MEMORY_TOOL_NAMES } from '../contract-codes.ts'
import { isLegacyAnchor, isLocked, type MemoryRecord, type SourceAnchor } from '../record-schema.ts'
import { ledgerLabel } from '../scope.ts'
import { hasSecret, maskSecrets } from '../secrets.ts'
import { oneLine } from '../governance/dreams-tidy.ts'
import { resolveGroupId } from '../governance/dreams-merge.ts'
import { numberDialogue, type DialogueSource } from '../governance/session-excerpt.ts'
import { TIER_FINDING_KINDS, kindOf, type DreamsExcerpt, type DreamsHold, type PendingDecision, type TierFindingKind, type TierOutcome } from '../governance/schema.ts'
import { resolvedFindingStep } from '../governance/op-steps.ts'
import { activeMembers, ask, unreadError } from './dreams-tidy.ts'
import { locateCopy } from './workspace-gate.ts'
import { anchorTimeMatches, excludesPluginEvidence, isOwnEvent, isRealUserMessage, relocateByTime, type SessionLog } from '../session-log.ts'
import type { NoReviewList } from '../storage/no-review.ts'
import type { DreamsStep } from './dreams-run.ts'
import { drillOpen, noteUnreadable, type DrillUnreadableReason } from './dreams-drill.ts'
import type { HostSession } from './host-session.ts'

/**
 * 记忆梦境处理矛盾、状态变化、纠错：账本里这个范围未决的横向配对发现（冲突、漏记的变化），先读两边出处、交给模型核实，
 * 「有把握」「重要」由代码判（governance/dreams-tiers.ts），再按档位：直接处理（结果记到批次条目上，发现移出账本）、
 * 进「先处理」（条目就地改成 important-pending）、或交给用户（条目照旧，记下这次核实过）。读会话原文在这一层，文件系统也在这一层碰。
 */

/**
 * shell 类和代码执行类工具：参数里的命令、代码拼出来的路径认不了，结果判不了。名字比较不分大小写。
 */
export const SHELL_TOOL_NAMES: readonly string[] = [
  'bash', 'shell', 'sh', 'zsh', 'exec', 'exec_command', 'run_command', 'terminal', 'powershell',
  'python', 'python3', 'node', 'deno', 'ruby', 'run_code', 'execute_code', 'code_interpreter', 'jupyter', 'repl',
]
/** 参数里有这些键（字符串值，任意层级）的调用按 shell 类算。键名比较不分大小写。 */
export const SHELL_ARG_KEYS: readonly string[] = ['command', 'cmd', 'script', 'code']
/** 参数里当路径解析的键（值是字符串或字符串数组，在任意层级的对象、数组里找）。键名比较不分大小写。 */
export const PATH_ARG_KEYS: readonly string[] = ['path', 'paths', 'file', 'files', 'file_path', 'filePath', 'filename', 'dir', 'directory', 'cwd', 'target', 'root']

export interface EvidenceKindOptions {
  /** 本插件注册的工具名（MEMORY_TOOL_NAMES）。 */
  pluginTools: readonly string[]
  /** 记忆根目录（绝对路径）。 */
  memoryRoot: string
  /** 家目录：参数里的 ~、$HOME、${HOME} 按它展开。 */
  homeDir?: string
}

/**
 * 会话里序号为 seq 的那条事件算哪类依据（EvidenceKind）。只认确定是这个会话自己的事件（isOwnEvent 严格为 true；unknown 也算 other）。
 * 「落在记忆根里」按路径边界判：等于记忆根，或以「记忆根 + 路径分隔符」开头；两边都用真实路径（fs.realpath）。
 * 记忆根的真实路径取不到时按 path.resolve 的结果比。「是记忆根的祖先」：记忆根落在它里面（含相等）。
 * user：isRealUserMessage。工具结果先找它之前最近的同 callId 调用（找不到 → unknown），失败的结果 → other，然后依次：
 * 1 调用名（不分大小写）在 pluginTools 里 → plugin；
 * 2 会话 header 的 cwd 的真实路径落在记忆根里 → memory；
 * 3 excludesPluginEvidence 的字符串比对认出记忆根 → memory；
 * 4 调用名在 SHELL_TOOL_NAMES 里，或参数里任意层级有 SHELL_ARG_KEYS 的字符串值 → unknown；
 * 5 参数不是 JSON，或是合法 JSON 但不是对象（数组、字符串、数字、null）→ unknown；
 * 6 收集参数里任意层级 PATH_ARG_KEYS 下的值（找到路径键就取它的值，不再往它里面找）：字符串是一项；数组里每个元素各是一项；
 *   值不是字符串也不是数组、数组元素不是字符串、空串，这一项按 unknown 算，和下面各路径的结果一起比；
 * 7 没有路径参数：cwd 缺省或真实路径取不到 → unknown；cwd 是记忆根的祖先 → unknown（调用可能在 cwd 下读到记忆）；否则 tool；
 * 8 每个路径：~、$HOME、${HOME} 开头的按 homeDir 展开（没有 homeDir → unknown），相对路径按 header 的 cwd 解析（没有 cwd、cwd 的真实路径取不到 → unknown），
 *   再取真实路径（不存在、读不了 → unknown）。落在记忆根里 → memory；是记忆根的祖先 → unknown；
 *   几个路径里有 memory 就判 memory，其次有 unknown 判 unknown，都不是 → tool。
 * 其余事件（助手的话、别的来源开的消息、注入的上下文、结构事件）→ other；序号不在日志里 → other。不抛错（文件系统出错按 unknown）。
 */
export async function evidenceKindOf(log: SessionLog, seq: number, opts: EvidenceKindOptions): Promise<EvidenceKind> {
  const index = log.events.findIndex(e => e.seq === seq)
  const event = log.events[index]
  if (event === undefined || isOwnEvent(log, event) !== true) return 'other'
  if (isRealUserMessage(log, event)) return 'user'
  if (event.type !== 'tool/result') return 'other'
  const message = objectOf(objectOf(event.data)?.message)
  if (typeof message?.toolCallId !== 'string') return 'unknown'
  const callEvent = log.events.slice(0, index).findLast(e => e.type === 'tool/call' && objectOf(e.data)?.callId === message.toolCallId)
  const call = objectOf(callEvent?.data)
  if (call === undefined || typeof call.name !== 'string') return 'unknown'
  if (message.isError === true) return 'other'
  const name = call.name.toLowerCase()
  if (opts.pluginTools.some(tool => tool.toLowerCase() === name)) return 'plugin'
  const root = await realPath(opts.memoryRoot) ?? resolve(opts.memoryRoot)
  const cwd = log.header.cwd === undefined ? undefined : await realPath(log.header.cwd)
  if (cwd !== undefined && isInside(cwd, root)) return 'memory'
  const args = typeof call.arguments === 'string' ? call.arguments : ''
  if (excludesPluginEvidence({ toolNames: [], memoryRoot: opts.memoryRoot, homeDir: opts.homeDir })({ name, arguments: args })) return 'memory'
  if (SHELL_TOOL_NAMES.includes(name)) return 'unknown'
  let parsed: unknown
  try { parsed = JSON.parse(args) } catch { return 'unknown' }
  if (hasCommand(parsed)) return 'unknown'
  const obj = objectOf(parsed)
  if (obj === undefined) return 'unknown'
  const paths: unknown[] = []
  collectPaths(obj, paths)
  if (paths.length === 0) return cwd === undefined || isInside(root, cwd) ? 'unknown' : 'tool'
  const kinds: EvidenceKind[] = []
  for (const item of paths) {
    if (typeof item !== 'string' || item.trim() === '') { kinds.push('unknown'); continue }
    let path = item
    const home = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(path)
    if (home !== null) {
      if (opts.homeDir === undefined) { kinds.push('unknown'); continue }
      path = opts.homeDir + path.slice(home[0].length)
    }
    if (!isAbsolute(path)) {
      if (cwd === undefined) { kinds.push('unknown'); continue }
      path = resolve(cwd, path)
    }
    const real = await realPath(path)
    kinds.push(real === undefined ? 'unknown' : isInside(real, root) ? 'memory' : isInside(root, real) ? 'unknown' : 'tool')
  }
  return kinds.includes('memory') ? 'memory' : kinds.includes('unknown') ? 'unknown' : 'tool'
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const isInside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** 路径不可读时无法证明结果来自记忆之外，交给依据判定拒收。 */
async function realPath(path: string): Promise<string | undefined> {
  try { return await realpath(path) } catch { return undefined }
}

function hasCommand(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) =>
    (SHELL_ARG_KEYS.includes(key.toLowerCase()) && typeof child === 'string') || hasCommand(child))
}

function collectPaths(value: unknown, paths: unknown[]): void {
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (PATH_ARG_KEYS.some(pathKey => pathKey.toLowerCase() === key.toLowerCase())) {
      paths.push(...(Array.isArray(child) ? child : [child]))
    } else collectPaths(child, paths)
  }
}

export interface ResolveFindingsDeps {
  store: MemoryStore
  decisions: Pick<PendingDecisionsStore, 'list' | 'get' | 'hold' | 'reviseFinding'>
  /** 用户撤销过的梦境合并和矛盾处理的结论（合并和矛盾共用一份；用户在「先处理」里不采纳、按原来那种发现裁决的不记）。读不全返回 undefined。 */
  dreams: Pick<DreamsStore, 'undoneMerges'>
  /** 读出处经下钻读口（drillOpen）：会话日志、会话清单、存档名单。 */
  host: Pick<HostSession, 'readSessionLog' | 'listSessions' | 'archivedSessionIds'>
  /** 标了不回看的会话不读（确认读不到）；名单读不出是这次读不出，下次重试。 */
  noReview: Pick<NoReviewList, 'isMarkedNoReview'>
  memoryRoot: string
  homeDir?: string
  /** 配置里的档位原值（brewingDreams.tier），用时经 resolveTier。 */
  tier: () => unknown
  /** 配置里的重点类型（brewingDreams.focusTypes）。 */
  focusTypes: () => readonly string[]
  now: () => number
}

/**
 * 运行计划里处理矛盾的一步（排在下钻补全之后、逐条整理之前）。每次都做（不看有没有新变化）：账本里的发现可能是这次运行之前的体检挂的。
 * 一次最多调 TIER_MAX_PER_RUN 次模型；模型到第一次要调时才取（ctx.llm）。读条目、读出处、调模型都不占着条目；
 * 写之前短暂认领条目，在认领里重读条目和两条记忆，对不上就放弃这一对。
 * 出处经下钻读口读（不占这次运行的下钻名额，读到的次数、存档会话照样记进下钻账），先读没存档的一边：
 * 确认读不到的进下钻报告；这次读不出的（会话清单、存档名单、不回看名单、日志）记一条 resolve-source 跳过，下次重试。
 */
export const resolveFindingsStep = (deps: ResolveFindingsDeps): DreamsStep => ({
  name: 'resolve-findings',
  needsChanges: false,
  async run(ctx) {
    if (ctx.shouldStop()) return
    const undone = await deps.dreams.undoneMerges(ctx.scope)
    if (undone === undefined) throw new Error('撤销过的梦境结论读不全，这一步没有处理')
    const entries = (await deps.decisions.list()).sort((a, b) => a.firstSeenAt - b.firstSeenAt)
    const all = await activeMembers(deps.store, ctx)
    const read = (id: string) => locateCopy(deps.store, id, ctx.scope)
    const scopeLabel = ledgerLabel(ctx.scope)
    let calls = 0
    let unread = 0
    let llm: Awaited<ReturnType<typeof ctx.llm>> | undefined
    for (let entry of entries) {
      if (ctx.shouldStop()) return
      const kind = kindOf(entry)
      const unlock = kind === 'important-pending' && entry.dreamsHold?.cause === 'locked'
      if ((!TIER_FINDING_KINDS.some(k => k === kind) && !unlock) || entry.baselineRef !== undefined
        || entry.memoryIds.length !== 2 || entry.memoryIds[0] === entry.memoryIds[1]) continue
      if (entry.memoryIds.some(id => !all.has(id) || ctx.isHeldForNextRun(id))) continue
      const members = await Promise.all(entry.memoryIds.map(read))
      if (ctx.shouldStop()) return
      const initial = checkFinding(entry, members, entry, scopeLabel, undefined)
      if ('reason' in initial) continue
      const { pair, basis } = initial
      const locked = (records: readonly MemoryRecord[]) => records.some(r => isLocked(r, deps.now()))
      if (unlock && locked(pair)) continue
      const skip = (reason: string) => ctx.skip({ kind: 'resolve', target: entry.id, reason })
      const reviseResult = (result: 'written' | 'stale' | 'gone' | 'claimed') => {
        if (result !== 'written') skip(result === 'stale' ? 'basis-changed' : result === 'gone' ? 'entry-changed' : 'busy')
      }
      const recheckPair = (current: PendingDecision, live: ReadonlyArray<MemoryRecord | undefined>) =>
        checkFinding(current, live, entry, scopeLabel, basis)
      if (unlock) {
        let reopened: PendingDecision | undefined
        const result = await deps.decisions.reviseFinding(entry.id, (current, live) => {
          const checked = recheckPair(current, live)
          if ('reason' in checked || locked(checked.pair) || current.dreamsHold?.cause !== 'locked') return undefined
          const { dreamsHold, change: _change, evidence: _evidence, ...rest } = current
          reopened = { ...rest, kind: dreamsHold.fromKind }
          return reopened
        }, read)
        reviseResult(result)
        if (result !== 'written') continue
        entry = reopened!
      }
      if (entry.dreamsReview?.basis === basis) continue
      const fromKind = kindOf(entry) as TierFindingKind
      const conclusion = tierConclusion(pair)
      const notify = (current: PendingDecision, proposal?: DreamsHold['proposal']): PendingDecision => {
        const { suggestion: _suggestion, suggestionFailure: _failure, suggestionAttempts: _attempts, plan: _plan,
          sourceCheck: _sourceCheck, dreamsReview: _review, change: _change, evidence: _evidence, ...rest } = current
        return { ...rest, kind: 'important-pending', dreamsHold: {
          runId: ctx.runId, at: deps.now(), cause: proposal === undefined ? 'locked' : 'important', fromKind, conclusion,
          ...(proposal === undefined ? {} : { proposal }),
        } }
      }
      const handOver = async (outcome: TierOutcome) => {
        if (ctx.shouldStop()) return
        reviseResult(await deps.decisions.reviseFinding(entry.id, (current, live) => {
          const checked = recheckPair(current, live)
          if ('reason' in checked) return undefined
          if (locked(checked.pair)) return notify(current)
          return { ...current, dreamsReview: { runId: ctx.runId, at: deps.now(), outcome, basis } }
        }, read))
      }
      if (undone.has(conclusion)) { await handOver('undone-before'); continue }
      if (ctx.shouldStop()) return
      if (locked(pair)) {
        reviseResult(await deps.decisions.reviseFinding(entry.id, (current, live) => {
          const checked = recheckPair(current, live)
          return !('reason' in checked) && locked(checked.pair) ? notify(current) : undefined
        }, read))
        continue
      }
      if (ctx.shouldStop()) return
      if (pair.some(hasSecret)) { await handOver('has-secret'); continue }
      if (ctx.shouldStop()) return
      if (calls >= TIER_MAX_PER_RUN || ctx.quotaLeft() === 0) {
        skip(calls >= TIER_MAX_PER_RUN ? 'run-limit' : 'quota')
        ctx.markUnprocessed(entry.memoryIds)
        continue
      }
      const anchors = pair.map(contentAnchorOf)
      const sources: Array<DialogueSource | undefined> = [undefined, undefined]
      const logs = new Map<string, SessionLog>()
      let isRead = anchors[0] !== undefined && anchors[1] !== undefined
      // 放行要求这一对没存档的锚先试过：先读的一边被拒，就先读另一边再回来读它
      const readOrder = [0, 1]
      for (let k = 0; isRead && k < readOrder.length; k++) {
        if (ctx.shouldStop()) return
        const i = readOrder[k]!
        const anchor: DrillAnchor = anchors[i]!
        const memoryId = pair[i].id
        const cached = logs.get(anchor.sessionId)
        const opened = cached !== undefined ? { kind: 'opened' as const, log: cached } : await drillOpen(
          { memoryId, purpose: 'verify-conflict', anchor, pairAnchors: anchors as DrillAnchor[] },
          // 核实矛盾的读取不占这次运行的下钻名额
          ctx.drillLog, { host: deps.host, noReview: deps.noReview, limit: Infinity },
        )
        if (opened.kind === 'refused' && opened.reason === 'archived-too-early' && k === 0) { readOrder.push(i); continue }
        if (opened.kind === 'retry') ctx.skip({ kind: 'resolve-source', target: memoryId, reason: opened.reason })
        if (opened.kind !== 'opened') { isRead = false; break }
        const source = sourceWindow(opened.log, anchors[i]!)
        if (typeof source === 'string') {
          noteUnreadable(ctx.drillLog, memoryId, anchor, source)
          isRead = false
          break
        }
        ctx.drillLog.attempted.add(drillAnchorKey(anchor))
        sources[i] = source
        logs.set(anchor.sessionId, opened.log)
      }
      if (ctx.shouldStop()) return
      if (!isRead) { skip('source-unreadable'); continue }
      const dialogue = numberDialogue(sources as DialogueSource[], 1, { numberSpeakers: ['user', 'tool'] })
      const evidence = new Map<number, EvidenceKind>()
      for (const [number, ref] of dialogue.refs) {
        if (ctx.shouldStop()) return
        evidence.set(number, await evidenceKindOf(logs.get(ref.sessionId)!, ref.seq, {
          memoryRoot: deps.memoryRoot, homeDir: deps.homeDir, pluginTools: MEMORY_TOOL_NAMES,
        }))
      }
      if (ctx.shouldStop()) return
      llm ??= await ctx.llm()
      if (ctx.shouldStop()) return
      calls++
      const reply = await ask(llm, buildTierPrompt({ fromKind, pair, dialogue }), parseTierReply, ctx)
      if (ctx.shouldStop()) return
      if (reply === undefined) { unread++; continue }
      const judged = judgeConfidence({ reply, pair, evidence, canChange: id => ctx.canChange(id) })
      if (!judged.isConfident) {
        if (judged.doubt === 'quota') { skip('quota'); ctx.markUnprocessed(entry.memoryIds) }
        else await handOver(judged.doubt)
        continue
      }
      if (ctx.shouldStop()) return
      const { newer, older, change, order } = judged
      const important = isImportant(older, deps.focusTypes())
      const ops = tierPlan({ runId: ctx.runId, conclusion, change, newer, older, draft: reply.draft })
      if (ops === undefined) { await handOver('draft-unusable'); continue }
      if (change === 'correct' && hasSecret({ ...older, ...ops[0]!.patch } as MemoryRecord)) { await handOver('has-secret'); continue }
      // 调模型在锁外，期间写进的密钥（如标签）不改依据，写前要在现读的两条上再查一遍，和入口查的一致。
      const hasSecretNow = (live: readonly MemoryRecord[]) => live.some(hasSecret)
        || (change === 'correct' && hasSecret({ ...live.find(r => r.id === older.id)!, ...ops[0]!.patch } as MemoryRecord))
      const reason = cleanText(reply.reason ?? '', TIER_REASON_MAX) || TIER_REASON_DEFAULT
      const excerpts = judged.evidence.map((number): DreamsExcerpt => {
        const ref = dialogue.refs.get(number)!
        return { sessionId: ref.sessionId, seq: ref.seq, speaker: ref.speaker as 'user' | 'tool', text: cleanText(ref.text, TIER_EXCERPT_MAX) }
      })
      const bound = order.olderBoundAt === undefined ? {} : { olderBoundNote: olderBoundNote(order.olderBoundAt) }
      if (ctx.shouldStop()) return
      if (dispositionOf({ isLocked: false, isConfident: true, isImportant: important, tier: resolveTier(deps.tier()) }) === 'hold') {
        reviseResult(await deps.decisions.reviseFinding(entry.id, (current, live) => {
          const checked = recheckPair(current, live)
          if ('reason' in checked) return undefined
          if (locked(checked.pair)) return notify(current)
          if (hasSecretNow(checked.pair)) return undefined
          return { ...notify(current, { ops, newer: newer.id, reason, excerpts, ...bound }), change,
            evidence: excerpts.map(({ sessionId, seq }) => ({ sessionId, seq })) }
        }, read))
        continue
      }
      const release = await deps.decisions.hold(entry.id)
      if (release === undefined) { skip('busy'); continue }
      try {
        if (ctx.shouldStop()) return
        const current = await deps.decisions.get(entry.id)
        const live = await Promise.all((current?.memoryIds ?? []).map(read))
        if (ctx.shouldStop()) return
        const checked = checkFinding(current, live, entry, scopeLabel, basis)
        if ('reason' in checked) {
          // 依据和锁同时变化时，沿用先报锁定的顺序；依据不符的返回已保证两条都在用。
          skip(checked.reason === 'basis-changed' && locked(live as MemoryRecord[]) ? 'locked' : checked.reason)
          continue
        }
        if (locked(checked.pair)) { skip('locked'); continue }
        if (hasSecretNow(checked.pair)) { skip('basis-changed'); continue }
        if (ctx.shouldStop()) return
        const result = await ctx.apply(ops, { afterCommit: () => [resolvedFindingStep({
          entryId: entry.id, ...(change === 'state-change' ? { olderId: older.id } : {}),
        })] })
        if (result.outcomes.some(o => o.kind === 'skipped' && o.reason === 'quota')) ctx.markUnprocessed(entry.memoryIds)
        const group = resolveGroupId(ctx.runId, conclusion)
        if (result.groups?.find(g => g.group === group)?.state !== 'applied') continue
        if (!result.outcomes.some(o => o.kind === 'applied')) { skip('no-change'); continue }
        await ctx.recordResult({ group, fromKind, change, newer: newer.id, older: older.id, at: deps.now(),
          ...(important ? { isImportant: true } : {}), reason, excerpts, ...bound })
        if (change === 'correct') ctx.holdForNextRun([older.id])
      } finally { await release() }
    }
    if (unread > 0) throw unreadError(unread)
  },
})

/**
 * 入口与各写入分支共用资格核对；入口尚无依据，返回现读两条的依据供后续复核。
 * 作用域要两项都记着且都是这一轮的范围：没记全的旧条目分不清指的是哪个范围的副本，留给用户或下次体检。
 */
function checkFinding(
  current: PendingDecision | undefined, live: ReadonlyArray<MemoryRecord | undefined>, expected: PendingDecision,
  scopeLabel: string, basis: string | undefined,
): { pair: [MemoryRecord, MemoryRecord]; basis: string } | { reason: 'entry-changed' | 'member-gone' | 'basis-changed' } {
  if (current === undefined || current.settled !== undefined || kindOf(current) !== kindOf(expected)
    || current.baselineRef !== undefined || current.workspaces?.length !== 2 || current.workspaces.some(w => w !== scopeLabel)
    || (kindOf(current) === 'important-pending' && current.dreamsHold?.fromKind !== expected.dreamsHold?.fromKind)
    || !isDeepStrictEqual(current.dreamsReview, expected.dreamsReview)) return { reason: 'entry-changed' }
  if (live.length !== 2 || live.some(r => r?.status !== 'active')) return { reason: 'member-gone' }
  const pair = live as [MemoryRecord, MemoryRecord]
  const freshBasis = pairBasis(pair)
  if (basis !== undefined && freshBasis !== basis) return { reason: 'basis-changed' }
  return { pair, basis: freshBasis }
}

function cleanText(text: string, max: number): string {
  return oneLine(maskSecrets(text, { severity: 'suspected' })).slice(0, max)
}

/**
 * 先定完整轮次，再按保存点挑消息；区间内用户原话优先，所有消息共用同一份上限。
 * 找不到锚那一轮（旧锚序号不在、按时间也找不回）为 anchor-lost；那一轮没有消息、或挑出的消息里没有用户和工具的为 empty。
 */
function sourceWindow(log: SessionLog, anchor: SourceAnchor): DialogueSource | Extract<DrillUnreadableReason, 'anchor-lost' | 'empty'> {
  const events = log.events
  let [start, end] = anchor.eventRange
  let relocated = false
  const first = events.find(e => e.seq === start)
  if (isLegacyAnchor(anchor)) {
    if (first === undefined) return 'anchor-lost'
  } else if (!anchorTimeMatches(anchor.at, first?.time, events.find(e => e.seq !== undefined && e.seq > end && e.time !== undefined)?.time)) {
    const found = relocateByTime(anchor, events)
    if (found === null) return 'anchor-lost'
    start = end = found
    relocated = true
  }
  const from = events.findLastIndex(e => e.type === 'turn/start' && e.seq !== undefined && e.seq <= start)
  const next = events.findIndex(e => e.type === 'turn/start' && e.seq !== undefined && e.seq > end)
  const turn = events.slice(Math.max(0, from), next < 0 ? undefined : next)
  // 和最终渲染共用消息筛选，结构事件、注入文本不会挤占窗口。
  const messages = [...numberDialogue([{ sessionId: anchor.sessionId, events: turn }]).refs.values()]
  if (messages.length === 0) return 'empty'
  if (relocated) { start = messages[0]!.seq; end = messages.at(-1)!.seq }
  const size = (text: string) => Math.min(text.length, TIER_WINDOW_MESSAGE_MAX_CHARS)
  let selected = messages
  if (messages.length > TIER_WINDOW_MAX_MESSAGES || messages.reduce((sum, m) => sum + size(m.text), 0) > TIER_WINDOW_MAX_CHARS) {
    const priority = (m: typeof messages[number]) => m.speaker === 'user' && m.seq >= start && m.seq <= end
    const ordered = [...messages].sort((a, b) => Number(priority(b)) - Number(priority(a))
      || Math.abs(a.seq - end) - Math.abs(b.seq - end) || b.seq - a.seq)
    selected = []
    let chars = 0
    for (const m of ordered) {
      if (selected.length === TIER_WINDOW_MAX_MESSAGES || chars + size(m.text) > TIER_WINDOW_MAX_CHARS) break
      selected.push(m)
      chars += size(m.text)
    }
    selected.sort((a, b) => a.seq - b.seq)
  }
  const kept = new Set(selected.map(m => m.seq))
  const positions = selected.map(m => messages.findIndex(all => all.seq === m.seq))
  const source: DialogueSource = {
    sessionId: anchor.sessionId, events: turn.filter(e => e.seq !== undefined && kept.has(e.seq)),
    clipped: new Map(selected.filter(m => m.text.length > TIER_WINDOW_MESSAGE_MAX_CHARS).map(m => [m.seq, TIER_WINDOW_MESSAGE_MAX_CHARS])),
    omitted: { before: positions[0]! > 0, after: positions.at(-1)! < messages.length - 1,
      gapBefore: selected.filter((_, i) => i > 0 && positions[i]! > positions[i - 1]! + 1).map(m => m.seq) },
  }
  return numberDialogue([source], 1, { numberSpeakers: ['user', 'tool'] }).refs.size === 0 ? 'empty' : source
}
