import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baselineFingerprint, conflictFingerprint, suggestionBasis, type PendingTable } from '../src/governance/decisions.ts'
import { editFingerprint } from '../src/governance/snapshots.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { deletedViewSchema, pendingViewSchema, type MemoryCommand } from '../src/gui/contract.ts'
import type { ReadEventFn } from '../src/tools/source.ts'
import { scopeAt, type Scope } from '../src/scope.ts'
import { locateCopy, workspaceLabel } from '../src/tools/workspace-gate.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { NOW, SESSION_WS, OTHER_WS, root, setRoot, type EnvOpts, env, ok, err, seedPair, allEntries, memoryTree, ledgerItems } from './helpers/gui-command-env.ts'
import { memoryText } from './helpers/memory-text.ts'


describe('apply-proposal（采纳建议：保留一方、都保留）', () => {
  /** 模型桩按顺序给出这几份回答。 */
  const answering = (...answers: string[]): SemanticLlm => ({ model: 'deepseek-v4-flash', complete: async () => answers.shift() ?? '' })
  const said = (action: string, extra: object = {}) => JSON.stringify({ action, reason: `模型说 ${action}`, ...extra })
  const horizontalOf = async (e: ReturnType<typeof env>, id: string) => {
    const item = pendingViewSchema.parse(await e.readView('pending')).items.find(i => 'decisionId' in i && i.decisionId === id)
    if (item?.kind !== 'conflict-horizontal') throw new Error(`没有横向冲突项 ${id}`)
    return item
  }
  /** 一对冲突，账本条目带真实指纹和一份建议（走「补上建议」写进去，依据由真实函数算出）。 */
  async function suggested(action: string, extra: object = {}) {
    const e = env({ llm: answering(said(action, extra)) })
    await seedPair(e)
    const fingerprint = conflictFingerprint([(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!])
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint }, 2)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    const suggestion = (await e.decisions.get(entry.id))!.suggestion!
    return { e, entry, suggestion }
  }
  const statuses = async (e: ReturnType<typeof env>) => [(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]

  it('保留 A：B 软删、快照先行，条目记现有的删一方裁决加依据和结论代码；撤销后 B 回来、条目回到待处理、建议还在', async () => {
    const { e, entry, suggestion } = await suggested('keep-a')
    const body = ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
    expect(await statuses(e)).toEqual(['active', 'deleted'])
    const [snap] = await e.snapshots.list()
    expect(body).toEqual({ ok: true, cmd: 'apply-proposal', decisionId: entry.id, snapshotId: snap!.id })
    expect((await e.decisions.listSettled()).map(d => d.settled)).toEqual([
      { verdict: 'keep-left', at: NOW, snapshotId: snap!.id, proposal: { source: 'suggestion', action: 'keep-a' } },
    ])
    // 最近删除的来由同直接裁决：恢复它等同撤销这次裁决
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => [i.memory.id, i.cause?.decisionId])).toEqual([['mem_b', entry.id]])

    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect(await statuses(e)).toEqual(['active', 'active'])
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await horizontalOf(e, entry.id)).suggestion).toMatchObject({ id: suggestion.id, action: 'keep-a' })
  })

  it('保留 B：删 A，记 keep-right', async () => {
    const { e, entry, suggestion } = await suggested('keep-b')
    ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
    expect(await statuses(e)).toEqual(['deleted', 'active'])
    expect((await e.decisions.listSettled()).map(d => [d.settled?.verdict, d.settled?.proposal])).toEqual([['keep-right', { source: 'suggestion', action: 'keep-b' }]])
  })

  it('都保留：记现有的都保留裁决加依据，体检同一对不再挂账；撤销后建议还在', async () => {
    const { e, entry, suggestion } = await suggested('keep-both')
    const body = ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
    expect(body).toEqual({ ok: true, cmd: 'apply-proposal', decisionId: entry.id })
    expect(await statuses(e)).toEqual(['active', 'active'])
    expect(await e.snapshots.list()).toEqual([])
    const [settled] = await e.decisions.listSettled()
    expect(settled!.settled).toEqual({ verdict: 'keep-both', at: NOW, proposal: { source: 'suggestion', action: 'keep-both' } })
    expect((await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '再报', fingerprint: settled!.fingerprint! }, 3)).settled).toBe(true)

    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await horizontalOf(e, entry.id)).suggestion?.id).toBe(suggestion.id)
  })

  it('直接裁决不带依据：结清信息里没有 proposal', async () => {
    const { e, entry } = await suggested('keep-a')
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect((await e.decisions.listSettled())[0]!.settled).not.toHaveProperty('proposal')
  })

  it('建议 id 对不上（已被新的一份替换、或条目上没有建议）：回 stale，什么都不动，视图重写', async () => {
    const { e, entry } = await suggested('keep-a')
    const body = err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: 'sg_old' }))
    expect(body.code).toBe('stale')
    expect(await statuses(e)).toEqual(['active', 'active'])
    expect(await e.snapshots.list()).toEqual([])
    expect(await e.decisions.listSettled()).toEqual([])

    await rm(root, { recursive: true, force: true })
    setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
    const bare = env()
    const plain = await seedPair(bare)
    expect(err(await bare.run({ cmd: 'apply-proposal', decisionId: plain.id, suggestionId: 'sg_x' })).code).toBe('stale')
    expect(await statuses(bare)).toEqual(['active', 'active'])
  })

  it.each([
    ['只改了摘要', (r: MemoryRecord) => ({ ...r, summary: '只改了摘要' })],
    ['只改了标签', (r: MemoryRecord) => ({ ...r, tags: ['别处加的'] })],
  ])('建议生成后 B %s：回 stale，什么都不删，视图里建议随之失效', async (_label, change) => {
    const { e, entry, suggestion } = await suggested('keep-a')
    await e.store.update({ id: 'mem_b' }, change)
    expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id })).code).toBe('stale')
    expect(await statuses(e)).toEqual(['active', 'active'])
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await horizontalOf(e, entry.id)).suggestion).toBeUndefined()
  })

  it('核对之后、软删之前 B 被别处改过：锁内比对挡下，回 stale，B 不删、条目不结清', async () => {
    const { e, entry, suggestion } = await suggested('keep-a')
    const softDelete = e.store.softDeleteUnlessSecret.bind(e.store)
    e.store.softDeleteUnlessSecret = (async (r: MemoryRecord, ...rest: unknown[]) => {
      if (r.id === 'mem_b') await e.store.update({ id: 'mem_b' }, cur => ({ ...cur, summary: '别处刚改的' }))
      return (softDelete as (...args: unknown[]) => Promise<unknown>)(r, ...rest)
    }) as never
    expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id })).code).toBe('stale')
    expect(await e.store.get('mem_b')).toMatchObject({ status: 'active', summary: '别处刚改的' })
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
  })

  it('两个标签页同时采纳：只成一次，只删一方、只拍一份快照；另一次回 claimed 或 not-found，什么都不动', async () => {
    const { e, entry, suggestion } = await suggested('keep-a')
    const other = env()
    const results = await Promise.all([
      e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }),
      other.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(['claimed', 'not-found']).toContain(err(results.find(r => !r.ok)!).code)
    expect(await statuses(e)).toEqual(['active', 'deleted'])
    expect(await e.snapshots.list()).toHaveLength(1)
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['keep-left'])
  })

  it('采纳与相反的直接裁决同时到：只有一条生效，只删一方', async () => {
    const { e, entry, suggestion } = await suggested('keep-a')
    const results = await Promise.all([
      e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }),
      e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' }),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect((await statuses(e)).filter(s => s === 'deleted')).toHaveLength(1)
  })

  it('条目不在待处理：not-found；不是冲突：invalid-args；垂直冲突没有这份建议：stale', async () => {
    const e = env()
    expect(err(await e.run({ cmd: 'apply-proposal', decisionId: 'pd_ghost', suggestionId: 'sg_x' })).code).toBe('not-found')
    await e.store.create(record({ id: 'mem_v', content: '用 npm' }))
    const vertical = (await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：用 pnpm', summary: 'v', fingerprint: 'fp-v' }, 1)).entry
    expect(err(await e.run({ cmd: 'apply-proposal', decisionId: vertical.id, suggestionId: 'sg_x' })).code).toBe('stale')
    await e.decisions.syncOverflow(SESSION_WS, { mode: 'relax', tier: 1 }, 1, '超限')
    const overflow = (await e.decisions.list()).find(d => d.kind === 'overflow')!
    expect(err(await e.run({ cmd: 'apply-proposal', decisionId: overflow.id, suggestionId: 'sg_x' })).code).toBe('invalid-args')
  })

  it('一方属于别的项目：同裁决过跨项目门，带 allowCrossWorkspace 后照常采纳', async () => {
    const e = env({ llm: answering(said('keep-a')) })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', scope: 'workspace', workspacePath: OTHER_WS }))
    const records = [(await e.store.get('mem_a'))!, (await e.store.get('mem_b', { workspacePath: OTHER_WS }))!]
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: conflictFingerprint(records) }, 1)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    const suggestionId = (await e.decisions.get(entry.id))!.suggestion!.id
    expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId })).code).toBe('cross-workspace')
    expect((await e.store.get('mem_b', { workspacePath: OTHER_WS }))!.status).toBe('active')
    ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId, allowCrossWorkspace: true }))
    expect((await e.store.get('mem_b', { workspacePath: OTHER_WS }))!.status).toBe('deleted')
  })

  it('治理开关关着、子 agent 会话：拒绝，什么都不动', async () => {
    for (const opts of [{ governanceEnabled: false }, { delegationDepth: 1 }]) {
      const e = env(opts)
      const entry = await seedPair(e)
      expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: 'sg_x' })).code).toBe('governanceEnabled' in opts ? 'governance-disabled' : 'subagent-readonly')
      expect(await statuses(e)).toEqual(['active', 'active'])
      await rm(root, { recursive: true, force: true })
      setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
    }
  })
})

