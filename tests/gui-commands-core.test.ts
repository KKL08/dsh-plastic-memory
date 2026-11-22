import { describe, expect, it } from 'vitest'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from '../src/storage/paths.ts'
import { conflictFingerprint } from '../src/governance/decisions.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, sessionViewFile, deletedViewSchema, pendingViewSchema, type MemoryCommand, type MemoryCommandResult } from '../src/gui/contract.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { executeScan } from '../src/tools/scan.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { noInstructions } from './helpers/instructions.ts'
import { SESSION_WS, OTHER_WS, registry, root, type EnvOpts, env, ok, err, seedPair, allEntries, ledgerItems } from './helpers/gui-command-env.ts'


describe('info', () => {
  it('返回 memoryRoot、视图文件绝对路径与契约版本；只建视图目录，不写视图文件（宿主的文件观察不跟踪父目录尚不存在的文件，客户端订阅前目录要先在）', async () => {
    const e = env()
    const body = ok(await e.run({ cmd: 'info' }))
    const dir = join(root, GUI_VIEW_DIR)
    expect(body.info).toEqual({
      memoryRoot: root,
      viewDir: dir,
      views: {
        pending: join(dir, GUI_VIEW_FILES.pending), health: join(dir, GUI_VIEW_FILES.health),
        library: join(dir, GUI_VIEW_FILES.library), deleted: join(dir, GUI_VIEW_FILES.deleted),
        checkups: join(dir, GUI_CHECKUP_VIEW_FILE),
        session: join(dir, sessionViewFile('sess-1')),
      },
      version: GUI_VIEW_VERSION,
    })
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('参数解析', () => {
  it.each([
    ['未知子命令', ' nope'],
    ['空输入', ''],
    ['参数不是 JSON', ' resolve {decisionId'],
    ['参数不是对象', ' resolve [1]'],
    ['缺必填字段', ' resolve {"decisionId":"pd_x"}'],
    ['verdict 取值非法', ' resolve {"decisionId":"pd_x","verdict":"dismiss"}'],
  ])('%s → invalid-args，账本与视图不动', async (_label, raw) => {
    const e = env()
    const entry = await seedPair(e)
    const body = err(await e.runRaw(raw))
    expect(body.code).toBe('invalid-args')
    expect(await e.decisions.list()).toEqual([entry])
    await expect(stat(join(root, GUI_VIEW_DIR))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('不存在的条目 → not-found', async () => {
    const e = env()
    expect(err(await e.run({ cmd: 'resolve', decisionId: 'pd_ghost', verdict: 'keep-left' })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'undo', decisionId: 'pd_ghost' })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_ghost' })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_ghost' })).code).toBe('not-found')
  })

  it('借的会话是子 agent：写命令一律 subagent-readonly，账本不动', async () => {
    const e = env({ delegationDepth: 1 })
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' })).code).toBe('subagent-readonly')
    expect(await e.decisions.list()).toEqual([entry])
    expect((await e.store.get('mem_b'))!.status).toBe('active')
  })
})

describe('resolve 与 undo', () => {
  it('横向 keep-left：删 B、快照先行、条目 settled；视图重写；undo 后 B 回来、冲突回到待处理且只有一条', async () => {
    const e = env()
    const entry = await seedPair(e)

    const resolved = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect(resolved.decisionId).toBe(entry.id)
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    const [snap] = await e.snapshots.list()
    expect(snap!.memoryIds).toEqual(['mem_b'])
    expect(resolved.snapshotId).toBe(snap!.id)
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict, d.settled?.snapshotId])).toEqual([[entry.id, 'keep-left', snap!.id]])
    expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending')))).toEqual([])
    const deleted = deletedViewSchema.parse(await e.readView('deleted'))
    expect(deleted.items.map(i => [i.memory.id, i.cause?.decisionId])).toEqual([['mem_b', entry.id]])

    const undone = ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect(undone.memoryIds).toEqual(['mem_b'])
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    const pending = pendingViewSchema.parse(await e.readView('pending'))
    expect(ledgerItems(pending).map(i => [i.kind, 'decisionId' in i ? i.decisionId : undefined])).toEqual([['conflict-horizontal', entry.id]])
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

  it('PA-11 败方不含密钥：照旧软删、记快照、可撤销；本次条目留在账本里，别的引用败方的条目清掉', async () => {
    const e = env()
    const entry = await seedPair(e)
    await e.store.create(record({ id: 'mem_c', name: '丙', content: '用 yarn' }))
    const other = (await e.decisions.upsert({ memoryIds: ['mem_b', 'mem_c'], summary: '另一条', fingerprint: 'fp-bc' }, 2)).entry

    const body = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))

    expect(body.isHardDeleted).toBeUndefined()
    expect(body.snapshotId).toBeDefined()
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.snapshotId])).toEqual([[entry.id, body.snapshotId]])
    expect((await allEntries(e)).map(d => d.id)).not.toContain(other.id)
    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await e.store.get('mem_b'))!.status).toBe('active')
  })

  it('PA-11 败方含密钥：物理删除、所有快照里已脱敏、不在最近删除；结果标明彻底删除，条目移出账本、没有撤销', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: `用 npm，token ${FAKE_SECRET.sk}` }))
    const entry = (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)).entry
    const earlier = await executeSnapshotTool({ action: 'create', memoryIds: ['mem_b'] }, { workspacePath: SESSION_WS }, { store: e.store, snapshots: e.snapshots })
    if (earlier.kind !== 'created') throw new Error(earlier.kind)

    const body = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))

    expect(body.isHardDeleted).toBe(true)
    expect(body.snapshotId).toBeUndefined()
    expect(await e.store.get('mem_b')).toBeUndefined()
    expect((await e.store.get('mem_a'))!.status).toBe('active')
    const snapshots = await e.snapshots.list()
    expect(snapshots.length).toBeGreaterThan(1)
    for (const snap of snapshots) {
      expect(JSON.stringify(snap)).not.toContain(FAKE_SECRET.sk)
      expect(snap.data.find(r => r.id === 'mem_b')!.redacted).toBe(true)
    }
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
    expect(await allEntries(e)).toEqual([])
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('not-found')
  })

  it('PA-11 败方只含疑似密钥（用户确认存下的）：照常软删、记快照、可撤销', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm，password: TESTONLY99' }))
    const entry = (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)).entry

    const body = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))

    expect(body.isHardDeleted).toBeUndefined()
    expect(body.snapshotId).toBeDefined()
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([entry.id])
    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await e.store.get('mem_b'))!.content).toBe('用 npm，password: TESTONLY99')
  })

  it('没有指纹的条目（升级前导入的）两边都留：按双方此刻的内容现算指纹记下，体检同一对不再挂账，可以撤销', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm' }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾' }, 1)
    const body = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-both' }))
    expect(body.isUnrecorded).toBeUndefined()
    const fingerprint = conflictFingerprint([(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!])
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict, d.fingerprint])).toEqual([[entry.id, 'keep-both', fingerprint]])
    expect((await e.decisions.upsert({ memoryIds: ['mem_b', 'mem_a'], summary: '再报', fingerprint }, 2)).settled).toBe(true)

    // 真跑一次体检：模型再报同一对冲突，沿用已裁决的结论，不挂新账
    const llm = { complete: async () => JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', suggestedAction: '裁决' }] }) }
    const scanned = await executeScan({}, {
      store: e.store, registry, decisions: e.decisions, cache: e.cache, checkups: e.checkups,
      host: { contextOf: async () => ({ workspacePath: undefined }), llmOf: () => llm }, instructions: noInstructions, now: () => e.clock.now,
    }, fakeExec())
    if (scanned.kind !== 'single') throw new Error(`expected single, got ${scanned.kind}`)
    expect(scanned.pendingDecisions.created).toBe(0)
    expect(scanned.notes.map(n => n.code)).toContain('conflicts-settled')
    expect(await e.decisions.list()).toEqual([])
    expect((await e.decisions.listSettled()).map(d => [d.id, d.fingerprint])).toEqual([[entry.id, fingerprint]])

    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
  })

  it('没有指纹的垂直冲突保留记忆：拿得到这条记忆对应的指令文件时现算指纹记下；拿不到时结果标 isUnrecorded，条目移出账本', async () => {
    const withBaseline = env({ instructions: { global: '包管理统一用 pnpm' } })
    await withBaseline.store.create(record({ id: 'mem_v', name: '丙', content: '用 yarn' }))
    const { entry } = await withBaseline.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾' }, 1)
    expect(ok(await withBaseline.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' })).isUnrecorded).toBeUndefined()
    const fingerprint = conflictFingerprint([(await withBaseline.store.get('mem_v'))!], ['包管理统一用 pnpm'])
    expect((await withBaseline.decisions.listSettled()).map(d => [d.id, d.fingerprint])).toEqual([[entry.id, fingerprint]])

    await rm(root, { recursive: true, force: true })
    const noBaseline = env()
    await noBaseline.store.create(record({ id: 'mem_v', name: '丙', content: '用 yarn' }))
    const again = (await noBaseline.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾' }, 1)).entry
    expect(ok(await noBaseline.run({ cmd: 'resolve', decisionId: again.id, verdict: 'keep-left' })).isUnrecorded).toBe(true)
    expect(await allEntries(noBaseline)).toEqual([])
    expect((await noBaseline.store.get('mem_v'))!.status).toBe('active')
  })

  it('没有指纹的垂直冲突，记忆属于别的项目（跨项目确认后裁决）：按它所在项目的指令文件现算指纹记下，和会话所在项目无关', async () => {
    const e = env({ instructions: { [SESSION_WS]: '会话项目：用 npm', [OTHER_WS]: '包管理统一用 pnpm' } })
    await e.store.create(record({ id: 'mem_v', name: '丙', content: '用 yarn', scope: 'workspace', workspacePath: OTHER_WS }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾' }, 1)
    expect(err(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' })).code).toBe('cross-workspace')
    const body = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }))
    expect(body.isUnrecorded).toBeUndefined()
    const written = (await e.store.get('mem_v', { kind: 'workspace', workspacePath: OTHER_WS }))!
    expect(written.status).toBe('active')
    expect((await e.decisions.listSettled()).map(d => [d.id, d.fingerprint])).toEqual([[entry.id, conflictFingerprint([written], ['包管理统一用 pnpm'])]])
    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
  })

})

describe('并发裁决', () => {
  /** 两条相反的裁决同时发出：恰好一条成功、只删它的败方，另一条失败且什么都不动。 */
  async function expectOneRuling(results: MemoryCommandResult[], e: ReturnType<typeof env>) {
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const winner = results[0]!.ok ? 'keep-left' : 'keep-right'
    const loser = err(results.find(r => !r.ok)!)
    expect(loser.detail).toMatch(/已被裁决|正在/)
    const statuses = [(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]
    expect(statuses).toEqual(winner === 'keep-left' ? ['active', 'deleted'] : ['deleted', 'active'])
    expect(await e.snapshots.list()).toHaveLength(1)
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual([winner])
  }

  it('同一冲突同时收到 keep-left 与 keep-right：只有一条生效，只删一方', async () => {
    const e = env()
    const entry = await seedPair(e)
    const results = await Promise.all([
      e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }),
      e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' }),
    ])
    await expectOneRuling(results, e)
  })

  it('两个宿主实例（各自的侧表与 FileTable）共用一个根：同样只有一条生效', async () => {
    const a = env()
    const b = env()
    const entry = await seedPair(a)
    const results = await Promise.all([
      a.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }),
      b.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' }),
    ])
    await expectOneRuling(results, a)
  })

  /**
   * 体检与裁决同时进行：体检的语义层跑完之后，下一次读账本先拿到快照，再让 rule 发出裁决，最后把裁决前的快照交给体检
   * （体检据此挂账）。rule 由同一个实例或另一个实例（另一个宿主进程）执行，结果从 ruled() 取。
   */
  async function scanDuringRuling(rule: (decisionId: string) => Promise<MemoryCommandResult>, scanner: (wrap: EnvOpts['wrapPending']) => ReturnType<typeof env>) {
    let decisionId = ''
    let isArmed = false
    let ruling: MemoryCommandResult | undefined
    const wrap: EnvOpts['wrapPending'] = table => ({
      get: key => table.get(key),
      put: (key, value) => table.put(key, value),
      delete: key => table.delete(key),
      deleteIf: (key, isStill) => table.deleteIf(key, isStill),
      claim: key => table.claim(key),
      list: async () => {
        const snapshot = await table.list()
        if (isArmed) {
          isArmed = false
          ruling = await rule(decisionId)
        }
        return snapshot
      },
    })
    const e = scanner(wrap)
    decisionId = (await seedPair(e)).id
    const armingLlm: SemanticLlm = {
      complete: async () => {
        isArmed = true
        return JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', suggestedAction: '裁决' }] })
      },
    }
    return { e, decisionId, armingLlm, ruled: () => ruling! }
  }

  /** 体检正在挂这一对时，要删一方的裁决被拒、什么都不动；体检完了条目还在待处理，再裁决一次照常生效。 */
  async function expectRulingTurnedDownThenRetried(e: ReturnType<typeof env>, decisionId: string, ruled: MemoryCommandResult) {
    expect(err(ruled).code).toBe('claimed')
    expect((await e.decisions.list()).map(d => d.id)).toEqual([decisionId])
    expect([(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]).toEqual(['active', 'active'])
    expect(await e.snapshots.list()).toHaveLength(0)

    ok(await e.run({ cmd: 'resolve', decisionId, verdict: 'keep-left' }))
    expect(await e.decisions.list()).toEqual([])
    expect([(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]).toEqual(['active', 'deleted'])
    expect(await e.snapshots.list()).toHaveLength(1)
  }

  /** 让条目带上体检会算出的指纹：都保留的结论按指纹判断还作不作数，夹具里的假指纹会被当成内容变了。 */
  async function stampRealFingerprint(e: ReturnType<typeof env>) {
    const fingerprint = conflictFingerprint([(await e.store.get('mem_a'))!, (await e.store.get('mem_b'))!])
    await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint }, 2)
  }

  async function expectKeptBothSurvives(e: ReturnType<typeof env>, decisionId: string) {
    expect(await e.decisions.list()).toEqual([])
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[decisionId, 'keep-both']])
    expect([(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]).toEqual(['active', 'active'])
  }

  it('体检正在挂这一对时收到要删一方的裁决：裁决被拒、什么都不动，体检后重试生效', async () => {
    let llm: SemanticLlm | undefined
    const { e, decisionId, armingLlm, ruled } = await scanDuringRuling(
      id => e.run({ cmd: 'resolve', decisionId: id, verdict: 'keep-left' }),
      wrapPending => env({ wrapPending, llm: { complete: (...args) => llm!.complete(...args) } }),
    )
    llm = armingLlm
    ok(await e.run({ cmd: 'scan' }))
    await expectRulingTurnedDownThenRetried(e, decisionId, ruled())
  })

  it('两个宿主实例共用一个根：一个在体检，另一个发来要删一方的裁决，同样被拒、重试生效', async () => {
    const other = env()
    let llm: SemanticLlm | undefined
    const { e, decisionId, armingLlm, ruled } = await scanDuringRuling(
      id => other.run({ cmd: 'resolve', decisionId: id, verdict: 'keep-left' }),
      wrapPending => env({ wrapPending, llm: { complete: (...args) => llm!.complete(...args) } }),
    )
    llm = armingLlm
    ok(await e.run({ cmd: 'scan' }))
    await expectRulingTurnedDownThenRetried(other, decisionId, ruled())
  })

  it('体检挂账时同一冲突刚被裁决为都保留：已裁决的条目不被体检改回待处理', async () => {
    let llm: SemanticLlm | undefined
    const { e, decisionId, armingLlm, ruled } = await scanDuringRuling(
      id => e.run({ cmd: 'resolve', decisionId: id, verdict: 'keep-both' }),
      wrapPending => env({ wrapPending, llm: { complete: (...args) => llm!.complete(...args) } }),
    )
    llm = armingLlm
    await stampRealFingerprint(e)
    ok(await e.run({ cmd: 'scan' }))
    ok(ruled())
    await expectKeptBothSurvives(e, decisionId)
  })

  it('两个宿主实例共用一个根：一个在体检，另一个裁决为都保留，同样不被改回待处理', async () => {
    const other = env()
    let llm: SemanticLlm | undefined
    const { e, decisionId, armingLlm, ruled } = await scanDuringRuling(
      id => other.run({ cmd: 'resolve', decisionId: id, verdict: 'keep-both' }),
      wrapPending => env({ wrapPending, llm: { complete: (...args) => llm!.complete(...args) } }),
    )
    llm = armingLlm
    await stampRealFingerprint(e)
    ok(await e.run({ cmd: 'scan' }))
    ok(ruled())
    await expectKeptBothSurvives(e, decisionId)
    await expectKeptBothSurvives(other, decisionId)
  })

  const writeClaim = async (decisionId: string, pid: number) => {
    await mkdir(join(root, STATE_DIR, 'pending'), { recursive: true })
    await writeFile(join(root, STATE_DIR, 'pending', `${decisionId}.claim`), JSON.stringify({ pid, at: Date.now(), id: 'other' }))
  }

  it('另一次裁决正持有认领：claimed 并说明，账本与记忆都不动', async () => {
    const e = env()
    const entry = await seedPair(e)
    await writeClaim(entry.id, process.pid)
    const body = err(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect(body.code).toBe('claimed')
    expect(body.detail).toMatch(/正在被另一次裁决处理/)
    expect(await e.decisions.list()).toEqual([entry])
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect(await e.snapshots.list()).toEqual([])
  })

  it('撤销、提升、留在本项目、忽略超限碰上别人持有的认领：同样回 claimed，账本与记忆都不动', async () => {
    const e = env()
    const pair = await seedPair(e)
    ok(await e.run({ cmd: 'resolve', decisionId: pair.id, verdict: 'keep-left' }))
    await e.store.create(record({ id: 'mem_c', name: '戊', scope: 'workspace', workspacePath: SESSION_WS, globalCandidate: true }))
    const { entry: candidate } = await e.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_c'], summary: '候选', workspaces: [SESSION_WS], fingerprint: 'fp-c' }, 1)
    const { entry: overflow } = await e.decisions.upsert({ kind: 'overflow', memoryIds: [], summary: '超出上限', fingerprint: '1' }, 1)
    const before = await allEntries(e)
    for (const id of [pair.id, candidate.id, overflow.id]) await writeClaim(id, process.pid)
    const commands: MemoryCommand[] = [
      { cmd: 'undo', decisionId: pair.id },
      { cmd: 'promote', decisionId: candidate.id, target: 'global' },
      { cmd: 'keep-local', decisionId: candidate.id },
      { cmd: 'dismiss-overflow', decisionId: overflow.id },
    ]
    for (const command of commands) expect(err(await e.run(command)).code, command.cmd).toBe('claimed')
    expect(await allEntries(e)).toEqual(before)
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect((await e.store.get('mem_c'))!.scope).toBe('workspace')
  })

  it('认领前别处刚裁决完：not-found，什么都不动', async () => {
    let entryId = ''
    // 预检之后、本次认领之前，另一个标签页的裁决做完（条目出了待决）并放开了认领
    const e = env({
      wrapPending: table => ({
        get: key => table.get(key),
        put: (key, value) => table.put(key, value),
        delete: key => table.delete(key),
        deleteIf: (key, isStill) => table.deleteIf(key, isStill),
        list: () => table.list(),
        claim: async (key) => {
          if (key === entryId) await table.delete(key)
          return table.claim(key)
        },
      }),
    })
    entryId = (await seedPair(e)).id
    expect(err(await e.run({ cmd: 'resolve', decisionId: entryId, verdict: 'keep-right' })).code).toBe('not-found')
    expect([(await e.store.get('mem_a'))!.status, (await e.store.get('mem_b'))!.status]).toEqual(['active', 'active'])
    expect(await e.snapshots.list()).toEqual([])
  })

  it('裁决进程崩溃留下的认领：持有进程已不在时不挡后来的裁决，裁决完认领文件也清掉', async () => {
    const e = env()
    const entry = await seedPair(e)
    await writeClaim(entry.id, 2 ** 22 + 12345) // 大于各平台的 pid 上限，必定不存在
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect((await readdir(join(root, STATE_DIR, 'pending'))).filter(f => !f.endsWith('.json'))).toEqual([])
  })
})