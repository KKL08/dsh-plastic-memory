import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { HISTORY_DIR, INDEX_FILE } from '../src/storage/paths.ts'
import { layerOf, versionReason, type HistoryVersion } from '../src/storage/history.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { globalConfirmCode, runSavePipeline, type PipelineResult } from '../src/pipeline.ts'
import { renderSaveResult } from '../src/tools/save.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import { scopeAt } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { candidate, record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { noInstructions } from './helpers/instructions.ts'
import { indexText, indexedIds } from './helpers/topic-index.ts'

// 更新记忆时声明改动性质，以及状态变化留历史版本：经真实的保存管线，落在真实文件表和 .state 侧表上。

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const WS = '/tmp/pm-change-kinds'
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-change-kinds-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env() {
  const clock = { now: T0 }
  const now = () => clock.now
  const sidecar = new SidecarStore({ root, log: quietLog, now, schemas: sidecarSchemas })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log: quietLog, now }), quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending, sidecar.lock)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const guided = new Map<string, Set<string>>()
  const guidedIn = (sessionId: string) => guided.get(sessionId) ?? guided.set(sessionId, new Set()).get(sessionId)!
  let seq = 0
  /** 走保存管线；每次调用时钟往前一分钟，事件序号加一。 */
  const save = async (partial: object, opts: { session?: string; workspacePath?: string | undefined; advanceMs?: number } = {}): Promise<PipelineResult> => {
    clock.now += opts.advanceMs ?? MINUTE
    const sessionId = opts.session ?? 'sess-1'
    return runSavePipeline(candidate({ scope: 'workspace', force: true, sourceMode: 'agent-inferred', ...partial }), {
      store, registry, workspacePath: 'workspacePath' in opts ? opts.workspacePath : WS,
      session: { id: sessionId, lastSeq: ++seq, turnStartSeq: seq },
      snapshots, decisions, callId: `call-${seq}`, guided: guidedIn(sessionId), now,
    })
  }
  const undoDeps = { store, decisions, snapshots, ignores, now, instructions: noInstructions }
  return {
    store, decisions, snapshots, clock, save,
    undo: (decisionId: string) => executeUndo({ decisionId }, { workspacePath: WS }, undoDeps),
  }
}
type Env = ReturnType<typeof env>

async function create(e: Env, partial: object = {}): Promise<MemoryRecord> {
  const saved = await e.save({ name: '部署方式', content: '部署用 Docker Compose', summary: '怎么部署', ...partial })
  if (saved.kind !== 'saved') throw new Error(JSON.stringify(saved))
  return saved.record
}
const current = async (e: Env, id: string, workspacePath: string | undefined = WS) => (await e.store.get(id, scopeAt(workspacePath)))!
async function versionsOf(e: Env, id: string, workspacePath: string | undefined = WS): Promise<HistoryVersion[]> {
  const found = (await e.store.locate(id, scopeAt(workspacePath)))!
  return e.store.history.list(layerOf(found), id)
}
const update = (e: Env, id: string, partial: object, opts?: Parameters<Env['save']>[1]) =>
  e.save({ action: 'update', id, name: '部署方式', summary: '怎么部署', ...partial }, opts)
function updated(r: PipelineResult) {
  expect(r.kind, JSON.stringify(r)).toBe('updated')
  return r as Extract<PipelineResult, { kind: 'updated' }>
}
const rewriteEntries = async (e: Env) => (await e.decisions.listSettled()).filter(d => d.kind === 'rewrite')

