import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { conflictFingerprint } from '../src/governance/decisions.ts'
import { deletedViewSchema, pendingViewSchema, scopeOfMemory, type PendingItem, type PendingView } from '../src/gui/contract.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { SESSION_WS, OTHER_WS, env, ok, err } from './helpers/gui-command-env.ts'

// 体检的四种新发现在处理视图里的样子（buildPendingView），以及界面的 resolve 命令放开的裁决值和 current（resolveConflict）。
// 真实临时目录 + 账本，经 refresh-views 走一遍写视图的整条路，断言视图和账本、记忆的终态。

type Env = ReturnType<typeof env>
const ws = (workspacePath: string) => ({ kind: 'workspace' as const, workspacePath })

async function create(e: Env, id: string, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  await e.store.create(record({ id, name: `${id} 的名称`, content: `${id} 的正文`, createdAt: 1, updatedAt: 1, lastConfirmedAt: e.clock.now, ...partial }))
  const scope = partial.workspacePath === undefined ? undefined : { workspacePath: partial.workspacePath }
  return (await e.store.get(id, scope))!
}

async function pendingView(e: Env): Promise<PendingView> {
  ok(await e.run({ cmd: 'refresh-views' }))
  return pendingViewSchema.parse(await e.readView('pending'))
}
const byDecision = (view: PendingView, decisionId: string): PendingItem | undefined =>
  view.items.find(i => 'decisionId' in i && i.decisionId === decisionId)

