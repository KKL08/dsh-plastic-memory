import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { executePromote } from '../src/tools/promote.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { libraryViewSchema } from '../src/gui/contract.ts'
import { UNSORTED_TITLE } from '../src/topic-index.ts'
import type { IndexOp } from '../src/topic-ops.ts'
import type { Scope } from '../src/scope.ts'
import { record } from './helpers/record.ts'
import { NOW, SESSION_WS, root, env, ok } from './helpers/gui-command-env.ts'
import { entryOf, expectedRow, membersOf, placement, rowOf } from './helpers/topic-placement.ts'

// 界面和治理工具里会改动记忆位置、名称、在用与否的入口：动完之后主题索引跟着改，不用等维护。
// 换作用域时带上原来的主题（目标里有同名的才归进去）；撤销搬家、从最近删除恢复一律进「未整理」。

type Env = ReturnType<typeof env>
const G = { kind: 'global' } as const
const W = { kind: 'workspace', workspacePath: SESSION_WS } as const
const gdir = () => join(root, GLOBAL_DIR)
const wdir = () => join(root, workspaceDirName(SESSION_WS))

async function index(e: Env, scope: Scope, op: IndexOp) {
  const r = await e.store.applyIndexOp(scope, op, { maxTopics: 30 })
  if (r.kind !== 'applied') throw new Error(`索引操作没做成：${r.reason}`)
}

/**
 * 全局：mem_g 在「发布」（曾用名「上线」），mem_h 在「回复语言」。
 * 项目：mem_m 在「上线」，mem_n 在「写锁」，mem_o 在「未整理」。
 */
async function seed(e: Env) {
  await e.store.create(record({ id: 'mem_g', name: '全局发布约定' }))
  await e.store.create(record({ id: 'mem_h', name: '回复用中文' }))
  for (const id of ['mem_m', 'mem_n', 'mem_o']) await e.store.create(record({ id, name: `项目记忆 ${id}`, scope: 'workspace', workspacePath: SESSION_WS }))
  await e.store.maintain(G)
  await e.store.maintain(W)
  await index(e, G, { kind: 'assign', memoryIds: ['mem_g'], from: UNSORTED_TITLE, to: '上线' })
  await index(e, G, { kind: 'rename', topic: '上线', name: '发布' })
  await index(e, G, { kind: 'assign', memoryIds: ['mem_h'], from: UNSORTED_TITLE, to: '回复语言' })
  await index(e, W, { kind: 'assign', memoryIds: ['mem_m'], from: UNSORTED_TITLE, to: '上线' })
  await index(e, W, { kind: 'assign', memoryIds: ['mem_n'], from: UNSORTED_TITLE, to: '写锁' })
}

describe('提升为全局', () => {
  it('界面提升：目标里有同名主题（按曾用名）就插到最前，项目里不留它', async () => {
    const e = env()
    await seed(e)
    ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: W }))
    expect(await membersOf(gdir(), '发布')).toEqual(['mem_m', 'mem_g'])
    expect((await placement(wdir())).mem_m).toBeUndefined()
  })

  it('治理工具提升：目标里没有同名主题就进「未整理」，不在全局建主题', async () => {
    const e = env()
    await seed(e)
    const entryBefore = await entryOf(gdir())
    const r = await executePromote({ confirmedIds: ['mem_n'], target: 'global' }, { workspacePath: SESSION_WS },
      { store: e.store, agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')), snapshots: e.snapshots, now: () => NOW })
    expect(r.promoted).toEqual([{ id: 'mem_n', target: 'global' }])
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_n'])
    expect(await entryOf(gdir())).toEqual(entryBefore)
    expect((await placement(wdir())).mem_n).toBeUndefined()
  })

  it('撤销提升：回到项目的「未整理」，全局里不留它', async () => {
    const e = env()
    await seed(e)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: W }))
    expect((await placement(gdir())).mem_m).toEqual(['发布'])
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(await membersOf(wdir(), UNSORTED_TITLE)).toEqual(['mem_m', 'mem_o'])
    expect((await placement(gdir())).mem_m).toBeUndefined()
  })
})

describe('移到项目', () => {
  it('带上原来的主题：项目里有同名主题就插到最前；撤销搬回全局进「未整理」', async () => {
    const e = env()
    await seed(e)
    await index(e, W, { kind: 'assign', memoryIds: ['mem_o'], from: UNSORTED_TITLE, to: '回复语言' })
    const body = ok(await e.run({ cmd: 'move-memory', memoryId: 'mem_h', workspacePath: SESSION_WS }))
    expect(await membersOf(wdir(), '回复语言')).toEqual(['mem_h', 'mem_o'])
    expect((await placement(gdir())).mem_h).toBeUndefined()
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_h'])
    expect((await placement(wdir())).mem_h).toBeUndefined()
  })
})

describe('删除和恢复', () => {
  it('遗忘去掉行；从最近删除恢复进「未整理」最前，不回原来的主题；再遗忘、彻底删除都不留它', async () => {
    const e = env()
    await seed(e)
    expect((await placement(wdir())).mem_m).toEqual(['上线'])
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_m', layer: W }))
    expect((await placement(wdir())).mem_m).toBeUndefined()
    expect(await membersOf(wdir(), '上线')).toEqual([])
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_m', layer: W }))
    expect(await membersOf(wdir(), UNSORTED_TITLE)).toEqual(['mem_m', 'mem_o'])
    expect(await membersOf(wdir(), '上线')).toEqual([])
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_m', layer: W }))
    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_m', layer: W }))
    expect((await placement(wdir())).mem_m).toBeUndefined()
    expect(await membersOf(wdir(), UNSORTED_TITLE)).toEqual(['mem_o'])
  })
})

describe('改名', () => {
  it('界面直接改名称和摘要：行在原位同步', async () => {
    const e = env()
    await seed(e)
    ok(await e.run({ cmd: 'refresh-views' }))
    const card = libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items).find(m => m.id === 'mem_n')!
    const before = await rowOf(wdir(), 'mem_n')
    ok(await e.run({ cmd: 'edit-memory', memoryId: 'mem_n', layer: W, base: { updatedAt: card.updatedAt, digest: card.digest! }, content: '新正文', name: '写锁的新名字', summary: '新摘要', tags: [] }))
    const after = await expectedRow(e.store, 'mem_n', W)
    expect(after).not.toBe(before)
    expect(await rowOf(wdir(), 'mem_n')).toBe(after)
    expect(await membersOf(wdir(), '写锁')).toEqual(['mem_n'])
  })
})
