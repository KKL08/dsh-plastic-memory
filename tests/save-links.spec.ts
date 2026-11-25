import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { layerOf, type HistoryVersion } from '../src/storage/history.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { globalConfirmCode, runSavePipeline, type PipelineResult, type SaveDelegation } from '../src/pipeline.ts'
import { renderSaveResult } from '../src/tools/save.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { LINKS_PER_KIND_MAX, premiseDigest } from '../src/links.ts'
import { scopeAt } from '../src/scope.ts'
import { MEMORY_ID_MAX_LENGTH, type MemoryRecord } from '../src/record-schema.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { candidate, record } from './helpers/record.ts'
import { noInstructions } from './helpers/instructions.ts'

// 保存时建关联、决定记录带前提：经真实的保存管线，落在真实文件表和 .state 侧表上。

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const WS = '/tmp/pm-links'
const OTHER_WS = '/tmp/pm-links-other'
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registry = buildTypeRegistry({ template: 'office', customTypes: {} })
/** 反向查询带的来源目录：本项目的记忆目录。 */
const wsDir = () => join(root, workspaceDirName(WS))

let root: string
const journals: OpJournal[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-links-')) })
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
})

/** isJournaled：带操作日志和写锁，写完断掉的步骤下次进写入段补做（同接线层）。 */
function env(opts: { isJournaled?: boolean } = {}) {
  const clock = { now: T0 }
  const now = () => clock.now
  const journal = opts.isJournaled === true ? new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quietLog }) : undefined
  if (journal !== undefined) journals.push(journal)
  // 同接线层：侧表、文件表、待决账本用同一把写锁
  const lock = journal === undefined ? undefined : createRootLock({ root, log: quietLog })
  const sidecar = new SidecarStore({ root, log: quietLog, now, schemas: sidecarSchemas, ...(lock !== undefined ? { lock } : {}) })
  // 两个文件表各自一份：像两个会话、两个进程各开一个，同一个记忆根
  const tableOf = () => new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log: quietLog, now, ...(journal !== undefined ? { journal, lock } : {}) }), quietLog, sidecar.recallStats)
  const store = tableOf()
  const other = tableOf()
  const decisions = new PendingDecisionsStore(sidecar.pending, sidecar.lock)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  let seq = 0
  /** 走保存管线；每次调用时钟往前一分钟。via 指定用哪个文件表（模拟另一个会话）。 */
  const save = async (partial: object, opts: { session?: string; workspacePath?: string | undefined; advanceMs?: number; via?: MemoryStore; delegation?: SaveDelegation } = {}): Promise<PipelineResult> => {
    clock.now += opts.advanceMs ?? MINUTE
    const sessionId = opts.session ?? 'sess-1'
    return runSavePipeline(candidate({ scope: 'workspace', force: true, sourceMode: 'agent-inferred', ...partial }), {
      store: opts.via ?? store, registry, workspacePath: 'workspacePath' in opts ? opts.workspacePath : WS,
      session: { id: sessionId, lastSeq: ++seq, turnStartSeq: seq },
      snapshots, decisions, callId: `call-${seq}`, now,
      ...(opts.delegation !== undefined ? { delegation: opts.delegation } : {}),
    })
  }
  const undoDeps = { store, decisions, snapshots, ignores, now, instructions: noInstructions }
  return {
    store, other, decisions, snapshots, clock, save,
    undo: (decisionId: string) => executeUndo({ decisionId }, { workspacePath: WS }, undoDeps),
  }
}
type Env = ReturnType<typeof env>

function saved(r: PipelineResult): MemoryRecord {
  expect(r.kind, JSON.stringify(r)).toBe('saved')
  return (r as Extract<PipelineResult, { kind: 'saved' }>).record
}
function updated(r: PipelineResult) {
  expect(r.kind, JSON.stringify(r)).toBe('updated')
  return r as Extract<PipelineResult, { kind: 'updated' }>
}
function rejected(r: PipelineResult) {
  expect(r.kind, JSON.stringify(r)).toBe('rejected')
  return r as Extract<PipelineResult, { kind: 'rejected' }>
}
let made = 0
const create = async (e: Env, partial: object = {}) => saved(await e.save({ name: `记忆${++made}`, content: `第 ${made} 条的正文`, summary: `第 ${made} 条`, ...partial }))
const current = async (e: Env, id: string, workspacePath: string | undefined = WS) => (await e.store.get(id, scopeAt(workspacePath)))!
const linkOnly = (e: Env, id: string, partial: object, opts?: Parameters<Env['save']>[1]) =>
  e.save({ action: 'update', id, name: undefined, type: undefined, scope: undefined, content: undefined, summary: undefined, tags: undefined, force: undefined, ...partial }, opts)