describe('apply-proposal（采纳融合建议：保留方改写成融合稿，另一条进最近删除）', () => {
  const LATER = NOW + 1000
  const DRAFT = { content: '前端仓用 pnpm，脚本仓用 npm', summary: '按仓库选包管理器', name: '包管理器按仓库选', tags: ['包管理器'] }
  const said = (draft: object = DRAFT) => JSON.stringify({ action: 'merge', reason: '两条各有适用范围', draft })
  const answering = (...answers: string[]): SemanticLlm => ({ model: 'deepseek-v4-flash', complete: async () => answers.shift() ?? '' })
  const GLOBAL = { kind: 'global' } as const
  const OWN = { kind: 'workspace', workspacePath: SESSION_WS } as const
  /** 条目带真实冲突指纹，走「补上建议」写进一份融合建议（依据由真实函数算出）。 */
  async function suggestMerge(e: ReturnType<typeof env>) {
    const pair = await Promise.all(['mem_a', 'mem_b'].map(id => e.store.get(id, { workspacePath: SESSION_WS })))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: conflictFingerprint(pair as MemoryRecord[]) }, 2)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    const suggestion = (await e.decisions.get(entry.id))!.suggestion!
    expect(suggestion.action).toBe('merge')
    return { entry: (await e.decisions.get(entry.id))!, suggestion }
  }
  /** 两条全局记忆（同建时刻，按 id 定保留方：A）各一份融合建议。 */
  async function merged(opts: EnvOpts = {}) {
    const e = env({ llm: answering(said()), ...opts })
    await seedPair(e)
    return { e, ...await suggestMerge(e) }
  }
  const adopt = (e: ReturnType<typeof env>, decisionId: string, suggestionId: string, extra: object = {}) =>
    e.run({ cmd: 'apply-proposal', decisionId, suggestionId, ...extra })
  /** 两条的文件（路径和逐字节内容）；不在为 undefined。 */
  const files = async (e: ReturnType<typeof env>, at: readonly [Scope, Scope] = [GLOBAL, GLOBAL]) => Promise.all(['mem_a', 'mem_b'].map(async (id, i) => {
    const located = await e.store.locate(id, at[i]!)
    return located === undefined ? undefined : [located.filePath, await memoryText(located.filePath)]
  }))
  const horizontalOf = async (e: ReturnType<typeof env>, id: string) => {
    const item = pendingViewSchema.parse(await e.readView('pending')).items.find(i => 'decisionId' in i && i.decisionId === id)
    if (item?.kind !== 'conflict-horizontal') throw new Error(`没有横向冲突项 ${id}`)
    return item
  }
  const deletedItems = async (e: ReturnType<typeof env>) => deletedViewSchema.parse(await e.readView('deleted')).items

  it('保留方改写成融合稿、另一条软删，两条各拍一份改前快照；条目结清为 plan-applied，带回执、依据、改后指纹，引用被删那条的其他条目清掉', async () => {
    const { e, entry, suggestion } = await merged()
    const other = (await e.decisions.upsert({ memoryIds: ['mem_b', 'mem_c'], summary: '另一条冲突', fingerprint: 'fp-bc' }, 1)).entry
    e.clock.now = LATER
    const body = ok(await adopt(e, entry.id, suggestion.id))
    const snaps = await e.snapshots.list()
    expect(snaps.map(s => s.data.map(r => [r.id, r.content])).sort()).toEqual([[['mem_a', '用 pnpm']], [['mem_b', '用 npm']]])
    // 结果和条目上带的是第一项（融合稿）的快照
    const snap = snaps.find(s => s.memoryIds.includes('mem_a'))
    expect(body).toEqual({ ok: true, cmd: 'apply-proposal', decisionId: entry.id, memoryIds: ['mem_a', 'mem_b'], snapshotId: snap!.id })
    const a = (await e.store.get('mem_a'))!
    const b = (await e.store.get('mem_b'))!
    expect(a).toMatchObject({ ...DRAFT, status: 'active', updatedAt: LATER })
    expect(b).toMatchObject({ status: 'deleted', content: '用 npm' })
    // 被删的那条记下它并进了保留方：历史版本以后归到保留方名下
    expect(b.mergedInto).toMatchObject({ id: 'mem_a', as: 'merge' })

    const settled = await e.decisions.listSettled()
    expect(settled.map(d => d.id)).toEqual([entry.id])
    expect(await e.decisions.get(other.id)).toBeUndefined()
    expect(settled[0]!.settled).toEqual({
      verdict: 'plan-applied', at: LATER, snapshotId: snap!.id, proposal: { source: 'suggestion', action: 'merge' },
      receipts: [
        { memoryId: 'mem_a', op: 'edit', fingerprint: editFingerprint(a), expectedStatus: 'active' },
        { memoryId: 'mem_b', op: 'forget', fingerprint: editFingerprint(b), expectedStatus: 'deleted' },
      ],
      priorFingerprint: entry.fingerprint,
    })
    expect(settled[0]!.fingerprint).toBe(conflictFingerprint([a, b]))
    // 建议是用户看过的那份，结清时留在条目上（撤销后继续显示）
    expect(settled[0]!.suggestion?.id).toBe(suggestion.id)
    // 最近删除的来由：融合时并入了另一条，对方是保留方
    expect((await deletedItems(e)).map(i => [i.memory.id, i.cause])).toEqual([['mem_b', { decisionId: entry.id, verdict: 'plan-applied', counterpartId: 'mem_a', snapshotId: snap!.id }]])
    expect(pendingViewSchema.parse(await e.readView('pending')).items.filter(i => 'decisionId' in i && i.decisionId === entry.id)).toEqual([])
  })

  it('融合稿和保留方现在的内容一模一样：照常采纳，只删另一条，条目结清，撤销后另一条回来', async () => {
    // 稿取保留方（seedPair 建的 mem_a）此刻的四项，一个字不差
    const keeper = record({ id: 'mem_a', name: '甲', content: '用 pnpm' })
    const same = { content: keeper.content, summary: keeper.summary, name: keeper.name, tags: keeper.tags }
    const e2 = env({ llm: answering(said(same)) })
    await seedPair(e2)
    const { entry, suggestion } = await suggestMerge(e2)
    const before = await files(e2)
    e2.clock.now = LATER
    const body = ok(await adopt(e2, entry.id, suggestion.id))
    expect(body.memoryIds).toEqual(['mem_a', 'mem_b'])
    expect((await e2.store.get('mem_b'))!.status).toBe('deleted')
    expect((await e2.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[entry.id, 'plan-applied']])
    ok(await e2.run({ cmd: 'undo', decisionId: entry.id }))
    expect(await files(e2)).toEqual(before)
  })

  it('撤销：两条逐字节恢复原样，冲突回到待处理，指纹还原，原来的建议还在卡上', async () => {
    const { e, entry, suggestion } = await merged()
    const before = await files(e)
    e.clock.now = LATER
    ok(await adopt(e, entry.id, suggestion.id))
    expect(await files(e)).not.toEqual(before)

    const undone = ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect([...undone.memoryIds!].sort()).toEqual(['mem_a', 'mem_b'])
    expect(await files(e)).toEqual(before)
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await e.decisions.get(entry.id))!.fingerprint).toBe(entry.fingerprint)
    expect((await horizontalOf(e, entry.id)).suggestion).toMatchObject({ id: suggestion.id, action: 'merge' })
    expect(await deletedItems(e)).toEqual([])
  })

  it('离开视图后从最近删除整体撤销：按视图里被并入那条的来源撤销这次融合，两条回到融合前，最近删除不留残余', async () => {
    const { e, entry, suggestion } = await merged()
    const before = await files(e)
    e.clock.now = LATER
    ok(await adopt(e, entry.id, suggestion.id))
    // 结果卡已经收起：手上只有重新读出的最近删除视图
    const [dropped] = await deletedItems(e)
    expect(dropped!.cause).toMatchObject({ verdict: 'plan-applied', counterpartId: 'mem_a' })
    const undone = ok(await e.run({ cmd: 'undo', decisionId: dropped!.cause!.decisionId, snapshotId: dropped!.cause!.snapshotId }))
    expect([...undone.memoryIds!].sort()).toEqual(['mem_a', 'mem_b'])
    expect(await files(e)).toEqual(before)
    expect(await deletedItems(e)).toEqual([])
    expect((await horizontalOf(e, entry.id)).suggestion).toMatchObject({ id: suggestion.id, action: 'merge' })
  })

  it('最近删除里看到的融合之后被撤销、又改成保留一方：按旧来源发来的整体撤销回 stale，新裁决原样留着', async () => {
    const { e, entry, suggestion } = await merged()
    ok(await adopt(e, entry.id, suggestion.id))
    const [dropped] = await deletedItems(e)
    const delayed = { cmd: 'undo', decisionId: dropped!.cause!.decisionId, snapshotId: dropped!.cause!.snapshotId } as const
    e.clock.now = LATER
    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    const resettled = (await e.decisions.listSettled()).map(d => d.settled)

    expect(err(await e.run(delayed)).code).toBe('stale')
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect((await e.decisions.listSettled()).map(d => d.settled)).toEqual(resettled)
    expect(resettled[0]).toMatchObject({ verdict: 'keep-left' })
  })

  it('同 id 在别的作用域另有一份、之后被单独删掉：最近删除里那一行不挂这次融合的来源，不给整体撤销', async () => {
    const e = env({ llm: answering(said()) })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS, createdAt: 1 }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', createdAt: 5 }))
    const { entry, suggestion } = await suggestMerge(e)
    ok(await adopt(e, entry.id, suggestion.id))
    expect((await deletedItems(e)).map(i => [i.memory.name, i.cause?.decisionId])).toEqual([['甲', entry.id]])
    await e.store.create(record({ id: 'mem_a', name: '无关的全局副本', content: '别的内容' }))
    e.clock.now = LATER
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_a', layer: GLOBAL }))
    expect((await deletedItems(e)).map(i => [i.memory.name, i.cause])).toEqual([['无关的全局副本', undefined]])
  })

  describe('同 id 在别的作用域另有一份，和这次裁决落在同一毫秒被单独删掉（条目记着各自所在的作用域）', () => {
    /** 项目 A、全局 B 一对冲突，条目按体检的写法带 workspaces；另建一份无关的全局 A。 */
    async function crossScoped() {
      const e = env({ llm: answering(said()) })
      await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS, createdAt: 1 }))
      await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', createdAt: 5 }))
      const pair = [(await locateCopy(e.store, 'mem_a', OWN))!, (await locateCopy(e.store, 'mem_b', GLOBAL))!]
      const { entry } = await e.decisions.upsert({
        memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', workspaces: pair.map(workspaceLabel), fingerprint: conflictFingerprint(pair),
      }, 2)
      expect(entry.workspaces).toEqual([SESSION_WS, 'global'])
      return { e, entry }
    }
    const unrelatedGlobalA = (e: ReturnType<typeof env>) => e.store.create(record({ id: 'mem_a', name: '无关的全局副本', content: '别的内容' }))

    it('融合：结清后条目的 workspaces 原样按 memoryIds 的顺序留着；全局那份不挂融合的来源', async () => {
      const { e, entry } = await crossScoped()
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      ok(await adopt(e, entry.id, (await e.decisions.get(entry.id))!.suggestion!.id))
      expect((await e.decisions.listSettled()).map(d => [d.settled!.verdict, d.workspaces])).toEqual([['plan-applied', [SESSION_WS, 'global']]])
      await unrelatedGlobalA(e)
      ok(await e.run({ cmd: 'forget', memoryId: 'mem_a', layer: GLOBAL }))
      const [row] = await deletedItems(e)
      expect(row!.deletedAt).toBe((await e.decisions.listSettled())[0]!.settled!.at)
      expect((await deletedItems(e)).map(i => [i.memory.name, i.cause])).toEqual([['无关的全局副本', undefined]])
    })

    it('保留 B（删项目 A）：结清后 workspaces 原样留着；全局那份不挂这次裁决的来源；被删的项目 A 自己照旧挂', async () => {
      const { e, entry } = await crossScoped()
      ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' }))
      expect((await e.decisions.listSettled()).map(d => [d.settled!.verdict, d.workspaces])).toEqual([['keep-right', [SESSION_WS, 'global']]])
      expect((await deletedItems(e)).map(i => [i.memory.name, i.cause?.decisionId])).toEqual([['甲', entry.id]])
      await unrelatedGlobalA(e)
      ok(await e.run({ cmd: 'forget', memoryId: 'mem_a', layer: GLOBAL }))
      expect((await deletedItems(e)).map(i => [i.memory.name, i.cause])).toEqual([['无关的全局副本', undefined]])
    })
  })

  it('被并入那条的删除时刻就是条目的结清时刻（时钟在命令执行中一直走也一样）', async () => {
    const { e, entry, suggestion } = await merged()
    let t = NOW
    Object.defineProperty(e.clock, 'now', { get: () => (t += 7) })
    ok(await adopt(e, entry.id, suggestion.id))
    const [settled] = await e.decisions.listSettled()
    expect((await e.store.get('mem_b'))!.deletedAt).toBe(settled!.settled!.at)
  })

  it('撤销时融合稿在落盘后又被改过：回 stale，什么都不动', async () => {
    const { e, entry, suggestion } = await merged()
    ok(await adopt(e, entry.id, suggestion.id))
    await e.store.update({ id: 'mem_a' }, r => ({ ...r, content: '落盘后又改的' }))
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('stale')
    expect(await e.store.get('mem_a')).toMatchObject({ status: 'active', content: '落盘后又改的' })
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([entry.id])
  })

  it('从最近删除恢复被并入的那条：只恢复它，融合稿不退回，条目清掉，之后整条撤销回 not-found', async () => {
    const { e, entry, suggestion } = await merged()
    ok(await adopt(e, entry.id, suggestion.id))
    const restored = ok(await e.run({ cmd: 'restore', memoryId: 'mem_b' }))
    expect(restored.memoryIds).toEqual(['mem_b'])
    expect(restored.decisionId).toBeUndefined()
    expect(await e.store.get('mem_b')).toMatchObject({ status: 'active', content: '用 npm' })
    expect(await e.store.get('mem_a')).toMatchObject({ status: 'active', content: DRAFT.content })
    expect(await allEntries(e)).toEqual([])
    expect(await deletedItems(e)).toEqual([])
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('not-found')
  })

  it('一条全局、一条项目：按合并规则写进全局那条（即便它后建），项目那条进最近删除；撤销后两条回到各自作用域', async () => {
    const e = env({ llm: answering(said()) })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS, createdAt: 1 }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', createdAt: 5 }))
    const { entry, suggestion } = await suggestMerge(e)
    const at = [OWN, GLOBAL] as const
    const before = await files(e, at)
    const body = ok(await adopt(e, entry.id, suggestion.id))
    expect(body.memoryIds).toEqual(['mem_b', 'mem_a'])
    expect(await locateCopy(e.store, 'mem_b', GLOBAL)).toMatchObject({ status: 'active', content: DRAFT.content })
    expect((await locateCopy(e.store, 'mem_a', OWN))!.status).toBe('deleted')
    expect((await deletedItems(e)).map(i => i.cause?.counterpartId)).toEqual(['mem_b'])

    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect(await files(e, at)).toEqual(before)
  })

  it('建议生成后 B 的标签被改过：回 stale，什么都不动，不拍快照', async () => {
    const { e, entry, suggestion } = await merged()
    await e.store.update({ id: 'mem_b' }, r => ({ ...r, tags: ['别处加的'] }))
    expect(err(await adopt(e, entry.id, suggestion.id))).toMatchObject({ code: 'stale', memoryIds: ['mem_a', 'mem_b'] })
    expect((await e.store.get('mem_a'))!.content).toBe('用 pnpm')
    expect(await e.snapshots.list()).toEqual([])
    expect(await e.decisions.listSettled()).toEqual([])
  })

  describe('写到一半失败（故障在进程边界注入：另一个会话改磁盘、写盘报错、账本写不进去）', () => {
    type Method = 'softDeleteUnlessSecret' | 'put'
    /** nth：这条记忆第几次走到这个方法（从 1 起）。融合稿的写入和退回都走 put：mem_a 的第 1 次是写入，第 2 次是退回。 */
    function intercept(e: ReturnType<typeof env>, method: Method, around: (id: string, call: () => Promise<unknown>, nth: number) => Promise<unknown>) {
      const original = (e.store[method] as (...args: unknown[]) => Promise<unknown>).bind(e.store)
      const seen = new Map<string, number>()
      e.store[method] = ((r: { id: string }, ...rest: unknown[]) => {
        const nth = (seen.get(r.id) ?? 0) + 1
        seen.set(r.id, nth)
        return around(r.id, () => original(r, ...rest), nth)
      }) as never
    }
    /** 别处直接改磁盘：绕过包装。 */
    const elsewhere = (e: ReturnType<typeof env>) => {
      const update = e.store.update.bind(e.store)
      return (id: string, summary: string) => update({ id }, r => ({ ...r, summary }))
    }

    it('软删 B 之前 B 被别处改过：锁内比对挡下，已写的融合稿按快照退回、文件逐字节复原，回 stale，条目不结清、建议随之失效', async () => {
      const { e, entry, suggestion } = await merged()
      const before = await files(e)
      const change = elsewhere(e)
      intercept(e, 'softDeleteUnlessSecret', async (id, call) => { if (id === 'mem_b') await change('mem_b', '别处刚改的'); return call() })
      e.clock.now = LATER
      expect(err(await adopt(e, entry.id, suggestion.id))).toMatchObject({ code: 'stale', memoryIds: ['mem_b'] })
      expect((await files(e))[0]).toEqual(before[0])
      expect(await e.store.get('mem_b')).toMatchObject({ status: 'active', summary: '别处刚改的' })
      expect(await e.decisions.listSettled()).toEqual([])
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
      expect((await horizontalOf(e, entry.id)).suggestion).toBeUndefined()
    })

    it('退回融合稿之前它又被别处接着改过：不覆盖，回 isPartial，A 列进 unrecordedIds，不记账、冲突条目不结清', async () => {
      const { e, entry, suggestion } = await merged()
      const change = elsewhere(e)
      intercept(e, 'softDeleteUnlessSecret', async (id, call) => { if (id === 'mem_b') await change('mem_b', '别处刚改的'); return call() })
      intercept(e, 'put', async (id, call, nth) => { if (id === 'mem_a' && nth === 2) await change('mem_a', '别处接着改的'); return call() })
      const body = ok(await adopt(e, entry.id, suggestion.id))
      expect(body).toMatchObject({ isPartial: true, memoryIds: [], unrecordedIds: ['mem_a'] })
      expect(body.decisionId).toBeUndefined()
      expect(await e.store.get('mem_a')).toMatchObject({ content: DRAFT.content, summary: '别处接着改的' })
      expect(await e.decisions.listSettled()).toEqual([])
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    })

    it('退回融合稿时写盘报错、它仍是这次写下的：回 isPartial，A 照常记一笔可撤销的账，撤销后复原', async () => {
      const { e, entry, suggestion } = await merged()
      const before = await files(e)
      const change = elsewhere(e)
      intercept(e, 'softDeleteUnlessSecret', async (id, call) => { if (id === 'mem_b') await change('mem_b', '别处刚改的'); return call() })
      intercept(e, 'put', async (id, call, nth) => { if (id === 'mem_a' && nth === 2) throw new Error('磁盘满了'); return call() })
      e.clock.now = LATER
      const body = ok(await adopt(e, entry.id, suggestion.id))
      expect(body).toMatchObject({ isPartial: true, memoryIds: ['mem_a'], unrecordedIds: [] })
      expect(body.decisionId).toBeDefined()
      expect(body.decisionId).not.toBe(entry.id)
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
      ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
      expect((await files(e))[0]).toEqual(before[0])
    })

    /** 包一层账本侧表：写进结清的条目时出错（写进去之前、或写进去之后）。 */
    const ledgerFailing = (when: 'before' | 'after', fault = { isFired: false }) => (table: PendingTable): PendingTable => ({
      get: k => table.get(k), list: () => table.list(), delete: k => table.delete(k), deleteIf: (k, isStill) => table.deleteIf(k, isStill), claim: k => table.claim(k),
      put: async (k, v) => {
        const isPlan = v.settled?.verdict === 'plan-applied'
        if (isPlan && when === 'before') throw new Error('账本写不进去')
        await table.put(k, v)
        // 只出一次错：之后撤销还要往这条上写
        if (isPlan && when === 'after' && !fault.isFired) { fault.isFired = true; throw new Error('写完之后清理报错') }
      },
    })

    it('结账没写进去：两条都按快照退回，错误照常报出，条目不结清', async () => {
      const { e, entry, suggestion } = await merged({ wrapPending: ledgerFailing('before') })
      const before = await files(e)
      e.clock.now = LATER
      expect(err(await adopt(e, entry.id, suggestion.id))).toMatchObject({ code: 'failed', detail: '账本写不进去' })
      expect(await files(e)).toEqual(before)
      expect(await e.decisions.listSettled()).toEqual([])
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    })

    it('结账没写进去：引用 B 的其他条目原样留着', async () => {
      const { e, entry, suggestion } = await merged({ wrapPending: ledgerFailing('before') })
      const other = (await e.decisions.upsert({ memoryIds: ['mem_b', 'mem_other'], summary: '另一对', fingerprint: 'fp-other' }, 1)).entry
      e.clock.now = LATER
      expect(err(await adopt(e, entry.id, suggestion.id))).toMatchObject({ code: 'failed' })
      expect((await e.decisions.list()).map(d => d.id).sort()).toEqual([entry.id, other.id].sort())
    })

    it('结账没写进去、退回融合稿时写盘又报错：回 isPartial，A 记一笔可撤销的账，B 已退回，冲突条目不结清', async () => {
      const { e, entry, suggestion } = await merged({ wrapPending: ledgerFailing('before') })
      const before = await files(e)
      intercept(e, 'put', async (id, call, nth) => { if (id === 'mem_a' && nth === 2) throw new Error('磁盘满了'); return call() })
      e.clock.now = LATER
      const body = ok(await adopt(e, entry.id, suggestion.id))
      expect(body).toMatchObject({ isPartial: true, memoryIds: ['mem_a'], unrecordedIds: [] })
      expect(body.decisionId).not.toBe(entry.id)
      expect((await files(e))[1]).toEqual(before[1])
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
      ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
      expect(await files(e)).toEqual(before)
    })

    it('B 的软删写进去之后才报错、退回 B 时写盘又报错：回 isPartial，记账的是仍被删的 B，A 已退回，冲突条目还在', async () => {
      const { e, entry, suggestion } = await merged()
      const before = await files(e)
      intercept(e, 'softDeleteUnlessSecret', async (_id, call) => { await call(); throw new Error('目录维护报错') })
      intercept(e, 'put', async (id, call, nth) => { if (id === 'mem_b' && nth === 1) throw new Error('磁盘满了'); return call() })
      e.clock.now = LATER
      const body = ok(await adopt(e, entry.id, suggestion.id))
      expect(body).toMatchObject({ isPartial: true, memoryIds: ['mem_b'], unrecordedIds: [] })
      expect((await files(e))[0]).toEqual(before[0])
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
      ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
      expect(await files(e)).toEqual(before)
    })

    it('结清的读写之间 B 被别处彻底删除、账本已清：结清不留在账本上', async () => {
      const holder: { purge?: () => Promise<void> } = {}
      const { e, entry, suggestion } = await merged({
        wrapPending: (table: PendingTable): PendingTable => ({
          get: k => table.get(k), list: () => table.list(), delete: k => table.delete(k), deleteIf: (k, isStill) => table.deleteIf(k, isStill), claim: k => table.claim(k),
          put: async (k, v) => {
            if (v.settled?.verdict === 'plan-applied') { await holder.purge?.(); await table.delete(k) }
            await table.put(k, v)
          },
        }),
      })
      holder.purge = async () => { await e.store.hardDelete({ id: 'mem_b' }, { at: GLOBAL }) }
      e.clock.now = LATER
      await adopt(e, entry.id, suggestion.id)
      expect(await e.store.get('mem_b')).toBeUndefined()
      expect(await e.decisions.listSettled()).toEqual([])
      expect(await e.decisions.list()).toEqual([])
    })

    it('结清写进去之后才报错：重读账本，条目已结清就算成功，可以撤销', async () => {
      const { e, entry, suggestion } = await merged({ wrapPending: ledgerFailing('after') })
      const before = await files(e)
      e.clock.now = LATER
      expect(ok(await adopt(e, entry.id, suggestion.id)).decisionId).toBe(entry.id)
      expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['plan-applied'])
      ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
      expect(await files(e)).toEqual(before)
    })
  })

  it('账本上的融合稿含高危密钥（防御：存盘时本已保证不会有）：回 secret-critical，什么都不动', async () => {
    const e = env()
    await seedPair(e)
    const pair = [(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!]
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: conflictFingerprint(pair) }, 2)
    const ops = [{ kind: 'edit' as const, memoryId: 'mem_a', ...DRAFT, content: `token ${FAKE_SECRET.sk}` }, { kind: 'forget' as const, memoryId: 'mem_b' }]
    const suggestion = { id: 'sg_x', action: 'merge' as const, reason: 'r', ops, basis: suggestionBasis(entry, pair), isSourced: false, generatedAt: NOW }
    expect(await e.decisions.writeSuggestion(entry.id, { suggestion }, id => e.store.get(id))).toBe('written')
    expect(err(await adopt(e, entry.id, 'sg_x')).code).toBe('secret-critical')
    expect((await e.store.get('mem_a'))!.content).toBe('用 pnpm')
    expect(await e.snapshots.list()).toEqual([])
  })

  it('两条原文里确认存下的疑似密钥写进融合稿：采纳不再确认，照常落盘；含疑似密钥的那条照常软删、可恢复', async () => {
    const e = env({ llm: answering(said({ ...DRAFT, content: '前端仓用 pnpm，脚本仓用 npm，password: TESTONLY99' })) })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm，password: TESTONLY99' }))
    const { entry, suggestion } = await suggestMerge(e)
    ok(await adopt(e, entry.id, suggestion.id))
    expect((await e.store.get('mem_a'))!.content).toBe('前端仓用 pnpm，脚本仓用 npm，password: TESTONLY99')
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await e.store.get('mem_b'))!.content).toBe('用 npm，password: TESTONLY99')
  })

  it('两个标签页同时采纳：只成一次，快照只有成的那次拍的两份；另一次回 claimed 或 not-found', async () => {
    const { e, entry, suggestion } = await merged()
    const other = env()
    const results = await Promise.all([adopt(e, entry.id, suggestion.id), adopt(other, entry.id, suggestion.id)])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(['claimed', 'not-found']).toContain(err(results.find(r => !r.ok)!).code)
    expect((await e.snapshots.list()).map(s => s.memoryIds).sort()).toEqual([['mem_a'], ['mem_b']])
    expect((await e.store.get('mem_a'))!.content).toBe(DRAFT.content)
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['plan-applied'])
  })

  it('采纳与相反的直接裁决同时到：只有一条生效', async () => {
    const { e, entry, suggestion } = await merged()
    const results = await Promise.all([adopt(e, entry.id, suggestion.id), e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' })])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect([(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status].filter(s => s === 'deleted')).toHaveLength(1)
  })

  it('一方属于别的项目：过跨项目门，带 allowCrossWorkspace 后照常采纳', async () => {
    const e = env({ llm: answering(said()) })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', scope: 'workspace', workspacePath: OTHER_WS }))
    const pair = [(await e.store.get('mem_a'))!, (await e.store.get('mem_b', { workspacePath: OTHER_WS }))!]
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: conflictFingerprint(pair) }, 1)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    const suggestionId = (await e.decisions.get(entry.id))!.suggestion!.id
    expect(err(await adopt(e, entry.id, suggestionId)).code).toBe('cross-workspace')
    expect((await e.store.get('mem_a'))!.content).toBe('用 pnpm')
    expect(await e.snapshots.list()).toEqual([])
    ok(await adopt(e, entry.id, suggestionId, { allowCrossWorkspace: true }))
    expect((await e.store.get('mem_a'))!.content).toBe(DRAFT.content)
    expect((await e.store.get('mem_b', { workspacePath: OTHER_WS }))!.status).toBe('deleted')
  })

  it('彻底删除被并入的那条：这次融合的结清条目连同建议一起清掉', async () => {
    const { e, entry, suggestion } = await merged()
    ok(await adopt(e, entry.id, suggestion.id))
    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_b' }))
    expect(await allEntries(e)).toEqual([])
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('not-found')
  })

  it('还没采纳时删掉其中一条：带融合稿的建议随未决条目一起清掉', async () => {
    const { e } = await merged()
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_b' }))
    expect(await allEntries(e)).toEqual([])
  })
})

