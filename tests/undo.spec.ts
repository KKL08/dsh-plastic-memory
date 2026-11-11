import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore, candidateFingerprint } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, type PendingDecision } from '../src/governance/schema.ts'
import { asUndoable, undoStateOf } from '../src/governance/undo-rules.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executePromote } from '../src/tools/promote.ts'
import { executeUndo, restoreDeleted, type UndoResult } from '../src/tools/undo.ts'
import { locateCopy } from '../src/tools/workspace-gate.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { scopeAt, type Scope } from '../src/scope.ts'
import { candidate, record } from './helpers/record.ts'

// 撤销执行模块：种类 × 现状的表格测试，走真实文件表与 .state 侧表。条目都经真实的写入路径记下（裁决、提升、管线、账本按种类的方法），
// 交错用透传包装插进去（先做真写再插别处的动作），不替换自己的模块。

const NOW = 10 * RETENTION_MS
const WS = '/tmp/pm-undo-session'
const OTHER_WS = '/tmp/pm-undo-other'
const GLOBAL: Scope = { kind: 'global' }
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-undo-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env() {
  const clock = { now: NOW }
  const now = () => clock.now
  const sidecar = new SidecarStore({ root, log: quietLog, now, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log: quietLog, now }), quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const deps = { store, decisions, snapshots, ignores, now }
  const context = { workspacePath: WS }
  return {
    ...deps, clock, context,
    undo: (decisionId: string, allowCrossWorkspace?: boolean) => executeUndo({ decisionId, allowCrossWorkspace }, context, deps),
    restore: (memoryId: string, scope?: Scope, allowCrossWorkspace?: boolean) => restoreDeleted({ memoryId, scope, allowCrossWorkspace }, context, deps),
  }
}
type Env = ReturnType<typeof env>

const at = (workspacePath: string | undefined) => (workspacePath === undefined ? {} : { scope: 'workspace' as const, workspacePath })
const label = (workspacePath: string | undefined) => workspacePath ?? 'global'
const settledOf = async (e: Env, id: string) => (await e.decisions.listSettled()).find(d => d.id === id)
const allEntries = async (e: Env) => [...await e.decisions.list(), ...await e.decisions.listSettled()]
const copy = (e: Env, id: string, workspacePath?: string) => locateCopy(e.store, id, scopeAt(workspacePath))

function errorOf(r: UndoResult | Awaited<ReturnType<typeof restoreDeleted>>) {
  expect(r.kind, JSON.stringify(r)).toBe('error')
  return r as Extract<typeof r, { kind: 'error' }>
}
function undoneOf(r: UndoResult) {
  expect(r.kind, JSON.stringify(r)).toBe('undone')
  return r as Extract<UndoResult, { kind: 'undone' }>
}

// —— 条目的来路：和生产同一条写入路径 ——

async function seedEdit(e: Env, id = 'mem_e', workspacePath: string | undefined = WS) {
  const rec = record({ id, name: '甲', content: '改前', ...at(workspacePath) })
  await e.store.create(rec)
  const before = (await copy(e, id, workspacePath))!
  const snap = await e.snapshots.capture({ operation: 'pre-update', description: '直接改前', records: [before] }, NOW)
  const committed = await e.store.update(before, cur => ({ ...cur, content: '改后', updatedAt: NOW, handEdited: true }), scopeAt(workspacePath))
  return (await e.decisions.addEdit(committed, { memoryIds: [id], summary: '甲', workspaces: [label(workspacePath)] }, 'edited', snap.id, NOW)).id
}

/** 直接合并：mem_k 保留（改成合并后的内容），mem_r 软删进最近删除，同一份快照。 */
async function seedMerge(e: Env) {
  await e.store.create(record({ id: 'mem_k', name: '保留的', content: '保留的正文' }))
  await e.store.create(record({ id: 'mem_r', name: '删掉的', content: '删掉的正文' }))
  const [kept, removed] = [(await copy(e, 'mem_k'))!, (await copy(e, 'mem_r'))!]
  const snap = await e.snapshots.capture({ operation: 'pre-update', description: '直接合并前', records: [kept, removed] }, NOW)
  const committed = await e.store.update(kept, cur => ({ ...cur, content: '合并后的正文', updatedAt: NOW, handEdited: true }), GLOBAL)
  expect(await e.store.softDelete(removed, { at: GLOBAL, now: NOW })).toBe(true)
  const id = (await e.decisions.addEdit(committed, { memoryIds: ['mem_k', 'mem_r'], summary: '合并后', workspaces: ['global', 'global'] }, 'merged', snap.id, NOW)).id
  return { id, kept, removed: (await copy(e, 'mem_r'))! }
}

async function seedMove(e: Env, workspacePath = WS) {
  await e.store.create(record({ id: 'mem_m', name: '本仓用 pnpm', content: '装依赖用 pnpm' }))
  const rec = (await copy(e, 'mem_m'))!
  const snap = await e.snapshots.capture({ operation: 'pre-update', description: '移到项目前', records: [rec] }, NOW)
  const written = await e.store.update(rec, cur => ({ ...cur, scope: 'workspace', workspacePath }), GLOBAL)
  return (await e.decisions.addMove(written, { summary: rec.summary, workspace: workspacePath }, snap.id, NOW)).id
}

