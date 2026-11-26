import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DialogueRecordStore, DialogueStoreUnavailable, SKIPPED_WATERMARK,
  type DialogueBatch, type DialogueRecordStoreOptions, type DialogueSegmentInput, type DialogueVersions,
} from '../src/storage/dialogue-records.ts'
import { sqliteProbe } from './helpers/sqlite-probe.ts'

// 对话记录库的存储层：真 node:sqlite、临时目录。「另一个进程」用同一路径上的第二个实例模拟（各有自己的连接）。
// 三列索引词在这里手写（空格分开的词），分词器另有自己的测试。

let dir: string
let opened: DialogueRecordStore[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-dialogue-records-')) })
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

const storePath = () => join(dir, 'nested', 'dialogue-records.sqlite')
const V1: DialogueVersions = { segmentRule: 1, tokenizer: 1, intake: 1 }
const HOME = '/sessions/home'
const WEIGHTS = [4, 2, 1] as const

function open(extra: Partial<DialogueRecordStoreOptions> = {}) {
  const warnings: string[] = []
  const log = { info: () => {}, warn: (m: string) => { warnings.push(m) }, error: (m: string) => { warnings.push(m) } }
  const store = new DialogueRecordStore({ path: storePath(), log, ...extra })
  opened.push(store)
  return { store, warnings }
}

/** 一段：正文按空格切成词放进 w、b 两列，c 列留空。 */
const seg = (seq: number, text: string, extra: Partial<DialogueSegmentInput> = {}): DialogueSegmentInput =>
  ({ turnSeq: 0, seq, segment: 0, at: 1000 + seq, speaker: 'user', text, w: text, b: text, c: '', ...extra })

/** 准备好库并开始收一个会话，返回提交一批的函数（水位自己接着上一批）。 */
function begin(store: DialogueRecordStore, sessionId = 's1', cwd = '/w/app') {
  const state = store.prepare(V1, 'dict-1', HOME)
  if (state.status === 'none') throw new Error('准备之后应当有库')
  const gen = state.write.gen
  const started = store.startSession(gen, sessionId, { cwd, isSubagent: false })!
  let watermark = started.watermark
  const commit = (segments: DialogueSegmentInput[], to: number, extra: Partial<DialogueBatch> = {}) => {
    const ok = store.commitBatch({ gen, sessionId, revision: started.revision, dictionary: 'dict-1', fromWatermark: watermark, watermark: to, segments, turns: [{ turnSeq: 0, at: 1000 }], ...extra })
    if (ok) watermark = to
    return ok
  }
  return { gen, revision: started.revision, commit }
}
const texts = (store: DialogueRecordStore, gen: number, match: string) => store.search(gen, match, { limit: 20, weights: WEIGHTS }).map(h => h.text)

describe('状态', () => {
  it('没用过时不建库文件，状态是还没建', () => {
    const { store } = open()
    expect(store.state()).toEqual({ status: 'none' })
    expect(existsSync(storePath())).toBe(false)
  })

  it('准备之后是在建；待建的建完是可用；规则没变再准备一次不动', () => {
    const { store } = open()
    const first = store.prepare(V1, 'dict-1', HOME)
    expect(first).toMatchObject({ status: 'building', read: { gen: 1, versions: V1, dictionary: 'dict-1', isComplete: false }, write: { gen: 1 } })
    expect(store.completeBuild(1)).toBe(true)
    expect(store.state()).toMatchObject({ status: 'ready', read: { gen: 1, isComplete: true } })
    expect(store.prepare(V1, 'dict-2', HOME)).toMatchObject({ status: 'ready', read: { gen: 1, dictionary: 'dict-1' } })
  })

  for (const [what, changed] of [
    ['切段规则', { ...V1, segmentRule: 2 }], ['分词器', { ...V1, tokenizer: 2 }], ['收录规则', { ...V1, intake: 2 }],
  ] as const) {
    it(`${what}的版本变了：开新的一代重建，建好之前查询还读旧的，建好切过去并删掉旧的`, () => {
      const { store } = open()
      const { gen, commit } = begin(store)
      commit([seg(1, 'alpha')], 1)
      store.completeBuild(gen)
      const state = store.prepare(changed, 'dict-1', HOME)
      expect(state).toMatchObject({ status: 'rebuilding', read: { gen: 1, versions: V1 }, write: { gen: 2, versions: changed, isComplete: false } })
      expect(texts(store, 1, 'alpha')).toEqual(['alpha'])
      const next = store.startSession(2, 's1', { cwd: '/w/app', isSubagent: false })!
      expect(next.watermark).toBe(-1)
      store.commitBatch({ gen: 2, sessionId: 's1', revision: next.revision, dictionary: 'dict-1', fromWatermark: -1, watermark: 1, segments: [seg(1, 'alpha beta')], turns: [] })
      expect(store.completeBuild(2)).toBe(true)
      expect(store.state()).toMatchObject({ status: 'ready', read: { gen: 2 }, write: { gen: 2 } })
      expect(texts(store, 2, 'alpha')).toEqual(['alpha beta'])
      expect(texts(store, 1, 'alpha')).toEqual([])
      expect(store.session(1, 's1')).toBeUndefined()
    })
  }

  it('第一次还没建完规则就变了：直接换成新的一代，不留旧规则算出来的那部分', () => {
    const { store } = open()
    const { commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    expect(store.prepare({ ...V1, intake: 2 }, 'dict-1', HOME)).toMatchObject({ status: 'building', read: { gen: 2 }, write: { gen: 2 } })
    expect(texts(store, 1, 'alpha')).toEqual([])
  })

  it('重建到一半规则又变了：那半代丢掉，另开一代，查询仍读最早那一代', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    store.completeBuild(gen)
    store.prepare({ ...V1, intake: 2 }, 'dict-1', HOME)
    expect(store.prepare({ ...V1, intake: 3 }, 'dict-1', HOME)).toMatchObject({ status: 'rebuilding', read: { gen: 1 }, write: { gen: 3 } })
    expect(store.startSession(2, 's1', { cwd: undefined, isSubagent: false })).toBeUndefined()
    expect(store.completeBuild(2)).toBe(false)
    expect(texts(store, 1, 'alpha')).toEqual(['alpha'])
  })

  it('代号不复用：清空从头建之后接着往上数，手里拿着旧代号的批次提交不进来', () => {
    const { store } = open()
    const { gen, revision, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    const state = store.prepare(V1, 'dict-1', '/sessions/other')
    if (state.status === 'none') throw new Error('unreachable')
    expect(state.write.gen).toBeGreaterThan(gen)
    expect(store.commitBatch({ gen, sessionId: 's1', revision, dictionary: 'dict-1', fromWatermark: 1, watermark: 2, segments: [seg(2, 'beta')], turns: [] })).toBe(false)
  })

  it('建完时队里还有别人刚排进来的会话：不算建完；只剩点了名的那些（这一趟读不到日志的）才算', () => {
    const a = open().store
    const b = open().store
    const { gen } = begin(a)
    a.enqueue(gen, ['s7'])
    b.enqueue(gen, ['s8'])
    expect(a.completeBuild(gen, ['s7'])).toBe(false)
    expect(a.state()).toMatchObject({ status: 'building' })
    expect(a.completeBuild(gen, ['s7', 's8'])).toBe(true)
    expect(a.state()).toMatchObject({ status: 'ready' })
    expect(a.queued(gen, 10)).toEqual(['s7', 's8'])
  })

  it('会话日志的位置和库里记的不一样：当成别处的库，清空从头建', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    store.completeBuild(gen)
    const state = store.prepare(V1, 'dict-1', '/sessions/other')
    expect(state).toMatchObject({ status: 'building', read: { isComplete: false } })
    if (state.status === 'none') throw new Error('unreachable')
    expect(texts(store, state.read.gen, 'alpha')).toEqual([])
    expect(store.session(state.read.gen, 's1')).toBeUndefined()
  })
})

describe('按批提交', () => {
  it('一批里的段、轮次边界和水位一起进库；段原文逐字保留，按序号和段序号取得回来', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    const long = ' 第一段\n\n'
    expect(commit([seg(1, 'hello world'), seg(3, long, { segment: 0, speaker: 'assistant', turnSeq: 2 }), seg(3, '第二段 ', { segment: 1, speaker: 'assistant', turnSeq: 2 })], 3,
      { turns: [{ turnSeq: 0, at: 1000 }, { turnSeq: 2 }] })).toBe(true)
    expect(store.session(gen, 's1')).toMatchObject({ watermark: 3, isRemoved: false })
    expect(store.segmentsOf(gen, 's1', 0, 9).map(s => [s.seq, s.segment, s.speaker, s.turnSeq, s.text])).toEqual([
      [1, 0, 'user', 0, 'hello world'], [3, 0, 'assistant', 2, long], [3, 1, 'assistant', 2, '第二段 '],
    ])
    expect(store.segmentsOf(gen, 's1', 3, 3).map(s => s.text).join('')).toBe(`${long}第二段 `)
    expect(store.turnsOf(gen, 's1')).toEqual([{ turnSeq: 0, at: 1000 }, { turnSeq: 2, at: undefined }])
  })

  it('没有段、只有轮次边界的一批也推进水位（空轮）', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    expect(commit([], 5, { turns: [{ turnSeq: 4, at: 1 }] })).toBe(true)
    expect(store.session(gen, 's1')!.watermark).toBe(5)
    expect(store.turnsOf(gen, 's1')).toEqual([{ turnSeq: 4, at: 1 }])
  })

  it('一批中途出错：这一批的段、轮次边界、水位都不留，之后重提交不丢不重', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    // 同一条消息的同一段出现两次，第二次撞唯一键
    expect(() => commit([seg(2, 'beta'), seg(3, 'gamma'), seg(3, 'gamma')], 3, { turns: [{ turnSeq: 2 }] })).toThrow(DialogueStoreUnavailable)
    expect(store.session(gen, 's1')!.watermark).toBe(1)
    expect(texts(store, gen, 'beta')).toEqual([])
    expect(store.turnsOf(gen, 's1')).toEqual([{ turnSeq: 0, at: 1000 }])
    expect(commit([seg(2, 'beta'), seg(3, 'gamma')], 3)).toBe(true)
    expect(store.segmentsOf(gen, 's1', 0, 9).map(s => s.text)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('两个连接同时追同一个会话：从同一个水位算出来的两批只进一批，水位不回退', () => {
    const a = open().store
    const b = open().store
    const { gen, revision } = begin(a)
    const batch = (watermark: number, text: string): DialogueBatch => ({ gen, sessionId: 's1', revision, dictionary: 'dict-1', fromWatermark: -1, watermark, segments: [seg(1, text)], turns: [] })
    expect(b.commitBatch(batch(2, 'from b'))).toBe(true)
    expect(a.commitBatch(batch(1, 'from a'))).toBe(false)
    expect(a.session(gen, 's1')!.watermark).toBe(2)
    expect(a.segmentsOf(gen, 's1', 0, 9).map(s => s.text)).toEqual(['from b'])
  })

  it('水位比起算的还小的一批不要', () => {
    const { store } = open()
    const { gen, revision, commit } = begin(store)
    commit([seg(5, 'alpha')], 5)
    expect(store.commitBatch({ gen, sessionId: 's1', revision, dictionary: 'dict-1', fromWatermark: 5, watermark: 3, segments: [], turns: [] })).toBe(false)
    expect(store.session(gen, 's1')!.watermark).toBe(5)
  })
})

describe('把会话移出库', () => {
  it('段、全文索引行、轮次边界、排队记录都删掉；拿着旧修订号的批次提交不进来，删掉的不会被写回', () => {
    const a = open().store
    const b = open().store
    const { gen, revision, commit } = begin(a)
    commit([seg(1, 'alpha')], 1)
    a.enqueue(gen, ['s1'])
    b.removeSession('s1')
    expect(a.commitBatch({ gen, sessionId: 's1', revision, dictionary: 'dict-1', fromWatermark: 1, watermark: 2, segments: [seg(2, 'beta')], turns: [] })).toBe(false)
    expect(a.commitBatch({ gen, sessionId: 's1', revision, dictionary: 'dict-1', fromWatermark: -1, watermark: 2, segments: [seg(2, 'beta')], turns: [] })).toBe(false)
    expect(texts(a, gen, 'alpha OR beta')).toEqual([])
    expect(a.segmentsOf(gen, 's1', 0, 9)).toEqual([])
    expect(a.turnsOf(gen, 's1')).toEqual([])
    expect(a.queued(gen, 10)).toEqual([])
    expect(a.session(gen, 's1')).toMatchObject({ watermark: -1, isRemoved: true })
    expect(a.sessionIds(gen)).toEqual([])
  })

  it('移出后重新开始收：换一个修订号从头来', () => {
    const { store } = open()
    const { gen, revision, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    store.removeSession('s1')
    const again = store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false })!
    expect(again).toMatchObject({ watermark: -1, isRemoved: false })
    expect(again.revision).not.toBe(revision)
    expect(store.commitBatch({ gen, sessionId: 's1', revision: again.revision, dictionary: 'dict-1', fromWatermark: -1, watermark: 1, segments: [seg(1, 'alpha')], turns: [] })).toBe(true)
    expect(texts(store, gen, 'alpha')).toEqual(['alpha'])
  })

  it('记整个不收：只在还一条没收到、修订号对得上时记；记了之后照旧能从头收', () => {
    const { store } = open()
    const { gen, revision } = begin(store)
    store.markSkipped(gen, 's1', revision + 1)
    expect(store.session(gen, 's1')).toMatchObject({ watermark: -1 })
    store.markSkipped(gen, 's1', revision)
    expect(store.session(gen, 's1')).toMatchObject({ watermark: SKIPPED_WATERMARK, isRemoved: false })
    expect(store.commitBatch({ gen, sessionId: 's1', revision, dictionary: 'dict-1', fromWatermark: SKIPPED_WATERMARK, watermark: 1, segments: [seg(1, 'alpha')], turns: [] })).toBe(true)
    store.markSkipped(gen, 's1', revision)
    expect(store.session(gen, 's1')).toMatchObject({ watermark: 1 })
  })

  it('删掉的对话不留在库文件和它旁边的日志文件里', async () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    const secret = 'zq9-unique-phrase-in-dialogue'
    commit([seg(1, secret, { w: 'zq9uniq', b: 'zq9uniq' })], 1)
    store.removeSession('s1')
    store.close()
    for (const suffix of ['', '-journal', '-wal']) {
      const bytes = await readFile(storePath() + suffix).catch(() => Buffer.alloc(0))
      expect(bytes.includes(secret)).toBe(false)
      expect(bytes.includes('zq9uniq')).toBe(false)
    }
    expect(gen).toBe(1)
  })

  it('段的行号不复用：移出一个会话之后新收的段排在所有旧行号后面，按行号往后翻不会漏', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    commit([seg(1, 'alpha'), seg(2, 'beta')], 2)
    const last = store.segmentsAfter(gen, 0, 10).at(-1)!.id
    store.removeSession('s1')
    const again = begin(store, 's2')
    again.commit([seg(1, 'gamma')], 1)
    expect(store.segmentsAfter(gen, last, 10).map(r => r.text)).toEqual(['gamma'])
  })

  it('按行号往后取段时沿行号范围扫，不按代取出整代再排序', () => {
    const probe = sqliteProbe()
    const { store } = open({ loadSqlite: () => probe.module })
    const { gen, commit } = begin(store)
    commit(Array.from({ length: 30 }, (_, i) => seg(i + 1, `alpha ${i}`)), 30)
    const { result, statements } = probe.record(() => store.segmentsAfter(gen, 10, 5))
    expect(result.map(r => r.text)).toEqual(['alpha 10', 'alpha 11', 'alpha 12', 'alpha 13', 'alpha 14'])
    const raw = new DatabaseSync(storePath())
    try {
      const plans = statements.filter(st => [...st.reads].some(r => r.startsWith('segments.')))
        .map(st => (raw.prepare(`EXPLAIN QUERY PLAN ${st.sql}`).all() as Array<{ detail: string }>).map(p => p.detail))
      expect(plans).toHaveLength(1)
      expect(plans[0]).toEqual(['SEARCH segments USING INTEGER PRIMARY KEY (rowid>?)'])
    } finally {
      raw.close()
    }
  })

  it('排队可以按位置一个个往后翻', () => {
    const { store } = open()
    const { gen } = begin(store)
    store.enqueue(gen, ['s3', 's1', 's2'])
    const first = store.queuedAfter(gen, 0, 1)[0]!
    expect(first.sessionId).toBe('s3')
    expect(store.queuedAfter(gen, first.position, 5).map(q => q.sessionId)).toEqual(['s1', 's2'])
  })

  it('重建切换与旧批次交错：新的一代切过去之后，往旧的一代提交的批次不要', () => {
    const a = open().store
    const b = open().store
    const { gen, revision, commit } = begin(a)
    commit([seg(1, 'alpha')], 1)
    a.completeBuild(gen)
    b.prepare({ ...V1, intake: 2 }, 'dict-1', HOME)
    b.completeBuild(2)
    expect(a.commitBatch({ gen, sessionId: 's1', revision, dictionary: 'dict-1', fromWatermark: 1, watermark: 2, segments: [seg(2, 'beta')], turns: [] })).toBe(false)
    expect(a.state()).toMatchObject({ status: 'ready', read: { gen: 2 } })
    expect(texts(a, 2, 'beta')).toEqual([])
  })
})

