import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { env, ok, err, root } from './helpers/gui-command-env.ts'

// 设置页读对话记录库的状态（dialogue-records-state）：真 node:sqlite 的库放在临时目录，按存储层的接口造出各个状态。

const V1 = { segmentRule: 1, tokenizer: 1, intake: 1 }
const quiet = { info() {}, warn() {}, error() {} }
const storePath = () => join(root, 'local', 'dialogue-records.sqlite')

/** 准备好库，收两个会话（各一段、出队），返回库和这一代的代号。 */
function built() {
  const store = new DialogueRecordStore({ path: storePath(), log: quiet })
  const state = store.prepare(V1, '', '/sessions')
  if (state.status === 'none') throw new Error('准备之后应当有库')
  const gen = state.write.gen
  for (const sessionId of ['s1', 's2']) {
    const started = store.startSession(gen, sessionId, { cwd: '/w/app', isSubagent: false })!
    store.commitBatch({
      gen, sessionId, revision: started.revision, dictionary: '', fromWatermark: started.watermark, watermark: 1,
      segments: [{ turnSeq: 0, seq: 1, segment: 0, at: 1, speaker: 'user', text: 'alpha', w: 'alpha', b: 'alpha', c: '' }], turns: [{ turnSeq: 0, at: 1 }],
    })
    store.dequeue(gen, sessionId)
  }
  return { store, gen }
}

describe('dialogue-records-state', () => {
  it('还没建库：none，不因为读状态建出库文件', async () => {
    const store = new DialogueRecordStore({ path: storePath(), log: quiet })
    expect(ok(await env({ dialogueRecords: store }).run({ cmd: 'dialogue-records-state' })).dialogueRecords).toEqual({ status: 'none' })
    expect(store.state()).toEqual({ status: 'none' })
  })

  it('第一次在建：building，带已覆盖的会话数', async () => {
    const { store } = built()
    expect(ok(await env({ dialogueRecords: store }).run({ cmd: 'dialogue-records-state' })).dialogueRecords).toEqual({ status: 'building', sessions: 2 })
    store.close()
  })

  it('建好是 ready；规则变了在重建是 rebuilding', async () => {
    const { store, gen } = built()
    store.completeBuild(gen)
    const e = env({ dialogueRecords: store })
    expect(ok(await e.run({ cmd: 'dialogue-records-state' })).dialogueRecords).toEqual({ status: 'ready' })
    store.prepare({ ...V1, intake: 2 }, '', '/sessions')
    expect(ok(await e.run({ cmd: 'dialogue-records-state' })).dialogueRecords).toEqual({ status: 'rebuilding' })
    store.close()
  })

  it('库文件损坏：failed，文件原样不动、不删不建', async () => {
    await mkdir(dirname(storePath()), { recursive: true })
    await writeFile(storePath(), 'not a sqlite database '.repeat(400))
    const before = await readFile(storePath())
    const r = err(await env({ dialogueRecords: new DialogueRecordStore({ path: storePath(), log: quiet }) }).run({ cmd: 'dialogue-records-state' }))
    expect(r.code).toBe('failed')
    expect((await readFile(storePath())).equals(before)).toBe(true)
    expect(existsSync(storePath() + '-journal')).toBe(false)
  })

  it('结构版本和本插件不同的库（别的版本建的）：failed，文件原样不动', async () => {
    const { store, gen } = built()
    store.completeBuild(gen)
    store.close()
    const raw = new DatabaseSync(storePath())
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    const before = await readFile(storePath())
    const r = err(await env({ dialogueRecords: new DialogueRecordStore({ path: storePath(), log: quiet }) }).run({ cmd: 'dialogue-records-state' }))
    expect(r.code).toBe('failed')
    expect((await readFile(storePath())).equals(before)).toBe(true)
  })

  it('正常的库：读状态不改文件', async () => {
    const { store } = built()
    store.close()
    const before = await readFile(storePath())
    expect(ok(await env({ dialogueRecords: new DialogueRecordStore({ path: storePath(), log: quiet }) }).run({ cmd: 'dialogue-records-state' })).dialogueRecords).toEqual({ status: 'building', sessions: 2 })
    expect((await readFile(storePath())).equals(before)).toBe(true)
  })

  it('只读：体检关着、借来的是子 agent 会话也能读', async () => {
    const store = new DialogueRecordStore({ path: storePath(), log: quiet })
    expect(ok(await env({ dialogueRecords: store, governanceEnabled: false }).run({ cmd: 'dialogue-records-state' })).dialogueRecords).toEqual({ status: 'none' })
    expect(ok(await env({ dialogueRecords: store, delegationDepth: 1 }).run({ cmd: 'dialogue-records-state' })).dialogueRecords).toEqual({ status: 'none' })
  })
})
