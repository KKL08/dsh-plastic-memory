import { describe, expect, it } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { candidateFingerprint } from '../src/governance/decisions.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { libraryViewSchema, pendingViewSchema, type MemoryCommand, type MemoryCommandResult } from '../src/gui/contract.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { scopeAt, type Scope } from '../src/scope.ts'
import { locateCopy } from '../src/tools/workspace-gate.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { candidate, record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { indexText, indexedIds } from './helpers/topic-index.ts'
import { NOW, SESSION_WS, OTHER_WS, registry, root, env, ok, err, seedPair, allEntries, ledgerItems } from './helpers/gui-command-env.ts'


describe('提升候选与超限', () => {
  const quietLlm: SemanticLlm = { complete: async () => '{"findings":[]}' }

  /** 真实路径：模型以 scope: global 保存 → 管线降级为本项目 + globalCandidate → 体检把它挂进账本 → 待处理视图里出现。 */
  async function seedCandidate(e: ReturnType<typeof env>) {
    const saved = await runSavePipeline(candidate({ name: '戊', content: '所有项目都用 vitest', summary: '都用 vitest' }), {
      store: e.store, snapshots: e.snapshots, registry, workspacePath: SESSION_WS, session: { id: 'sess-1', lastSeq: 1 },
    })
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect([saved.record.scope, saved.record.workspacePath, saved.record.globalCandidate]).toEqual(['workspace', SESSION_WS, true])
    ok(await e.run({ cmd: 'scan' }))
    const items = pendingViewSchema.parse(await e.readView('pending')).items.filter(i => i.kind === 'promote-candidate')
    expect(items.map(i => i.kind === 'promote-candidate' && i.memory?.id)).toEqual([saved.record.id])
    return { decisionId: (items[0] as { decisionId: string }).decisionId, memoryId: saved.record.id }
  }
  const pendingCandidates = async (e: ReturnType<typeof env>) =>
    pendingViewSchema.parse(await e.readView('pending')).items.filter(i => i.kind === 'promote-candidate')

  it('promote 到全局：记忆变 global、条目 settled 为 promoted 并带快照、待处理里消失；undo 后回到本项目、候选回到待处理', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId, memoryId } = await seedCandidate(e)
    const body = ok(await e.run({ cmd: 'promote', decisionId, target: 'global' }))
    expect(body.memoryIds).toEqual([memoryId])
    expect((await e.store.get(memoryId))!.scope).toBe('global')
    const [snap] = await e.snapshots.list()
    expect((await e.decisions.listSettled()).map(d => d.settled)).toEqual([{ verdict: 'promoted', at: NOW, snapshotId: snap!.id }])
    expect(await pendingCandidates(e)).toEqual([])

    // 提升后再体检：已提升的不再挂候选
    ok(await e.run({ cmd: 'scan' }))
    expect(await pendingCandidates(e)).toEqual([])

    ok(await e.run({ cmd: 'undo', decisionId }))
    const back = (await e.store.get(memoryId))!
    expect([back.scope, back.workspacePath, back.globalCandidate]).toEqual(['workspace', SESSION_WS, true])
    expect((await e.decisions.list()).map(d => d.id)).toEqual([decisionId])
    expect((await pendingCandidates(e)).map(i => 'decisionId' in i && i.decisionId)).toEqual([decisionId])
  })

  it('promote 写进 AGENTS.md：条目移出账本（插件不再管理，不可撤销）', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId } = await seedCandidate(e)
    ok(await e.run({ cmd: 'promote', decisionId, target: 'agents-md' }))
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('戊')
    expect(await allEntries(e)).toEqual([])
    expect(await pendingCandidates(e)).toEqual([])
  })

  it('promote 含密钥的记忆到 AGENTS.md → failed 并说明原因，什么都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_sec', name: '部署凭证', content: `token ${FAKE_SECRET.sk}`, scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
    const { entry } = await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_sec'], summary: '部署凭证', workspaces: [SESSION_WS], fingerprint: 'fp-sec' }, 1)
    const body = err(await e.run({ cmd: 'promote', decisionId: entry.id, target: 'agents-md' }))
    expect(body.code).toBe('failed')
    expect(body.detail).toContain('含密钥的记忆不能写入 AGENTS.md')
    await expect(stat(join(root, 'AGENTS.md'))).rejects.toThrow()
    expect((await e.store.get('mem_sec'))!.status).toBe('active')
    expect(await e.decisions.list()).toEqual([entry])
    expect(await e.snapshots.list()).toEqual([])
  })

  it('keep-local：清候选标记、条目 settled 为 keep-local；再体检不重开，内容改了（模型又标为全局）才重新提示', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId, memoryId } = await seedCandidate(e)
    ok(await e.run({ cmd: 'keep-local', decisionId }))
    expect((await e.store.get(memoryId))!.globalCandidate).toBeUndefined()
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['keep-local'])
    expect(await pendingCandidates(e)).toEqual([])

    ok(await e.run({ cmd: 'scan' }))
    expect(await pendingCandidates(e)).toEqual([])
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([decisionId])

    const updated = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: memoryId, name: '戊', content: '所有项目都用 vitest，覆盖率不设门槛', summary: '都用 vitest' }), {
      store: e.store, snapshots: e.snapshots, registry, workspacePath: SESSION_WS, session: { id: 'sess-1', lastSeq: 2 },
    })
    expect(updated.kind).toBe('updated')
    expect((await e.store.get(memoryId))!.globalCandidate).toBe(true)
    ok(await e.run({ cmd: 'scan' }))
    expect((await pendingCandidates(e)).map(i => i.kind === 'promote-candidate' && i.memory?.id)).toEqual([memoryId])
  })

  it('undo「留在本项目」：候选标记回到记忆上、条目回到待处理；再体检也还在，内容不变', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId, memoryId } = await seedCandidate(e)
    const before = (await e.store.get(memoryId))!
    ok(await e.run({ cmd: 'keep-local', decisionId }))
    const undone = ok(await e.run({ cmd: 'undo', decisionId }))
    expect(undone.memoryIds).toEqual([memoryId])
    const back = (await e.store.get(memoryId))!
    expect([back.globalCandidate, back.content, back.updatedAt]).toEqual([true, before.content, before.updatedAt])
    expect((await e.decisions.list()).map(d => d.id)).toEqual([decisionId])
    expect((await pendingCandidates(e)).map(i => 'decisionId' in i && i.decisionId)).toEqual([decisionId])

    ok(await e.run({ cmd: 'scan' }))
    expect((await pendingCandidates(e)).map(i => 'decisionId' in i && i.decisionId)).toEqual([decisionId])
  })

  it('keep-local 的指纹按记忆此刻的内容记：上次体检后模型改过内容，留在本项目后同内容再被标记也不重开', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId, memoryId } = await seedCandidate(e)
    // 体检之后、用户点「留在本项目」之前，模型改了内容（仍是候选）
    await e.store.put({ ...(await e.store.get(memoryId))!, content: '所有项目都用 vitest，覆盖率不设门槛' })
    ok(await e.run({ cmd: 'keep-local', decisionId }))
    expect((await e.store.get(memoryId))!.globalCandidate).toBeUndefined()

    await e.store.put({ ...(await e.store.get(memoryId))!, globalCandidate: true }) // 模型又把同样的内容标为全局
    ok(await e.run({ cmd: 'scan' }))
    expect(await pendingCandidates(e)).toEqual([])
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([decisionId])
  })

  it('promote / keep-local 指向冲突条目 → failed，条目不动', async () => {
    const e = env()
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'promote', decisionId: entry.id, target: 'global' })).code).toBe('failed')
    expect(err(await e.run({ cmd: 'keep-local', decisionId: entry.id })).code).toBe('failed')
    expect(await e.decisions.list()).toEqual([entry])
  })

  it('同一候选同时收到 promote 与 keep-local：只有一条生效，另一条什么都不动', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId, memoryId } = await seedCandidate(e)
    const results = await Promise.all([
      e.run({ cmd: 'promote', decisionId, target: 'global' }),
      e.run({ cmd: 'keep-local', decisionId }),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const settled = (await e.decisions.listSettled()).map(d => d.settled?.verdict)
    const rec = (await e.store.get(memoryId))!
    if (results[0]!.ok) {
      expect(settled).toEqual(['promoted'])
      expect(rec.scope).toBe('global')
    } else {
      expect(settled).toEqual(['keep-local'])
      expect([rec.scope, rec.globalCandidate]).toEqual(['workspace', undefined])
    }
  })

  it('dismiss-overflow：超限提醒标 settled（dismiss）', async () => {
    const e = env()
    const { entry } = await e.decisions.upsert({ kind: 'overflow', memoryIds: [], summary: '超出上限', fingerprint: '1' }, 1)
    ok(await e.run({ cmd: 'dismiss-overflow', decisionId: entry.id }))
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[entry.id, 'dismiss']])
  })

})