describe('待建队列和覆盖情况', () => {
  it('排队按先后、不重复；存在库里，换一个连接接着取；建完一个拿掉一个', () => {
    const { store } = open()
    const { gen } = begin(store)
    store.enqueue(gen, ['s3', 's1'])
    store.enqueue(gen, ['s1', 's2'])
    store.close()
    const again = open().store
    expect(again.queued(gen, 2)).toEqual(['s3', 's1'])
    again.dequeue(gen, 's3')
    expect(again.queued(gen, 10)).toEqual(['s1', 's2'])
  })

  it('记下会话收的时候是不是开着：再收一次时按新的状态改，移出的不算', () => {
    const { store } = open()
    const { gen } = begin(store)
    expect(store.openSessionIds(gen)).toEqual([])
    store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false, isOpen: true })
    store.startSession(gen, 's2', { cwd: '/w/app', isSubagent: false, isOpen: true })
    expect(store.openSessionIds(gen)).toEqual(['s1', 's2'])
    store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false })
    store.removeSession('s2')
    expect(store.openSessionIds(gen)).toEqual([])
  })

  it('覆盖情况：收过且不在排队的会话数、还在排队的个数、库里最晚一段的时刻', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    expect(store.coverage(gen)).toEqual({ sessions: 1, queued: 0, coveredUntil: undefined })
    commit([seg(1, 'alpha', { at: 5000 }), seg(2, 'beta', { at: 7000 })], 2)
    store.startSession(gen, 's2', { cwd: '/w/app', isSubagent: false })
    store.enqueue(gen, ['s2', 's9'])
    expect(store.coverage(gen)).toEqual({ sessions: 1, queued: 2, coveredUntil: 7000 })
  })
})