describe('处理视图：四种新发现', () => {
  it('漏记的变化、例外提示进「可以整理」，依据已变、跨项目重复进「等你决定」；各带自己的形状，排在同级的冲突、提升之后或建议整理之前', async () => {
    const e = env()
    const [a, b] = [await create(e, 'mem_a'), await create(e, 'mem_b')]
    const [d, p] = [await create(e, 'mem_d'), await create(e, 'mem_p')]
    const [x, y] = [await create(e, 'mem_x', { scope: 'workspace', workspacePath: SESSION_WS }), await create(e, 'mem_y', { scope: 'workspace', workspacePath: OTHER_WS })]
    const v = await create(e, 'mem_v')
    const missed = (await e.decisions.upsert({ kind: 'missed-change', memoryIds: ['mem_a', 'mem_b'], summary: '端口从 8100 改成了 8200', fingerprint: conflictFingerprint([a, b]), plan: { kind: 'as-versions', current: 'mem_b' } }, 1)).entry
    const exception = (await e.decisions.upsert({ kind: 'exception', memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：一律用 pnpm', summary: '脚本目录另用 npm', fingerprint: conflictFingerprint([v]) }, 2)).entry
    const premise = (await e.decisions.upsert({ kind: 'premise-changed', memoryIds: ['mem_d', 'mem_p'], summary: '「暂停归档」依据的「归档容量」改过了', fingerprint: 'fp-premise' }, 3)).entry
    const cross = (await e.decisions.upsert({
      kind: 'cross-duplicate', memoryIds: ['mem_x', 'mem_y'], workspaces: [SESSION_WS, OTHER_WS], summary: '两个项目各记了一遍提交规范',
      fingerprint: conflictFingerprint([x, y]), plan: { kind: 'promote', memoryId: 'mem_y' },
    }, 4)).entry
    const conflict = (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_d'], summary: '互相矛盾', fingerprint: conflictFingerprint([a, d]), sourceCheck: 'unreadable' }, 5)).entry

    const view = await pendingView(e)
    expect(view.items.map(i => [i.level, i.kind])).toEqual([
      ['your-call', 'conflict-horizontal'], ['your-call', 'premise-changed'], ['your-call', 'cross-duplicate'],
      ['advice', 'missed-change'], ['advice', 'exception'],
    ])
    expect(view.levelCounts).toEqual({ 'must-fix': 0, 'your-call': 3, 'advice': 2 })
    expect(view.dot).toBe('amber')
    expect(byDecision(view, conflict.id)).toMatchObject({ kind: 'conflict-horizontal', sourceCheck: 'unreadable', left: { id: 'mem_a' }, right: { id: 'mem_d' } })
    expect(byDecision(view, missed.id)).toMatchObject({ kind: 'missed-change', summary: '端口从 8100 改成了 8200', left: { id: 'mem_a' }, right: { id: 'mem_b' }, current: 'mem_b' })
    expect(byDecision(view, exception.id)).toMatchObject({ kind: 'exception', summary: '脚本目录另用 npm', memories: [{ id: 'mem_v' }], baselineRef: 'AGENTS.md：一律用 pnpm' })
    expect(byDecision(view, premise.id)).toMatchObject({ kind: 'premise-changed', decision: { id: 'mem_d', name: d.name }, premise: { id: 'mem_p', name: p.name } })
    expect(byDecision(view, cross.id)).toMatchObject({
      kind: 'cross-duplicate', summary: '两个项目各记了一遍提交规范', promoteId: 'mem_y',
      memories: [{ id: 'mem_x', workspacePath: SESSION_WS }, { id: 'mem_y', workspacePath: OTHER_WS }],
    })
  })

  it('没有方案、方案不在这一对里时不带建议的那条；冲突没回查过时不带回查标记；横向例外两条都在', async () => {
    const e = env()
    const [a, b] = [await create(e, 'mem_a'), await create(e, 'mem_b')]
    await create(e, 'mem_c')
    const [x, y] = [await create(e, 'mem_x', { scope: 'workspace', workspacePath: SESSION_WS }), await create(e, 'mem_y', { scope: 'workspace', workspacePath: OTHER_WS })]
    const missed = (await e.decisions.upsert({ kind: 'missed-change', memoryIds: ['mem_a', 'mem_b'], summary: '变了', fingerprint: conflictFingerprint([a, b]), plan: { kind: 'as-versions', current: 'mem_zzz' } }, 1)).entry
    // 同一对在冲突、漏记的变化、例外三种里最多一条未决：例外用另一对
    const exception = (await e.decisions.upsert({ kind: 'exception', memoryIds: ['mem_a', 'mem_c'], summary: '例外', fingerprint: 'fp-ex' }, 2)).entry
    const cross = (await e.decisions.upsert({ kind: 'cross-duplicate', memoryIds: ['mem_x', 'mem_y'], workspaces: [SESSION_WS, OTHER_WS], summary: '重复', fingerprint: conflictFingerprint([x, y]) }, 3)).entry
    const conflict = (await e.decisions.upsert({ memoryIds: ['mem_x', 'mem_b'], summary: '矛盾', fingerprint: 'fp-c' }, 4)).entry

    const view = await pendingView(e)
    expect(byDecision(view, missed.id)).toMatchObject({ kind: 'missed-change' })
    expect(byDecision(view, missed.id)).not.toHaveProperty('current')
    expect(byDecision(view, exception.id)).toMatchObject({ kind: 'exception', memories: [{ id: 'mem_a' }, { id: 'mem_c' }] })
    expect(byDecision(view, exception.id)).not.toHaveProperty('baselineRef')
    expect(byDecision(view, cross.id)).toMatchObject({ kind: 'cross-duplicate' })
    expect(byDecision(view, cross.id)).not.toHaveProperty('promoteId')
    expect(byDecision(view, conflict.id)).toMatchObject({ kind: 'conflict-horizontal' })
    expect(byDecision(view, conflict.id)).not.toHaveProperty('sourceCheck')
  })

  it('跨项目重复里有一条已不在它记下的项目（提升成全局了、删掉了）：不再显示，等下次体检清掉；撤销提升后回来', async () => {
    const e = env()
    const [x, y] = [await create(e, 'mem_x', { scope: 'workspace', workspacePath: SESSION_WS }), await create(e, 'mem_y', { scope: 'workspace', workspacePath: OTHER_WS })]
    const cross = (await e.decisions.upsert({
      kind: 'cross-duplicate', memoryIds: ['mem_x', 'mem_y'], workspaces: [SESSION_WS, OTHER_WS], summary: '重复',
      fingerprint: conflictFingerprint([x, y]), plan: { kind: 'promote', memoryId: 'mem_x' },
    }, 1)).entry
    expect(byDecision(await pendingView(e), cross.id)).toMatchObject({ kind: 'cross-duplicate' })

    const promoted = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_x', layer: ws(SESSION_WS) }))
    expect((await e.store.get('mem_x'))!.scope).toBe('global')
    // 账本里的条目还未决（提升不碰账本），视图里不再画它
    expect((await e.decisions.list()).map(d => d.id)).toContain(cross.id)
    expect(byDecision(await pendingView(e), cross.id)).toBeUndefined()

    ok(await e.run({ cmd: 'undo', decisionId: promoted.decisionId! }))
    expect(byDecision(await pendingView(e), cross.id)).toMatchObject({ kind: 'cross-duplicate' })

    ok(await e.run({ cmd: 'forget', memoryId: 'mem_y', layer: ws(OTHER_WS), allowCrossWorkspace: true }))
    expect(byDecision(await pendingView(e), cross.id)).toBeUndefined()
  })

  it('跨项目重复按「作用域 + id」认成员：别处新增一份同 id 的全局副本，两个项目里的那两条还在用，卡照常显示、成员是项目里的那份', async () => {
    const e = env()
    const [x, y] = [await create(e, 'mem_x', { scope: 'workspace', workspacePath: SESSION_WS, content: '项目里的 X' }), await create(e, 'mem_y', { scope: 'workspace', workspacePath: OTHER_WS })]
    const cross = (await e.decisions.upsert({
      kind: 'cross-duplicate', memoryIds: ['mem_x', 'mem_y'], workspaces: [SESSION_WS, OTHER_WS], summary: '重复', fingerprint: conflictFingerprint([x, y]),
    }, 1)).entry
    await e.store.create(record({ id: 'mem_x', name: '全局那份', content: '全局的 X', scope: 'global', workspacePath: undefined, createdAt: 2, updatedAt: 2, lastConfirmedAt: e.clock.now }))

    expect(byDecision(await pendingView(e), cross.id)).toMatchObject({
      kind: 'cross-duplicate',
      memories: [{ id: 'mem_x', scope: 'workspace', workspacePath: SESSION_WS, content: '项目里的 X' }, { id: 'mem_y', workspacePath: OTHER_WS }],
    })
  })

  it('跨项目重复的成员所在项目这次没读全（有读不出的文件）、成员没读到：照常显示，读不到的那条为空，不下「不在了」的结论', async () => {
    const e = env()
    const [x, y] = [await create(e, 'mem_x', { scope: 'workspace', workspacePath: SESSION_WS }), await create(e, 'mem_y', { scope: 'workspace', workspacePath: OTHER_WS })]
    const cross = (await e.decisions.upsert({
      kind: 'cross-duplicate', memoryIds: ['mem_x', 'mem_y'], workspaces: [SESSION_WS, OTHER_WS], summary: '重复', fingerprint: conflictFingerprint([x, y]),
    }, 1)).entry
    const file = (await e.store.locate('mem_y', ws(OTHER_WS)))!.filePath
    await writeFile(file, '---\nname: [坏了\n---\n正文\n')

    const view = await pendingView(e)
    expect(view.items.some(i => i.kind === 'unreadable-file')).toBe(true)
    expect(byDecision(view, cross.id)).toMatchObject({ kind: 'cross-duplicate', memories: [{ id: 'mem_x', workspacePath: SESSION_WS }, null] })
  })

  it('账本里不认识、不该出卡的种类（生来就已结清的那几类混进未决）不画成冲突', async () => {
    const e = env()
    await create(e, 'mem_a')
    await create(e, 'mem_b')
    const odd = (await e.decisions.upsert({ kind: 'edit', memoryIds: ['mem_a', 'mem_b'], summary: '不该出卡', fingerprint: 'fp-odd' }, 1)).entry
    expect((await e.decisions.list()).map(d => d.id)).toContain(odd.id)
    const view = await pendingView(e)
    expect(byDecision(view, odd.id)).toBeUndefined()
    expect(view.items).toEqual([])
  })
})

describe('resolve：四种新发现与冲突的新裁决', () => {
  it('漏记的变化并成版本：带 current 透传给裁决，旧状态那条进历史、条目结清；撤销后旧那条回来、条目回到待处理', async () => {
    const e = env()
    const [a, b] = [await create(e, 'mem_a', { content: '服务监听 8100' }), await create(e, 'mem_b', { content: '服务监听 8200' })]
    const entry = (await e.decisions.upsert({ kind: 'missed-change', memoryIds: ['mem_a', 'mem_b'], summary: '端口变了', fingerprint: conflictFingerprint([a, b]), plan: { kind: 'as-versions', current: 'mem_b' } }, 1)).entry

    const body = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'as-versions', current: 'mem_b' }))
    expect(body.decisionId).toBe(entry.id)
    expect((await e.store.get('mem_a'))!.status).toBe('deleted')
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[entry.id, 'as-versions']])
    expect(byDecision(await pendingView(e), entry.id)).toBeUndefined()

    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await e.store.get('mem_a'))!.status).toBe('active')
    expect(byDecision(await pendingView(e), entry.id)).toMatchObject({ kind: 'missed-change' })
  })

  it('并成版本删掉的旧那条在「最近删除」里带上这次并成版本作来源，对方是留作当前的那条', async () => {
    const e = env()
    const [a, b] = [await create(e, 'mem_a', { content: '服务监听 8100' }), await create(e, 'mem_b', { content: '服务监听 8200' })]
    const entry = (await e.decisions.upsert({ kind: 'missed-change', memoryIds: ['mem_a', 'mem_b'], summary: '端口变了', fingerprint: conflictFingerprint([a, b]) }, 1)).entry
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'as-versions', current: 'mem_b' }))
    ok(await e.run({ cmd: 'refresh-views' }))
    const deleted = deletedViewSchema.parse(await e.readView('deleted'))
    // 并成版本的改前快照记在条目的 changes 上（不在 settled.snapshotId）
    const settled = (await e.decisions.listSettled()).find(d => d.id === entry.id)!
    const snapshotId = settled.changes?.find(c => c.memoryId === 'mem_a')?.snapshotId
    expect(snapshotId).toEqual(expect.any(String))
    const item = deleted.items.find(i => i.memory.id === 'mem_a')!
    expect(item).toMatchObject({ cause: { decisionId: entry.id, verdict: 'as-versions', counterpartId: 'mem_b', snapshotId } })

    // 在「最近删除」里恢复它：撤销整次并成版本，旧那条回来，这一对回到待处理
    const restored = ok(await e.run({ cmd: 'restore', memoryId: 'mem_a', layer: scopeOfMemory(item.memory) }))
    expect(restored.decisionId).toBe(entry.id)
    expect((await e.store.get('mem_a'))!.status).toBe('active')
    expect(byDecision(await pendingView(e), entry.id)).toMatchObject({ kind: 'missed-change' })
  })

  it('例外条目没有成员（账本里 memoryIds 为空）：跳过，不产出不合契约的条目，整页照常解析', async () => {
    const e = env()
    await create(e, 'mem_a')
    const empty = (await e.decisions.upsert({ kind: 'exception', memoryIds: [], summary: '空的', fingerprint: 'fp-empty' }, 1)).entry
    const view = await pendingView(e)
    expect(byDecision(view, empty.id)).toBeUndefined()
  })

  it.each([
    ['as-versions', 'mem_a', ['active', 'deleted']],
    ['not-conflict', undefined, ['active', 'active']],
    ['exception', undefined, ['active', 'active']],
  ] as const)('横向冲突 %s（并成版本时留作当前的可以是左边那条；确实不冲突、记成例外两条都不动）：原样记下裁决值', async (verdict, current, statuses) => {
    const e = env()
    const [a, b] = [await create(e, 'mem_a'), await create(e, 'mem_b')]
    const entry = (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: conflictFingerprint([a, b]) }, 1)).entry
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict, ...(current !== undefined ? { current } : {}) }))
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[entry.id, verdict]])
    expect([(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]).toEqual(statuses)
  })

  it('忽略：漏记的变化、例外提示、依据已变、跨项目重复都能忽略，记忆不动', async () => {
    const e = env()
    const [a, b] = [await create(e, 'mem_a'), await create(e, 'mem_b')]
    const [x, y] = [await create(e, 'mem_x', { scope: 'workspace', workspacePath: SESSION_WS }), await create(e, 'mem_y', { scope: 'workspace', workspacePath: OTHER_WS })]
    const ids: string[] = []
    ids.push((await e.decisions.upsert({ kind: 'missed-change', memoryIds: ['mem_a', 'mem_b'], summary: '变了', fingerprint: conflictFingerprint([a, b]) }, 1)).entry.id)
    ids.push((await e.decisions.upsert({ kind: 'exception', memoryIds: ['mem_a'], baselineRef: 'AGENTS.md', summary: '例外', fingerprint: conflictFingerprint([a]) }, 2)).entry.id)
    ids.push((await e.decisions.upsert({ kind: 'premise-changed', memoryIds: ['mem_b', 'mem_a'], summary: '依据变了', fingerprint: 'fp-p' }, 3)).entry.id)
    ids.push((await e.decisions.upsert({ kind: 'cross-duplicate', memoryIds: ['mem_x', 'mem_y'], workspaces: [SESSION_WS, OTHER_WS], summary: '重复', fingerprint: conflictFingerprint([x, y]) }, 4)).entry.id)
    for (const id of ids) ok(await e.run({ cmd: 'resolve', decisionId: id, verdict: 'dismiss', allowCrossWorkspace: true }))
    expect((await e.decisions.listSettled()).map(d => [d.kind, d.settled?.verdict]).sort()).toEqual([
      ['cross-duplicate', 'dismiss'], ['exception', 'dismiss'], ['missed-change', 'dismiss'], ['premise-changed', 'dismiss'],
    ])
    for (const id of ['mem_a', 'mem_b', 'mem_x', 'mem_y']) expect((await e.store.get(id))!.status, id).toBe('active')
    expect((await pendingView(e)).items).toEqual([])
  })

  it('表外的组合、并成版本缺 current 或 current 不在这一对里：回 invalid-args，条目和记忆都不动', async () => {
    const e = env()
    const [a, b] = [await create(e, 'mem_a'), await create(e, 'mem_b')]
    const premise = (await e.decisions.upsert({ kind: 'premise-changed', memoryIds: ['mem_a', 'mem_b'], summary: '依据变了', fingerprint: 'fp-p' }, 1)).entry
    const missed = (await e.decisions.upsert({ kind: 'missed-change', memoryIds: ['mem_a', 'mem_b'], summary: '变了', fingerprint: conflictFingerprint([a, b]) }, 2)).entry
    const before = await e.decisions.list()
    expect(err(await e.run({ cmd: 'resolve', decisionId: premise.id, verdict: 'not-conflict' })).code).toBe('invalid-args')
    expect(err(await e.run({ cmd: 'resolve', decisionId: missed.id, verdict: 'keep-left' })).code).toBe('invalid-args')
    expect(err(await e.run({ cmd: 'resolve', decisionId: missed.id, verdict: 'as-versions' })).code).toBe('invalid-args')
    expect(err(await e.run({ cmd: 'resolve', decisionId: missed.id, verdict: 'as-versions', current: 'mem_zzz' })).code).toBe('invalid-args')
    expect(await e.decisions.list()).toEqual(before)
    expect([(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]).toEqual(['active', 'active'])
  })
})