const save = (e: Env, partial: object) => runSavePipeline(
  candidate({ scope: 'workspace', force: true, ...partial }),
  { store: e.store, registry, workspacePath: WS, session: { id: 'sess-1', lastSeq: 1 }, snapshots: e.snapshots, decisions: e.decisions, callId: 'call-1' },
)
const modelChangeOf = async (e: Env) => (await e.decisions.listSettled()).find(d => d.kind === 'rewrite' || d.kind === 'supersede')!.id

async function seedRewrite(e: Env) {
  await e.store.create(record({ id: 'mem_w', name: '名-mem_w', content: '改前的内容', ...at(WS) }))
  expect((await save(e, { action: 'update', id: 'mem_w', name: '名-mem_w', content: '模型改写后的' })).kind).toBe('updated')
  return modelChangeOf(e)
}

async function seedSupersede(e: Env) {
  await e.store.create(record({ id: 'mem_old', name: '旧说法', content: '旧说法', ...at(WS) }))
  const saved = await save(e, { name: '新说法', content: '完全不同的新说法', supersedes: ['mem_old'] })
  if (saved.kind !== 'saved') throw new Error(saved.kind)
  return { id: await modelChangeOf(e), newId: saved.record.id }
}

/** 冲突裁决：mem_a / mem_b 横向冲突，keep-left 删 mem_b。 */
async function seedConflict(e: Env, verdict: 'keep-left' | 'keep-right' | 'keep-both' = 'keep-left', workspacePath?: string) {
  await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', ...at(workspacePath) }))
  await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', ...at(workspacePath) }))
  const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)
  const r = await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict, allowCrossWorkspace: true }, e.context, e)
  expect(r.kind).toBe('resolved')
  return entry.id
}