describe('没变就不写', () => {
  /** 一段操作里开了几次写事务，连同它的返回值。 */
  function counted<T>(action: () => T): { result: T; transactions: number } {
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    try {
      const result = action()
      return { result, transactions: exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE').length }
    } finally {
      exec.mockRestore()
    }
  }
  /** 用另一个连接直接看会话那一行。 */
  function sessionRow(gen: number, sessionId: string) {
    const raw = new DatabaseSync(storePath())
    try {
      return raw.prepare('SELECT revision, cwd, is_subagent, is_open, is_removed FROM sessions WHERE gen = ? AND session_id = ?').get(gen, sessionId)
    } finally {
      raw.close()
    }
  }

  it('准备：记的会话日志位置和正在写的那一代规则都没变，不开写事务，返回当前状态', () => {
    const { store } = open()
    const { gen } = begin(store)
    const { result, transactions } = counted(() => store.prepare(V1, 'dict-1', HOME))
    expect(transactions).toBe(0)
    expect(result).toEqual(store.state())
    expect(result).toMatchObject({ write: { gen } })
  })

  it('准备：库在但还没有任何一代、规则变了、会话日志位置变了，都照常在写事务里建', () => {
    const { store } = open()
    // 先让库文件和表建出来，只数准备这一步
    expect(store.sessionIds(1)).toEqual([])
    const fresh = counted(() => store.prepare(V1, 'dict-1', HOME))
    expect(fresh.transactions).toBe(1)
    expect(fresh.result).toMatchObject({ status: 'building', write: { gen: 1 } })
    store.completeBuild(1)
    const changed = counted(() => store.prepare({ ...V1, intake: 2 }, 'dict-1', HOME))
    expect(changed.transactions).toBe(1)
    expect(changed.result).toMatchObject({ status: 'rebuilding', read: { gen: 1 }, write: { gen: 2 } })
    const moved = counted(() => store.prepare({ ...V1, intake: 2 }, 'dict-1', '/sessions/other'))
    expect(moved.transactions).toBe(1)
    expect(moved.result).toMatchObject({ status: 'building', read: { gen: 3 }, write: { gen: 3 } })
  })

  it('开始收会话：已有这个会话、工作目录和是不是子代理、开没开都没变，不开写事务，返回已有进度', () => {
    const { store } = open()
    const { gen, revision, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false, isOpen: true })
    const { result, transactions } = counted(() => store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false, isOpen: true }))
    expect(transactions).toBe(0)
    expect(result).toEqual({ watermark: 1, revision, isRemoved: false })
  })

  it('别的连接正拿着写锁：没变的会话照常返回进度，不报忙', () => {
    const { store } = open()
    const { gen, revision } = begin(store)
    const other = new DatabaseSync(storePath())
    other.exec('BEGIN IMMEDIATE')
    try {
      expect(store.prepare(V1, 'dict-1', HOME)).toMatchObject({ write: { gen } })
      expect(store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false })).toEqual({ watermark: -1, revision, isRemoved: false })
    } finally {
      other.exec('ROLLBACK')
      other.close()
    }
  })

  it.each([
    ['工作目录', { cwd: '/w/other', isSubagent: false }, { cwd: '/w/other', is_subagent: 0, is_open: 0 }],
    ['是不是子代理', { cwd: '/w/app', isSubagent: true }, { cwd: '/w/app', is_subagent: 1, is_open: 0 }],
    ['开没开', { cwd: '/w/app', isSubagent: false, isOpen: true }, { cwd: '/w/app', is_subagent: 0, is_open: 1 }],
  ] as const)('开始收会话：%s变了，照常写一次，进度不变', (_what, info, row) => {
    const { store } = open()
    const { gen, revision, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    const { result, transactions } = counted(() => store.startSession(gen, 's1', info))
    expect(transactions).toBe(1)
    expect(result).toEqual({ watermark: 1, revision, isRemoved: false })
    expect(sessionRow(gen, 's1')).toMatchObject({ ...row, revision, is_removed: 0 })
  })

  it('开始收会话：没收过的、移出过的，照常在写事务里从头收', () => {
    const { store } = open()
    const { gen, revision } = begin(store)
    const added = counted(() => store.startSession(gen, 's2', { cwd: '/w/app', isSubagent: false }))
    expect(added.transactions).toBe(1)
    expect(added.result).toMatchObject({ watermark: -1, isRemoved: false })
    store.removeSession('s1')
    const back = counted(() => store.startSession(gen, 's1', { cwd: '/w/app', isSubagent: false }))
    expect(back.transactions).toBe(1)
    expect(back.result).toMatchObject({ watermark: -1, isRemoved: false })
    expect(back.result!.revision).not.toBe(revision)
    expect(sessionRow(gen, 's1')).toMatchObject({ is_removed: 0 })
  })
})