describe('promote-memory（建议整理「放错层」的提升为全局）', () => {
  /** 模型把 mem_m 判为放错层（该放全局）；别的层里没有这个 id，解析时丢掉。 */
  const misplacedLlm: SemanticLlm = { complete: async () => JSON.stringify({ findings: [{ type: 'misplaced', memoryIds: ['mem_m'], summary: '对所有项目都适用' }] }) }
  const wsScope = (workspacePath: string) => ({ kind: 'workspace', workspacePath }) as const
  const misplacedIds = async (e: ReturnType<typeof env>) => pendingViewSchema.parse(await e.readView('pending')).items
    .flatMap(i => i.kind === 'advice' && i.type === 'misplaced' ? i.memories.map(m => m.id) : [])

  it('提升到全局：记忆变 global、快照先行、留一条已结清的提升供撤销，「放错层」消失；undo 后回到本项目，「放错层」回来', async () => {
    const e = env({ llm: misplacedLlm })
    await e.store.create(record({ id: 'mem_m', name: '己', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'scan' }))
    expect(await misplacedIds(e)).toEqual(['mem_m'])

    const body = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: wsScope(SESSION_WS) }))
    const [snap] = await e.snapshots.list()
    expect(body).toMatchObject({ cmd: 'promote-memory', memoryIds: ['mem_m'], snapshotId: snap!.id })
    expect((await e.store.get('mem_m'))!.scope).toBe('global')
    const settled = await e.decisions.listSettled()
    expect(settled.map(d => [d.id, d.kind, d.memoryIds, d.settled])).toEqual([[body.decisionId, 'promote-candidate', ['mem_m'], { verdict: 'promoted', at: NOW, snapshotId: snap!.id }]])
    expect(await misplacedIds(e)).toEqual([])
    expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending')))).toEqual([])

    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    const back = (await e.store.get('mem_m'))!
    expect([back.scope, back.workspacePath]).toEqual(['workspace', SESSION_WS])
    expect(await misplacedIds(e)).toEqual(['mem_m'])
    // 撤销后条目回到未决，但记忆不是提升候选：等你决定里不出现，下次体检清掉
    expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending')))).toEqual([])
    ok(await e.run({ cmd: 'scan' }))
    expect(await allEntries(e)).toEqual([])
    expect(await misplacedIds(e)).toEqual(['mem_m'])
  })

  it('记忆同时是提升候选：提升后那条候选一并结清，账本里只有一条；undo 后候选回到等你决定', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_m', name: '己', scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
    const { entry } = await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_m'], summary: '己', workspaces: [SESSION_WS], fingerprint: 'fp-m' }, 1)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_m', layer: wsScope(SESSION_WS) }))
    expect(body.decisionId).toBe(entry.id)
    expect((await allEntries(e)).map(d => [d.id, d.settled?.verdict])).toEqual([[entry.id, 'promoted']])
    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending'))).map(i => 'decisionId' in i && i.decisionId)).toEqual([entry.id])
  })

  it('已不在那个项目里（已提升、已删除、不存在）→ not-found，什么都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', name: '全局的' }))
    await e.store.create(record({ id: 'mem_d', name: '删掉的', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_d' }))
    for (const memoryId of ['mem_g', 'mem_d', 'mem_none']) {
      expect(err(await e.run({ cmd: 'promote-memory', memoryId, layer: wsScope(SESSION_WS) })).code).toBe('not-found')
    }
    expect((await e.store.get('mem_g'))!.scope).toBe('global')
    expect(await allEntries(e)).toEqual([])
    expect(await e.snapshots.list()).toHaveLength(1) // 只有 forget 那一份
  })

  it('别的项目的记忆：先要 allowCrossWorkspace，带上才提升', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_o', name: '别处的', scope: 'workspace', workspacePath: OTHER_WS }))
    const body = err(await e.run({ cmd: 'promote-memory', memoryId: 'mem_o', layer: wsScope(OTHER_WS) }))
    expect(body).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_o', workspacePath: OTHER_WS }] })
    expect((await e.store.get('mem_o'))!.scope).toBe('workspace')
    expect(await allEntries(e)).toEqual([])
    ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_o', layer: wsScope(OTHER_WS), allowCrossWorkspace: true }))
    expect((await e.store.get('mem_o'))!.scope).toBe('global')
  })

  it('提升待确认的子 agent 记忆算用户升档：写 reviewed user 与提升的时刻，创建者字段不动', async () => {
    const e = env()
    const creator = { sessionId: 'sess-sub', depth: 1, parentSessionId: 'sess-1' }
    await e.store.create(record({ id: 'mem_p', scope: 'workspace', workspacePath: SESSION_WS, delegation: creator }))
    ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_p', layer: wsScope(SESSION_WS) }))
    const after = (await e.store.get('mem_p'))!
    expect(after.scope).toBe('global')
    expect(after.delegation).toEqual({ ...creator, reviewed: { by: 'user', at: NOW } })
  })
})