describe('补证', () => {
  it('正文参数不生效，只加出处、刷新确认时间；不拍快照、不留撤销入口', async () => {
    const e = env()
    const made = await create(e)
    const r = updated(await update(e, made.id, { change: 'corroborate', content: '想顺手改掉的正文', sourceMode: 'user-explicit' }))
    const now = await current(e, made.id)
    expect(now).toMatchObject({ content: '部署用 Docker Compose', updatedAt: made.updatedAt, lastConfirmedAt: e.clock.now })
    expect(now.lastChange).toBeUndefined()
    expect(now.sourceTrail!.map(a => [a.change, a.sourceMode, a.by])).toEqual([['corroborate', 'user-explicit', 'main'], ['create', 'agent-inferred', 'main']])
    expect(now.source).toEqual({ sessionId: 'sess-1', eventRange: [2, 2], sourceMode: 'user-explicit' })
    expect(r.warnings?.map(w => w.code)).toEqual(['corroborate-fields-ignored'])
    expect(renderSaveResult(r)).toMatch(/content.* 没有生效/)
    expect(await e.snapshots.list()).toEqual([])
    expect(await rewriteEntries(e)).toEqual([])
  })

  it('只传 id 和依据就够；别的字段一个不动', async () => {
    const e = env()
    const made = await create(e, { tags: ['上线'], validTo: '2030-01-01' })
    const r = updated(await e.save({ action: 'update', id: made.id, change: 'corroborate', name: undefined, type: undefined, scope: undefined, content: undefined, summary: undefined, tags: undefined }))
    expect(r.warnings).toBeUndefined()
    const { sourceTrail: _t, source: _s, lastConfirmedAt: _c, ...rest } = await current(e, made.id)
    const { sourceTrail: _t0, source: _s0, lastConfirmedAt: _c0, ...before } = made
    expect(rest).toEqual({ ...before, recallCount: 0, lastRecalledAt: null })
  })

  it('原来存下时带疑似密钥的记忆照样能补证', async () => {
    const e = env()
    const made = await create(e, { allowSecret: true, content: `连接串 password=${'x'.repeat(4)}Zq9${'k'.repeat(12)}` })
    expect((await update(e, made.id, { change: 'corroborate', force: undefined })).kind).toBe('updated')
  })
})

describe.each(['refine', 'correct'] as const)('%s', (change) => {
  it('改前内容进撤销快照，不产生历史版本；记下这一次内容改动', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change, content: '部署用 Docker Compose，生产环境加 --profile prod' }))
    const now = await current(e, made.id)
    expect(now.content).toBe('部署用 Docker Compose，生产环境加 --profile prod')
    expect(now.lastChange).toEqual({ kind: change, at: e.clock.now, op: expect.stringMatching(/^op_/), by: 'main' })
    expect(now.sourceTrail!.map(a => a.change)).toEqual([change, 'create'])
    expect(now.stateSince).toBe(made.createdAt)
    expect(await versionsOf(e, made.id)).toEqual([])
    const [snapshot] = await e.snapshots.list()
    expect(snapshot!.data.map(r => r.content)).toEqual(['部署用 Docker Compose'])
    expect(await rewriteEntries(e)).toHaveLength(1)
  })

  it('确认时间只在来源是用户明说时刷新', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change, content: '第二版' }))
    expect((await current(e, made.id)).lastConfirmedAt).toBe(made.lastConfirmedAt)
    updated(await update(e, made.id, { change, content: '第三版', sourceMode: 'user-explicit' }))
    expect((await current(e, made.id)).lastConfirmedAt).toBe(e.clock.now)
  })
})

