import { describe, expect, it } from 'vitest'
import { executePromote } from '../src/tools/promote.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { scopeAt } from '../src/scope.ts'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { record } from './helpers/record.ts'
import { NOW, SESSION_WS, OTHER_WS, root, env, ok } from './helpers/gui-command-env.ts'

// 换作用域时在锁内按目标作用域重验关联和前提：越界的去掉、结果里列出、撤销时随作用域一起还原。

const ws = (workspacePath: string) => ({ kind: 'workspace' as const, workspacePath })

async function seed(e: ReturnType<typeof env>) {
  await e.store.create(record({ id: 'mem_p', name: '项目状态页', scope: 'workspace', workspacePath: SESSION_WS }))
  await e.store.create(record({ id: 'mem_g', name: '全局事实', scope: 'global' }))
  await e.store.create(record({
    id: 'mem_m', name: '要提升的', scope: 'workspace', workspacePath: SESSION_WS,
    related: ['mem_p', 'mem_g', 'mem_dangling'], premises: [{ id: 'mem_p', digest: 'dg_p' }, { id: 'mem_g', digest: 'dg_g' }],
  }))
}

describe('提升为全局', () => {
  it('指向项目记忆的关联和前提去掉，结果里列出；指向全局的和悬空的留着', async () => {
    const e = env()
    await seed(e)
    const r = await executePromote({ confirmedIds: ['mem_m'], target: 'global' }, { workspacePath: SESSION_WS },
      { store: e.store, agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')), snapshots: e.snapshots, now: () => NOW })
    expect(r.promoted).toEqual([{ id: 'mem_m', target: 'global' }])
    expect(r.droppedLinks).toEqual([{ id: 'mem_m', related: ['mem_p'], premises: ['mem_p'] }])
    expect(r.message).toContain('mem_p')
    const promoted = (await e.store.get('mem_m', { kind: 'global' }))!
    expect(promoted.related).toEqual(['mem_g', 'mem_dangling'])
    expect(promoted.premises).toEqual([{ id: 'mem_g', digest: 'dg_g' }])
  })

  it('撤销提升：去掉的关联和前提随作用域一起还原', async () => {
    const e = env()
    await seed(e)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: ws(SESSION_WS) }))
    expect((await e.store.get('mem_m', { kind: 'global' }))!.related).toEqual(['mem_g', 'mem_dangling'])
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    const back = (await e.store.get('mem_m', scopeAt(SESSION_WS)))!
    expect([back.scope, back.workspacePath]).toEqual(['workspace', SESSION_WS])
    expect(back.related).toEqual(['mem_p', 'mem_g', 'mem_dangling'])
    expect(back.premises).toEqual([{ id: 'mem_p', digest: 'dg_p' }, { id: 'mem_g', digest: 'dg_g' }])
  })

  it('结果里列出去掉的：promote-memory 和 promote 两个命令都带', async () => {
    const e = env()
    await seed(e)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: ws(SESSION_WS) }))
    expect(body.droppedLinks).toEqual([{ id: 'mem_m', related: ['mem_p'], premises: ['mem_p'] }])
  })

  it('撤销提升：期间被指向的记忆搬去了别的项目，放回原项目后够不着的去掉，结果里列出', async () => {
    const e = env()
    await seed(e)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: ws(SESSION_WS) }))
    await e.store.update({ id: 'mem_p' }, r => ({ ...r, workspacePath: OTHER_WS }), scopeAt(SESSION_WS))
    const undone = ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(undone.droppedLinks).toEqual([{ id: 'mem_m', related: ['mem_p'], premises: ['mem_p'] }])
    const back = (await e.store.get('mem_m', scopeAt(SESSION_WS)))!
    expect(back.related).toEqual(['mem_g', 'mem_dangling'])
    expect(back.premises).toEqual([{ id: 'mem_g', digest: 'dg_g' }])
  })

  it('同一批一起提升的互相指着：关联留着，结果不取决于先处理哪一条', async () => {
    for (const order of [['mem_a', 'mem_b'], ['mem_b', 'mem_a']]) {
      const e = env()
      await e.store.create(record({ id: 'mem_a', name: '甲', scope: 'workspace', workspacePath: SESSION_WS, related: ['mem_b'] }))
      await e.store.create(record({ id: 'mem_b', name: '乙', scope: 'workspace', workspacePath: SESSION_WS, premises: [{ id: 'mem_a', digest: 'dg_a' }] }))
      const r = await executePromote({ confirmedIds: order, target: 'global' }, { workspacePath: SESSION_WS },
        { store: e.store, agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')), snapshots: e.snapshots, now: () => NOW })
      expect(r.droppedLinks).toEqual([])
      expect((await e.store.get('mem_a', { kind: 'global' }))!.related).toEqual(['mem_b'])
      expect((await e.store.get('mem_b', { kind: 'global' }))!.premises).toEqual([{ id: 'mem_a', digest: 'dg_a' }])
    }
  })

  it('一起提升的另一条被跳过：指向它的关联照越界去掉，结果里列出', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', name: '甲', scope: 'workspace', workspacePath: SESSION_WS, related: ['mem_b'] }))
    await e.store.create(record({ id: 'mem_b', name: '乙', scope: 'workspace', workspacePath: SESSION_WS }))
    // 拍完快照、提升之前，乙被别处改过：这次提升跳过它
    const capture = e.snapshots.capture.bind(e.snapshots)
    e.snapshots.capture = async (...args) => {
      const snapshot = await capture(...args)
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: '期间被改过' }), scopeAt(SESSION_WS))
      return snapshot
    }
    const r = await executePromote({ confirmedIds: ['mem_a', 'mem_b'], target: 'global' }, { workspacePath: SESSION_WS },
      { store: e.store, agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')), snapshots: e.snapshots, now: () => NOW })
    expect(r.promoted).toEqual([{ id: 'mem_a', target: 'global' }])
    expect(r.skipped).toEqual(['mem_b'])
    expect(r.droppedLinks).toEqual([{ id: 'mem_a', related: ['mem_b'], premises: [] }])
    expect((await e.store.get('mem_a', { kind: 'global' }))!.related).toBeUndefined()
    expect((await e.store.get('mem_b', scopeAt(SESSION_WS)))!.scope).toBe('workspace')
  })

  it('提升之后又追加了关联：撤销回 stale，什么都不动', async () => {
    const e = env()
    await seed(e)
    await e.store.create(record({ id: 'mem_g2', name: '另一条全局', scope: 'global' }))
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: ws(SESSION_WS) }))
    await e.store.update({ id: 'mem_m' }, r => ({ ...r, related: [...r.related!, 'mem_g2'] }), { kind: 'global' })
    expect((await e.run({ cmd: 'undo', decisionId: body.decisionId! })).ok).toBe(false)
    expect((await e.store.get('mem_m', { kind: 'global' }))!.related).toEqual(['mem_g', 'mem_dangling', 'mem_g2'])
  })
})