describe('就地提升（对话卡片、右侧栏「这次新写入的」）：promote-memory 与 keep-local-memory', () => {
  const quietLlm: SemanticLlm = { complete: async () => '{"findings":[]}' }
  const wsScope = { kind: 'workspace', workspacePath: SESSION_WS } as const

  /** 模型以 scope: global 新记一条：管线降级为本项目 + globalCandidate，不经体检，账本里什么都没有。 */
  async function saveCandidate(e: ReturnType<typeof env>, name = '戊', content = '所有项目都用 vitest') {
    const saved = await runSavePipeline(candidate({ name, content, summary: content }), {
      store: e.store, snapshots: e.snapshots, registry, workspacePath: SESSION_WS, session: { id: 'sess-1', lastSeq: 1 },
    })
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect(saved.record.globalCandidate).toBe(true)
    return saved.record.id
  }
  const pendingView = async (e: ReturnType<typeof env>) => pendingViewSchema.parse(await e.readView('pending'))
  const candidateIds = async (e: ReturnType<typeof env>) =>
    (await pendingView(e)).items.flatMap(i => i.kind === 'promote-candidate' && i.memory !== null ? [i.memory.id] : [])

  it('保存候选不写账本；没处理的，体检照旧同步成「等你决定」里的提升候选', async () => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    expect(await allEntries(e)).toEqual([])
    ok(await e.run({ cmd: 'scan' }))
    expect(await candidateIds(e)).toEqual([memoryId])
  })

  it('留在本项目：清掉候选标记、账本里只留一条已结清的 keep-local，待处理与圆点不变；之后体检也不再提', async () => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    const body = ok(await e.run({ cmd: 'keep-local-memory', memoryId, layer: wsScope }))
    expect(body).toMatchObject({ cmd: 'keep-local-memory', memoryIds: [memoryId] })
    const rec = (await e.store.get(memoryId))!
    expect([rec.scope, rec.workspacePath, rec.globalCandidate]).toEqual(['workspace', SESSION_WS, undefined])
    expect(await e.decisions.list()).toEqual([])
    expect((await e.decisions.listSettled()).map(d => [d.id, d.kind, d.memoryIds, d.settled?.verdict])).toEqual([[body.decisionId, 'promote-candidate', [memoryId], 'keep-local']])
    const view = await pendingView(e)
    expect([ledgerItems(view), view.dot]).toEqual([[], 'none'])
    // 全部记忆视图把它标成「留在本项目」，两处据此换成结果文字
    const library = libraryViewSchema.parse(await e.readView('library'))
    expect(library.layers.flatMap(l => l.items).find(i => i.id === memoryId)?.promotion).toBe('kept-local')

    ok(await e.run({ cmd: 'scan' }))
    expect(await candidateIds(e)).toEqual([])
    // 模型又把同样的内容标成全局：按「留在本项目」的指纹，体检也不再提
    await e.store.put({ ...(await e.store.get(memoryId))!, globalCandidate: true })
    ok(await e.run({ cmd: 'scan' }))
    expect(await candidateIds(e)).toEqual([])
  })

  it('提升为全局：记忆变 global，账本里只留一条已结清的提升，待处理与圆点不变；之后体检也不再提', async () => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId, layer: wsScope }))
    expect((await e.store.get(memoryId))!.scope).toBe('global')
    expect(await e.decisions.list()).toEqual([])
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[body.decisionId, 'promoted']])
    const view = await pendingView(e)
    expect([ledgerItems(view), view.dot]).toEqual([[], 'none'])
    ok(await e.run({ cmd: 'scan' }))
    expect(await candidateIds(e)).toEqual([])
  })

  it('体检已把它挂进等你决定：就地处理结清的是那一条，待处理里随之消失', async () => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    ok(await e.run({ cmd: 'scan' }))
    const [open] = await e.decisions.list()
    const body = ok(await e.run({ cmd: 'keep-local-memory', memoryId, layer: wsScope }))
    expect(body.decisionId).toBe(open!.id)
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[open!.id, 'keep-local']])
    expect(await candidateIds(e)).toEqual([])
  })

  it.each([
    ['keep-local-memory'],
    ['promote-memory'],
  ] as const)('%s：等你决定里的那一条正被别处处理（认领中）→ claimed，什么都不动', async (cmd) => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    ok(await e.run({ cmd: 'scan' }))
    const [open] = await e.decisions.list()
    let result: MemoryCommandResult | undefined
    await e.decisions.withClaim(open!.id, async () => { result = await e.run({ cmd, memoryId, layer: wsScope }) })
    expect(err(result!).code).toBe('claimed')
    const rec = (await e.store.get(memoryId))!
    expect([rec.scope, rec.globalCandidate]).toEqual(['workspace', true])
    expect(await e.decisions.list()).toEqual([open])
    expect(await e.decisions.listSettled()).toEqual([])
  })

  it('别处已处理：提升过的再「留在本项目」、留下过的再「留在本项目」→ not-found，什么都不动', async () => {
    const e = env()
    const promotedId = await saveCandidate(e)
    ok(await e.run({ cmd: 'promote-memory', memoryId: promotedId, layer: wsScope }))
    expect(err(await e.run({ cmd: 'keep-local-memory', memoryId: promotedId, layer: wsScope })).code).toBe('not-found')
    expect((await e.store.get(promotedId))!.scope).toBe('global')

    const keptId = await saveCandidate(e, '己', '提交信息一律写英文')
    ok(await e.run({ cmd: 'keep-local-memory', memoryId: keptId, layer: wsScope }))
    expect(err(await e.run({ cmd: 'keep-local-memory', memoryId: keptId, layer: wsScope })).code).toBe('not-found')
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['promoted', 'keep-local'])
    expect(await e.decisions.list()).toEqual([])
  })

  it('就地提升只认此刻仍是候选的：别处已「留在本项目」后再点「提升为全局」→ not-found，记忆不动、结论还是留在本项目', async () => {
    const e = env()
    const memoryId = await saveCandidate(e)
    const kept = ok(await e.run({ cmd: 'keep-local-memory', memoryId, layer: wsScope }))
    expect(err(await e.run({ cmd: 'promote-memory', memoryId, layer: wsScope, isCandidateRequired: true })).code).toBe('not-found')
    const rec = (await e.store.get(memoryId))!
    expect([rec.scope, rec.workspacePath]).toEqual(['workspace', SESSION_WS])
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[kept.decisionId, 'keep-local']])
  })

  it('不带 isCandidateRequired 的 promote-memory（建议整理「放错层」）照旧：不是候选也提升', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_plain', name: '普通', scope: 'workspace', workspacePath: SESSION_WS }))
    expect(err(await e.run({ cmd: 'promote-memory', memoryId: 'mem_plain', layer: wsScope, isCandidateRequired: true })).code).toBe('not-found')
    ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_plain', layer: wsScope }))
    expect((await e.store.get('mem_plain'))!.scope).toBe('global')
  })

  it.each([
    ['keep-local-memory', 'keep-local'],
    ['promote-memory', 'promoted'],
  ] as const)('%s：账本里还没有它的条目时先做再记账，期间体检清掉条目也不会丢撤销记录', async (cmd, verdict) => {
    const e = env()
    const memoryId = await saveCandidate(e)
    // 模拟体检在记账与认领之间把没挂账的条目清掉：认领任何条目之前先删掉它
    const claim = e.decisions.withClaim.bind(e.decisions)
    e.decisions.withClaim = async (id, fn) => { await e.decisions.remove(id); return await claim(id, fn) }
    const body = ok(await e.run({ cmd, memoryId, layer: wsScope }))
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[body.decisionId, verdict]])
    e.decisions.withClaim = claim
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    const rec = (await e.store.get(memoryId))!
    expect([rec.scope, rec.globalCandidate]).toEqual(['workspace', true])
  })

  it.each([
    ['keep-local-memory'],
    ['promote-memory'],
  ] as const)('就地%s后就地撤销（点之前账本里没有它）：记忆回到候选、账本里的那条移除，不进等你决定、不亮圆点；之后体检照旧同步', async (cmd) => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    const body = ok(await e.run(cmd === 'promote-memory' ? { cmd, memoryId, layer: wsScope, isCandidateRequired: true } : { cmd, memoryId, layer: wsScope }))
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    const rec = (await e.store.get(memoryId))!
    expect([rec.scope, rec.workspacePath, rec.globalCandidate]).toEqual(['workspace', SESSION_WS, true])
    expect(await allEntries(e)).toEqual([])
    const view = await pendingView(e)
    expect([ledgerItems(view), view.dot]).toEqual([[], 'none'])
    ok(await e.run({ cmd: 'scan' }))
    expect(await candidateIds(e)).toEqual([memoryId])
  })

  it('PA-39 就地提升记条目时体检恰好同步提升候选（记忆已在全局、不再是候选）：条目照样记下，撤销成功', async () => {
    let sync = async () => {}
    let isArmed = true
    const e = env({
      llm: quietLlm,
      wrapPending: table => ({
        get: key => table.get(key),
        put: async (key, value) => {
          await table.put(key, value)
          // 账本里一出现这条记忆的提升候选，就让体检同步一次
          if (isArmed && value.kind === 'promote-candidate') {
            isArmed = false
            await sync()
          }
        },
        delete: key => table.delete(key),
        deleteIf: (key, isStill) => table.deleteIf(key, isStill),
        claim: key => table.claim(key),
        list: () => table.list(),
      }),
    })
    sync = () => e.decisions.syncPromoteCandidates(SESSION_WS, [], new Set(), e.clock.now)
    const memoryId = await saveCandidate(e)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId, layer: wsScope, isCandidateRequired: true }))
    expect(isArmed).toBe(false)
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    const rec = (await e.store.get(memoryId))!
    expect([rec.scope, rec.workspacePath, rec.globalCandidate]).toEqual(['workspace', SESSION_WS, true])
    expect(await allEntries(e)).toEqual([])
  })

  it('就地留下时体检刚把它挂进等你决定（点的时候账本里还没有）：结清那一条，不另记一条，之后体检也不再提', async () => {
    let lists = 0
    let raceIn = async () => {}
    const e = env({
      llm: quietLlm,
      wrapPending: table => ({
        get: key => table.get(key),
        put: (key, value) => table.put(key, value),
        delete: key => table.delete(key),
        deleteIf: (key, isStill) => table.deleteIf(key, isStill),
        claim: key => table.claim(key),
        // 命令第一次读账本（还没有条目）之后，体检挂进一条
        list: async () => {
          const rows = await table.list()
          if (++lists === 1) await raceIn()
          return rows
        },
      }),
    })
    const memoryId = await saveCandidate(e)
    raceIn = async () => {
      const r = (await e.store.get(memoryId))!
      await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: [memoryId], summary: r.summary, workspaces: [SESSION_WS], fingerprint: candidateFingerprint(r) }, e.clock.now)
    }
    const body = ok(await e.run({ cmd: 'keep-local-memory', memoryId, layer: wsScope }))
    expect((await allEntries(e)).map(d => [d.id, d.settled?.verdict])).toEqual([[body.decisionId, 'keep-local']])
    ok(await e.run({ cmd: 'scan' }))
    expect(await candidateIds(e)).toEqual([])
  })

  it('就地处理的是体检已挂进等你决定的那条：撤销照旧重开那一条（点之前它就在等你决定里）', async () => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    ok(await e.run({ cmd: 'scan' }))
    const [open] = await e.decisions.list()
    const body = ok(await e.run({ cmd: 'keep-local-memory', memoryId, layer: wsScope }))
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect((await e.decisions.list()).map(d => d.id)).toEqual([open!.id])
    expect(await candidateIds(e)).toEqual([memoryId])
  })

  it('配置为写进 AGENTS.md 时就地提升同等待处理卡：写进 AGENTS.md、项目里那条软删（快照先行），账本不留东西、不进等你决定；最近删除里能找回', async () => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    const body = ok(await e.run({ cmd: 'promote-memory', memoryId, layer: wsScope, isCandidateRequired: true, target: 'agents-md' }))
    expect(body.memoryIds).toEqual([memoryId])
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('所有项目都用 vitest')
    expect((await e.store.get(memoryId))!.status).toBe('deleted')
    expect((await e.snapshots.list()).flatMap(s => s.memoryIds)).toEqual([memoryId])
    // 写进 AGENTS.md 后插件不再管理它：同待处理卡，账本不留可撤销的条目
    expect(await allEntries(e)).toEqual([])
    const view = await pendingView(e)
    expect([ledgerItems(view), view.dot]).toEqual([[], 'none'])
    ok(await e.run({ cmd: 'restore', memoryId, layer: wsScope }))
    expect((await e.store.get(memoryId))!.status).toBe('active')
  })

  it('写进 AGENTS.md：体检已把它挂进等你决定的，那一条移出账本', async () => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    ok(await e.run({ cmd: 'scan' }))
    expect(await candidateIds(e)).toEqual([memoryId])
    ok(await e.run({ cmd: 'promote-memory', memoryId, layer: wsScope, isCandidateRequired: true, target: 'agents-md' }))
    expect(await allEntries(e)).toEqual([])
    expect(await candidateIds(e)).toEqual([])
  })

  it('写进 AGENTS.md：含密钥的记忆同待处理卡回 failed 并说明原因，什么都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_sec', name: '部署凭证', content: `token ${FAKE_SECRET.sk}`, scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
    const body = err(await e.run({ cmd: 'promote-memory', memoryId: 'mem_sec', layer: wsScope, isCandidateRequired: true, target: 'agents-md' }))
    expect(body.code).toBe('failed')
    expect(body.detail).toContain('含密钥的记忆不能写入 AGENTS.md')
    await expect(stat(join(root, 'AGENTS.md'))).rejects.toThrow()
    const rec = (await e.store.get('mem_sec'))!
    expect([rec.status, rec.globalCandidate]).toEqual(['active', true])
    expect(await allEntries(e)).toEqual([])
    expect(await e.snapshots.list()).toEqual([])
  })

  it.each([
    ['全局有在用的同 id 记忆', false],
    ['全局同 id 的那条在最近删除里', true],
  ] as const)('提升为全局时%s：promote 与 promote-memory 都回 target-taken，什么都不动', async (_label, isDeleted) => {
    const e = env({ llm: quietLlm })
    const memoryId = await saveCandidate(e)
    const project = (await e.store.get(memoryId, { workspacePath: SESSION_WS }))!
    const { workspacePath: _ws, ...rest } = project
    await e.store.create({ ...rest, scope: 'global', globalCandidate: undefined, content: '全局那份' })
    if (isDeleted) ok(await e.run({ cmd: 'forget', memoryId, layer: { kind: 'global' } }))
    expect(err(await e.run({ cmd: 'promote-memory', memoryId, layer: wsScope, isCandidateRequired: true })).code).toBe('target-taken')
    const { entry: open } = await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: [memoryId], summary: '', workspaces: [SESSION_WS], fingerprint: 'fp' }, 1)
    expect(err(await e.run({ cmd: 'promote', decisionId: open.id, target: 'global' })).code).toBe('target-taken')
    const rec = (await e.store.locate(memoryId, { kind: 'workspace', workspacePath: SESSION_WS }))!.record
    expect([rec.scope, rec.status, rec.globalCandidate]).toEqual(['workspace', 'active', true])
    expect(await e.decisions.list()).toEqual([open])
    expect(await e.decisions.listSettled()).toEqual([])
  })

  it('keep-local-memory：不是候选、全局的、已删的、不存在的 → not-found，账本不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_plain', name: '普通', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_g', name: '全局的' }))
    await e.store.create(record({ id: 'mem_d', name: '删掉的', scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_d' }))
    for (const memoryId of ['mem_plain', 'mem_g', 'mem_d', 'mem_none']) {
      expect(err(await e.run({ cmd: 'keep-local-memory', memoryId, layer: wsScope })).code).toBe('not-found')
    }
    expect(await allEntries(e)).toEqual([])
  })

  it('别的项目的候选：先回 cross-workspace（账本不留东西），带 allowCrossWorkspace 才留下', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_o', name: '别处的', scope: 'workspace', workspacePath: OTHER_WS, globalCandidate: true }))
    const other = { kind: 'workspace', workspacePath: OTHER_WS } as const
    expect(err(await e.run({ cmd: 'keep-local-memory', memoryId: 'mem_o', layer: other }))).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_o', workspacePath: OTHER_WS }] })
    expect((await e.store.get('mem_o'))!.globalCandidate).toBe(true)
    expect(await allEntries(e)).toEqual([])
    ok(await e.run({ cmd: 'keep-local-memory', memoryId: 'mem_o', layer: other, allowCrossWorkspace: true }))
    expect((await e.store.get('mem_o'))!.globalCandidate).toBeUndefined()
  })

  it('体检关闭时 keep-local-memory 同 keep-local：governance-disabled，什么都不动', async () => {
    const e = env({ governanceEnabled: false })
    const memoryId = await saveCandidate(e)
    const refused = err(await e.run({ cmd: 'keep-local-memory', memoryId, layer: wsScope }))
    expect(refused.code).toBe('governance-disabled')
    // 设置页只读这个开关，打开它要改配置文件
    expect(refused.detail).toBe('体检已关闭，可在配置文件里把 governance.enabled 改成 true 打开')
    expect((await e.store.get(memoryId))!.globalCandidate).toBe(true)
  })
})