describe('没声明改动性质', () => {
  it('不落盘，回当前内容和三个判断问题；同一会话对同一条再缺一次，按状态变化写下并说明', async () => {
    const e = env()
    const made = await create(e)
    const first = await update(e, made.id, { content: '改成 Kubernetes' })
    expect(first).toMatchObject({ kind: 'rejected', code: 'change-kind-missing' })
    const guide = renderSaveResult(first)
    expect(guide).toContain('部署用 Docker Compose')
    for (const kind of ['corroborate', 'refine', 'state-change', 'correct']) expect(guide).toContain(`change=${kind}`)
    expect((await current(e, made.id)).content).toBe('部署用 Docker Compose')

    const second = updated(await update(e, made.id, { content: '改成 Kubernetes' }))
    expect(second.warnings?.map(w => w.code)).toContain('change-kind-assumed')
    expect(renderSaveResult(second)).toContain('已按状态变化')
    expect((await current(e, made.id)).lastChange?.kind).toBe('state-change')
    expect((await versionsOf(e, made.id)).map(v => v.record.content)).toEqual(['部署用 Docker Compose'])
  })

  it('引导过只算在那个会话、那一条上', async () => {
    const e = env()
    const [a, b] = [await create(e), await create(e, { name: '端口', content: '服务端口 3000', summary: '端口' })]
    expect((await update(e, a.id, { content: '甲' })).kind).toBe('rejected')
    expect(await update(e, b.id, { name: '端口', content: '乙' })).toMatchObject({ code: 'change-kind-missing' })
    expect(await update(e, a.id, { content: '甲' }, { session: 'sess-2' })).toMatchObject({ code: 'change-kind-missing' })
  })

  it('引导过的记录不落盘：换一个进程（新的内存状态）重新引导', async () => {
    const [first, second] = [env(), env()]
    const made = await create(first)
    expect((await update(first, made.id, { content: '甲' })).kind).toBe('rejected')
    expect(await update(second, made.id, { content: '甲' })).toMatchObject({ code: 'change-kind-missing' })
    const stateFiles = await readdir(join(root, '.state'), { recursive: true })
    expect(stateFiles.filter(f => /guid/i.test(f))).toEqual([])
  })

  it('取值不认识同样回引导，并列出可用的取值', async () => {
    const e = env()
    const made = await create(e)
    const r = await update(e, made.id, { change: 'rewrite', content: '甲' })
    expect(r).toMatchObject({ code: 'change-kind-missing' })
    expect(renderSaveResult(r)).toContain('change="rewrite" 不是可用的取值')
  })

  it('引导里的当前内容先整条遮密钥、再限长', async () => {
    const e = env()
    // 含密钥的记忆过不了保存管线，只会是手写进来的：直接放进存储
    const at = { scope: 'workspace' as const, workspacePath: WS }
    // 密钥正好跨在限长的位置上：先截断的话会剩下半截密钥，规则认不出来
    await e.store.create(record({ id: 'mem_long', name: '部署步骤', content: `${'步'.repeat(1990)}${FAKE_SECRET.github}${'骤'.repeat(3000)}`, ...at }))
    const guide = renderSaveResult(await update(e, 'mem_long', { name: '部署步骤', content: '甲' }))
    expect(guide).not.toContain('ghp_')
    expect(guide).toContain(SECRET_MASK)
    expect(guide).toContain('正文共')
    expect(guide.length).toBeLessThan(2600)
    await e.store.create(record({ id: 'mem_short', name: '令牌', content: `令牌 ${FAKE_SECRET.github}`, ...at }))
    const shortGuide = renderSaveResult(await update(e, 'mem_short', { name: '令牌', content: '甲' }))
    expect(shortGuide).toContain(SECRET_MASK)
    expect(shortGuide).not.toContain(FAKE_SECRET.github)
  })

  it('全局记忆：先过确认码，再查改动性质，两道都过才写', async () => {
    const e = env()
    const made = record({ id: 'mem_g', name: '回复语言', content: '回复用中文', summary: '语言' })
    await e.store.create(made)
    const globalNow = async () => (await e.store.get('mem_g', { kind: 'global' }))!
    const code = async () => globalConfirmCode('sess-1', await globalNow())
    const args = { action: 'update', id: 'mem_g', name: '回复语言', scope: 'global', content: '回复用中文，代码注释也用中文', summary: '语言' }
    // 两样都缺：先回确认码这一道，这时还不算引导过改动性质
    expect(await e.save(args)).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
    expect(await e.save({ ...args, confirmGlobal: await code() })).toMatchObject({ kind: 'rejected', code: 'change-kind-missing' })
    // 性质有了、码不对：照样拦在确认码
    expect(await e.save({ ...args, change: 'refine', confirmGlobal: '0000' === await code() ? '0001' : '0000' })).toMatchObject({ code: 'global-update-unconfirmed' })
    expect((await globalNow()).content).toBe('回复用中文')
    updated(await e.save({ ...args, change: 'refine', confirmGlobal: await code() }))
    expect((await globalNow()).content).toBe('回复用中文，代码注释也用中文')
  })
})

