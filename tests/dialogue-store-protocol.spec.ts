import { afterEach, beforeEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DialogueRecordStore, DialogueStoreUnavailable } from '../src/storage/dialogue-records.ts'
import { readsSegmentText, sqliteProbe } from './helpers/sqlite-probe.ts'

let dir: string
const opened: DialogueRecordStore[] = []
const versions = { segmentRule: 1, tokenizer: 1, intake: 1 }
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-dialogue-protocol-')) })
afterEach(async () => {
  for (const store of opened.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

function rig() {
  const probe = sqliteProbe()
  const warnings: string[] = []
  const path = join(dir, 'records.sqlite')
  const store = new DialogueRecordStore({ path, loadSqlite: () => probe.module,
    log: { info() {}, error() {}, warn: message => { warnings.push(message) } } })
  opened.push(store)
  const state = store.prepare(versions, 'dict', '/sessions')
  if (state.status === 'none') throw new Error('夹具：准备之后应当有库')
  const fail = (error: unknown) => {
    probe.beforeExecute = () => { probe.beforeExecute = undefined; throw error }
    expect(() => store.state()).toThrow(DialogueStoreUnavailable)
  }
  return { store, probe, warnings, path, gen: state.write.gen, fail }
}

it('同一主错误码的扩展码和文案变化不重复告警，不同主错误码分别告警', () => {
  const { fail, warnings } = rig()
  for (const errcode of [13, 8, 10]) {
    for (const extended of [errcode, errcode | 256]) {
      fail(Object.assign(new Error(`故障 ${extended}`), { code: 'ERR_SQLITE_ERROR', errcode: extended }))
    }
  }
  expect(warnings).toHaveLength(3)
})

it('不满足 SQLite 错误码条件时按错误文本去重', () => {
  const { fail, warnings } = rig()
  fail(Object.assign(new Error('故障甲'), { code: 'OTHER', errcode: 13 }))
  fail(new Error('故障甲'))
  fail(Object.assign(new Error('故障乙'), { code: 'ERR_SQLITE_ERROR', errcode: '13' }))
  fail('故障乙')
  expect(warnings).toHaveLength(2)
})

it('没有待恢复的告警时不查写入计数，准备不写和删除零行不算恢复，写成一行才算恢复', () => {
  const { store, probe, gen, fail, warnings } = rig()
  const totalChanges = () => probe.record(() => store.state()).statements.filter(s => /total_changes\(/i.test(s.sql))
  expect(totalChanges()).toHaveLength(0)
  const error = Object.assign(new Error('disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
  fail(error)
  store.prepare(versions, 'dict', '/sessions')
  store.dequeue(gen, 'absent')
  fail(error)
  expect(warnings).toHaveLength(1)
  store.enqueue(gen, ['next'])
  expect(totalChanges()).toHaveLength(0)
  fail(error)
  expect(warnings).toHaveLength(2)
})

it('第二步读正文出错后关闭连接释放事务，下次检索仍返回完整正文', () => {
  const { store, probe, path, gen, warnings } = rig()
  const session = store.startSession(gen, 's1', { cwd: '/w', isSubagent: false })!
  expect(store.commitBatch({ gen, sessionId: 's1', revision: session.revision, dictionary: 'dict',
    fromWatermark: session.watermark, watermark: 1, turns: [{ turnSeq: 0 }],
    segments: [{ turnSeq: 0, seq: 1, segment: 0, speaker: 'user', text: 'alpha\0正文', w: 'alpha', b: '', c: '' }] })).toBe(true)
  probe.beforeExecute = statement => {
    if (!readsSegmentText(statement)) return
    probe.beforeExecute = undefined
    throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })
  }
  const search = () => store.search(gen, 'alpha', { limit: 1, weights: [4, 2, 1] })
  expect(search).toThrow(DialogueStoreUnavailable)
  const raw = new DatabaseSync(path)
  try { raw.exec('BEGIN EXCLUSIVE'); raw.exec('ROLLBACK') } finally { raw.close() }
  expect(search()).toMatchObject([{ text: 'alpha\0正文' }])
  expect(warnings).toHaveLength(1)
})

it('结构版本为一但缺时刻列时先重建库，再补覆盖索引', () => {
  const { store, path } = rig()
  store.close()
  const raw = new DatabaseSync(path)
  try { raw.exec('ALTER TABLE segments RENAME COLUMN at TO legacy_at') } finally { raw.close() }
  expect(store.state()).toEqual({ status: 'none' })
  expect(store.prepare(versions, 'dict', '/sessions')).toMatchObject({ status: 'building' })
  const fresh = new DatabaseSync(path)
  try {
    expect(fresh.prepare('PRAGMA index_info(segments_gen_at)').all().map(row => row.name)).toEqual(['gen', 'at'])
    expect(fresh.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
  } finally { fresh.close() }
})