// 同一个 id 在本项目和全局各有一份在用的：「留在本项目」和它的撤销读写都只认项目那一份，全局那份一字不动。
// 两种表都跑，两份各自较新时各跑一遍（不带层的定位按「在用、较新」挑，正好把两种挑法都走到）。
describe.each([
  { name: 'FileTable', inMemory: false },
  { name: 'InMemoryTable', inMemory: true },
])('留在本项目与撤销只认项目那一份（同 id 两层并存）：$name', ({ inMemory }) => {
  const wsScope = { kind: 'workspace', workspacePath: SESSION_WS } as const
  const copy = (partial: Partial<MemoryRecord>) => record({ id: 'mem_dup', type: 'preference', createdAt: 1, lastConfirmedAt: 1, ...partial })

  describe.each([
    { newer: '全局', globalAt: NOW - 1000, projectAt: NOW - 2000 },
    { newer: '项目', globalAt: NOW - 2000, projectAt: NOW - 1000 },
  ])('$newer那份较新', ({ globalAt, projectAt }) => {
    const globalCopy = copy({ name: '全局那份', content: '全局那份的正文', updatedAt: globalAt })
    const projectCopy = copy({ name: '项目那份', content: '项目那份的正文', scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true, updatedAt: projectAt })

    async function setup() {
      const table = inMemory ? new InMemoryTable(root) : undefined
      const e = env({ ...(table !== undefined ? { table } : {}) })
      for (const r of [globalCopy, projectCopy]) {
        // 内存表的 create 会清掉同 id 的其余副本：直接放进虚拟目录
        if (table !== undefined) table.seedFile({ dir: join(root, r.scope === 'global' ? GLOBAL_DIR : workspaceDirName(r.workspacePath!)), fileName: `${r.name}.md`, record: r })
        else await e.store.create(r)
      }
      expect(await locateCopy(e.store, 'mem_dup', { kind: 'global' })).toBeDefined()
      expect(await locateCopy(e.store, 'mem_dup', wsScope)).toBeDefined()
      return e
    }
    async function expectGlobalUntouched(e: ReturnType<typeof env>) {
      const g = await locateCopy(e.store, 'mem_dup', { kind: 'global' })
      expect(g).toMatchObject({ status: 'active', name: '全局那份', content: '全局那份的正文', updatedAt: globalAt })
      expect(g!.globalCandidate).toBeUndefined()
    }
    const projectNow = async (e: ReturnType<typeof env>) => locateCopy(e.store, 'mem_dup', wsScope)

    it('就地留下：清的是项目那份，账本指纹记项目那份；撤销把标记放回项目那份', async () => {
      const e = await setup()
      const body = ok(await e.run({ cmd: 'keep-local-memory', memoryId: 'mem_dup', layer: wsScope }))
      expect((await projectNow(e))!.globalCandidate).toBeUndefined()
      await expectGlobalUntouched(e)
      const settled = (await e.decisions.listSettled()).find(d => d.id === body.decisionId)!
      expect(settled.fingerprint).toBe(candidateFingerprint(projectCopy))

      ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
      expect(await projectNow(e)).toMatchObject({ status: 'active', content: '项目那份的正文', globalCandidate: true })
      await expectGlobalUntouched(e)
    })

    it('从「等你决定」留下：同样只动项目那一份；撤销后条目回到待处理', async () => {
      const e = await setup()
      const { entry } = await e.decisions.upsert({
        kind: 'promote-candidate', memoryIds: ['mem_dup'], summary: projectCopy.summary, workspaces: [SESSION_WS], fingerprint: candidateFingerprint(projectCopy),
      }, NOW)
      ok(await e.run({ cmd: 'keep-local', decisionId: entry.id }))
      expect((await projectNow(e))!.globalCandidate).toBeUndefined()
      await expectGlobalUntouched(e)

      ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
      expect(await projectNow(e)).toMatchObject({ status: 'active', content: '项目那份的正文', globalCandidate: true })
      await expectGlobalUntouched(e)
      expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    })
  })
})