async function seedVertical(e: Env) {
  await e.store.create(record({ id: 'mem_v', name: '丙', content: '用 yarn' }))
  const { entry } = await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾', fingerprint: 'fp-v' }, 1)
  expect((await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-right' }, e.context, e)).kind).toBe('resolved')
  return entry.id
}

/** 提升候选（WS 里带候选标记的 mem_c）。isBornSettled：就地提升时才记的条目。 */
async function seedPromote(e: Env, opts: { isBornSettled?: true } = {}) {
  await e.store.create(record({ id: 'mem_c', name: '戊', content: '都用 vitest', ...at(WS), globalCandidate: true }))
  const r = await executePromote({ confirmedIds: ['mem_c'], target: 'global' }, e.context,
    { store: e.store, agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')), snapshots: e.snapshots, now: e.now }, { target: scopeAt(WS) })
  expect(r.promoted).toEqual([{ id: 'mem_c', target: 'global' }])
  const entry = await e.decisions.addSettled(
    { kind: 'promote-candidate', memoryIds: ['mem_c'], summary: '都用 vitest', workspaces: [WS], fingerprint: 'fp-c' }, 'promoted', NOW,
    { snapshotId: r.snapshotId!, ...opts },
  )
  return entry.id
}

async function seedKeepLocal(e: Env) {
  await e.store.create(record({ id: 'mem_c', name: '戊', content: '都用 vitest', ...at(WS), globalCandidate: true }))
  const { entry } = await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_c'], summary: '候选', workspaces: [WS], fingerprint: 'fp-c' }, 1)
  const r = await executePromote({ confirmedIds: ['mem_c'], target: 'global', dismiss: true }, e.context,
    { store: e.store, agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')), snapshots: e.snapshots, now: e.now }, { target: scopeAt(WS) })
  expect(r.dismissed).toEqual(['mem_c'])
  expect(await e.decisions.settle(entry.id, 'keep-local', NOW, { fingerprint: candidateFingerprint((await copy(e, 'mem_c', WS))!) })).toBe(true)
  return entry.id
}

async function seedDismissedOverflow(e: Env) {
  const { entry } = await e.decisions.upsert({ kind: 'overflow', memoryIds: [], summary: '超出上限', fingerprint: '1' }, 1)
  await e.decisions.settle(entry.id, 'dismiss', NOW)
  return entry.id
}

const contentOf = async (e: Env, id: string, workspacePath?: string) => (await copy(e, id, workspacePath))?.content

describe('原样可撤：按种类的机制与撤后去向', () => {
  it.each([
    ['冲突删一方：败方回来，条目回到待处理', async (e: Env) => seedConflict(e), 'reopen', async (e: Env) => expect((await copy(e, 'mem_b'))!.status).toBe('active')],
    ['垂直冲突以基线为准：记忆回来，条目回到待处理', seedVertical, 'reopen', async (e: Env) => expect((await copy(e, 'mem_v'))!.status).toBe('active')],
    ['两边都留：只去掉结清，记忆不动、不碰快照', async (e: Env) => seedConflict(e, 'keep-both'), 'reopen', async (e: Env) => {
      expect([(await copy(e, 'mem_a'))!.status, (await copy(e, 'mem_b'))!.status]).toEqual(['active', 'active'])
      expect(await e.snapshots.list()).toEqual([])
    }],
    ['忽略过的超限提醒：回到未决', seedDismissedOverflow, 'reopen', async () => {}],
    ['提升为全局：回到本项目、全局那份不在', async (e: Env) => seedPromote(e), 'reopen', async (e: Env) => {
      expect(await copy(e, 'mem_c')).toBeUndefined()
      expect((await copy(e, 'mem_c', WS))!.globalCandidate).toBe(true)
    }],
    ['就地提升（生来结清）：回到本项目，条目移出账本', async (e: Env) => seedPromote(e, { isBornSettled: true }), 'remove', async (e: Env) => expect(await copy(e, 'mem_c', WS)).toBeDefined()],
    ['留在本项目：候选标记放回', seedKeepLocal, 'reopen', async (e: Env) => expect((await copy(e, 'mem_c', WS))!.globalCandidate).toBe(true)],
    ['直接改：回到改前，条目移出账本', async (e: Env) => seedEdit(e), 'remove', async (e: Env) => expect(await contentOf(e, 'mem_e', WS)).toBe('改前')],
    ['直接合并：两条都回到合并前，条目移出账本', async (e: Env) => (await seedMerge(e)).id, 'remove', async (e: Env) => {
      expect([await contentOf(e, 'mem_k'), (await copy(e, 'mem_r'))!.status]).toEqual(['保留的正文', 'active'])
    }],
    ['移到项目：搬回全局，条目移出账本', async (e: Env) => seedMove(e), 'remove', async (e: Env) => {
      expect([await copy(e, 'mem_m', WS), (await copy(e, 'mem_m'))?.scope]).toEqual([undefined, 'global'])
    }],
    ['模型改写：回到改前，条目标已撤销', seedRewrite, 'mark-undone', async (e: Env) => expect(await contentOf(e, 'mem_w', WS)).toBe('改前的内容')],
    ['模型替代：旧记忆回到在用，条目标已撤销', async (e: Env) => (await seedSupersede(e)).id, 'mark-undone', async (e: Env) => expect((await copy(e, 'mem_old', WS))!.status).toBe('active')],
  ] as const)('%s', async (_label, seed, fate, check) => {
    const e = env()
    const id = await seed(e)
    expect(undoneOf(await e.undo(id)).decisionId).toBe(id)
    await check(e)
    const settled = await settledOf(e, id)
    if (fate === 'remove') expect(await allEntries(e)).not.toContainEqual(expect.objectContaining({ id }))
    else if (fate === 'mark-undone') expect(settled?.settled?.isUndone).toBe(true)
    else expect([settled, (await e.decisions.get(id))?.id]).toEqual([undefined, id])
  })

  it('force 改写、替代手改过的记忆后撤销：内容、状态、手改标记都回到改前；替代时新写的那条保留', async () => {
    for (const kind of ['update', 'supersede'] as const) {
      await rm(root, { recursive: true, force: true })
      const e = env()
      await e.store.create(record({ id: 'mem_h', name: '名-mem_h', content: '改前的内容', ...at(WS) }))
      await e.store.update({ id: 'mem_h', workspacePath: WS }, r => ({ ...r, content: '用户手改后的内容', handEdited: true }), scopeAt(WS))
      const saved = kind === 'update'
        ? await save(e, { action: 'update', id: 'mem_h', name: '名-mem_h', content: '用户同意后的新内容' })
        : await save(e, { name: '新说法', content: '完全不同的新说法', supersedes: ['mem_h'] })
      undoneOf(await e.undo(await modelChangeOf(e)))
      expect(await copy(e, 'mem_h', WS)).toMatchObject({ content: '用户手改后的内容', status: 'active', handEdited: true })
      if (saved.kind === 'saved') expect(await copy(e, saved.record.id, WS)).toMatchObject({ status: 'active', content: '完全不同的新说法' })
    }
  })

  it('冲突败方回到它自己的作用域：别的作用域里同 id 的在用副本不比、不动', async () => {
    const e = env()
    const id = await seedConflict(e, 'keep-left', WS)
    await e.store.create(record({ id: 'mem_b', name: '全局那份', content: '全局的另一份' }))
    expect(undoneOf(await e.undo(id)).restored).toEqual(['mem_b'])
    expect(await copy(e, 'mem_b', WS)).toMatchObject({ status: 'active', content: '用 npm' })
    expect(await copy(e, 'mem_b')).toMatchObject({ status: 'active', content: '全局的另一份' })
  })
})

describe('PA-35 之后又被改过：六种撤销一律 stale，什么都不动、条目留着', () => {
  it.each([
    ['冲突删一方：败方从最近删除恢复后又改过', async (e: Env) => {
      const id = await seedConflict(e)
      await e.store.restoreArchived({ id: 'mem_b' }, { at: GLOBAL })
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: '恢复后又改的' }), GLOBAL)
      return { id, check: async () => expect(await contentOf(e, 'mem_b')).toBe('恢复后又改的') }
    }],
    ['提升为全局：全局那份之后又改过', async (e: Env) => {
      const id = await seedPromote(e)
      await e.store.update({ id: 'mem_c' }, r => ({ ...r, content: '提升后又改的' }), GLOBAL)
      return { id, check: async () => expect([await contentOf(e, 'mem_c'), await copy(e, 'mem_c', WS)]).toEqual(['提升后又改的', undefined]) }
    }],
    ['留在本项目：之后被删进最近删除', async (e: Env) => {
      const id = await seedKeepLocal(e)
      await e.store.softDelete({ id: 'mem_c', workspacePath: WS }, { at: scopeAt(WS), now: NOW })
      return { id, check: async () => expect([(await copy(e, 'mem_c', WS))!.status, (await copy(e, 'mem_c', WS))!.globalCandidate === true]).toEqual(['deleted', false]) }
    }],
    ['直接改：之后又改过', async (e: Env) => {
      const id = await seedEdit(e)
      await e.store.update({ id: 'mem_e', workspacePath: WS }, r => ({ ...r, content: '之后又改的' }), scopeAt(WS))
      return { id, check: async () => expect(await contentOf(e, 'mem_e', WS)).toBe('之后又改的') }
    }],
    ['移到项目：移过去之后又改过', async (e: Env) => {
      const id = await seedMove(e)
      await e.store.update({ id: 'mem_m', workspacePath: WS }, r => ({ ...r, content: '之后又改的' }), scopeAt(WS))
      return { id, check: async () => expect([await contentOf(e, 'mem_m', WS), await copy(e, 'mem_m')]).toEqual(['之后又改的', undefined]) }
    }],
    ['模型改写：之后又被手改', async (e: Env) => {
      const id = await seedRewrite(e)
      await e.store.update({ id: 'mem_w', workspacePath: WS }, r => ({ ...r, content: '用户又改的' }), scopeAt(WS))
      return { id, check: async () => expect(await contentOf(e, 'mem_w', WS)).toBe('用户又改的') }
    }],
    ['模型替代：旧记忆之后又被手改', async (e: Env) => {
      const { id } = await seedSupersede(e)
      await e.store.update({ id: 'mem_old', workspacePath: WS }, r => ({ ...r, content: '之后手改的' }), scopeAt(WS))
      return { id, check: async () => expect(await copy(e, 'mem_old', WS)).toMatchObject({ status: 'superseded', content: '之后手改的' }) }
    }],
  ] as const)('PA-35 %s', async (_label, arrange) => {
    const e = env()
    const { id, check } = await arrange(e)
    const before = await settledOf(e, id)
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'stale', reason: 'changed' })
    await check()
    expect(await settledOf(e, id)).toEqual(before)
  })

  it('PA-35 failed 只留给真失败：写盘出错照常抛出（命令层回 failed），条目留着', async () => {
    const e = env()
    const id = await seedEdit(e)
    const dir = join(root, workspaceDirName(WS))
    await chmod(dir, 0o500)
    try {
      await expect(e.undo(id)).rejects.toThrow()
    } finally {
      await chmod(dir, 0o700)
    }
    expect(await settledOf(e, id)).toBeDefined()
    expect(await contentOf(e, 'mem_e', WS)).toBe('改后')
  })
})

describe('之后又被改过的其余情形', () => {
  /** 预检之后、写回之前，另一个会话把这条删进最近删除：透传包装在写回前插进一次软删。 */
  function forgetBeforePut(e: Env, id: string, workspacePath?: string) {
    const put = e.store.put.bind(e.store)
    e.store.put = async (...args) => {
      if (args[0].id === id) expect(await e.store.softDelete({ id, workspacePath }, { at: scopeAt(workspacePath), now: NOW })).toBe(true)
      return put(...args)
    }
  }

  it.each([
    ['直接改', async (e: Env) => ({ id: await seedEdit(e), memoryId: 'mem_e' })],
    ['模型改写', async (e: Env) => ({ id: await seedRewrite(e), memoryId: 'mem_w' })],
    ['模型替代', async (e: Env) => ({ id: (await seedSupersede(e)).id, memoryId: 'mem_old' })],
  ] as const)('%s：预检之后、写回之前被别处删进最近删除：不盖回在用，回 stale', async (_label, seed) => {
    const e = env()
    const { id, memoryId } = await seed(e)
    forgetBeforePut(e, memoryId, WS)
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect((await copy(e, memoryId, WS))!.status).toBe('deleted')
    expect(await settledOf(e, id)).toBeDefined()
  })

  it('移到项目：移过去之后被删进最近删除：stale，全局不出现', async () => {
    const e = env()
    const id = await seedMove(e)
    await e.store.softDelete({ id: 'mem_m', workspacePath: WS }, { at: scopeAt(WS), now: NOW })
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect(await copy(e, 'mem_m')).toBeUndefined()
  })

  it('移到项目：移过去之后又被提升回全局：stale，全局那份不动', async () => {
    const e = env()
    const id = await seedMove(e)
    await e.store.update({ id: 'mem_m', workspacePath: WS }, ({ workspacePath: _w, ...r }) => ({ ...r, scope: 'global' }), scopeAt(WS))
    const globalBefore = await copy(e, 'mem_m')
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect(await copy(e, 'mem_m')).toEqual(globalBefore)
    expect(await settledOf(e, id)).toBeDefined()
  })

  it('移到项目：撤销时全局已有这个 id：target-taken，两份都不动', async () => {
    const e = env()
    const id = await seedMove(e)
    await e.store.create(record({ id: 'mem_m', name: '后来的全局', content: '后来写进全局的' }))
    expect(errorOf(await e.undo(id)).code).toBe('target-taken')
    expect([await contentOf(e, 'mem_m'), await contentOf(e, 'mem_m', WS)]).toEqual(['后来写进全局的', '装依赖用 pnpm'])
  })

  it('提升为全局后又移到别的项目：撤销提升回 stale，移过去的那份不动', async () => {
    const e = env()
    const id = await seedPromote(e)
    await e.store.update({ id: 'mem_c' }, cur => ({ ...cur, scope: 'workspace', workspacePath: OTHER_WS }), GLOBAL)
    const moved = await copy(e, 'mem_c', OTHER_WS)
    expect(errorOf(await e.undo(id, true)).code).toBe('stale')
    expect([await copy(e, 'mem_c', OTHER_WS), await copy(e, 'mem_c', WS), await copy(e, 'mem_c')]).toEqual([moved, undefined, undefined])
  })

  it('直接合并：撤销前保留的那条又被改过：stale，另一条也不恢复', async () => {
    const e = env()
    const { id } = await seedMerge(e)
    await e.store.update({ id: 'mem_k' }, r => ({ ...r, content: '之后又改的' }), GLOBAL)
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect([await contentOf(e, 'mem_k'), (await copy(e, 'mem_r'))!.status]).toEqual(['之后又改的', 'deleted'])
  })

  it('直接合并：删掉的那条在最近删除里的内容和快照不同：stale，不拿快照里的旧内容盖掉它', async () => {
    const e = env()
    const { id } = await seedMerge(e)
    await e.store.update({ id: 'mem_r' }, r => ({ ...r, content: '删掉的第二版' }), GLOBAL)
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect([await contentOf(e, 'mem_k'), await copy(e, 'mem_r')]).toEqual(['合并后的正文', expect.objectContaining({ status: 'deleted', content: '删掉的第二版' })])
  })

  it('直接合并：删掉的那条先从最近删除恢复、又改过：stale，保留的那条也不还原', async () => {
    const e = env()
    const { id } = await seedMerge(e)
    expect(await e.restore('mem_r', GLOBAL)).toMatchObject({ kind: 'restored' })
    await e.store.update({ id: 'mem_r' }, r => ({ ...r, content: '恢复后又改的' }), GLOBAL)
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect([await contentOf(e, 'mem_k'), await copy(e, 'mem_r')]).toEqual(['合并后的正文', expect.objectContaining({ status: 'active', content: '恢复后又改的' })])
    expect(await settledOf(e, id)).toBeDefined()
  })
})

describe('合并撤销不留半截（锁内复核被拒时）', () => {
  /** 透传包装 store.put：第一次写 id 时，写之前（before）或写之后（after）插进别处的动作，只插一次。 */
  function interleave(e: Env, id: string, when: 'before' | 'after', act: () => Promise<void>) {
    const put = e.store.put.bind(e.store)
    let isArmed = true
    e.store.put = async (...args) => {
      const isHit = isArmed && args[0].id === id
      if (isHit) isArmed = false
      if (isHit && when === 'before') await act()
      const written = await put(...args)
      if (isHit && when === 'after') await act()
      return written
    }
  }

  it('PA-37 预检之后删掉的那条被别处恢复并编辑：它的锁内复核被拒，两条都是撤销前的状态，stale，条目还在、再撤照样判得出', async () => {
    const e = env()
    const { id } = await seedMerge(e)
    interleave(e, 'mem_r', 'before', async () => {
      await e.store.restoreArchived({ id: 'mem_r' }, { at: GLOBAL, now: NOW })
      await e.store.update({ id: 'mem_r' }, r => ({ ...r, content: '别处恢复后改的' }), GLOBAL)
    })
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'stale', reason: 'changed' })
    expect([await contentOf(e, 'mem_k'), await copy(e, 'mem_r')]).toEqual(['合并后的正文', expect.objectContaining({ status: 'active', content: '别处恢复后改的' })])
    expect(await settledOf(e, id)).toBeDefined()
    expect(errorOf(await e.undo(id)).code).toBe('stale')
  })

  it('PA-37 删掉的那条已恢复、保留的那条随后被别处改过而被拒：已恢复的退回最近删除里撤销前的样子，stale，条目还在', async () => {
    const e = env()
    const { id, removed } = await seedMerge(e)
    interleave(e, 'mem_r', 'after', async () => {
      await e.store.update({ id: 'mem_k' }, r => ({ ...r, content: '别处改的保留那条' }), GLOBAL)
    })
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'stale', reason: 'changed' })
    expect(await copy(e, 'mem_r')).toEqual(removed)
    expect(await contentOf(e, 'mem_k')).toBe('别处改的保留那条')
    const entry = asUndoable((await settledOf(e, id))!)!
    const snapshot = (await e.snapshots.get(entry.settled.snapshotId!))!
    expect(undoStateOf(entry, snapshot.data.find(r => r.id === 'mem_k'), await copy(e, 'mem_k'))).toBe('changed')
  })

  it('PA-56 删掉的那条已恢复之后被第三方改过，保留的那条随后被拒：不写回，停在第三方的版本，stale，条目还在', async () => {
    const e = env()
    const { id } = await seedMerge(e)
    interleave(e, 'mem_r', 'after', async () => {
      await e.store.update({ id: 'mem_r' }, r => ({ ...r, content: '第三方改的删掉那条' }), GLOBAL)
      await e.store.update({ id: 'mem_k' }, r => ({ ...r, content: '第三方改的保留那条' }), GLOBAL)
    })
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'stale', reason: 'kept-third-party' })
    expect(await copy(e, 'mem_r')).toMatchObject({ status: 'active', content: '第三方改的删掉那条' })
    expect(await contentOf(e, 'mem_k')).toBe('第三方改的保留那条')
    expect(await settledOf(e, id)).toBeDefined()
  })
})