describe('只改元数据的写入', () => {
  it('软删再恢复、读改写别的字段都不动最近一次内容改动', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'correct', content: '部署用 Kubernetes' }))
    const { lastChange } = await current(e, made.id)
    expect(lastChange?.kind).toBe('correct')
    await e.store.update(made, r => ({ ...r, globalCandidate: true }))
    expect(await e.store.softDelete(made, { now: e.clock.now })).toBe(true)
    expect(await e.store.restoreArchived(made, { now: e.clock.now })).toBe(true)
    updated(await update(e, made.id, { change: 'corroborate' }))
    expect((await current(e, made.id)).lastChange).toEqual(lastChange)
  })
})

describe('状态变化', () => {
  it('改前整条原样存成历史版本：id 不变，带起止时间、变化原因、版本种类', async () => {
    const e = env()
    const made = await create(e, { tags: ['上线'] })
    updated(await update(e, made.id, { change: 'state-change', content: '部署改用 Kubernetes', changeReason: '单机撑不住了' }))
    const now = await current(e, made.id)
    expect(now).toMatchObject({ id: made.id, content: '部署改用 Kubernetes', stateSince: e.clock.now, lastConfirmedAt: e.clock.now })
    const [version, ...rest] = await versionsOf(e, made.id)
    expect(rest).toEqual([])
    expect(version).toMatchObject({ startedAt: made.createdAt, endedAt: e.clock.now, kind: 'state-change', sessionId: 'sess-1' })
    expect(versionReason(version!)).toBe('单机撑不住了')
    expect(version!.record).toEqual({ ...made, recallCount: 0, lastRecalledAt: null })
  })

  it('历史版本落在这条记忆所在目录的 .history 下，文件就是改前的记忆文件加几个版本键', async () => {
    const e = env()
    const made = await create(e)
    const before = await e.store.locate(made.id, scopeAt(WS))
    const beforeRaw = await readFile(before!.filePath, 'utf8')
    updated(await update(e, made.id, { change: 'state-change', content: '部署改用 Kubernetes', changeReason: '单机撑不住了' }))
    const dir = join(before!.dir, HISTORY_DIR, made.id)
    const [name] = await readdir(dir)
    expect(name).toMatch(/^\d{8}T\d{9}Z\.md$/)
    const raw = await readFile(join(dir, name!), 'utf8')
    for (const key of ['versionOf', 'versionStartedAt', 'versionEndedAt', 'versionKind', 'versionReason']) expect(raw).toContain(`\n${key}: `)
    // 去掉版本自己的键（排在记录的键后面）和原文件的提交标记，剩下的逐字节相同
    expect(raw.replace(/^versionOf: [\s\S]*?(?=^---$)/m, '')).toBe(beforeRaw.replace(/^lastWriteOp: .*\n/m, ''))
  })

  it('旧锚随历史版本走：新建加两次补证有三个锚，状态变化后当前只剩这次的一个', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'corroborate' }))
    updated(await update(e, made.id, { change: 'corroborate', sourceMode: 'user-explicit' }))
    const trail = (await current(e, made.id)).sourceTrail!
    expect(trail.map(a => a.change)).toEqual(['corroborate', 'corroborate', 'create'])
    for (const a of trail) expect(a).toMatchObject({ at: expect.any(Number), sourceMode: expect.any(String), by: 'main' })
    updated(await update(e, made.id, { change: 'state-change', content: '部署改用 Kubernetes' }))
    expect((await current(e, made.id)).sourceTrail!.map(a => a.change)).toEqual(['state-change'])
    expect((await versionsOf(e, made.id))[0]!.record.sourceTrail).toEqual(trail)
  })

  it('同一会话在合并窗口里接着改：只留一次档，后一次的原因追加上去；过了窗口另留一版', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版', changeReason: '原因一' }))
    const firstAt = e.clock.now
    updated(await update(e, made.id, { change: 'state-change', content: '第三版', changeReason: '原因二' }, { advanceMs: 59 * MINUTE }))
    let versions = await versionsOf(e, made.id)
    expect(versions.map(v => [v.record.content, v.endedAt, versionReason(v)])).toEqual([['部署用 Docker Compose', firstAt, '原因一\n原因二']])
    // 并进去的那次没有新留档：它换掉的那一版（第二版）的锚没有历史版本可跟，留在当前清单里
    expect((await current(e, made.id)).sourceTrail!.map(a => a.change)).toEqual(['state-change', 'state-change'])
    // 窗口从上一次留档算起，不随追加往后延
    updated(await update(e, made.id, { change: 'state-change', content: '第四版', changeReason: '原因三' }, { advanceMs: 2 * MINUTE }))
    versions = await versionsOf(e, made.id)
    expect(versions.map(v => v.record.content)).toEqual(['部署用 Docker Compose', '第三版'])
  })

  it('合并窗口里连做两次之后，下一版的起点是第二次变化的时刻', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版' }))
    updated(await update(e, made.id, { change: 'state-change', content: '第三版' }))
    const secondAt = e.clock.now
    expect((await current(e, made.id)).stateSince).toBe(secondAt)
    updated(await update(e, made.id, { change: 'state-change', content: '第四版' }, { advanceMs: 61 * MINUTE }))
    const versions = await versionsOf(e, made.id)
    expect(versions.map(v => [v.record.content, v.startedAt, v.endedAt])).toEqual([
      ['部署用 Docker Compose', made.createdAt, secondAt - MINUTE],
      ['第三版', secondAt, e.clock.now],
    ])
  })

  it('别的会话来改一律留档', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版' }))
    updated(await update(e, made.id, { change: 'state-change', content: '第三版' }, { session: 'sess-2' }))
    expect((await versionsOf(e, made.id)).map(v => [v.record.content, v.sessionId])).toEqual([['部署用 Docker Compose', 'sess-1'], ['第二版', 'sess-2']])
  })

  it('窗口里中间被别的会话改过正文：不并，中间那一版另留一档', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版' }))
    updated(await update(e, made.id, { change: 'correct', content: '第二版（纠正过）' }, { session: 'sess-2' }))
    updated(await update(e, made.id, { change: 'state-change', content: '第三版' }))
    expect((await versionsOf(e, made.id)).map(v => v.record.content)).toEqual(['部署用 Docker Compose', '第二版（纠正过）'])
  })

  it('变化原因记在当前这一版的最近一次内容改动里，下一次改动换掉它', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版', changeReason: '  迁到新集群  ' }))
    expect((await current(e, made.id)).lastChange).toMatchObject({ kind: 'state-change', reason: '迁到新集群' })
    updated(await update(e, made.id, { change: 'refine', content: '第二版，补一句' }))
    expect((await current(e, made.id)).lastChange).not.toHaveProperty('reason')
  })

  it('id 整段是点的记忆：历史版本仍落在 .history 下，不落进记忆目录', async () => {
    const e = env()
    await e.store.create(record({ id: '..', name: '怪 id', content: '第一版', scope: 'workspace', workspacePath: WS }))
    updated(await update(e, '..', { name: '怪 id', change: 'state-change', content: '第二版' }))
    const found = (await e.store.locate('..', scopeAt(WS)))!
    expect(await readdir(join(found.dir, HISTORY_DIR))).toEqual(['%2E%2E'])
    expect((await readdir(found.dir)).filter(n => n.endsWith('.md') && n !== INDEX_FILE)).toHaveLength(1)
    expect((await versionsOf(e, '..')).map(v => v.record.content)).toEqual(['第一版'])
  })

  it('较弱的来源来补证：把握不降，重新读文件也不降', async () => {
    const e = env()
    const made = await create(e, { sourceMode: 'user-explicit' })
    updated(await update(e, made.id, { change: 'corroborate', sourceMode: 'agent-inferred' }))
    const now = await current(e, made.id)
    expect(now.source!.sourceMode).toBe('agent-inferred')
    expect(now.confidence).toBe(made.confidence)
  })

  it('旧文件没有状态起点：第一版的起点取创建时间，以后各版取上一版的结束时间', async () => {
    const e = env()
    const old = record({ id: 'mem_old', name: '旧记忆', content: '第一版', createdAt: T0 - 5 * MINUTE, updatedAt: T0 - MINUTE, scope: 'workspace', workspacePath: WS })
    await e.store.create(old)
    expect((await current(e, old.id)).stateSince).toBeUndefined()
    updated(await update(e, old.id, { name: '旧记忆', change: 'state-change', content: '第二版' }))
    const firstEnd = e.clock.now
    // 状态页上的起点被手工删掉：下一版的起点按上一版的结束时间推
    const found = (await e.store.locate(old.id, scopeAt(WS)))!
    await writeFile(found.filePath, (await readFile(found.filePath, 'utf8')).replace(/^stateSince: .*\n/m, ''))
    updated(await update(e, old.id, { name: '旧记忆', change: 'state-change', content: '第三版' }, { session: 'sess-2' }))
    expect((await versionsOf(e, old.id)).map(v => [v.startedAt, v.endedAt])).toEqual([[T0 - 5 * MINUTE, firstEnd], [firstEnd, e.clock.now]])
  })

  it('历史版本不进记忆表、索引和查询', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '部署改用 Kubernetes', changeReason: '单机撑不住了' }))
    const all = await e.store.readRaw({ kind: 'workspace', workspacePath: WS }, { includeArchive: true })
    expect(all.records.map(r => r.record.content)).toEqual(['部署改用 Kubernetes'])
    expect(all.listedCount).toBe(1)
    expect(all.quarantined).toEqual([])
    expect(all.directoryNotes).toEqual([])
    expect(await e.store.query({ keyword: 'Compose', status: ['active', 'superseded', 'deleted'] })).toEqual([])
    expect((await e.store.copiesOf(made.id))).toEqual([{ kind: 'workspace', workspacePath: WS }])
    const found = (await e.store.locate(made.id, scopeAt(WS)))!
    await e.store.maintain({ kind: 'workspace', workspacePath: WS })
    expect(await indexedIds(dirname(found.filePath))).toEqual([made.id])
    expect(await indexText(dirname(found.filePath))).not.toContain('Compose')
    expect(await versionsOf(e, made.id)).toHaveLength(1)
  })
})