describe('move-memory（建议整理「放错层」的移到项目）', () => {
  /** 模型把全局的 mem_g 判为放错层（只和某个项目有关）。 */
  const misplacedLlm: SemanticLlm = { complete: async () => JSON.stringify({ findings: [{ type: 'misplaced', memoryIds: ['mem_g'], summary: '只和一个项目有关' }] }) }
  const misplacedIds = async (e: ReturnType<typeof env>) => pendingViewSchema.parse(await e.readView('pending')).items
    .flatMap(i => i.kind === 'advice' && i.type === 'misplaced' ? i.memories.map(m => m.id) : [])
  const copyIn = async (e: ReturnType<typeof env>, id: string, workspacePath?: string) =>
    (await e.store.locate(id, scopeAt(workspacePath)))
  const original = () => record({
    id: 'mem_g', name: '本仓用 pnpm', content: '这个仓库装依赖用 pnpm', summary: '装依赖用 pnpm', tags: ['pnpm'],
    source: { sessionId: 'sess-old', eventRange: [3, 9], sourceMode: 'user-explicit' },
    createdAt: 100, updatedAt: 200, lastConfirmedAt: 300,
  })
  const move = (workspacePath: string, extra: { allowCrossWorkspace?: boolean } = {}): MemoryCommand => ({ cmd: 'move-memory', memoryId: 'mem_g', workspacePath, ...extra })

  it('移到项目：全局目录里没有这条、目标项目目录里有，内容、id、出处、时间戳不动；快照先行，账本留一条可撤销的移动，「放错层」消失', async () => {
    const e = env({ llm: misplacedLlm })
    await e.store.create(original())
    ok(await e.run({ cmd: 'scan' }))
    expect(await misplacedIds(e)).toEqual(['mem_g'])

    const body = ok(await e.run(move(SESSION_WS)))
    expect(await copyIn(e, 'mem_g')).toBeUndefined()
    const moved = (await copyIn(e, 'mem_g', SESSION_WS))!
    expect(dirname(moved.filePath)).toBe(join(root, workspaceDirName(SESSION_WS)))
    expect(body.filePath).toBe(moved.filePath)
    const { scope, workspacePath, ...rest } = moved.record
    expect([scope, workspacePath]).toEqual(['workspace', SESSION_WS])
    const { scope: _s, workspacePath: _w, ...before } = original()
    expect(rest).toEqual(before)
    // 索引跟着变：维护后项目的索引有它，全局的没有
    await e.store.maintain({ kind: 'visible', workspacePath: SESSION_WS })
    expect(await indexedIds(dirname(moved.filePath))).toContain('mem_g')
    expect(await indexText(dirname(moved.filePath))).toContain('装依赖用 pnpm')
    expect(await indexedIds(join(root, GLOBAL_DIR))).not.toContain('mem_g')
    expect(await indexText(join(root, GLOBAL_DIR))).not.toContain('装依赖用 pnpm')

    const [snap] = await e.snapshots.list()
    expect(snap).toMatchObject({ memoryIds: ['mem_g'] })
    expect(snap!.data[0]!.scope).toBe('global')
    expect(body).toMatchObject({ cmd: 'move-memory', memoryIds: ['mem_g'], snapshotId: snap!.id })
    const settled = await e.decisions.listSettled()
    expect(settled.map(d => [d.id, d.kind, d.memoryIds, d.workspaces, d.settled])).toEqual([
      [body.decisionId, 'move', ['mem_g'], [SESSION_WS], { verdict: 'moved', at: NOW, snapshotId: snap!.id }],
    ])
    expect(await misplacedIds(e)).toEqual([])
    expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending')))).toEqual([])
    const library = libraryViewSchema.parse(await e.readView('library'))
    expect(library.layers.map(l => [l.layer, l.items.map(m => m.id)])).toEqual([[{ kind: 'global' }, []], [{ kind: 'workspace', workspacePath: SESSION_WS }, ['mem_g']]])
  })

  it('撤销：回到全局、项目里那份不在了，账本条目清掉，「放错层」回来', async () => {
    const e = env({ llm: misplacedLlm })
    await e.store.create(original())
    ok(await e.run({ cmd: 'scan' }))
    const globalPath = (await copyIn(e, 'mem_g'))!.filePath
    const body = ok(await e.run(move(SESSION_WS)))

    const undone = ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(undone.memoryIds).toEqual(['mem_g'])
    expect(await copyIn(e, 'mem_g', SESSION_WS)).toBeUndefined()
    const back = (await copyIn(e, 'mem_g'))!
    expect(back.filePath).toBe(globalPath)
    expect(back.record).toEqual(original())
    expect(await allEntries(e)).toEqual([])
    expect(await misplacedIds(e)).toEqual(['mem_g'])
  })

  it.each([
    ['在用的', 'active'],
    ['最近删除里的', 'deleted'],
  ] as const)('目标项目已有同 id 的记忆（%s）：拒绝，什么都不动', async (_label, status) => {
    const e = env()
    await e.store.create(original())
    await e.store.create(record({ id: 'mem_g', name: '项目里那份', content: '项目里的内容', scope: 'workspace', workspacePath: SESSION_WS }))
    if (status === 'deleted') await e.store.softDelete({ id: 'mem_g', workspacePath: SESSION_WS }, { at: scopeAt(SESSION_WS) })
    const projectBefore = await readFile((await copyIn(e, 'mem_g', SESSION_WS))!.filePath, 'utf8')
    const globalBefore = await readFile((await copyIn(e, 'mem_g'))!.filePath, 'utf8')
    const snapshotsBefore = (await e.snapshots.list()).length

    expect(err(await e.run(move(SESSION_WS))).code).toBe('target-taken')
    expect(await readFile((await copyIn(e, 'mem_g'))!.filePath, 'utf8')).toBe(globalBefore)
    expect(await readFile((await copyIn(e, 'mem_g', SESSION_WS))!.filePath, 'utf8')).toBe(projectBefore)
    expect(await e.snapshots.list()).toHaveLength(snapshotsBefore)
    expect(await allEntries(e)).toEqual([])
  })

  it('目标项目里有同名文件（别的 id）：按撞名规则换个文件名，两条都在', async () => {
    const e = env()
    await e.store.create(original())
    await e.store.create(record({ id: 'mem_same_name', name: '本仓用 pnpm', content: '另一条', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run(move(SESSION_WS)))
    const moved = (await copyIn(e, 'mem_g', SESSION_WS))!
    const other = (await copyIn(e, 'mem_same_name', SESSION_WS))!
    expect(moved.filePath).not.toBe(other.filePath)
    expect([moved.record.content, other.record.content]).toEqual(['这个仓库装依赖用 pnpm', '另一条'])
  })

  it('不在全局（项目记忆、已删除、不存在）→ not-found，什么都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_p', name: '项目的', scope: 'workspace', workspacePath: OTHER_WS }))
    await e.store.create(record({ id: 'mem_d', name: '删掉的' }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_d' }))
    for (const memoryId of ['mem_p', 'mem_d', 'mem_none']) {
      expect(err(await e.run({ cmd: 'move-memory', memoryId, workspacePath: SESSION_WS })).code).toBe('not-found')
    }
    expect((await e.store.get('mem_p'))!.workspacePath).toBe(OTHER_WS)
    expect(await allEntries(e)).toEqual([])
    expect(await e.snapshots.list()).toHaveLength(1) // 只有 forget 那一份
  })

  it('目标是别的项目：先要 allowCrossWorkspace，带上才移；撤销同样要先确认', async () => {
    const e = env()
    await e.store.create(original())
    const refused = err(await e.run(move(OTHER_WS)))
    expect(refused).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_g', workspacePath: OTHER_WS }] })
    expect(await copyIn(e, 'mem_g')).toBeDefined()
    expect(await copyIn(e, 'mem_g', OTHER_WS)).toBeUndefined()
    expect(await e.snapshots.list()).toEqual([])

    const body = ok(await e.run(move(OTHER_WS, { allowCrossWorkspace: true })))
    expect(await copyIn(e, 'mem_g', OTHER_WS)).toBeDefined()
    expect(err(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_g', workspacePath: OTHER_WS }] })
    expect(await copyIn(e, 'mem_g')).toBeUndefined()
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId!, allowCrossWorkspace: true }))
    expect(await copyIn(e, 'mem_g')).toBeDefined()
    expect(await copyIn(e, 'mem_g', OTHER_WS)).toBeUndefined()
  })

  it.each([
    ['末尾带斜杠', `${SESSION_WS}/`],
    ['带 ..', `${SESSION_WS}/sub/..`],
  ])('目标路径%s：按规范化后的项目判跨项目、查重、落盘和记账', async (_label, workspacePath) => {
    const e = env()
    await e.store.create(original())
    const body = ok(await e.run(move(workspacePath)))
    const moved = (await copyIn(e, 'mem_g', SESSION_WS))!
    expect(moved.record.workspacePath).toBe(SESSION_WS)
    expect(dirname(moved.filePath)).toBe(join(root, workspaceDirName(SESSION_WS)))
    expect((await e.decisions.listSettled()).map(d => [d.id, d.workspaces])).toEqual([[body.decisionId, [SESSION_WS]]])

    // 查重也按规范化后的路径：已在 SESSION_WS 里，再移一次撞上它
    await e.store.create(record({ id: 'mem_g', name: '又一份全局' }))
    expect(err(await e.run(move(workspacePath))).code).toBe('target-taken')
  })

  it('体检关闭时不可用（同提升为全局）', async () => {
    const e = env({ governanceEnabled: false })
    await e.store.create(original())
    expect(err(await e.run(move(SESSION_WS))).code).toBe('governance-disabled')
    expect(await copyIn(e, 'mem_g')).toBeDefined()
  })

  it('移动记录 14 天后随保留窗口清掉', async () => {
    const e = env()
    await e.store.create(original())
    const body = ok(await e.run(move(SESSION_WS)))
    await e.decisions.sweep(NOW + RETENTION_MS + 1)
    expect(await allEntries(e)).toEqual([])
    expect(err(await e.run({ cmd: 'undo', decisionId: body.decisionId! })).code).toBe('not-found')
  })
})