describe('写入那一刻的交错与写盘出错', () => {
  /** 透传包装 store.put：每次写 id 之前跑 before、写完跑 after（各只跑一次）；throwOn 的 id 写入时抛错。 */
  function around(e: Env, id: string, hooks: { before?: () => Promise<void>; after?: () => Promise<void>; throwOn?: string }) {
    const put = e.store.put.bind(e.store)
    let { before, after } = hooks
    e.store.put = async (...args) => {
      if (args[0].id === hooks.throwOn) throw Object.assign(new Error('EIO: 写盘出错'), { code: 'EIO' })
      const isHit = args[0].id === id
      if (isHit && before) { const act = before; before = undefined; await act() }
      const written = await put(...args)
      if (isHit && after) { const act = after; after = undefined; await act() }
      return written
    }
  }

  it('PA-37 合并撤销写回之前，删掉的那条已被别处原样恢复，保留的那条随后被拒：退回的是写入前那一刻的样子，别处的恢复保留', async () => {
    const e = env()
    const { id } = await seedMerge(e)
    around(e, 'mem_r', {
      before: async () => { await e.store.restoreArchived({ id: 'mem_r' }, { at: GLOBAL, now: NOW }) },
      after: async () => { await e.store.update({ id: 'mem_k' }, r => ({ ...r, content: '别处改的保留那条' }), GLOBAL) },
    })
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect(await copy(e, 'mem_r')).toMatchObject({ status: 'active', content: '删掉的正文' })
    expect(await settledOf(e, id)).toBeDefined()
  })

  it('PA-37 合并撤销写保留的那条时写盘出错：已恢复的那条退回最近删除，错误照常抛出，条目留着', async () => {
    const e = env()
    const { id, removed } = await seedMerge(e)
    around(e, 'mem_r', { throwOn: 'mem_k' })
    await expect(e.undo(id)).rejects.toMatchObject({ code: 'EIO' })
    expect(await copy(e, 'mem_r')).toEqual(removed)
    expect(await contentOf(e, 'mem_k')).toBe('合并后的正文')
    expect(await settledOf(e, id)).toBeDefined()
  })

  it('PA-35 直接改：预检之后被别处移到别的项目：stale，原处不重建旧版，移过去的那份不动，条目留着', async () => {
    const e = env()
    const id = await seedEdit(e)
    around(e, 'mem_e', { before: async () => { await e.store.update({ id: 'mem_e' }, r => ({ ...r, workspacePath: OTHER_WS }), scopeAt(WS)) } })
    expect(errorOf(await e.undo(id, true)).code).toBe('stale')
    expect([await copy(e, 'mem_e', WS), await contentOf(e, 'mem_e', OTHER_WS)]).toEqual([undefined, '改后'])
    expect(await settledOf(e, id)).toBeDefined()
  })

  it('PA-35 提升为全局后全局那份被删进最近删除：stale，原项目不复活，条目留着', async () => {
    const e = env()
    const id = await seedPromote(e)
    expect(await e.store.softDelete({ id: 'mem_c' }, { at: GLOBAL, now: NOW })).toBe(true)
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect([await copy(e, 'mem_c', WS), (await copy(e, 'mem_c'))?.status]).toEqual([undefined, 'deleted'])
    expect(await settledOf(e, id)).toBeDefined()
  })

  it('冲突删一方时败方已在最近删除（没有快照可撤）：撤销与撤销规则同判过期，冲突不回待处理', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm' }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)
    await e.store.softDelete({ id: 'mem_b' }, { at: GLOBAL, now: NOW })
    expect((await executeConfirm({ action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, e.context, e)).kind).toBe('resolved')
    const settled = asUndoable((await settledOf(e, entry.id))!)!
    expect(undoStateOf(settled, undefined, undefined)).toBe('expired')
    expect(errorOf(await e.undo(entry.id))).toMatchObject({ code: 'not-found', reason: 'expired' })
    expect(await settledOf(e, entry.id)).toBeDefined()
  })

  it('PA-35 撤销提升核对过全局那份之后、写回之前它被删进最近删除：stale，原项目不复活', async () => {
    const e = env()
    const id = await seedPromote(e)
    const restore = e.snapshots.restore.bind(e.snapshots)
    e.snapshots.restore = async (...args) => {
      await e.store.softDelete({ id: 'mem_c' }, { at: GLOBAL, now: NOW })
      return restore(...args)
    }
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect([await copy(e, 'mem_c', WS), (await copy(e, 'mem_c'))?.status]).toEqual([undefined, 'deleted'])
  })

  it('PA-35 提升为全局后全局那份被改过、原项目里另有同 id 的原样副本：stale，全局改过的那份不被清掉', async () => {
    const e = env()
    const id = await seedPromote(e)
    await e.store.update({ id: 'mem_c' }, r => ({ ...r, content: '全局里改过的' }), GLOBAL)
    await e.store.create(record({ id: 'mem_c', name: '戊', content: '都用 vitest', ...at(WS), globalCandidate: true }))
    expect(errorOf(await e.undo(id)).code).toBe('stale')
    expect(await contentOf(e, 'mem_c')).toBe('全局里改过的')
    expect(await settledOf(e, id)).toBeDefined()
  })
})