describe('draft-proposal 与按要求应用（补充要求）', () => {
  const LATER = NOW + 1000
  const DRAFT = { content: '前端仓用 pnpm，脚本仓用 npm', summary: '按仓库选包管理器', name: '包管理器按仓库选', tags: ['包管理器'] }
  function scripted(...answers: Array<string | Error | (() => Promise<string>)>) {
    const prompts: Array<{ system: string; user: string }> = []
    const llm: SemanticLlm = {
      model: 'deepseek-v4-flash',
      complete: async (prompt) => {
        prompts.push(prompt)
        const next = answers.shift() ?? ''
        if (next instanceof Error) throw next
        return typeof next === 'function' ? next() : next
      },
    }
    return { llm, prompts }
  }
  const said = (action: string, extra: object = {}) => JSON.stringify({ action, reason: `照你说的 ${action}`, ...extra })
  const MERGED = said('merge', { draft: DRAFT })
  /** 卡片上那一份的版本（同 MemoryCard 的 updatedAt、digest）。 */
  const baseOf = (r: MemoryRecord) => ({ updatedAt: r.updatedAt, digest: editFingerprint(r) })
  const basesOf = async (e: ReturnType<typeof env>) => {
    const [a, b] = [(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!]
    return [baseOf(a), baseOf(b)] as [ReturnType<typeof baseOf>, ReturnType<typeof baseOf>]
  }
  /** 一对冲突，条目带真实冲突指纹。 */
  async function seeded(opts: EnvOpts = {}) {
    const e = env(opts)
    await seedPair(e)
    const pair = [(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!]
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: conflictFingerprint(pair) }, 2)
    return { e, entry }
  }
  const draft = async (e: ReturnType<typeof env>, decisionId: string, extra: Partial<Extract<MemoryCommand, { cmd: 'draft-proposal' }>> = {}) =>
    e.run({ cmd: 'draft-proposal', decisionId, request: '两者融合', bases: await basesOf(e), ...extra })
  /** 生成一份方案，交回给应用。 */
  async function drafted(answer: string, opts: EnvOpts = {}) {
    const { e, entry } = await seeded({ llm: scripted(answer).llm, ...opts })
    const proposal = ok(await draft(e, entry.id)).proposal!
    return { e, entry, proposal }
  }
  const statuses = async (e: ReturnType<typeof env>) => [(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]
  const files = async (e: ReturnType<typeof env>) => Promise.all(['mem_a', 'mem_b'].map(async id => {
    const located = await e.store.locate(id, { kind: 'global' })
    return located === undefined ? undefined : [located.filePath, await memoryText(located.filePath)]
  }))

  describe('draft-proposal：只读，按要求回一份方案或做不到', () => {
    it('回方案（结论、说明、逐条操作、依据版本）和模型名；不写账本、不写记忆、不拍快照，不重写视图', async () => {
      const { llm, prompts } = scripted(MERGED)
      const { e, entry } = await seeded({ llm })
      const views = await e.readView('pending').catch(() => undefined)
      const memoriesBefore = await memoryTree()
      const recordsBefore = [await e.store.get('mem_a'), await e.store.get('mem_b')]
      const body = ok(await draft(e, entry.id))
      const [a, b] = [(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!]
      expect(body).toEqual({
        ok: true, cmd: 'draft-proposal', model: 'deepseek-v4-flash',
        proposal: {
          action: 'merge', reason: '照你说的 merge',
          ops: [{ kind: 'edit', memoryId: 'mem_a', ...DRAFT }, { kind: 'forget', memoryId: 'mem_b' }],
          basis: { conflictFingerprint: entry.fingerprint, memories: suggestionBasis(entry, [a, b]).memories },
        },
      })
      expect(body.proposal!.basis.memories.map(m => m.fingerprint)).toEqual([editFingerprint(a), editFingerprint(b)])
      expect(prompts).toHaveLength(1)
      expect(prompts[0]!.user).toContain('## 用户的要求\n两者融合')
      expect(await e.decisions.get(entry.id)).toEqual(entry)
      expect(await e.decisions.listSettled()).toEqual([])
      expect(await e.snapshots.list()).toEqual([])
      expect(await statuses(e)).toEqual(['active', 'active'])
      expect([a, b]).toEqual(recordsBefore)
      expect(await memoryTree()).toEqual(memoriesBefore)
      expect(await e.readView('pending').catch(() => undefined)).toEqual(views)
    })

    it('改要求：此前的要求、上一份方案一起给模型（上一份方案只作参照）', async () => {
      const { llm, prompts } = scripted(MERGED)
      const { e, entry } = await seeded({ llm })
      const previous = { action: 'keep-a' as const, reason: '以 A 为准', ops: [{ kind: 'keep' as const, memoryId: 'mem_a' }, { kind: 'forget' as const, memoryId: 'mem_b' }] }
      ok(await draft(e, entry.id, { request: '还是融合吧', priorRequests: ['以 A 为准'], previous }))
      expect(prompts[0]!.user).toContain('## 此前的要求\n1. 以 A 为准')
      expect(prompts[0]!.user).toContain('## 用户的要求\n还是融合吧')
      expect(prompts[0]!.user).toContain('## 上一份方案\n{\n  "action": "keep-a"')
      expect(prompts[0]!.system).toContain('上一份方案只是参照')
    })

    it('做不到：回 infeasible 只带一句说明（遮疑似密钥），没有方案', async () => {
      const { e, entry } = await seeded({ llm: scripted(JSON.stringify({ action: 'infeasible', reason: '两条里都没有端口号，password: abc12345x' })).llm })
      expect(ok(await draft(e, entry.id, { request: '把端口号并进来' }))).toEqual({
        ok: true, cmd: 'draft-proposal', model: 'deepseek-v4-flash', infeasible: { reason: '两条里都没有端口号，[已隐藏]' },
      })
    })

    it('模型调用不在认领里：生成期间别处能认领这一条', async () => {
      let e!: ReturnType<typeof env>
      let isClaimedElsewhere = false
      const { llm } = scripted(async () => {
        isClaimedElsewhere = (await e.decisions.withClaim((await e.decisions.list())[0]!.id, async () => undefined)).isClaimed
        return MERGED
      })
      e = (await seeded({ llm })).e
      ok(await draft(e, (await e.decisions.list())[0]!.id))
      expect(isClaimedElsewhere).toBe(true)
    })

    it.each([
      ['要求', { request: `融合，token ${FAKE_SECRET.github}` }],
      ['此前的要求', { priorRequests: [`token ${FAKE_SECRET.github}`] }],
      ['上一份方案', { previous: { action: 'merge' as const, reason: 'r', ops: [{ kind: 'edit' as const, memoryId: 'mem_a', content: `token ${FAKE_SECRET.github}`, name: 'n', summary: 's', tags: [] }, { kind: 'forget' as const, memoryId: 'mem_b' }] } }],
    ])('%s含高危密钥：回 secret-critical，不发给模型', async (_label, extra) => {
      const { llm, prompts } = scripted(MERGED)
      const { e, entry } = await seeded({ llm })
      expect(err(await draft(e, entry.id, extra)).code).toBe('secret-critical')
      expect(prompts).toEqual([])
    })

    it('任一条含高危密钥：回 has-secret，不发给模型', async () => {
      const { llm, prompts } = scripted(MERGED)
      const { e, entry } = await seeded({ llm })
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: `用 npm，token ${FAKE_SECRET.github}` }))
      expect(err(await draft(e, entry.id)).code).toBe('has-secret')
      expect(prompts).toEqual([])
    })

    it('卡片版本对不上：回 stale 带两条的 id，不发给模型；生成期间被改过（只改了标签）也回 stale，这一份丢弃', async () => {
      const { llm, prompts } = scripted(MERGED)
      const { e, entry } = await seeded({ llm })
      const bases = await basesOf(e)
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: '别处改了', updatedAt: 5 }))
      expect(err(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '融合', bases }))).toMatchObject({ code: 'stale', memoryIds: ['mem_b'] })
      expect(prompts).toEqual([])

      let racing!: ReturnType<typeof env>
      const during = scripted(async () => {
        await racing.store.update({ id: 'mem_b' }, r => ({ ...r, tags: ['别处加的'] }))
        return MERGED
      })
      await rm(root, { recursive: true, force: true })
      setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
      const second = await seeded({ llm: during.llm })
      racing = second.e
      expect(err(await draft(second.e, second.entry.id))).toMatchObject({ code: 'stale', memoryIds: ['mem_a', 'mem_b'] })
    })

    it('条目不在、卡片版本条数和条目对不上、一方已不在用：not-found / invalid-args / not-found 带记忆 id', async () => {
      const { llm, prompts } = scripted(MERGED)
      const { e, entry } = await seeded({ llm })
      const bases = await basesOf(e)
      expect(err(await e.run({ cmd: 'draft-proposal', decisionId: 'pd_ghost', request: '融合', bases })).code).toBe('not-found')
      await e.store.create(record({ id: 'mem_v', content: '用 npm' }))
      const vertical = (await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：用 pnpm', summary: 'v', fingerprint: 'fp-v' }, 1)).entry
      expect(err(await e.run({ cmd: 'draft-proposal', decisionId: vertical.id, request: '融合', bases })).code).toBe('invalid-args')
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, status: 'deleted', deletedAt: NOW }))
      expect(err(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '融合', bases }))).toMatchObject({ code: 'not-found', memoryIds: ['mem_b'] })
      expect(prompts).toEqual([])
    })

    it('拿不到模型：llm-unavailable；模型报错：原话脱敏回 llm-failed；输出不合格式：llm-invalid-output。都不写账本', async () => {
      const none = await seeded({ llm: null })
      expect(err(await draft(none.e, none.entry.id)).code).toBe('llm-unavailable')
      await rm(root, { recursive: true, force: true })
      setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
      const { e, entry } = await seeded({ llm: scripted(new Error(`upstream said ${FAKE_SECRET.sk}`), '不是 JSON').llm })
      expect(err(await draft(e, entry.id))).toMatchObject({ code: 'llm-failed', detail: 'upstream said [已隐藏]' })
      expect(err(await draft(e, entry.id)).code).toBe('llm-invalid-output')
      expect(await e.decisions.get(entry.id)).toEqual(entry)
    })

    it('治理开关关着、子 agent 会话：拒绝，不调用模型', async () => {
      for (const opts of [{ governanceEnabled: false }, { delegationDepth: 1 }]) {
        const { llm, prompts } = scripted(MERGED)
        const { e, entry } = await seeded({ llm, ...opts })
        expect(err(await draft(e, entry.id)).code).toBe('governanceEnabled' in opts ? 'governance-disabled' : 'subagent-readonly')
        expect(prompts).toEqual([])
        await rm(root, { recursive: true, force: true })
        setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
      }
    })

    it('回查出处：读得到的出处一起给模型', async () => {
      const { llm, prompts } = scripted(MERGED)
      const readEvent: ReadEventFn = async ({ sessionId }) => ({
        session: { id: sessionId, cwd: SESSION_WS },
        events: [{ type: 'user/message', seq: 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '前端仓库用 pnpm' }], source: { kind: 'user' } } }],
      })
      const e = env({ llm, readEvent })
      const source = { sessionId: 'sess-a', eventRange: [0, 4] as [number, number], sourceMode: 'user-explicit' as const }
      await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS, source }))
      await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', scope: 'workspace', workspacePath: SESSION_WS }))
      const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', workspaces: [SESSION_WS, SESSION_WS], fingerprint: 'fp-ab' }, 1)
      ok(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '融合', bases: [baseOf((await e.store.get('mem_a', { workspacePath: SESSION_WS }))!), baseOf((await e.store.get('mem_b', { workspacePath: SESSION_WS }))!)] }))
      expect(prompts[0]!.user).toContain('## 记忆 A 的出处')
      expect(prompts[0]!.user).toContain('前端仓库用 pnpm')
    })
  })

  describe('apply-proposal 带按要求生成的方案', () => {
    it('保留 A 的方案生成后 B 被写进高危密钥：应用回 stale，B 不删、条目不结清（含密钥的生成时就不发给模型）', async () => {
      const { e, entry, proposal } = await drafted(said('keep-a'))
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: `用 npm，token ${FAKE_SECRET.github}` }))
      expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal })).code).toBe('stale')
      expect(await statuses(e)).toEqual(['active', 'active'])
      expect(await e.decisions.listSettled()).toEqual([])
    })
    it('保留 A：B 软删，条目记删一方裁决、来源 request；撤销后 B 回来、条目回到待处理', async () => {
      const { e, entry, proposal } = await drafted(said('keep-a'))
      const body = ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }))
      const [snap] = await e.snapshots.list()
      expect(body).toEqual({ ok: true, cmd: 'apply-proposal', decisionId: entry.id, snapshotId: snap!.id })
      expect(await statuses(e)).toEqual(['active', 'deleted'])
      expect((await e.decisions.listSettled()).map(d => d.settled)).toEqual([
        { verdict: 'keep-left', at: NOW, snapshotId: snap!.id, proposal: { source: 'request', action: 'keep-a' } },
      ])
      ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
      expect(await statuses(e)).toEqual(['active', 'active'])
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    })

    it('都保留：记都保留裁决、来源 request，不拍快照', async () => {
      const { e, entry, proposal } = await drafted(said('keep-both'))
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }))
      expect((await e.decisions.listSettled()).map(d => d.settled)).toEqual([{ verdict: 'keep-both', at: NOW, proposal: { source: 'request', action: 'keep-both' } }])
      expect(await e.snapshots.list()).toEqual([])
    })

    it('融合：保留方改写成融合稿、另一条软删，结清为 plan-applied、来源 request；撤销后两条逐字节恢复', async () => {
      const { e, entry, proposal } = await drafted(MERGED)
      const before = await files(e)
      e.clock.now = LATER
      const body = ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }))
      expect(body).toMatchObject({ ok: true, decisionId: entry.id, memoryIds: ['mem_a', 'mem_b'] })
      expect(await e.store.get('mem_a')).toMatchObject({ ...DRAFT, status: 'active' })
      expect((await e.store.get('mem_b'))!.status).toBe('deleted')
      expect((await e.decisions.listSettled())[0]!.settled).toMatchObject({ verdict: 'plan-applied', proposal: { source: 'request', action: 'merge' } })
      ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
      expect(await files(e)).toEqual(before)
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    })

    it.each([
      ['保留一方', said('keep-a')],
      ['融合', MERGED],
    ])('%s：方案生成后 B 只改了标签，回 stale，什么都不动', async (_label, answer) => {
      const { e, entry, proposal } = await drafted(answer)
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, tags: ['别处加的'] }))
      expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }))).toMatchObject({ code: 'stale', memoryIds: ['mem_a', 'mem_b'] })
      expect(await statuses(e)).toEqual(['active', 'active'])
      expect((await e.store.get('mem_a'))!.content).toBe('用 pnpm')
      expect(await e.snapshots.list()).toEqual([])
      expect(await e.decisions.listSettled()).toEqual([])
    })

    it('操作和结论对不上（结论 keep-a 却两条都留、改写项不在保留方、记忆 id 不是这一对）：invalid-args，什么都不动', async () => {
      const { e, entry, proposal } = await drafted(MERGED)
      const edit = proposal.ops[0]!
      const bad = [
        { ...proposal, action: 'keep-a' as const, ops: [{ kind: 'keep' as const, memoryId: 'mem_a' }, { kind: 'keep' as const, memoryId: 'mem_b' }] },
        { ...proposal, ops: [{ kind: 'forget' as const, memoryId: 'mem_a' }, { ...edit, memoryId: 'mem_b' }] },
        { ...proposal, ops: [edit, { kind: 'forget' as const, memoryId: 'mem_x' }] },
        { ...proposal, ops: [edit] },
      ]
      for (const p of bad) expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal: p })).code).toBe('invalid-args')
      expect(await statuses(e)).toEqual(['active', 'active'])
      expect(await e.snapshots.list()).toEqual([])
    })

    it('融合稿含高危密钥：secret-critical；含疑似密钥：secret-suspected，带 allowSecret 后照常写入', async () => {
      const { e, entry, proposal } = await drafted(MERGED)
      const withContent = (content: string) => ({ ...proposal, ops: proposal.ops.map(op => (op.kind === 'edit' ? { ...op, content } : op)) })
      expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal: withContent(`用 pnpm，token ${FAKE_SECRET.github}`) })).code).toBe('secret-critical')
      const suspected = withContent('用 pnpm，password: abc12345x')
      expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal: suspected })).code).toBe('secret-suspected')
      expect(await statuses(e)).toEqual(['active', 'active'])
      expect(await e.snapshots.list()).toEqual([])
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal: suspected, allowSecret: true }))
      expect((await e.store.get('mem_a'))!.content).toBe('用 pnpm，password: abc12345x')
    })

    it('两个标签页同时应用：只成一次，只删一方', async () => {
      const { e, entry, proposal } = await drafted(said('keep-a'))
      const other = env()
      const results = await Promise.all([
        e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }),
        other.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }),
      ])
      expect(results.filter(r => r.ok)).toHaveLength(1)
      expect(await statuses(e)).toEqual(['active', 'deleted'])
      expect(await e.snapshots.list()).toHaveLength(1)
    })

    it('条目上另有一份建议：按要求应用不看它，结清记来源 request', async () => {
      const { e, entry } = await seeded({ llm: scripted(said('keep-b'), said('keep-a')).llm })
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      const proposal = ok(await draft(e, entry.id, { request: '保留 A' })).proposal!
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }))
      expect(await statuses(e)).toEqual(['active', 'deleted'])
      expect((await e.decisions.listSettled())[0]!.settled?.proposal).toEqual({ source: 'request', action: 'keep-a' })
    })
  })
})

