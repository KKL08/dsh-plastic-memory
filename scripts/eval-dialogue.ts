/**
 * 中文原话评估：自造日志经追库、收录、切段和分词进入临时 SQLite，记忆写入临时 FileTable。
 * 手动运行，不进 CI：
 *
 *   node scripts/eval-dialogue.ts
 *   node scripts/eval-dialogue.ts --rerank
 *
 * 先逐题校验生产权重下的对照路径与 executeSearch 完整输出同序，再按类别打印前五消息命中。
 * 权重对照只在 store.search 边界替换 weights，仍调用真实 SQLite 与生产排序、融合、装填。
 * 输出包含两种分词模式、两种来源、九组权重、预算复核、固定常量的跳过说明及逐题延迟。
 * 前五按最终展示顺序取不同消息，包含记忆附带原话和相邻上下文；记忆正文不冒充原话命中。
 * 换说法只旁列；调参差异排除它。结果只打印到标准输出，不向仓库写结果。
 * 规则排序逐题计时五次；--rerank 留出重排比较入口，尚未接入模型，均不读取凭据或调用模型。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FileTable } from '../src/storage/file-table.ts'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { MemoryStore } from '../src/store.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { DialogueCatchup } from '../src/tools/dialogue-catchup.ts'
import { executeSearch, renderSearchResult, type SearchToolDeps } from '../src/tools/search.ts'
import { executeSource, MESSAGE_REF_TEXT_CAP } from '../src/tools/source.ts'
import { searchDialogue } from '../src/tools/dialogue-search.ts'
import { dialogueTokenizer, DIALOGUE_BM25_WEIGHTS } from '../src/search/dialogue-tokenizer.ts'
import { resetJieba } from '../src/search/jieba-segmenter.ts'
import { dialogueBudgetOf, parseMessageRef, formatMessageRef } from '../src/search/dialogue-format.ts'
import { isSameAsMemory, MEMORY_QUOTE_LIMIT, MEMORY_QUOTE_BUDGET_TOKENS } from '../src/search/memory-quotes.ts'
import { messageText } from '../src/session-log.ts'
import { DIALOGUE_EVAL_QUERIES as queries, DIALOGUE_EVAL_SESSIONS as sessions, DIALOGUE_EVAL_MEMORIES as memories, DIALOGUE_EVAL_CATEGORIES as categories, type DialogueEvalQuery } from '../tests/fixtures/dialogue-eval.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from '../tests/helpers/in-memory-kv.ts'
import { record } from '../tests/helpers/record.ts'

type Source = 'dialogue' | 'both'
type Weights = readonly [number, number, number]
type Row = { text: string; refs: string[]; memoryIds: string[] }
type Results = Map<string, Row>
const exec = { signal: new AbortController().signal } as ToolRunContext
const log = { info() {}, warn() {}, error() {} }
const key = (ref: { sessionId: string; seq: number }) => JSON.stringify([ref.sessionId, ref.seq])
const missingJieba = {
  async importJieba(): Promise<never> { throw Object.assign(new Error('分词包不可用'), { code: 'ERR_MODULE_NOT_FOUND' }) },
  readMainDictionary(): Uint8Array { throw new Error('回退模式不读词典') },
}

async function setup(root: string) {
  const tokenizer = await dialogueTokenizer({ log })
  const db = new DialogueRecordStore({ path: join(root, 'dialogue.sqlite'), log })
  const context = { workspacePath: root, session: { id: sessions[0]!.log.header.id!, lastSeq: sessions[0]!.log.events.at(-1)!.seq! } }
  const host = {
    contextOf: async () => context,
    readSessionLog: async (id: string) => sessions.find(s => s.log.header.id === id)?.log ?? null,
    sessionTitleOf: async (id: string) => id,
    listSessions: async () => sessions.map(s => ({ id: s.log.header.id!, cwd: root, isSubagent: false, isLive: false })),
  }
  const noReview = { sessionIds: async () => new Set<string>(), isMarkedNoReview: async () => false }
  const workspaceOf = async (cwd: string | undefined) => cwd
  const catchup = new DialogueCatchup({ store: db, host, noReview, workspaceOf, tokenizer: async () => tokenizer,
    knownWorkspaces: async () => [root], isEnabled: () => true, sessionStore: join(root, 'sessions'), log })
  const ready = await catchup.beforeSearch({ sessionId: context.session.id, cwd: root, isSubagent: false }, 60_000, 60_000)
  assert(ready.kind === 'ready' && ready.coverage.queued === 0 && ready.isCaughtUp, '评测前必须收齐全部日志')
  const store = new MemoryStore(new FileTable({ root: join(root, 'memories'), stats: new InMemoryKvTable<RecallStats>() }), undefined, new InMemoryBatchKvTable())
  for (const m of memories) await store.put(record({
    id: m.id, name: m.name, summary: m.summary, content: m.body, scope: 'workspace', workspacePath: root,
    source: { sessionId: m.sessionId, eventRange: m.eventRange, sourceMode: 'user-explicit' },
  }))
  const deps: SearchToolDeps = { store, host, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    tokenizer: { log }, searchSource: () => 'both', memoryQuotes: () => true,
    dialogue: { store: db, catchup, host, noReview, workspaceOf, tokenizer: async () => tokenizer, includeTools: () => true, hasBackgroundTimer: () => true } }
  return { db, deps, context, host, noReview, workspaceOf, tokenizer }
}

// 只替换真实数据库接受的参数；不复制召回或排序算法。
function variant(deps: SearchToolDeps, weights: Weights, budget = 1500): SearchToolDeps {
  const d = deps.dialogue!
  const store = d.store
  return { ...deps, dialogue: { ...d, budget: () => budget, store: {
    state: store.state.bind(store), session: store.session.bind(store), isQueued: store.isQueued.bind(store),
    segmentsOf: store.segmentsOf.bind(store), turnsOf: store.turnsOf.bind(store),
    search: (gen, match, opts) => store.search(gen, match, { ...opts, weights }),
  } } }
}
async function runOne(q: DialogueEvalQuery, source: Source, deps: SearchToolDeps): Promise<Row> {
  const result = await executeSearch({ query: q.query, source, limit: 5 }, exec, deps)
  assert(result.dialogueText !== undefined && !result.pathNote && !result.dialogueText.includes('过往对话的原话暂时查不了'), '原话路径必须成功')
  const text = renderSearchResult(result)
  const refs = [...new Set([...text.matchAll(/〔引用 ([^〕]+)〕/g)].map(m => {
    const ref = parseMessageRef(m[1]!)
    assert(ref, '输出引用必须可解析')
    return key(ref)
  }))]
  return { text, refs, memoryIds: result.hits.map(h => h.id) }
}
async function run(deps: SearchToolDeps, source: Source, selected = queries): Promise<Results> {
  const rows: Results = new Map()
  for (const q of selected) rows.set(q.id, await runOne(q, source, deps))
  return rows
}
const hit = (q: DialogueEvalQuery, row: Row) => q.answers.some(a => row.refs.slice(0, 5).includes(key(a)))
function metrics(rows: Results, selected: readonly DialogueEvalQuery[], baseline = rows) {
  const ids = (predicate: (q: DialogueEvalQuery, r: Row) => boolean) => selected.filter(q => predicate(q, rows.get(q.id)!)).map(q => q.id)
  return {
    n: selected.length, hit: ids(hit).length,
    added: ids((q, r) => hit(q, r) && !hit(q, baseline.get(q.id)!)),
    lost: ids((q, r) => !hit(q, r) && hit(q, baseline.get(q.id)!)),
    distractors: ids((q, r) => q.distractors?.some(a => r.refs.slice(0, 5).includes(key(a))) === true),
    falseReturn: ids((q, r) => q.answers.length === 0 && (r.refs.length > 0 || r.memoryIds.length > 0)),
  }
}
const gated = queries.filter(q => q.category !== 'paraphrase')
const weightQueries = queries.filter(q => ['bigram', 'single-char', 'mixed', 'identifier', 'fullwidth'].includes(q.category))
const guards = queries.filter(q => ['cross-word', 'no-answer'].includes(q.category))

// 补找接入后替换此步骤，返回相同的逐题结果，再用同一指标出表。
type Supplement = (deps: SearchToolDeps, source: Source) => Promise<Results>
async function supplementTable(strategy: Supplement | undefined, deps: SearchToolDeps, baseline: Results) {
  if (!strategy) { console.log('补找未实现，跳过'); return }
  console.log('补找', metrics(await strategy(deps, 'both'), gated, baseline))
}

// 将来适配器在检索候选形成后接入排序，固定关键词头部，只接收候选编号。
// 凭据选择复用 scripts/host-contract/test-model.ts 的 resolveTestModel；客户端走宿主路由。
// 此处不探测环境变量；模型调用失败交回规则结果，失败耗时仍计入。
type SortStep = { name: string; run(q: DialogueEvalQuery): Promise<Row> }
async function latencyTable(steps: SortStep[]) {
  const samples: Array<{ id: string; step: string; repeat: number; ms: number; failed: boolean; hit: boolean }> = []
  for (const q of queries) for (let repeat = 0; repeat < 5; repeat++) {
    const ordered = [...steps.slice(repeat % steps.length), ...steps.slice(0, repeat % steps.length)]
    for (const step of ordered) {
      const start = performance.now()
      let failed = false
      let row: Row
      try { row = await step.run(q) }
      catch (error) {
        if (step === steps[0]) throw error
        failed = true; row = await steps[0]!.run(q)
      }
      samples.push({ id: q.id, step: step.name, repeat, ms: performance.now() - start, failed, hit: hit(q, row) })
    }
  }
  for (const q of queries) for (const step of steps) {
    const values = samples.filter(s => s.id === q.id && s.step === step.name)
    const times = values.map(s => s.ms).sort((a, b) => a - b)
    console.log('延迟', JSON.stringify({ id: q.id, step: step.name, medianMs: times[2], p95Ms: times[4], samples: values }))
  }
}

async function main() {
  const { values } = parseArgs({ options: { rerank: { type: 'boolean', default: false } } })
  for (const mode of ['dictionary', 'fallback'] as const) {
    resetJieba(mode === 'fallback' ? missingJieba : undefined)
    const root = await mkdtemp(join(tmpdir(), 'dialogue-eval-'))
    let env: Awaited<ReturnType<typeof setup>> | undefined
    try {
      env = await setup(root)
      if (mode === 'dictionary' && env.tokenizer.degraded) { console.log('词典不可用，跳过词典档'); continue }
      const { deps, db, context, host, noReview, workspaceOf } = env
      const baselines = new Map<Source, Results>()
      for (const source of ['dialogue', 'both'] as const) {
        const baseline = await run(deps, source)
        const control = await run(variant(deps, DIALOGUE_BM25_WEIGHTS), source)
        for (const q of queries) assert.deepEqual(control.get(q.id), baseline.get(q.id), `${mode}/${source}/${q.id} 同序自检`)
        baselines.set(source, baseline)
      }
      console.log(`同序自检通过：${mode}，两来源各 ${queries.length} 题`)
      for (const [source, baseline] of baselines) {
        console.log('主结果', mode, source)
        for (const category of categories) console.log(category, JSON.stringify(metrics(baseline, queries.filter(q => q.category === category))))
        for (const q of queries) console.log('逐题', JSON.stringify({ id: q.id, ...baseline.get(q.id), hit: hit(q, baseline.get(q.id)!) }))
        console.log('两者相对只查原话', JSON.stringify(metrics(baseline, gated, baselines.get('dialogue')!)))
        for (const b of [1, 2, 3]) for (const c of [0.5, 1, 2]) {
          const rows = await run(variant(deps, [4, b, c]), source, [...weightQueries, ...guards])
          console.log('权重', mode, source, `4/${b}/${c}`, JSON.stringify({ score: metrics(rows, weightQueries, baseline), guards: metrics(rows, guards, baseline) }))
        }
        const small = await run(variant(deps, DIALOGUE_BM25_WEIGHTS, 1000), source)
        console.log('预算', mode, source, JSON.stringify({ configured: 1000, effective: dialogueBudgetOf(1000), score: metrics(small, gated, baseline) }))
        console.log('预算', mode, source, JSON.stringify({ configured: 1500, effective: dialogueBudgetOf(1500), score: metrics(baseline, gated, small) }))
      }
      for (const budget of [1000, 1500]) {
        let maxUsed = 0, evidence = 0, expanded = 0, maxChars = 0
        for (const q of queries) {
          const result = await searchDialogue({ query: q.query }, context, variant(deps, DIALOGUE_BM25_WEIGHTS, budget).dialogue!)
          assert.equal(result.kind, 'ready')
          assert((result.fill?.usedTokens ?? 0) <= dialogueBudgetOf(budget))
          maxUsed = Math.max(maxUsed, result.fill?.usedTokens ?? 0)
          const messages = result.groups.flatMap(g => g.turns.flatMap(t => t.messages.map(m => ({ ...m, sessionId: g.sessionId }))))
          if (q.category !== 'paraphrase' && q.answers.some(a => messages.some(m => key(a) === key(m) && m.text.includes(messageText(sessions.find(s => s.log.header.id === a.sessionId)!.log.events.find(e => e.seq === a.seq)!)!.text.split('\n').at(-1)!)))) evidence++
          for (const m of messages) {
            const out = await executeSource({ messageRef: formatMessageRef(m) }, context, { store: deps.store, host, noReview, workspaceOf, dialogueStore: db, isDialogueEnabled: () => true, dialogueToolResults: () => true })
            assert.equal(out.kind, 'ok')
            if (out.kind === 'ok') {
              const original = messageText(sessions.find(s => s.log.header.id === m.sessionId)!.log.events.find(e => e.seq === m.seq)!)!.text
              assert(out.lines.some(line => line.replace(/\n  /g, '\n').includes(original.slice(0, MESSAGE_REF_TEXT_CAP))), '展开应保留目标消息边界内的正文')
            }
            expanded++
          }
          for (const a of q.answers) {
            const text = messageText(sessions.find(s => s.log.header.id === a.sessionId)!.log.events.find(e => e.seq === a.seq)!)!.text
            maxChars = Math.max(maxChars, text.length)
          }
        }
        console.log('预算复核', JSON.stringify({ mode, configured: budget, effective: dialogueBudgetOf(budget), maxUsed, evidence, expanded, expansionCap: MESSAGE_REF_TEXT_CAP, maxAnswerChars: maxChars }))
      }
      for (const q of queries.filter(q => q.category === 'near-verbatim')) {
        const m = memories.find(m => m.id === q.anchorMemoryId)!
        const a = q.answers[0]!
        const text = messageText(sessions.find(s => s.log.header.id === a.sessionId)!.log.events.find(e => e.seq === a.seq)!)!.text
        console.log('去重现状', q.id, isSameAsMemory(text, m.body))
      }
      console.log(`带原话条数 2/3/4/5：固定 MEMORY_QUOTE_LIMIT=${MEMORY_QUOTE_LIMIT}，无参数入口，跳过对照；附原话预算固定 ${MEMORY_QUOTE_BUDGET_TOKENS}，不向下取整。`)
      console.log('相似度 0.90/0.95/0.98：生产只按 NFKC、小写、去空白后完全相等判断，阈值对照跳过。')
      await supplementTable(undefined, deps, baselines.get('both')!)
      console.log('未提供模型，跳过重排对比')
      console.log('重排开关', values.rerank ? '开启，等待模型适配器' : '关闭，仅规则排序')
      await latencyTable([{ name: '规则排序', run: q => runOne(q, 'both', deps) }])
    } finally {
      env?.db.close()
      resetJieba()
      await rm(root, { recursive: true, force: true })
    }
  }
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main()