const linkEntries = async (e: Env) => (await e.decisions.listSettled()).filter(d => d.kind === 'link')
async function versionsOf(e: Env, id: string): Promise<HistoryVersion[]> {
  const found = (await e.store.locate(id, scopeAt(WS)))!
  return (await e.store.history.list(layerOf(found), id)).versions
}
/** 下一次落盘之前，别的程序先把这条记忆的文件改成 edit 后的样子（写入段挡不住的手改）。 */
function handEditBeforeNextPut(e: Env, id: string, edit: (r: MemoryRecord) => MemoryRecord) {
  const put = e.store.put.bind(e.store)
  e.store.put = async (...args) => {
    e.store.put = put
    const found = (await e.store.locate(id, scopeAt(WS)))!
    await writeFile(found.filePath, encodeRecord(edit(found.record), found.extras), 'utf8')
    return put(...args)
  }
}
/** 放一条全局记忆（模型没有新建全局的通道：用户提升过的才是全局）。 */
async function seedGlobal(e: Env, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const r = record({ scope: 'global', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await e.store.create(r)
  return r
}

describe('新建时带关联', () => {
  it('related 指向本项目和全局的在用记忆：去重后存下，被指向的那条能查到反向的「相关」', async () => {
    const e = env()
    const page = await create(e)
    const global = await seedGlobal(e)
    const fact = await create(e, { related: [page.id, global.id, page.id] })
    expect((await current(e, fact.id)).related).toEqual([page.id, global.id])
    expect((await e.store.linksTo(page.id, scopeAt(WS))).refs).toEqual([{ sourceId: fact.id, kind: 'related', sourceDir: wsDir() }])
    expect((await e.store.linksTo(global.id, { kind: 'global' })).refs).toEqual([{ sourceId: fact.id, kind: 'related', sourceDir: wsDir() }])
  })

  it('指向不存在、已删除的记忆：退回并说明，什么都不写', async () => {
    const e = env()
    const gone = await create(e)
    await e.store.softDelete(gone, { at: scopeAt(WS) })
    const deleted = rejected(await e.save({ name: '新事实', content: '新的正文', summary: '新摘要', related: [gone.id] }))
    expect(deleted.code).toBe('link-invalid')
    expect(deleted.reason).toContain(gone.id)
    // 查不到的只说第几项、不回显：模型填进来的可能根本不是 id
    const nowhere = rejected(await e.save({ name: '新事实', content: '新的正文', summary: '新摘要', related: [gone.id, 'mem_nowhere'] }))
    expect(nowhere.reason).toContain('related 第 2 项')
    expect(nowhere.reason).not.toContain('mem_nowhere')
    expect((await e.store.query({ scope: scopeAt(WS) })).map(m => m.id)).toEqual([])
  })

  it('指向别的项目的记忆：退回并说明', async () => {
    const e = env()
    const elsewhere = saved(await e.save({ name: '别处', content: '别的项目', summary: '别处' }, { workspacePath: OTHER_WS }))
    const r = rejected(await e.save({ name: '新事实', content: '新的正文', summary: '新摘要', related: [elsewhere.id] }))
    expect(r.code).toBe('link-invalid')
  })

  it('不能指向自己；超过上限退回', async () => {
    const e = env()
    const targets = []
    for (let i = 0; i <= LINKS_PER_KIND_MAX; i++) targets.push((await create(e)).id)
    const r = rejected(await e.save({ name: '太多', content: '正文', summary: '摘要', related: targets }))
    expect(r.code).toBe('link-invalid')
    expect(r.reason).toContain(String(LINKS_PER_KIND_MAX))
  })

  it('决定记录带 premises：记下被依据记忆的 id 和当时的内容摘要', async () => {
    const e = env()
    const page = await create(e)
    const decision = await create(e, { type: 'decision', premises: [page.id] })
    expect((await current(e, decision.id)).premises).toEqual([{ id: page.id, digest: premiseDigest(page) }])
    expect((await e.store.linksTo(page.id, scopeAt(WS))).refs).toEqual([{ sourceId: decision.id, kind: 'premise', digest: premiseDigest(page), sourceDir: wsDir() }])
  })

  it('子 agent 新建时也能填 related', async () => {
    const e = env()
    const page = await create(e)
    const sub = saved(await e.save({ type: 'knowledge', name: '子任务观察', content: '观察到的事实', summary: '观察', sourceMode: 'environment-observed', force: undefined, related: [page.id] },
      { session: 'sub-1', delegation: { depth: 1, parentSessionId: 'sess-1', mode: 'one-shot' } }))
    expect((await current(e, sub.id)).related).toEqual([page.id])
  })
})

describe('更新时带关联', () => {
  it('只传 related：不用填改动性质，追加在已有的后面、不删已有；不动修改时间和最近一次内容改动；留一条可撤销的回执', async () => {
    const e = env()
    const [a, b] = [await create(e), await create(e)]
    const fact = await create(e, { related: [a.id] })
    const before = await current(e, fact.id)
    const r = updated(await linkOnly(e, fact.id, { related: [b.id, a.id] }))
    const after = await current(e, fact.id)
    expect(after.related).toEqual([a.id, b.id])
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.lastChange).toEqual(before.lastChange)
    expect(after.content).toBe(before.content)
    expect(r.record.related).toEqual([a.id, b.id])
    expect(renderSaveResult(r)).toMatch(/^已更新记忆/)
    const [entry] = await linkEntries(e)
    expect(entry).toMatchObject({ memoryIds: [fact.id], links: { related: [b.id] }, settled: { verdict: 'linked' } })
    // 状态页和这次挂上去的都看得到这条线
    expect((await e.store.linksTo(b.id, scopeAt(WS))).refs).toEqual([{ sourceId: fact.id, kind: 'related', sourceDir: wsDir() }])
  })

  it('全部已经挂着：不写文件、不留回执', async () => {
    const e = env()
    const a = await create(e)
    const fact = await create(e, { related: [a.id] })
    updated(await linkOnly(e, fact.id, { related: [a.id] }))
    expect(await linkEntries(e)).toEqual([])
  })

  it('追加后超过上限：退回，已有的原样留着', async () => {
    const e = env()
    const targets = []
    for (let i = 0; i < LINKS_PER_KIND_MAX + 1; i++) targets.push((await create(e)).id)
    const fact = await create(e, { related: targets.slice(0, LINKS_PER_KIND_MAX) })
    const r = rejected(await linkOnly(e, fact.id, { related: [targets[LINKS_PER_KIND_MAX]!] }))
    expect(r.code).toBe('link-invalid')
    expect((await current(e, fact.id)).related).toEqual(targets.slice(0, LINKS_PER_KIND_MAX))
  })

  it('两个会话同时追加：两次都在；单撤其中一次只去掉那一次加的', async () => {
    const e = env()
    const [a, b, c] = [await create(e), await create(e), await create(e)]
    const fact = await create(e, { related: [a.id] })
    const [first, second] = await Promise.all([
      linkOnly(e, fact.id, { related: [b.id] }, { session: 'sess-1' }),
      linkOnly(e, fact.id, { related: [c.id] }, { session: 'sess-2', via: e.other }),
    ])
    updated(first)
    updated(second)
    expect(new Set((await current(e, fact.id)).related)).toEqual(new Set([a.id, b.id, c.id]))
    const entries = await linkEntries(e)
    const ofB = entries.find(d => d.links?.related?.includes(b.id))!
    expect((await e.undo(ofB.id)).kind).toBe('undone')
    expect(new Set((await current(e, fact.id)).related)).toEqual(new Set([a.id, c.id]))
    // 撤过的不能再撤；另一次照常能撤
    expect((await e.undo(ofB.id)).kind).toBe('error')
    const ofC = entries.find(d => d.links?.related?.includes(c.id))!
    expect((await e.undo(ofC.id)).kind).toBe('undone')
    expect((await current(e, fact.id)).related).toEqual([a.id])
  })

  it('撤销去掉了链接、回执还没标成已撤销时断掉：重试不再动文件，之后重新挂上的同一个 id 留着，回执补成已撤销', async () => {
    const e = env({ isJournaled: true })
    const a = await create(e)
    const fact = await create(e)
    updated(await linkOnly(e, fact.id, { related: [a.id] }))
    const [entry] = await linkEntries(e)
    // 进程在去掉链接的文件写完之后、标回执之前退出
    const markUndone = e.decisions.markUndone.bind(e.decisions)
    e.decisions.markUndone = async () => { throw new Error('进程退出') }
    await expect(e.undo(entry!.id)).rejects.toThrow('进程退出')
    e.decisions.markUndone = markUndone
    expect((await current(e, fact.id)).related).toBeUndefined()
    // 另一次保存重新挂上同一个 id：进写入段时先补上那一步
    updated(await linkOnly(e, fact.id, { related: [a.id] }))
    expect((await e.decisions.listSettled()).find(d => d.id === entry!.id)?.settled?.isUndone).toBe(true)
    expect(await e.undo(entry!.id)).toMatchObject({ kind: 'error', code: 'not-found' })
    expect((await current(e, fact.id)).related).toEqual([a.id])
  })

  it('撤销去掉链接后断掉、紧接着重试：重试进写入段先补上回执，不再写文件', async () => {
    const e = env({ isJournaled: true })
    const a = await create(e)
    const fact = await create(e)
    updated(await linkOnly(e, fact.id, { related: [a.id] }))
    const [entry] = await linkEntries(e)
    const markUndone = e.decisions.markUndone.bind(e.decisions)
    e.decisions.markUndone = async () => { throw new Error('进程退出') }
    await expect(e.undo(entry!.id)).rejects.toThrow('进程退出')
    e.decisions.markUndone = markUndone
    const before = await current(e, fact.id)
    expect(await e.undo(entry!.id)).toMatchObject({ kind: 'error', code: 'not-found' })
    expect(await current(e, fact.id)).toEqual(before)
    expect((await e.decisions.listSettled()).find(d => d.id === entry!.id)?.settled?.isUndone).toBe(true)
  })

  it('撤销去掉链接成功：回执只结清一次，再结清一次会出错也不影响撤销结果', async () => {
    for (const isJournaled of [true, false]) {
      const e = env({ isJournaled })
      const a = await create(e)
      const fact = await create(e)
      updated(await linkOnly(e, fact.id, { related: [a.id] }))
      // 两轮共用一个记忆根：按记忆找这一轮的回执
      const entry = (await linkEntries(e)).find(d => d.memoryIds[0] === fact.id)
      const markUndone = e.decisions.markUndone.bind(e.decisions)
      let calls = 0
      e.decisions.markUndone = async (id) => {
        if (++calls > 1) throw new Error('回执表写不进去')
        return markUndone(id)
      }
      expect(await e.undo(entry!.id)).toMatchObject({ kind: 'undone', restored: [fact.id] })
      expect(calls).toBe(1)
      expect((await current(e, fact.id)).related).toBeUndefined()
      expect((await linkEntries(e)).find(d => d.id === entry!.id)?.settled?.isUndone).toBe(true)
    }
  })

  it('撤销时它加的已经被别处去掉：什么都不动，回 stale；期间被软删的不撤', async () => {
    const e = env()
    const [a, b] = [await create(e), await create(e)]
    const fact = await create(e)
    updated(await linkOnly(e, fact.id, { related: [a.id] }))
    const [ofA] = await linkEntries(e)
    await e.store.update(fact, r => ({ ...r, related: [] }), scopeAt(WS))
    expect(await e.undo(ofA!.id)).toMatchObject({ kind: 'error', code: 'stale' })
    updated(await linkOnly(e, fact.id, { related: [b.id] }))
    const ofB = (await linkEntries(e)).find(d => d.links?.related?.includes(b.id))!
    await e.store.softDelete(fact, { at: scopeAt(WS) })
    expect(await e.undo(ofB.id)).toMatchObject({ kind: 'error', code: 'stale' })
  })

  it('保存期间文件被手改、先挂上了同一个 id：不写、不留回执，退回让模型重读；单撤不会删掉手改加的', async () => {
    const e = env()
    const a = await create(e)
    const fact = await create(e)
    handEditBeforeNextPut(e, fact.id, r => ({ ...r, related: [a.id] }))
    const r = rejected(await linkOnly(e, fact.id, { related: [a.id] }))
    expect(r.subcode).toBe('changed-after-read')
    expect(await linkEntries(e)).toEqual([])
    expect((await current(e, fact.id)).related).toEqual([a.id])
  })

  it('保存期间文件被手改得追加后超上限：不写、不留回执', async () => {
    const e = env()
    const targets: string[] = []
    for (let i = 0; i <= LINKS_PER_KIND_MAX; i++) targets.push((await create(e)).id)
    const fact = await create(e)
    handEditBeforeNextPut(e, fact.id, r => ({ ...r, related: targets.slice(0, LINKS_PER_KIND_MAX) }))
    rejected(await linkOnly(e, fact.id, { related: [targets[LINKS_PER_KIND_MAX]!] }))
    expect(await linkEntries(e)).toEqual([])
    expect((await current(e, fact.id)).related).toEqual(targets.slice(0, LINKS_PER_KIND_MAX))
  })

  it('改内容时带 related、保存期间文件被手改：不写，手改的留着', async () => {
    const e = env()
    const [a, b] = [await create(e), await create(e)]
    const fact = await create(e)
    handEditBeforeNextPut(e, fact.id, r => ({ ...r, related: [b.id] }))
    rejected(await e.save({ action: 'update', id: fact.id, change: 'refine', name: fact.name, summary: fact.summary, content: `${fact.content}，补一句`, related: [a.id] }))
    expect((await current(e, fact.id)).related).toEqual([b.id])
  })

  it('related、premises 是空列表：不用补全内容，什么都不写、不留回执，结果说明没有要挂的 id', async () => {
    const e = env()
    const fact = await create(e)
    const before = await current(e, fact.id)
    for (const links of [{ related: [] }, { premises: [] }, { related: [], premises: [] }]) {
      const r = updated(await linkOnly(e, fact.id, links))
      expect(r.warnings?.map(w => w.code)).toEqual(['links-empty'])
    }
    expect(await current(e, fact.id)).toEqual(before)
    expect(await linkEntries(e)).toEqual([])
  })

  it('只挂关联时带的 scope、confidence、change、changeReason 不生效，结果里列出', async () => {
    const e = env()
    const a = await create(e)
    const fact = await create(e)
    const r = updated(await linkOnly(e, fact.id, { related: [a.id], scope: 'global', confidence: 0.3, change: 'refine', changeReason: '补充' }))
    const note = r.warnings?.find(w => w.code === 'link-only-params-ignored')
    expect(note?.text).toContain('scope、confidence、change、changeReason')
    const after = await current(e, fact.id)
    expect([after.related, after.scope, after.confidence]).toEqual([[a.id], 'workspace', fact.confidence])
    expect(renderSaveResult(r)).toContain('confidence')
  })

  it('关联参数里有不像记忆 id 的项：退回，只说第几项、不回显原值；新建、改内容、补证、只挂关联都拦', async () => {
    const e = env()
    const a = await create(e)
    const fact = await create(e)
    const spaced = 'ghp_' + 'x'.repeat(18) + ' ' + 'y'.repeat(18)
    const controlled = 'mem_\u0007bell'
    const long = 'mem_' + 'z'.repeat(MEMORY_ID_MAX_LENGTH)
    const before = await current(e, fact.id)
    const attempts = [
      e.save({ name: '新事实', content: '新的正文', summary: '新摘要', related: [a.id, spaced] }),
      e.save({ action: 'update', id: fact.id, change: 'refine', name: fact.name, summary: fact.summary, content: `${fact.content}，补一句`, premises: [controlled] }),
      linkOnly(e, fact.id, { change: 'corroborate', related: [long] }),
      linkOnly(e, fact.id, { related: [a.id, spaced], premises: [long] }),
    ]
    for (const attempt of attempts) {
      const r = rejected(await attempt)
      expect(r.code).toBe('link-invalid')
      for (const odd of [spaced, controlled, long]) expect(renderSaveResult(r)).not.toContain(odd)
    }
    const last = rejected(await linkOnly(e, fact.id, { related: [a.id, spaced], premises: [long] }))
    expect(last.reason).toContain('related 第 2 项不是记忆 id')
    expect(last.reason).toContain('premises 第 1 项不是记忆 id')
    expect(await current(e, fact.id)).toEqual(before)
    expect((await e.store.query({ scope: scopeAt(WS) })).map(m => m.id).sort()).toEqual([a.id, fact.id].sort())
    expect(await linkEntries(e)).toEqual([])
  })

  it('形状像 id、却查不到记忆的项（比如密钥）：退回，只说第几项、不回显', async () => {
    const e = env()
    const a = await create(e)
    const fact = await create(e)
    const token = 'ghp_' + 'x'.repeat(36)
    for (const attempt of [
      e.save({ name: '新事实', content: '新的正文', summary: '新摘要', premises: [token] }),
      linkOnly(e, fact.id, { related: [a.id, token] }),
    ]) {
      const r = rejected(await attempt)
      expect(r.code).toBe('link-invalid')
      expect(renderSaveResult(r)).not.toContain(token)
    }
    expect(await linkEntries(e)).toEqual([])
  })

  it('手建文件里写的 id（不是插件生成的样子）也能挂', async () => {
    const e = env()
    const fact = await create(e)
    const located = (await e.store.locate(fact.id, scopeAt(WS)))!
    const manual = record({ id: 'mem_manual-1', name: '手建的', scope: 'workspace', workspacePath: WS, createdAt: T0, updatedAt: T0, lastConfirmedAt: T0 })
    await writeFile(join(located.dir, 'manual.md'), encodeRecord(manual, {}), 'utf8')
    updated(await linkOnly(e, fact.id, { related: ['mem_manual-1'] }))
    expect((await current(e, fact.id)).related).toEqual(['mem_manual-1'])
  })

  it('premises 也能两个会话同时追加、单撤其中一次', async () => {
    const e = env()
    const [a, b] = [await create(e), await create(e)]
    const decision = await create(e, { type: 'decision' })
    const [first, second] = await Promise.all([
      linkOnly(e, decision.id, { premises: [a.id] }, { session: 'sess-1' }),
      linkOnly(e, decision.id, { premises: [b.id] }, { session: 'sess-2', via: e.other }),
    ])
    updated(first)
    updated(second)
    expect(new Set((await current(e, decision.id)).premises?.map(p => p.id))).toEqual(new Set([a.id, b.id]))
    const ofA = (await linkEntries(e)).find(d => d.links?.premises.includes(a.id))!
    expect((await e.undo(ofA.id)).kind).toBe('undone')
    expect((await current(e, decision.id)).premises).toEqual([{ id: b.id, digest: premiseDigest(b) }])
  })

  it('premises 追加后超过上限：退回，已有的原样留着', async () => {
    const e = env()
    const targets: string[] = []
    for (let i = 0; i <= LINKS_PER_KIND_MAX; i++) targets.push((await create(e)).id)
    const decision = await create(e, { type: 'decision', premises: targets.slice(0, LINKS_PER_KIND_MAX) })
    const r = rejected(await linkOnly(e, decision.id, { premises: [targets[LINKS_PER_KIND_MAX]!] }))
    expect(r.reason).toContain('premises')
    expect((await current(e, decision.id)).premises?.map(p => p.id)).toEqual(targets.slice(0, LINKS_PER_KIND_MAX))
  })

  it('指向被取代的记忆：退回，说明挂在用的那条', async () => {
    const e = env()
    const old = await create(e)
    await create(e, { name: '新的', content: '新的说法', summary: '新的', supersedes: [old.id] })
    const fact = await create(e)
    for (const key of ['related', 'premises'] as const) {
      const r = rejected(await linkOnly(e, fact.id, { [key]: [old.id] }))
      expect(r.reason).toContain('被取代')
    }
  })

  it('改内容时一起带 related：追加关联，照常是一次内容改动', async () => {
    const e = env()
    const a = await create(e)
    const fact = await create(e)
    updated(await e.save({ action: 'update', id: fact.id, change: 'refine', name: fact.name, summary: fact.summary, content: `${fact.content}，补一句`, related: [a.id] }))
    const after = await current(e, fact.id)
    expect(after.related).toEqual([a.id])
    expect(after.lastChange?.kind).toBe('refine')
  })

  it('补证时带的 related 不生效，结果里说明怎么挂', async () => {
    const e = env()
    const a = await create(e)
    const fact = await create(e)
    const r = updated(await linkOnly(e, fact.id, { change: 'corroborate', related: [a.id] }))
    expect((await current(e, fact.id)).related).toBeUndefined()
    expect(r.warnings?.map(w => w.code)).toContain('corroborate-fields-ignored')
    expect(renderSaveResult(r)).toContain('related')
  })

  it('全局记忆的 related 或 premises 指向项目记忆：退回并说明', async () => {
    const e = env()
    const global = await seedGlobal(e)
    const local = await create(e)
    const global2 = await seedGlobal(e)
    const code = globalConfirmCode('sess-1', global)
    for (const key of ['related', 'premises'] as const) {
      const r = rejected(await linkOnly(e, global.id, { [key]: [local.id], confirmGlobal: code }))
      expect(r.code).toBe('link-invalid')
      expect(r.reason).toContain(local.id)
      expect(r.reason).toContain('去掉它，或改挂全局里说同一件事的那条')
    }
    // 指向全局的照常挂上
    updated(await linkOnly(e, global.id, { related: [global2.id], confirmGlobal: code }))
    expect((await e.store.get(global.id, { kind: 'global' }))!.related).toEqual([global2.id])
  })
})

describe('新建闸附的相近记忆', () => {
  it('带 id；模型据此只传 related 再调一次，就把新记忆挂到状态页上', async () => {
    const e = env()
    const page = await create(e, { type: 'project', name: '发版流程', content: '发版走 release 分支，合并前跑完整测试，打 tag 后发布到 npm', summary: '发版流程现状' })
    const r = await e.save({ type: 'decision', name: '发版前冻结', content: '发版前冻结 release 分支，合并前跑完整测试，只收缺陷修复', summary: '发版前冻结范围', force: undefined })
    const decision = saved(r)
    const similar = (r as Extract<PipelineResult, { kind: 'saved' }>).similar ?? []
    expect(similar.map(s => s.id)).toContain(page.id)
    const shown = renderSaveResult(r)
    expect(shown).toContain(page.id)
    expect(shown).toContain('related')
    updated(await linkOnly(e, decision.id, { related: [page.id] }))
    expect((await e.store.linksTo(page.id, scopeAt(WS))).refs).toEqual([{ sourceId: decision.id, kind: 'related', sourceDir: wsDir() }])
  })
})

describe('被前提引用的版本', () => {
  it('同一会话在合并窗口里接着做状态变化：当前版本被某条决定引用为前提时也另留一版', async () => {
    const e = env()
    const page = await create(e, { type: 'project' })
    const change = (content: string) => e.save({ action: 'update', id: page.id, change: 'state-change', name: page.name, summary: page.summary, content })
    updated(await change('第二版'))
    // 决定依据的是第二版
    await create(e, { type: 'decision', premises: [page.id] })
    updated(await change('第三版'))
    expect((await versionsOf(e, page.id)).map(v => v.record.content)).toEqual([page.content, '第二版'])
  })

  it('前提引用的是更早的版本：当前版本照常并进上一次留的那版', async () => {
    const e = env()
    const page = await create(e, { type: 'project' })
    await create(e, { type: 'decision', premises: [page.id] })
    const change = (content: string) => e.save({ action: 'update', id: page.id, change: 'state-change', name: page.name, summary: page.summary, content })
    updated(await change('第二版'))
    updated(await change('第三版'))
    expect((await versionsOf(e, page.id)).map(v => v.record.content)).toEqual([page.content])
  })

  it('全局状态页被项目里的决定引为前提：合并窗口里接着改也另留一版', async () => {
    const e = env()
    const page = await seedGlobal(e, { type: 'project', name: '全局状态页', content: '第一版', summary: '状态' })
    const change = async (content: string) => {
      const latest = (await e.store.get(page.id, { kind: 'global' }))!
      return e.save({ action: 'update', id: page.id, change: 'state-change', name: page.name, summary: page.summary, content, confirmGlobal: globalConfirmCode('sess-1', latest) })
    }
    updated(await change('第二版'))
    await create(e, { type: 'decision', premises: [page.id] })
    updated(await change('第三版'))
    const found = (await e.store.locate(page.id, { kind: 'global' }))!
    expect((await e.store.history.list(layerOf(found), page.id)).versions.map(v => v.record.content)).toEqual(['第一版', '第二版'])
  })

  it('引用它的决定已被取代、留在归档里：照样算', async () => {
    const e = env()
    const page = await create(e, { type: 'project' })
    const change = (content: string) => e.save({ action: 'update', id: page.id, change: 'state-change', name: page.name, summary: page.summary, content })
    updated(await change('第二版'))
    const decision = await create(e, { type: 'decision', premises: [page.id] })
    await create(e, { type: 'decision', name: '新决定', content: '换了做法', summary: '新决定', supersedes: [decision.id] })
    expect((await current(e, decision.id)).status).toBe('superseded')
    updated(await change('第三版'))
    expect((await versionsOf(e, page.id)).map(v => v.record.content)).toEqual([page.content, '第二版'])
  })
})