describe('查询', () => {
  function seeded() {
    const { store } = open()
    const one = begin(store, 's1', '/w/app')
    one.commit([seg(1, 'deploy steps', { speaker: 'user' }), seg(2, 'deploy deploy checklist', { speaker: 'assistant' }), seg(3, 'deploy error log', { speaker: 'tool' })], 3)
    const two = begin(store, 's2', '/w/other')
    two.commit([seg(1, 'deploy elsewhere')], 1)
    return { store, gen: one.gen }
  }

  it('按相关度排，带回会话的工作目录和是否子 agent 会话', () => {
    const { store, gen } = seeded()
    const hits = store.search(gen, 'w : "deploy"', { limit: 10, weights: WEIGHTS })
    expect(hits.map(h => h.text).sort()).toEqual(['deploy deploy checklist', 'deploy elsewhere', 'deploy error log', 'deploy steps'])
    expect(hits.every((h, i) => i === 0 || hits[i - 1]!.score <= h.score)).toBe(true)
    expect(hits.find(h => h.sessionId === 's2')).toMatchObject({ cwd: '/w/other', isSubagent: false, seq: 1, segment: 0, turnSeq: 0 })
  })

  it('可以只要某些说话人、某些工作目录，可以排除会话，可以限条数', () => {
    const { store, gen } = seeded()
    const search = (extra: object) => store.search(gen, 'deploy', { limit: 10, weights: WEIGHTS, ...extra }).map(h => h.text).sort()
    expect(search({ speakers: ['user', 'assistant'] })).toEqual(['deploy deploy checklist', 'deploy elsewhere', 'deploy steps'])
    expect(search({ cwds: ['/w/other'] })).toEqual(['deploy elsewhere'])
    expect(search({ cwds: [] })).toEqual([])
    expect(search({ excludeSessionIds: ['s1'] })).toEqual(['deploy elsewhere'])
    expect(search({ limit: 2 })).toHaveLength(2)
  })

  it('换词典后只重算 w 列：原来的词搜不到了，新词搜得到，b 列和原文不动；算到哪记在库里，换一个连接接着算', () => {
    const { store, gen } = seeded()
    expect(store.beginDictionary(gen, 'dict-2')).toBe(true)
    expect(store.state()).toMatchObject({ read: { dictionary: 'dict-2', wRewriteAfter: 0 } })
    const rows = store.segmentsAfter(gen, 0, 2)
    expect(rows.map(r => r.text)).toEqual(['deploy steps', 'deploy deploy checklist'])
    expect(store.rewriteW(gen, 'dict-2', rows.map(r => ({ id: r.id, w: 'rollout' })), rows.at(-1)!.id)).toBe(true)
    store.close()
    const again = open().store
    const state = again.state()
    if (state.status === 'none') throw new Error('unreachable')
    expect(state.read.wRewriteAfter).toBe(rows.at(-1)!.id)
    const rest = again.segmentsAfter(gen, state.read.wRewriteAfter!, 10)
    expect(rest.map(r => r.text)).toEqual(['deploy error log', 'deploy elsewhere'])
    expect(again.search(gen, 'w : "rollout"', { limit: 10, weights: WEIGHTS }).map(h => h.text).sort()).toEqual(['deploy deploy checklist', 'deploy steps'])
    expect(again.search(gen, 'w : "deploy"', { limit: 10, weights: WEIGHTS }).map(h => h.text).sort()).toEqual(['deploy elsewhere', 'deploy error log'])
    expect(again.search(gen, 'b : "deploy"', { limit: 10, weights: WEIGHTS })).toHaveLength(4)
    expect(again.rewriteW(gen, 'dict-2', rest.map(r => ({ id: r.id, w: 'rollout' })), rest.at(-1)!.id)).toBe(true)
    expect(again.rewriteW(gen, 'dict-2', [])).toBe(true)
    expect(again.state()).toMatchObject({ read: { dictionary: 'dict-2', wRewriteAfter: undefined } })
    expect(again.rewriteW(99, 'dict-2', [])).toBe(false)
  })

  it('换了词典之后，按旧词典算的批不要；重算时词典又被换了，这一批重算也不要', () => {
    const { store, gen } = seeded()
    const stale = store.startSession(gen, 's3', { cwd: '/w/app', isSubagent: false })!
    store.beginDictionary(gen, 'dict-2')
    const batch = (dictionary: string): DialogueBatch => ({ gen, sessionId: 's3', revision: stale.revision, dictionary, fromWatermark: -1, watermark: 1, segments: [seg(1, 'late words')], turns: [] })
    expect(store.commitBatch(batch('dict-1'))).toBe(false)
    expect(store.session(gen, 's3')!.watermark).toBe(-1)
    const rows = store.segmentsAfter(gen, 0, 10)
    store.beginDictionary(gen, 'dict-3')
    expect(store.rewriteW(gen, 'dict-2', rows.map(r => ({ id: r.id, w: 'rollout' })), rows.at(-1)!.id)).toBe(false)
    expect(store.search(gen, 'w : "rollout"', { limit: 10, weights: WEIGHTS })).toEqual([])
    expect(store.commitBatch(batch('dict-3'))).toBe(true)
  })

  it('分词器降级时收的批没有整词列：照收，记下从哪开始要补算；补算收尾时又来了这样的批，不算补完', () => {
    const { store, gen } = seeded()
    expect(store.state()).toMatchObject({ read: { wRewriteAfter: undefined } })
    const s3 = store.startSession(gen, 's3', { cwd: '/w/app', isSubagent: false })!
    const batch = (from: number, to: number): DialogueBatch => ({
      gen, sessionId: 's3', revision: s3.revision, dictionary: '', fromWatermark: from, watermark: to, segments: [seg(to, `plain ${to}`, { w: '' })], turns: [],
    })
    expect(store.commitBatch(batch(-1, 1))).toBe(true)
    const state = store.state()
    if (state.status === 'none') throw new Error('unreachable')
    const after = state.read.wRewriteAfter!
    expect(store.segmentsAfter(gen, after, 10).map(r => r.text)).toEqual(['plain 1'])
    // 另一个连接读完要补的段、正要收尾时，又进来一批没有整词列的
    const rows = store.segmentsAfter(gen, after, 10)
    expect(store.rewriteW(gen, 'dict-1', rows.map(r => ({ id: r.id, w: 'plain' })), rows.at(-1)!.id)).toBe(true)
    expect(open().store.commitBatch(batch(1, 2))).toBe(true)
    expect(store.rewriteW(gen, 'dict-1', [])).toBe(true)
    const left = store.state()
    if (left.status === 'none') throw new Error('unreachable')
    expect(store.segmentsAfter(gen, left.read.wRewriteAfter!, 10).map(r => r.text)).toEqual(['plain 2'])
  })

  it('正文里的 NUL 字符原样取得回来', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    const text = 'before\u0000after alpha'
    commit([seg(1, text)], 1)
    expect(store.segmentsOf(gen, 's1', 0, 9).map(s => s.text)).toEqual([text])
    expect(texts(store, gen, 'alpha')).toEqual([text])
    expect(store.segmentsAfter(gen, 0, 10).map(r => r.text)).toEqual([text])
  })
})