describe('撤不了的其余情形', () => {
  it('未结清的条目、不存在的条目：not-found', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a' }))
    await e.store.create(record({ id: 'mem_b' }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'fp' }, 1)
    expect(errorOf(await e.undo(entry.id))).toMatchObject({ code: 'not-found', reason: 'no-entry' })
    expect(errorOf(await e.undo('pd_none'))).toMatchObject({ code: 'not-found', reason: 'no-entry' })
  })

  it('已撤销过的模型改写：not-found，什么都不动', async () => {
    const e = env()
    const id = await seedRewrite(e)
    undoneOf(await e.undo(id))
    await e.store.update({ id: 'mem_w', workspacePath: WS }, r => ({ ...r, content: '撤销后又改的' }), scopeAt(WS))
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'not-found', reason: 'undone' })
    expect(await contentOf(e, 'mem_w', WS)).toBe('撤销后又改的')
  })

  it.each([
    ['直接改', (e: Env) => seedEdit(e)],
    ['冲突删一方', (e: Env) => seedConflict(e)],
  ] as const)('%s：改前快照已过保留窗口：not-found，什么都不动', async (_label, seed) => {
    const e = env()
    const id = await seed(e)
    e.clock.now = NOW + RETENTION_MS + 1000
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'not-found', reason: 'expired' })
    expect(await settledOf(e, id)).toBeDefined()
  })

  it('同一条正被另一次操作认领：claimed，什么都不动', async () => {
    const e = env()
    const id = await seedEdit(e)
    const held = await e.decisions.withClaim(id, () => e.undo(id))
    expect(held.isClaimed && errorOf(held.value).code).toBe('claimed')
    expect(await contentOf(e, 'mem_e', WS)).toBe('改后')
  })

  it.each([
    ['直接改', (e: Env) => seedEdit(e, 'mem_e', OTHER_WS), 'mem_e'],
    ['冲突删一方', (e: Env) => seedConflict(e, 'keep-left', OTHER_WS), 'mem_b'],
    ['移到项目', (e: Env) => seedMove(e, OTHER_WS), 'mem_m'],
  ] as const)('%s：别的项目的记忆先回 cross-workspace（什么都不动），带上 allowCrossWorkspace 才撤', async (_label, seed, memoryId) => {
    const e = env()
    const id = await seed(e)
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'cross-workspace', rejected: [expect.objectContaining({ id: memoryId, workspacePath: OTHER_WS })] })
    expect(await settledOf(e, id)).toBeDefined()
    undoneOf(await e.undo(id, true))
  })
})