describe('垂直冲突（记忆和指令文件）用处理卡', () => {
  const LATER = NOW + 1000
  const PROJECT_TEXT = 'Instructions from: /tmp/pm-cmd-session/AGENTS.md\n前端统一用 pnpm'
  const BASELINE = [PROJECT_TEXT]
  /** 记忆所在项目（SESSION_WS）的指令文件；另一个项目、全局层各有自己的一份。 */
  const FILES = { [SESSION_WS]: PROJECT_TEXT, [OTHER_WS]: 'Instructions from: /tmp/pm-cmd-other/AGENTS.md\n统一用 yarn', global: '全局：注释用英文' }
  const DRAFT = { content: '脚本仓用 npm；前端按 AGENTS.md 用 pnpm', summary: '脚本仓的包管理器', name: '脚本仓包管理器', tags: ['npm'] }
  const said = (action: string, extra: object = {}) => JSON.stringify({ action, reason: `模型说 ${action}`, ...extra })
  function scripted(...answers: string[]) {
    const prompts: Array<{ system: string; user: string }> = []
    const llm: SemanticLlm = { model: 'deepseek-v4-flash', complete: async (prompt) => { prompts.push(prompt); return answers.shift() ?? '' } }
    return { llm, prompts }
  }
  /** 一个项目的一条记忆和那个项目的 AGENTS.md 矛盾（改成全局记忆时对全局层）；条目指纹同体检（含这条记忆对应的整份基线）。 */
  async function seeded(opts: EnvOpts & { memory?: Partial<MemoryRecord> } = {}) {
    const { memory, ...rest } = opts
    const e = env({ instructions: FILES, ...rest })
    await e.store.create(record({ id: 'mem_v', name: '包管理器', content: '用 npm', scope: 'workspace', workspacePath: SESSION_WS, ...memory }))
    const r = (await e.store.get('mem_v', { workspacePath: SESSION_WS }))!
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '记忆说 npm，AGENTS.md 说 pnpm', workspaces: [r.workspacePath ?? 'global'], fingerprint: conflictFingerprint([r], r.scope === 'workspace' ? BASELINE : [FILES.global]) }, 2)
    return { e, entry }
  }
  const verticalOf = async (e: ReturnType<typeof env>, id: string) => {
    const item = pendingViewSchema.parse(await e.readView('pending')).items.find(i => 'decisionId' in i && i.decisionId === id)
    if (item?.kind !== 'conflict-vertical') throw new Error(`没有垂直冲突项 ${id}`)
    return item
  }
  const memoryNow = async (e: ReturnType<typeof env>) => (await e.store.get('mem_v', { workspacePath: SESSION_WS }))!
  const baseOf = (r: MemoryRecord) => ({ updatedAt: r.updatedAt, digest: editFingerprint(r) })
  const agentsMdPath = () => join(root, 'AGENTS.md')

  describe('suggest（补上建议）', () => {
    it('按这条记忆所在项目的指令文件生成，会话在别的项目也一样：依据记下记忆所在项目和基线指纹；指令文件按疑似级遮盖后才进提示词；视图带上建议和项目', async () => {
      const { llm, prompts } = scripted(said('rewrite', { draft: DRAFT }))
      const { e, entry } = await seeded({ llm, workspacePath: OTHER_WS, instructions: { ...FILES, [SESSION_WS]: `${PROJECT_TEXT}\n部署口令 password: abc12345x` } })
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      expect(prompts).toHaveLength(1)
      expect(prompts[0]!.user).toContain('前端统一用 pnpm')
      expect(prompts[0]!.user).not.toContain('统一用 yarn')
      expect(prompts[0]!.user).not.toContain('abc12345x')
      const saved = (await e.decisions.get(entry.id))!.suggestion!
      expect(saved).toMatchObject({ action: 'rewrite', ops: [{ kind: 'edit', memoryId: 'mem_v', ...DRAFT }] })
      expect(saved.basis.baseline).toEqual({ workspace: SESSION_WS, fingerprint: expect.any(String) })
      expect((await verticalOf(e, entry.id)).suggestion).toMatchObject({ id: saved.id, action: 'rewrite', baselineWorkspace: SESSION_WS })
    })

    it('缺基线：这条记忆所在项目一个指令文件都没有、或取不到，回 no-baseline，不调用模型、账本不动', async () => {
      for (const files of [{ ...FILES, [SESSION_WS]: { kind: 'none' } }, { ...FILES, [SESSION_WS]: { kind: 'unavailable', reason: 'EACCES' } }] as const) {
        const { llm, prompts } = scripted(said('delete'))
        const { e, entry } = await seeded({ llm, instructions: files })
        expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('no-baseline')
        expect(prompts).toEqual([])
        expect(await e.decisions.get(entry.id)).toEqual(entry)
        await rm(root, { recursive: true, force: true })
        setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
      }
    })

    it('升级前按某个项目的指令文件扫出的全局记忆条目（还没被覆盖全局的体检清掉）：补上建议、补充要求都回 no-baseline，不拿全局层调用模型；对着全局层扫出的照常', async () => {
      const { llm, prompts } = scripted(said('delete'), said('delete'))
      const e = env({ instructions: FILES, llm })
      await e.store.create(record({ id: 'mem_g', name: '注释语言', content: '注释用中文' }))
      const g = (await e.store.get('mem_g'))!
      const legacy = (await e.decisions.upsert({ memoryIds: ['mem_g'], baselineRef: 'AGENTS.md：注释语言', summary: '记忆说中文', workspaces: ['global'], fingerprint: conflictFingerprint([g], BASELINE) }, 2)).entry
      const NO_BASELINE = '这条记忆对应的指令文件读不到，或在体检后改过。重新体检后再试。'
      expect(err(await e.run({ cmd: 'suggest', decisionId: legacy.id }))).toMatchObject({ code: 'no-baseline', detail: `${NO_BASELINE}未做任何改动` })
      expect(err(await e.run({ cmd: 'draft-proposal', decisionId: legacy.id, request: '删掉', bases: [baseOf(g)] }))).toMatchObject({ code: 'no-baseline', detail: `${NO_BASELINE}没有生成方案` })
      expect(prompts).toEqual([])
      expect(await e.decisions.get(legacy.id)).toEqual(legacy)

      const current = (await e.decisions.upsert({ memoryIds: ['mem_g'], baselineRef: 'AGENTS.md：注释语言', summary: '记忆说中文', workspaces: ['global'], fingerprint: conflictFingerprint([g], [FILES.global]) }, 3)).entry
      ok(await e.run({ cmd: 'suggest', decisionId: current.id }))
      expect(prompts[0]!.user).toContain('注释用英文')
      expect((await e.decisions.get(current.id))!.suggestion!.basis.baseline).toEqual({ workspace: 'global', fingerprint: expect.any(String) })
    })

    it('会话不在这个项目、或没有会话项目：补上建议、按要求生成、采纳、直接裁决都照常', async () => {
      for (const workspacePath of [OTHER_WS, undefined]) {
        const { llm } = scripted(said('delete'), said('keep-both'))
        const { e, entry } = await seeded({ llm, workspacePath })
        ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
        const suggestion = (await e.decisions.get(entry.id))!.suggestion!
        const proposal = ok(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '都留着', bases: [baseOf(await memoryNow(e))] })).proposal!
        expect(proposal).toMatchObject({ action: 'keep-both', basis: { baseline: { workspace: SESSION_WS } } })
        ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id, allowCrossWorkspace: true }))
        expect((await memoryNow(e)).status).toBe('deleted')
        ok(await e.run({ cmd: 'undo', decisionId: entry.id, allowCrossWorkspace: true }))
        // 直接裁决：保留记忆，两边都留的指纹按它所在项目的指令文件记下
        ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }))
        expect((await e.decisions.listSettled()).find(d => d.id === entry.id)).toMatchObject({ settled: { verdict: 'keep-left' }, fingerprint: conflictFingerprint([await memoryNow(e)], BASELINE) })
        await rm(root, { recursive: true, force: true })
        setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
      }
    })

    it('全局记忆：对照全局层的指令文件，和会话在哪个项目无关；在一个会话里补上的建议，换一个项目的会话照样能采纳', async () => {
      const { llm, prompts } = scripted(said('delete'), said('delete'))
      const { e, entry } = await seeded({ llm, workspacePath: OTHER_WS, memory: { scope: 'global', workspacePath: undefined } })
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      expect(prompts[0]!.user).toContain('注释用英文')
      expect(prompts[0]!.user).not.toContain('统一用 yarn')
      const suggestion = (await e.decisions.get(entry.id))!.suggestion!
      expect(suggestion.basis.baseline).toEqual({ workspace: 'global', fingerprint: expect.any(String) })
      // 同一份数据目录，换一个项目的会话
      const elsewhere = env({ llm, instructions: FILES })
      expect(ok(await elsewhere.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '删掉', bases: [baseOf(await memoryNow(e))] })).proposal)
        .toMatchObject({ action: 'delete', basis: { baseline: { workspace: 'global' } } })
      ok(await elsewhere.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      expect((await memoryNow(e)).status).toBe('deleted')
    })

    it('升级前在别的会话里给全局记忆补的建议（依据记的是那个会话的项目）：全局层指令文件没变就照常能采纳', async () => {
      const { llm } = scripted(said('delete'))
      // 写建议时把依据里的基线所属换成会话的项目，同旧版写下的
      const { e, entry } = await seeded({
        llm, memory: { scope: 'global', workspacePath: undefined },
        wrapPending: (table: PendingTable): PendingTable => ({
          get: k => table.get(k), list: () => table.list(), delete: k => table.delete(k), deleteIf: (k, isStill) => table.deleteIf(k, isStill), claim: k => table.claim(k),
          put: async (k, v) => {
            const baseline = v.suggestion?.basis.baseline
            await table.put(k, baseline === undefined ? v : { ...v, suggestion: { ...v.suggestion!, basis: { ...v.suggestion!.basis, baseline: { ...baseline, workspace: OTHER_WS } } } })
          },
        }),
      })
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      const suggestion = (await e.decisions.get(entry.id))!.suggestion!
      expect(suggestion.basis.baseline?.workspace).toBe(OTHER_WS)
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      expect((await memoryNow(e)).status).toBe('deleted')
    })

    it('记忆含高危密钥：has-secret，不调用模型', async () => {
      const { llm, prompts } = scripted(said('delete'))
      const { e, entry } = await seeded({ llm, memory: { content: `用 npm，token ${FAKE_SECRET.github}` } })
      expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('has-secret')
      expect(prompts).toEqual([])
    })
  })

  describe('apply-proposal（采纳建议）', () => {
    async function suggested(action: string, extra: object = {}, opts: EnvOpts = {}) {
      const { e, entry } = await seeded({ llm: scripted(said(action, extra)).llm, ...opts })
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      return { e, entry, suggestion: (await e.decisions.get(entry.id))!.suggestion! }
    }

    it('全局记忆的条目上存着升级前的建议、依据里的基线是某个项目的指令文件：直接采纳回 stale，记忆和条目都不动', async () => {
      const e = env({ instructions: FILES })
      await e.store.create(record({ id: 'mem_g', name: '注释语言', content: '注释用中文' }))
      const g = (await e.store.get('mem_g'))!
      const { entry } = await e.decisions.upsert({ memoryIds: ['mem_g'], baselineRef: 'AGENTS.md：注释语言', summary: '记忆说中文', workspaces: ['global'], fingerprint: conflictFingerprint([g], BASELINE) }, 2)
      const suggestion = {
        id: 'sg_legacy', action: 'delete' as const, reason: '以指令文件为准', ops: [{ kind: 'forget' as const, memoryId: 'mem_g' }],
        basis: suggestionBasis(entry, [g], { workspace: SESSION_WS, fingerprint: baselineFingerprint(BASELINE) }), isSourced: false, generatedAt: NOW,
      }
      expect(await e.decisions.writeSuggestion(entry.id, { suggestion }, id => e.store.get(id))).toBe('written')
      expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id })).code).toBe('stale')
      expect(await e.store.get('mem_g')).toEqual(g)
      expect(await e.decisions.get(entry.id)).toMatchObject({ suggestion: { id: 'sg_legacy' } })
      expect(await e.snapshots.list()).toEqual([])
    })

    it('改写：记忆换成改写稿，一份快照；条目结清为 plan-applied（只有改写一项回执、没有败方），改后指纹按这条记忆所在项目的指令文件重算；指令文件不改', async () => {
      const { e, entry, suggestion } = await suggested('rewrite', { draft: DRAFT })
      e.clock.now = LATER
      const body = ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      const [snap] = await e.snapshots.list()
      expect(body).toEqual({ ok: true, cmd: 'apply-proposal', decisionId: entry.id, memoryIds: ['mem_v'], snapshotId: snap!.id })
      const written = await memoryNow(e)
      expect(written).toMatchObject({ ...DRAFT, status: 'active' })
      const [settled] = await e.decisions.listSettled()
      expect(settled).toMatchObject({ id: entry.id, fingerprint: conflictFingerprint([written], BASELINE) })
      expect(settled!.settled).toEqual({
        verdict: 'plan-applied', at: LATER, snapshotId: snap!.id, proposal: { source: 'suggestion', action: 'rewrite' }, priorFingerprint: entry.fingerprint,
        receipts: [{ memoryId: 'mem_v', op: 'edit', fingerprint: editFingerprint(written), expectedStatus: 'active' }],
      })
      await expect(stat(agentsMdPath())).rejects.toThrow()
      expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending')))).toEqual([])
      // 同一条按改后的内容再被扫到：算已结清，不再挂账
      expect((await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md', summary: '再报', fingerprint: conflictFingerprint([written], BASELINE) }, LATER)).settled).toBe(true)
    })

    it('改写后撤销：记忆恢复原样，条目回到待处理，建议照常显示', async () => {
      const { e, entry, suggestion } = await suggested('rewrite', { draft: DRAFT })
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
      expect(await memoryNow(e)).toMatchObject({ content: '用 npm', name: '包管理器' })
      expect(await e.decisions.get(entry.id)).toMatchObject({ fingerprint: entry.fingerprint })
      expect((await verticalOf(e, entry.id)).suggestion?.id).toBe(suggestion.id)
    })

    it('两个标签页同时采纳改写：只成一次，只拍一份快照；另一次回 claimed 或 not-found', async () => {
      const { e, entry, suggestion } = await suggested('rewrite', { draft: DRAFT })
      const other = env({ instructions: FILES })
      const adopt = (on: ReturnType<typeof env>) => on.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id })
      const results = await Promise.all([adopt(e), adopt(other)])
      expect(results.filter(r => r.ok)).toHaveLength(1)
      expect(['claimed', 'not-found']).toContain(err(results.find(r => !r.ok)!).code)
      expect(await e.snapshots.list()).toHaveLength(1)
      expect(await memoryNow(e)).toMatchObject({ content: DRAFT.content })
      expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['plan-applied'])
    })

    it('改写后记忆又被改过：撤销回 stale，什么都不动', async () => {
      const { e, entry, suggestion } = await suggested('rewrite', { draft: DRAFT })
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      await e.store.update({ id: 'mem_v', workspacePath: SESSION_WS }, r => ({ ...r, content: '落盘后又改的' }))
      expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('stale')
      expect(await memoryNow(e)).toMatchObject({ status: 'active', content: '落盘后又改的' })
      expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([entry.id])
    })

    it('改写结清后指令文件改了、体检按新指纹重报：另挂一条待处理，已结清条目和撤销回执留着，照常能撤销', async () => {
      const { e, entry, suggestion } = await suggested('rewrite', { draft: DRAFT })
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      const rescan: SemanticLlm = { model: 'm-test', complete: async () => JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '还是矛盾', suggestedAction: '裁决' }] }) }
      const later = env({ llm: rescan, instructions: { ...FILES, [SESSION_WS]: `${PROJECT_TEXT}\n脚本仓也用 pnpm` } })
      ok(await later.run({ cmd: 'scan', workspacePath: SESSION_WS }))
      expect((await e.decisions.list()).map(d => d.id)).not.toContain(entry.id)
      expect(await e.decisions.list()).toHaveLength(1)
      const [settled] = await e.decisions.listSettled()
      expect(settled).toMatchObject({ id: entry.id, settled: { verdict: 'plan-applied', receipts: [expect.objectContaining({ memoryId: 'mem_v', op: 'edit' })] } })
      ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
      expect(await memoryNow(e)).toMatchObject({ content: '用 npm', name: '包管理器' })
    })

    it('改写结清的读写之间这条记忆被别处彻底删除、账本已清：结清和建议稿不留在账本上', async () => {
      const holder: { purge?: () => Promise<void> } = {}
      const { e, entry, suggestion } = await suggested('rewrite', { draft: DRAFT }, {
        wrapPending: (table: PendingTable): PendingTable => ({
          get: k => table.get(k), list: () => table.list(), delete: k => table.delete(k), deleteIf: (k, isStill) => table.deleteIf(k, isStill), claim: k => table.claim(k),
          put: async (k, v) => {
            if (v.settled?.verdict === 'plan-applied') { await holder.purge?.(); await table.delete(k) }
            await table.put(k, v)
          },
        }),
      })
      holder.purge = async () => { await e.store.hardDelete({ id: 'mem_v' }, { at: scopeAt(SESSION_WS) }) }
      await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id })
      expect(await e.store.get('mem_v', { workspacePath: SESSION_WS })).toBeUndefined()
      expect(await e.decisions.listSettled()).toEqual([])
      expect(await e.decisions.list()).toEqual([])
    })

    it('删除：记现有的删一方裁决（keep-right，带来源和结论代码），记忆进最近删除；撤销后回来', async () => {
      const { e, entry, suggestion } = await suggested('delete')
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      expect((await memoryNow(e)).status).toBe('deleted')
      const [settled] = await e.decisions.listSettled()
      expect(settled!.settled).toMatchObject({ verdict: 'keep-right', proposal: { source: 'suggestion', action: 'delete' } })
      ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
      expect((await memoryNow(e)).status).toBe('active')
    })

    it('都保留：记都保留裁决（带来源），记忆不动', async () => {
      const { e, entry, suggestion } = await suggested('keep-both')
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }))
      expect(await memoryNow(e)).toMatchObject({ content: '用 npm', status: 'active' })
      expect((await e.decisions.listSettled())[0]!.settled).toMatchObject({ verdict: 'keep-both', proposal: { source: 'suggestion', action: 'keep-both' } })
    })

    it('采纳时按这条记忆所在项目此刻的指令文件重算：指令文件改了、或取不到、或删光了，都回 stale，什么都不动', async () => {
      for (const now of [`${PROJECT_TEXT}\n另加一条`, { kind: 'unavailable', reason: 'EACCES' }, { kind: 'none' }] as const) {
        for (const action of ['rewrite', 'delete'] as const) {
          const { e, entry, suggestion } = await suggested(action, { draft: DRAFT })
          const before = await memoryNow(e)
          // 同一份数据目录，指令文件此刻已经不同
          const other = env({ instructions: { ...FILES, [SESSION_WS]: now } })
          expect(err(await other.run({ cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id })).code).toBe('stale')
          expect(await memoryNow(e)).toEqual(before)
          expect(await e.decisions.get(entry.id)).toMatchObject({ suggestion: { id: suggestion.id } })
          expect(await e.snapshots.list()).toEqual([])
          await rm(root, { recursive: true, force: true })
          setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
        }
      }
    })
  })

  describe('draft-proposal 与按要求应用', () => {
    it('按记忆所在项目的指令文件生成：方案的依据带基线；缺基线回 no-baseline、不调用模型；卡片版本条数对不上回 invalid-args', async () => {
      const { llm, prompts } = scripted(said('rewrite', { draft: DRAFT }))
      const { e, entry } = await seeded({ llm })
      const bases: [ReturnType<typeof baseOf>] = [baseOf(await memoryNow(e))]
      const body = ok(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '改写这条记忆', bases }))
      expect(body.proposal).toMatchObject({ action: 'rewrite', ops: [{ kind: 'edit', memoryId: 'mem_v', ...DRAFT }], basis: { baseline: { workspace: SESSION_WS } } })
      expect(prompts[0]!.system).toContain('rewrite')
      const twice: [ReturnType<typeof baseOf>, ReturnType<typeof baseOf>] = [baseOf(await memoryNow(e)), baseOf(await memoryNow(e))]
      expect(err(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '改写', bases: twice })).code).toBe('invalid-args')

      const missing = env({ instructions: { ...FILES, [SESSION_WS]: { kind: 'none' } }, llm })
      expect(err(await missing.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '改写', bases })).code).toBe('no-baseline')
      expect(prompts).toHaveLength(1)
    })

    it('应用改写方案：记 plan-applied（来源是要求）；基线在生成后改了回 stale；疑似密钥等用户确认', async () => {
      const { llm } = scripted(said('rewrite', { draft: DRAFT }), said('rewrite', { draft: { ...DRAFT, content: '用 npm，password: abc12345x' } }))
      const { e, entry } = await seeded({ llm })
      const bases: [ReturnType<typeof baseOf>] = [baseOf(await memoryNow(e))]
      const proposal = ok(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '改写', bases })).proposal!
      const changed = env({ instructions: { ...FILES, [SESSION_WS]: `${PROJECT_TEXT}\n另加一条` } })
      expect(err(await changed.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal })).code).toBe('stale')
      expect(await memoryNow(e)).toMatchObject({ content: '用 npm' })

      const suspicious = ok(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '写进口令', bases })).proposal!
      expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal: suspicious })).code).toBe('secret-suspected')
      ok(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal }))
      expect(await memoryNow(e)).toMatchObject({ content: DRAFT.content })
      expect((await e.decisions.listSettled())[0]!.settled).toMatchObject({ verdict: 'plan-applied', proposal: { source: 'request', action: 'rewrite' } })
    })

    it('方案的操作和结论对不上：invalid-args，什么都不动', async () => {
      const { llm } = scripted(said('delete'))
      const { e, entry } = await seeded({ llm })
      const proposal = ok(await e.run({ cmd: 'draft-proposal', decisionId: entry.id, request: '删掉', bases: [baseOf(await memoryNow(e))] })).proposal!
      for (const bad of [
        { ...proposal, action: 'rewrite' as const },
        { ...proposal, ops: [{ kind: 'keep' as const, memoryId: 'mem_v' }] },
        { ...proposal, action: 'merge' as const },
      ]) expect(err(await e.run({ cmd: 'apply-proposal', decisionId: entry.id, proposal: bad })).code).toBe('invalid-args')
      expect((await memoryNow(e)).status).toBe('active')
    })
  })
})