describe('撤销状态变化', () => {
  it('这次留的历史版本一并撤掉，记忆回到改前', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '部署改用 Kubernetes' }))
    const [entry] = await rewriteEntries(e)
    expect((await e.undo(entry!.id)).kind).toBe('undone')
    expect(await current(e, made.id)).toMatchObject({ content: '部署用 Docker Compose', stateSince: made.createdAt })
    expect((await current(e, made.id)).lastChange).toBeUndefined()
    expect(await versionsOf(e, made.id)).toEqual([])
  })

  it('撤销并进去的那一次：版本留着，只撤回它追加的原因', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版', changeReason: '原因一' }))
    updated(await update(e, made.id, { change: 'state-change', content: '第三版', changeReason: '原因二' }))
    const entries = await rewriteEntries(e)
    const second = entries.find(d => d.settled!.at === e.clock.now)!
    expect((await e.undo(second.id)).kind).toBe('undone')
    expect((await current(e, made.id)).content).toBe('第二版')
    expect((await versionsOf(e, made.id)).map(v => [v.record.content, versionReason(v)])).toEqual([['部署用 Docker Compose', '原因一']])
  })

  it('按改前快照恢复回去：那次留下的历史版本和恢复回来的内容是同一份，一并撤掉', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版' }))
    const [snapshot] = await e.snapshots.list()
    const r = await executeSnapshotTool({ action: 'restore', snapshotId: snapshot!.id, overwriteChanged: true }, { workspacePath: WS }, { store: e.store, snapshots: e.snapshots, now: () => e.clock.now })
    expect(r.kind).toBe('restored')
    expect((await current(e, made.id)).content).toBe('部署用 Docker Compose')
    expect(await versionsOf(e, made.id)).toEqual([])
  })

  it('之后又被改过、撤不了时，历史版本原样留着', async () => {
    const e = env()
    const made = await create(e)
    updated(await update(e, made.id, { change: 'state-change', content: '第二版', changeReason: '原因一' }))
    const [entry] = await rewriteEntries(e)
    const found = (await e.store.locate(made.id, scopeAt(WS)))!
    await writeFile(found.filePath, (await readFile(found.filePath, 'utf8')).replace('第二版', '用户手改的第二版'))
    expect((await e.undo(entry!.id)).kind).toBe('error')
    expect((await versionsOf(e, made.id)).map(v => versionReason(v))).toEqual(['原因一'])
  })
})