describe('最近删除的恢复', () => {
  it('PA-41 恢复一条被裁决删掉的记忆，效果等于撤销那次裁决：记忆回来、冲突回到待处理（同一条条目）', async () => {
    const outcome = async (via: 'undo' | 'restore') => {
      await rm(root, { recursive: true, force: true })
      const e = env()
      const id = await seedConflict(e)
      const r = via === 'undo' ? await e.undo(id) : await e.restore('mem_b', GLOBAL)
      expect(r.kind, JSON.stringify(r)).not.toBe('error')
      const entries = (await allEntries(e)).map(({ id: entryId, ...rest }: PendingDecision) => ({ isSame: entryId === id, ...rest }))
      return { restored: 'restored' in r ? r.restored : [], decisionId: 'decisionId' in r && r.decisionId === id, memory: await copy(e, 'mem_b'), entries }
    }
    const viaRestore = await outcome('restore')
    expect(viaRestore).toEqual(await outcome('undo'))
    expect(viaRestore).toMatchObject({ restored: ['mem_b'], decisionId: true, memory: { status: 'active' }, entries: [expect.not.objectContaining({ settled: expect.anything() })] })
    expect(viaRestore.entries.map(d => d.isSame)).toEqual([true])
  })

  it('PA-41 败方的快照副本已被脱敏（含密钥硬删）：最近删除里恢复回 not-found，撤销那次裁决回 stale，记忆与条目都不动', async () => {
    const e = env()
    const id = await seedConflict(e)
    await e.snapshots.redact(new Set(['mem_b']))
    // 脱敏后快照不再覆盖它：按普通恢复处理，也不复活
    expect(errorOf(await e.restore('mem_b', GLOBAL)).code).toBe('not-found')
    expect(errorOf(await e.undo(id))).toMatchObject({ code: 'stale', reason: 'redacted' })
    expect((await copy(e, 'mem_b'))!.status).toBe('deleted')
  })

  it('裁决条目正被别处认领：claimed，记忆与账本都不动', async () => {
    const e = env()
    const id = await seedConflict(e)
    const before = await allEntries(e)
    const held = await e.decisions.withClaim(id, () => e.restore('mem_b'))
    expect(held.isClaimed && errorOf(held.value).code).toBe('claimed')
    expect(await allEntries(e)).toEqual(before)
    expect((await copy(e, 'mem_b'))!.status).toBe('deleted')
  })

  it('认领之前别处撤销了这条并按相反结论重新裁决：新的裁决不被重开', async () => {
    const e = env()
    const id = await seedConflict(e)
    const claim = e.decisions.withClaim.bind(e.decisions)
    let isArmed = true
    e.decisions.withClaim = async (key, fn) => {
      if (isArmed && key === id) {
        isArmed = false
        undoneOf(await executeUndo({ decisionId: id }, e.context, e))
        expect((await executeConfirm({ action: 'resolve', decisionId: id, verdict: 'keep-right' }, e.context, e)).kind).toBe('resolved')
      }
      return claim(key, fn)
    }
    expect(errorOf(await e.restore('mem_b')).code).toBe('not-found')
    expect((await allEntries(e)).map(d => [d.id, d.settled?.verdict])).toEqual([[id, 'keep-right']])
    expect([(await copy(e, 'mem_a'))!.status, (await copy(e, 'mem_b'))!.status]).toEqual(['deleted', 'active'])
  })

  it('不是裁决删掉的：按快照恢复，账本不动；途中那份快照刚过 14 天被别处清扫，刚恢复的留着', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_f', content: '临期的记忆' }))
    const rec = (await copy(e, 'mem_f'))!
    await e.snapshots.capture({ operation: 'pre-forget', description: '删除前', records: [rec] }, NOW)
    await e.store.softDelete(rec, { at: GLOBAL, now: NOW })
    e.clock.now = NOW + RETENTION_MS - 1
    const put = e.store.put.bind(e.store)
    e.store.put = async (...args) => {
      const written = await put(...args)
      e.clock.now += 2
      await e.snapshots.sweep(e.clock.now)
      return written
    }
    expect(await e.restore('mem_f', GLOBAL)).toMatchObject({ kind: 'restored', restored: ['mem_f'] })
    expect(await e.snapshots.list()).toEqual([])
    expect(await copy(e, 'mem_f')).toMatchObject({ status: 'active', content: '临期的记忆' })
    expect(await allEntries(e)).toEqual([])
  })

  /** 不是裁决删掉的 mem_f：删前留快照、软删进最近删除。 */
  async function seedForgotten(e: Env) {
    await e.store.create(record({ id: 'mem_f', content: '删前的内容' }))
    const rec = (await copy(e, 'mem_f'))!
    await e.snapshots.capture({ operation: 'pre-forget', description: '删除前', records: [rec] }, NOW)
    await e.store.softDelete(rec, { at: GLOBAL, now: NOW })
  }

  it('列出快照之后、写回之前它因含密钥被物理删除（快照只剩脱敏副本）：拒绝恢复，提示说明原因，记忆仍在最近删除', async () => {
    const e = env()
    await seedForgotten(e)
    const restore = e.snapshots.restore.bind(e.snapshots)
    e.snapshots.restore = async (...args) => {
      await e.snapshots.redact(new Set(['mem_f']))
      return restore(...args)
    }
    const r = errorOf(await e.restore('mem_f', GLOBAL))
    expect(r.code).toBe('failed')
    expect(r.message).toContain('mem_f')
    expect(r.message).toContain('含密钥已物理删除，快照里只剩脱敏副本')
    expect((await copy(e, 'mem_f'))!.status).toBe('deleted')
  })

  it('核对之后、写回之前别处把它恢复并改过：拒绝恢复，提示「快照后被修改过」，别处改的内容不被快照盖掉', async () => {
    const e = env()
    await seedForgotten(e)
    const restore = e.snapshots.restore.bind(e.snapshots)
    e.snapshots.restore = async (...args) => {
      expect(await e.store.restoreArchived({ id: 'mem_f' }, { at: GLOBAL, now: NOW })).toBe(true)
      await e.store.update({ id: 'mem_f' }, cur => ({ ...cur, content: '恢复后又改的' }), GLOBAL)
      return restore(...args)
    }
    const r = errorOf(await e.restore('mem_f', GLOBAL))
    expect(r.code).toBe('failed')
    expect(r.message).toContain('mem_f')
    expect(r.message).toContain('快照后被修改过')
    expect(await copy(e, 'mem_f')).toMatchObject({ status: 'active', content: '恢复后又改的' })
  })

  it('还在用的记忆：not-found', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_live' }))
    expect(errorOf(await e.restore('mem_live')).code).toBe('not-found')
  })
})