describe('全局移到项目', () => {
  it('指向别的项目的关联去掉；指向全局和目标项目的留着', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_o', name: '别的项目', scope: 'workspace', workspacePath: OTHER_WS }))
    await e.store.create(record({ id: 'mem_p', name: '目标项目', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_g', name: '全局事实', scope: 'global' }))
    // 手改出来的越界关联
    await e.store.create(record({ id: 'mem_m', name: '要移的', scope: 'global', related: ['mem_o', 'mem_p', 'mem_g'] }))
    const body = ok(await e.run({ cmd: 'move-memory', memoryId: 'mem_m', workspacePath: SESSION_WS }))
    expect((await e.store.get('mem_m', scopeAt(SESSION_WS)))!.related).toEqual(['mem_p', 'mem_g'])
    expect(body.droppedLinks).toEqual([{ id: 'mem_m', related: ['mem_o'], premises: [] }])
  })

  it('拍快照之后、搬之前文件被手改：不搬、不记账，回 stale；手改的原样留在全局', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_t', name: '别的项目', scope: 'workspace', workspacePath: OTHER_WS }))
    await e.store.create(record({ id: 'mem_m', name: '要移的', scope: 'global', related: ['mem_t'] }))
    const capture = e.snapshots.capture.bind(e.snapshots)
    e.snapshots.capture = async (...args) => {
      const snapshot = await capture(...args)
      // 用户手删了这条越界关联
      const found = (await e.store.locate('mem_m', { kind: 'global' }))!
      const { related: _r, ...edited } = found.record
      await writeFile(found.filePath, encodeRecord(edited, found.extras), 'utf8')
      return snapshot
    }
    const before = (await e.decisions.listSettled()).length
    expect(await e.run({ cmd: 'move-memory', memoryId: 'mem_m', workspacePath: SESSION_WS })).toMatchObject({ ok: false, code: 'stale' })
    const kept = (await e.store.get('mem_m', { kind: 'global' }))!
    expect([kept.scope, kept.related]).toEqual(['global', undefined])
    expect(await e.store.get('mem_m', scopeAt(SESSION_WS))).toBeUndefined()
    expect((await e.decisions.listSettled()).length).toBe(before)
  })

  it('撤销移到项目：移过去时去掉的放回来，回到全局后仍够不着的去掉并列出', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_o', name: '别的项目', scope: 'workspace', workspacePath: OTHER_WS }))
    await e.store.create(record({ id: 'mem_q', name: '又一个项目', scope: 'workspace', workspacePath: OTHER_WS }))
    await e.store.create(record({ id: 'mem_g', name: '全局事实', scope: 'global' }))
    await e.store.create(record({
      id: 'mem_m', name: '要移的', scope: 'global', related: ['mem_o', 'mem_g', 'mem_q'], premises: [{ id: 'mem_o', digest: 'dg_o' }],
    }))
    const body = ok(await e.run({ cmd: 'move-memory', memoryId: 'mem_m', workspacePath: SESSION_WS }))
    expect(body.droppedLinks).toEqual([{ id: 'mem_m', related: ['mem_o', 'mem_q'], premises: ['mem_o'] }])
    // 期间 mem_o 提升成了全局，放回去就够得着；mem_q 还在别的项目
    await e.store.update({ id: 'mem_o' }, ({ workspacePath: _w, ...r }) => ({ ...r, scope: 'global' }), scopeAt(OTHER_WS))
    const undone = ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(undone.droppedLinks).toEqual([{ id: 'mem_m', related: ['mem_q'], premises: [] }])
    const back = (await e.store.get('mem_m', { kind: 'global' }))!
    expect(back.related).toEqual(['mem_o', 'mem_g'])
    expect(back.premises).toEqual([{ id: 'mem_o', digest: 'dg_o' }])
  })
})
