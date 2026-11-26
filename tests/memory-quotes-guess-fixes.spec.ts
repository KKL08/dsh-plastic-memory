import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { judgeGuess, lookbackTurns, quoteTurnKey, unlocatedTurns } from '../src/search/memory-quotes.ts'
import { ANCHOR_TURN_MISMATCH_NOTE, GUESSED_SOURCE_MARK } from '../src/search/dialogue-format.ts'
import { quoteMemories, type MemoryQuoteDeps } from '../src/tools/memory-quotes.ts'
import type { SourceAnchor } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
const memory = '部署脚本先跑数据库迁移再重启服务'
const anchor = (start: number, end = start + 2): SourceAnchor => ({ sessionId: 's', eventRange: [start, end], at: 1000 + start, change: 'create', sourceMode: 'user-explicit' })
const item = (id: string, anchors: SourceAnchor[], content = memory) => ({ record: record({ id, content, scope: 'workspace', workspacePath: '/proj', source: { sessionId: 's', eventRange: anchors[0]!.eventRange, sourceMode: 'user-explicit' }, sourceTrail: anchors }) })
let dir: string
let db: DialogueRecordStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guess-fixes-'))
  db = new DialogueRecordStore({ path: join(dir, 'db'), log: { info() {}, warn() {}, error() {} } })
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

function setup(texts: string[]) {
  db.prepare({ segmentRule: 1, tokenizer: 1, intake: 1 }, 'dict', '/sessions')
  const started = db.startSession(1, 's', { cwd: '/proj', isSubagent: false })!
  const turns = texts.map((_, i) => ({ turnSeq: (i + 1) * 10, at: 1000 + (i + 1) * 10 }))
  expect(db.commitBatch({ gen: 1, sessionId: 's', revision: started.revision, dictionary: 'dict', fromWatermark: started.watermark, watermark: texts.length * 10 + 2,
    turns, segments: texts.map((text, i) => ({ turnSeq: turns[i]!.turnSeq, seq: turns[i]!.turnSeq + 1, segment: 0, at: turns[i]!.at + 1, speaker: 'user', text, ...tokenizer.columns(text) })),
  })).toBe(true)
  db.completeBuild(1)
  const reads: number[][] = []
  let turnReads = 0
  const store: MemoryQuoteDeps['store'] = {
    state: () => db.state(), session: (...args) => db.session(...args), isQueued: (...args) => db.isQueued(...args),
    turnsOf: (...args) => { turnReads++; return db.turnsOf(...args) },
    segmentsOf: (...args) => { reads.push([args[2], args[3]]); return db.segmentsOf(...args) },
  }
  const deps: MemoryQuoteDeps = { store, tokenizer: async () => tokenizer, isOutOfScope: () => false,
    sessionTable: async () => ({ isComplete: true, get: () => ({ workspacePath: '/proj', isSubagent: false }), isMarkedNoReview: () => false }),
  }
  return { reads, turnReads: () => turnReads, run: (items: ReturnType<typeof item>[]) => quoteMemories(items, '', { workspacePath: '/proj', session: { id: 'cur', lastSeq: 0 } }, deps) }
}

it.each([0, 3])('起点 %s 无法定位时只读取覆盖范围内最近二十轮', async start => {
  const f = setup(Array.from({ length: 30 }, () => memory))
  const result = await f.run([item('m', [anchor(start, 302)])])
  expect(result.quotes[0]!.turns[0]!.view.provenance).toBe('guessed')
  expect(f.reads.map(r => r[0])).toEqual(Array.from({ length: 20 }, (_, i) => (i + 11) * 10))
})
it.each([false, true])('实际锚与推测轮重合时无论顺序都按实际锚标记：反序 %s', async reverse => {
  const f = setup([memory, '今天天气不错', '请记下来'])
  const anchors = [anchor(30), anchor(10)]
  const result = await f.run([item('m', reverse ? anchors.reverse() : anchors)])
  expect(result.quotes[0]!.turns.find(t => t.key === quoteTurnKey('s', 10))!.view.provenance).toBeUndefined()
})
it('多轮锚的首轮被其他记忆认领时在剩下的首个锚轮补说明', async () => {
  const f = setup(['缓存失效策略改成按版本号刷新', '今天下午三点开站会'])
  const result = await f.run([item('a', [anchor(10)], '缓存失效策略改成按版本号刷新'), item('b', [anchor(10, 22)], '苍穹碧海群鹭翱翔')])
  expect(result.quotes[1]!.turns.map(t => [t.key, t.view.provenance])).toEqual([[quoteTurnKey('s', 20), 'anchor-mismatch']])
})
it.each([memory, '……！'])('锚轮判 keep 时不读取回看候选：%s', async content => {
  const f = setup([memory, memory, memory, memory, memory, memory])
  await f.run([item('m', [anchor(60)], content)])
  expect(f.reads.map(r => r[0])).toEqual([60, 60])
})
it('每个锚只读取一次轮次表', async () => {
  const f = setup([memory])
  await f.run([item('m', [anchor(10)])])
  expect(f.turnReads()).toBe(1)
})
it('定位不到且正文切不出二元组时不读取候选', async () => {
  const f = setup([memory, memory])
  await f.run([item('m', [anchor(0, 22)], '……！')])
  expect(f.reads).toEqual([])
})
it('差值恰好等于门槛时给出推测轮，少一个共有词时不给', () => {
  const words = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0x5000 + 2 * i, 0x5001 + 2 * i))
  const turn = (n: number, turnSeq: number) => ({ turnSeq, segments: [{ sessionId: 's', turnSeq, seq: turnSeq + 1, segment: 0, at: undefined, speaker: 'user', text: words.slice(0, n).join('，') }] })
  const judge = (n: number) => judgeGuess({ memory: words.join('，'), tokenizer, anchorTurns: [turn(11, 20)], candidates: [turn(n, 10)] })
  expect(judge(17)).toEqual({ kind: 'guessed', turnSeq: 10 })
  expect(judge(16)).toEqual({ kind: 'mismatch' })
})
it.each([0, -1])('候选数 %s 返回空，坏区间仍返回 undefined', count => {
  const rows = [10, 20, 30].map(turnSeq => ({ turnSeq, at: undefined }))
  expect(lookbackTurns(rows, 40, count)).toEqual([])
  expect(unlocatedTurns([0, 35], rows, count)).toEqual([])
  expect(unlocatedTurns([3, 35], rows, count)).toEqual([])
  expect(unlocatedTurns([35, 0], rows, count)).toBeUndefined()
  expect(unlocatedTurns([10, 35], rows, count)).toBeUndefined()
})
it('两句标注采用定稿措辞', () => {
  expect(GUESSED_SOURCE_MARK).toBe('【推测出处】下面这一轮是按内容相近补找的，供参考')
  expect(ANCHOR_TURN_MISMATCH_NOTE).toBe('【出处待确认】上面这一轮是保存时记下的，和记忆内容重合少，内容可能出自更早几轮')
})