describe('用不了的时候', () => {
  it('node:sqlite 加载不到：每个操作都抛「这一次用不了」，不建文件', () => {
    const { store } = open({ loadSqlite: () => undefined })
    expect(() => store.prepare(V1, '', HOME)).toThrow(DialogueStoreUnavailable)
    expect(existsSync(storePath())).toBe(false)
  })

  it('库文件是坏的：删掉换新库，照常能用', async () => {
    const first = open().store
    first.prepare(V1, '', HOME)
    first.close()
    await writeFile(storePath(), 'not a database, definitely '.repeat(200))
    const { store } = open()
    expect(store.prepare(V1, '', HOME)).toMatchObject({ status: 'building' })
  })

  it('库的结构版本和本插件的不一样：删库重建', () => {
    const first = open().store
    const { gen, commit } = begin(first)
    commit([seg(1, 'alpha')], 1)
    first.close()
    const raw = new DatabaseSync(storePath())
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    const { store } = open()
    expect(store.state()).toEqual({ status: 'none' })
    expect(gen).toBe(1)
  })

  it('结构版本不一样的库正被别的连接写着：这一次用不了，库不动', () => {
    const first = open().store
    const { commit } = begin(first)
    commit([seg(1, 'alpha')], 1)
    first.close()
    const other = new DatabaseSync(storePath())
    other.exec('PRAGMA user_version = 99')
    other.exec('BEGIN IMMEDIATE')
    const { store } = open()
    expect(() => store.state()).toThrow(DialogueStoreUnavailable)
    other.exec('ROLLBACK')
    expect((other.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n).toBe(1)
    other.close()
  })

  it('库正被别的连接占着：抛「忙」，不删库；对方放开后照常能用，原来的行还在', () => {
    const { store } = open()
    const { gen, commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    const other = new DatabaseSync(storePath())
    other.exec('BEGIN EXCLUSIVE')
    let caught: unknown
    try { store.enqueue(gen, ['s2']) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(DialogueStoreUnavailable)
    expect((caught as DialogueStoreUnavailable).isBusy).toBe(true)
    other.exec('ROLLBACK')
    other.close()
    expect(texts(store, gen, 'alpha')).toEqual(['alpha'])
  })

  it('删库：文件没了，之后从还没建开始', () => {
    const { store } = open()
    const { commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    store.destroy()
    expect(existsSync(storePath())).toBe(false)
    expect(store.state()).toEqual({ status: 'none' })
  })

  it('删库时文件删不掉：抛错，不当成删掉了', async () => {
    const { store } = open()
    const { commit } = begin(store)
    commit([seg(1, 'alpha')], 1)
    store.close()
    // 旁边的日志文件位置上放一个非空目录：删不掉
    await mkdir(storePath() + '-wal', { recursive: true })
    await writeFile(join(storePath() + '-wal', 'keep'), 'x')
    expect(() => store.destroy()).toThrow()
  })
})

it('放行集合下推查询，空集合不打开库，两千个会话不超参数上限', () => {
  const { store } = open()
  const a = begin(store, 'allowed'); a.commit([seg(1, 'needle')], 1)
  const b = begin(store, 'denied'); b.commit(Array.from({ length: 100 }, (_, i) => seg(i + 1, 'needle')), 100)
  expect(store.search(a.gen, 'needle', { weights: WEIGHTS, limit: 60, sessionIds: ['allowed'] }).map(h => h.sessionId)).toEqual(['allowed'])
  const ids = Array.from({ length: 2000 }, (_, i) => i === 0 ? 'allowed' : `s${i}`)
  expect(store.search(a.gen, 'needle', { weights: WEIGHTS, limit: 60, sessionIds: ids })).toHaveLength(1)
  const unavailable = open({ loadSqlite: () => { throw new Error('不该打开库') } }).store
  expect(unavailable.search(a.gen, 'needle', { weights: WEIGHTS, limit: 60, sessionIds: [] })).toEqual([])
})