describe('同 id 在会话项目和别的项目各有一份时提升', () => {
  // 页面上点的是别的项目那份：提升的必须是它，会话项目里的同 id 副本不碰
  const copyIn = async (e: ReturnType<typeof env>, scope: Scope) =>
    (await e.store.readRaw(scope, { includeArchive: true })).records.find(l => l.record.id === 'mem_dup')?.record
  const seedCopies = async (e: ReturnType<typeof env>) => {
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', scope: 'workspace', workspacePath: OTHER_WS, globalCandidate: true }))
  }

  it('promote-memory 指明别的项目：先要 allowCrossWorkspace，带上后提升的是那一份', async () => {
    const e = env()
    await seedCopies(e)
    const other = { kind: 'workspace', workspacePath: OTHER_WS } as const
    expect(err(await e.run({ cmd: 'promote-memory', memoryId: 'mem_dup', layer: other })).code).toBe('cross-workspace')
    expect((await copyIn(e, { kind: 'workspace', workspacePath: SESSION_WS }))?.name).toBe('本项目那份')
    ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true }))
    expect((await copyIn(e, { kind: 'global' }))?.name).toBe('别的项目那份')
    expect(await copyIn(e, { kind: 'workspace', workspacePath: OTHER_WS })).toBeUndefined()
    expect((await copyIn(e, { kind: 'workspace', workspacePath: SESSION_WS }))?.name).toBe('本项目那份')
  })

  it('promote 别的项目的提升候选：同样只动候选所在项目那一份', async () => {
    const e = env()
    await seedCopies(e)
    const { entry } = await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_dup'], summary: '别的项目那份', workspaces: [OTHER_WS], fingerprint: 'fp' }, 1)
    expect(err(await e.run({ cmd: 'promote', decisionId: entry.id, target: 'global' })).code).toBe('cross-workspace')
    expect((await copyIn(e, { kind: 'workspace', workspacePath: SESSION_WS }))?.name).toBe('本项目那份')
    ok(await e.run({ cmd: 'promote', decisionId: entry.id, target: 'global', allowCrossWorkspace: true }))
    expect((await copyIn(e, { kind: 'global' }))?.name).toBe('别的项目那份')
    expect((await copyIn(e, { kind: 'workspace', workspacePath: SESSION_WS }))?.name).toBe('本项目那份')
  })

  it.each([OTHER_WS, SESSION_WS])('两份都是候选：待处理的提升卡显示条目所在项目（%s）那一份，与提升命令动的是同一份', async (ws) => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', scope: 'workspace', workspacePath: OTHER_WS, globalCandidate: true }))
    await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_dup'], summary: '候选', workspaces: [ws], fingerprint: 'fp' }, 1)
    ok(await e.run({ cmd: 'refresh-views' }))
    const cards = pendingViewSchema.parse(await e.readView('pending')).items.flatMap(i => (i.kind === 'promote-candidate' && i.memory !== null ? [i.memory] : []))
    expect(cards.map(m => [m.name, m.workspacePath, dirname(m.filePath)])).toEqual([
      [ws === OTHER_WS ? '别的项目那份' : '本项目那份', ws, join(root, workspaceDirName(ws))],
    ])
  })

  it('条目所在项目那份在最近删除里、别的项目那份仍是在用的候选：不出这张提升卡，也不拿别的项目那份顶上', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', scope: 'workspace', workspacePath: OTHER_WS, globalCandidate: true }))
    await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_dup'], summary: '候选', workspaces: [SESSION_WS], fingerprint: 'fp' }, 1)
    expect(await e.store.softDelete({ id: 'mem_dup', workspacePath: SESSION_WS }, { at: scopeAt(SESSION_WS), now: e.clock.now })).toBe(true)
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(pendingViewSchema.parse(await e.readView('pending')).items.filter(i => i.kind === 'promote-candidate')).toEqual([])
  })
})