import { describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LegacyKvTables } from '../src/storage/legacy-kv-import.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, STATE_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { REDACTED_PLACEHOLDER } from '../src/governance/schema.ts'
import { deletedViewSchema, libraryViewSchema, scopeOfMemory } from '../src/gui/contract.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { scopeAt } from '../src/scope.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { NOW, SESSION_WS, OTHER_WS, root, env, ok, err, seedPair, allEntries } from './helpers/gui-command-env.ts'


describe('restore', () => {
  it('从最近删除恢复被裁决删掉的那条：记忆回来、冲突回到待处理，再被扫到也不多出第二条', async () => {
    const e = env()
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' }))
    expect((await e.store.get('mem_a'))!.status).toBe('deleted')

    const restored = ok(await e.run({ cmd: 'restore', memoryId: 'mem_a' }))
    expect(restored.memoryIds).toEqual(['mem_a'])
    expect(restored.decisionId).toBe(entry.id)
    expect((await e.store.get('mem_a'))!.status).toBe('active')
    expect((await allEntries(e)).map(d => [d.id, d.settled])).toEqual([[entry.id, undefined]])

    // 下次体检同一对再报：沿用原条目，不新建
    const again = await e.decisions.upsert({ memoryIds: ['mem_b', 'mem_a'], summary: '再报', fingerprint: 'fp-ab' }, 2)
    expect(again.created).toBe(false)
    expect((await allEntries(e)).map(d => d.id)).toEqual([entry.id])
  })

  it('forget：读到之后这条被别处改过，不删，回 stale，不报成功', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_late', name: '戊', content: '旧正文' }))
    const get = e.store.get.bind(e.store)
    let isFired = false
    vi.spyOn(e.store, 'get').mockImplementation(async (id, hint, opts) => {
      const r = await get(id, hint, opts)
      if (id === 'mem_late' && !isFired && r !== undefined) {
        isFired = true
        await e.store.put({ ...r, content: '别处刚改的正文', updatedAt: r.updatedAt + 1 })
      }
      return r
    })
    const body = err(await e.run({ cmd: 'forget', memoryId: 'mem_late' }))
    vi.restoreAllMocks()
    expect(body.code).toBe('stale')
    expect(await e.store.get('mem_late')).toMatchObject({ status: 'active', content: '别处刚改的正文' })
  })

  it('forget 删掉的记忆：restore 按快照恢复，与冲突无关', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_f', name: '丁' }))
    const forgot = ok(await e.run({ cmd: 'forget', memoryId: 'mem_f' }))
    expect(forgot.memoryIds).toEqual(['mem_f'])
    expect((await e.store.get('mem_f'))!.status).toBe('deleted')
    const [snap] = await e.snapshots.list()
    expect(forgot.snapshotId).toBe(snap!.id)
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => i.memory.id)).toEqual(['mem_f'])

    ok(await e.run({ cmd: 'restore', memoryId: 'mem_f' }))
    expect((await e.store.get('mem_f'))!.status).toBe('active')
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

})

describe('restore：没有快照覆盖的归档记忆', () => {
  // 不经插件删除、没拍快照的归档文件：最近删除照样列出它，恢复就拿归档文件本身
  const own = { kind: 'workspace', workspacePath: SESSION_WS } as const
  const wsDir = () => join(root, workspaceDirName(SESSION_WS))
  const deletedIds = async (e: ReturnType<typeof env>) => deletedViewSchema.parse(await e.readView('deleted')).items.map(i => i.memory.id)
  const libraryIds = async (e: ReturnType<typeof env>) =>
    libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items.map(m => m.id))
  const isInArchive = async (e: ReturnType<typeof env>, id: string) => {
    const found = (await e.store.locate(id, { workspacePath: SESSION_WS }))!
    return found.filePath.startsWith(join(found.dir, ARCHIVE_DIR))
  }

  it('PA-17 恢复归档文件本身：updatedAt 取注入的时钟', async () => {
    const e = env({ now: NOW + 60_000 })
    await mkdir(join(wsDir(), ARCHIVE_DIR), { recursive: true })
    await writeFile(join(wsDir(), WORKSPACE_MARKER), SESSION_WS + '\n')
    const hand = record({ id: 'mem_hand', name: '手工归档', scope: 'workspace', workspacePath: SESSION_WS, status: 'deleted', deletedAt: NOW, updatedAt: NOW })
    await writeFile(join(wsDir(), ARCHIVE_DIR, 'hand.md'), encodeRecord(hand, {}))

    ok(await e.run({ cmd: 'restore', memoryId: 'mem_hand', layer: own }))
    expect(await e.store.get('mem_hand', { workspacePath: SESSION_WS })).toMatchObject({ status: 'active', updatedAt: NOW + 60_000 })
  })

  it('手工放进 .archive/ 的文件（status 仍写 active）：恢复成功，回到层顶层、重新出现在全部记忆里', async () => {
    const e = env()
    await mkdir(join(wsDir(), ARCHIVE_DIR), { recursive: true })
    await writeFile(join(wsDir(), WORKSPACE_MARKER), SESSION_WS + '\n')
    // 手工放进去的文件早于恢复：恢复靠 updatedAt 记成恢复时刻才写回顶层
    const hand = record({ id: 'mem_hand', name: '手工归档', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS, updatedAt: NOW - 60_000 })
    await writeFile(join(wsDir(), ARCHIVE_DIR, 'hand.md'), encodeRecord(hand, {}))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await deletedIds(e)).toEqual(['mem_hand'])
    expect(await e.snapshots.list()).toEqual([])

    const body = ok(await e.run({ cmd: 'restore', memoryId: 'mem_hand', layer: own }))
    expect(body.memoryIds).toEqual(['mem_hand'])
    expect(await e.store.get('mem_hand', { workspacePath: SESSION_WS })).toMatchObject({ status: 'active', content: '用 pnpm' })
    expect(await isInArchive(e, 'mem_hand')).toBe(false)
    expect(await deletedIds(e)).toEqual([])
    expect(await libraryIds(e)).toEqual(['mem_hand'])
  })

  it('手改 frontmatter 为 status: deleted、维护点归档后：恢复成功，deletedAt 清掉', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_edit', name: '手改删除', scope: 'workspace', workspacePath: SESSION_WS }))
    const { filePath } = (await e.store.locate('mem_edit', { workspacePath: SESSION_WS }))!
    const text = await readFile(filePath, 'utf8')
    expect(text).toContain('status: active')
    await writeFile(filePath, text.replace('status: active', 'status: deleted'))
    await e.store.maintain({ kind: 'workspace', workspacePath: SESSION_WS })
    expect(await isInArchive(e, 'mem_edit')).toBe(true)
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await deletedIds(e)).toEqual(['mem_edit'])

    ok(await e.run({ cmd: 'restore', memoryId: 'mem_edit', layer: own }))
    const back = (await e.store.get('mem_edit', { workspacePath: SESSION_WS }))!
    expect(back.status).toBe('active')
    expect(back.deletedAt).toBeUndefined()
    expect(await isInArchive(e, 'mem_edit')).toBe(false)
    expect(await libraryIds(e)).toEqual(['mem_edit'])
  })

  it('不带层也能恢复（按会话定位）', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_nolayer', scope: 'workspace', workspacePath: SESSION_WS, status: 'deleted' }))
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_nolayer' }))
    expect((await e.store.get('mem_nolayer', { workspacePath: SESSION_WS }))!.status).toBe('active')
  })

  it('别的项目的归档记忆：要 allowCrossWorkspace，带上才恢复', async () => {
    const e = env()
    const other = { kind: 'workspace', workspacePath: OTHER_WS } as const
    await e.store.create(record({ id: 'mem_far', scope: 'workspace', workspacePath: OTHER_WS, status: 'deleted' }))
    const body = err(await e.run({ cmd: 'restore', memoryId: 'mem_far', layer: other }))
    expect(body.code).toBe('cross-workspace')
    expect(body.rejected).toEqual([{ id: 'mem_far', workspacePath: OTHER_WS }])
    expect((await e.store.get('mem_far', { workspacePath: OTHER_WS }))!.status).toBe('deleted')
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_far', layer: other, allowCrossWorkspace: true }))
    expect((await e.store.get('mem_far', { workspacePath: OTHER_WS }))!.status).toBe('active')
  })

  it('快照里只剩脱敏副本的（密钥硬删过）：归档里还留着一份也不恢复', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_red', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_red', layer: own }))
    await e.snapshots.redact(new Set(['mem_red']))
    const body = err(await e.run({ cmd: 'restore', memoryId: 'mem_red', layer: own }))
    expect(body.code).toBe('not-found')
    expect((await e.store.get('mem_red', { workspacePath: SESSION_WS }))!.status).toBe('deleted')
  })
})

describe('跨项目', () => {
  it('resolve 涉及其他项目且缺 allowCrossWorkspace：cross-workspace，账本与文件不动；带上参数才执行', async () => {
    const e = env()
    const entry = await seedPair(e, OTHER_WS)
    const body = err(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect(body.code).toBe('cross-workspace')
    expect(body.rejected).toEqual([{ id: 'mem_a', workspacePath: OTHER_WS }, { id: 'mem_b', workspacePath: OTHER_WS }])
    expect(await e.decisions.list()).toEqual([entry])
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect(await e.snapshots.list()).toEqual([])

    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }))
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
  })

  it('undo / forget 同样把关', async () => {
    const e = env()
    const entry = await seedPair(e, OTHER_WS)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }))
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('cross-workspace')
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([entry.id])
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_a' })).code).toBe('cross-workspace')
    expect((await e.store.get('mem_a'))!.status).toBe('active')
  })
})

describe('forget 遇到含密钥的记忆', () => {
  // forget 承诺 14 天可撤销；含密钥的记忆只能物理删除，界面要先问用户，改走 hard-delete
  it.each([
    ['critical 密钥', `token ${FAKE_SECRET.sk}`],
    ['仅 suspected（用户 force 存下的疑似口令）', 'password: TESTONLY99'],
  ])('%s：has-secret，记忆原样留着、不建快照', async (_label, content) => {
    const e = env()
    await e.store.create(record({ id: 'mem_s', content }))
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_s' })).code).toBe('has-secret')
    expect((await e.store.get('mem_s'))!.status).toBe('active')
    expect(await e.snapshots.list()).toEqual([])

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_s' }))
    expect(await e.store.get('mem_s')).toBeUndefined()
  })

  it('不含密钥的记忆照常软删', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_plain' }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_plain' }))
    expect((await e.store.get('mem_plain'))!.status).toBe('deleted')
  })
})

describe('彻底删除与旧 KV 导入', () => {
  const oldSnapshot = { id: 'snap_old', createdAt: 1, operation: 'manual' as const, description: '旧快照', memoryIds: [], data: [] }
  it.each([
    ['旧 KV 服务暂缺、还没导入', async (): Promise<LegacyKvTables | undefined> => undefined],
    ['导入了但旧行还没删掉', async (): Promise<LegacyKvTables | undefined> => ({ snapshots: [['snap_old', oldSnapshot]], pending: [], discard: async () => { throw new Error('宿主忙') } })],
  ])('PA-06 %s：彻底删除回 failed、说明旧数据迁移还没收尾，在用的密钥条目和最近删除里的都不动', async (_label, openLegacyKv) => {
    const e = env({ openLegacyKv })
    await e.store.create(record({ id: 'mem_s', content: `token ${FAKE_SECRET.sk}` }))
    await e.store.create(record({ id: 'mem_gone', name: '已删' }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_gone' }))
    const snapshots = await e.snapshots.list()
    for (const memoryId of ['mem_s', 'mem_gone']) {
      const r = err(await e.run({ cmd: 'hard-delete', memoryId }))
      expect([r.code, r.detail]).toEqual(['failed', expect.stringContaining('旧数据迁移还没收尾')])
      expect(r.detail).not.toContain('带回来')
    }
    expect((await e.store.get('mem_s'))!.status).toBe('active')
    expect((await e.store.get('mem_gone'))!.status).toBe('deleted')
    expect(await e.snapshots.list()).toEqual(snapshots)
  })
})

describe('forget 与并发写入的密钥', () => {
  /** 第一次按 id 定位之后，另一个会话往这条记忆里写进密钥（模拟两次读之间的竞态）。 */
  const secretAfterFirstLookup = (e: ReturnType<typeof env>, id: string) => {
    const get = e.store.get.bind(e.store)
    let isInjected = false
    e.store.get = async (key, hint) => {
      const found = await get(key, hint)
      if (key === id && !isInjected) {
        isInjected = true
        await e.store.put({ ...(await get(key, hint))!, content: `token ${FAKE_SECRET.sk}` })
      }
      return found
    }
  }

  it('GUI forget：查找之后才出现的密钥不会被物理删除，回 has-secret，记忆原样留着', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_r', content: '用 pnpm' }))
    secretAfterFirstLookup(e, 'mem_r')
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_r' })).code).toBe('has-secret')
    const after = await e.store.get('mem_r')
    expect(after).toMatchObject({ status: 'active', content: `token ${FAKE_SECRET.sk}` })
  })

  it('memory_forget 不受影响：含密钥的记录照旧物理删除，结果里不多字段', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_r', content: `token ${FAKE_SECRET.sk}` }))
    const r = await executeForget({ ids: ['mem_r'], reason: '模型遗忘' }, { workspacePath: SESSION_WS }, { store: e.store, snapshots: e.snapshots, decisions: e.decisions })
    expect(r).toMatchObject({ ok: true, forgotten: ['mem_r'], hardDeleted: ['mem_r'] })
    expect(r).not.toHaveProperty('skippedSecrets')
    expect(await e.store.get('mem_r')).toBeUndefined()
  })
})

describe('同 id 在两个项目里各有一份', () => {
  // 页面按项目列记忆：用户在 OTHER 项目下点的那一份，即使借来的会话属于 SESSION 项目，也只动 OTHER 的副本
  const other = { kind: 'workspace', workspacePath: OTHER_WS } as const
  const own = { kind: 'workspace', workspacePath: SESSION_WS } as const
  const seedCopies = async (e: ReturnType<typeof env>, content = '内容') => {
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', content, scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', content, scope: 'workspace', workspacePath: OTHER_WS }))
  }
  /** 直接读那一层的目录（含 .archive/），不经同 id 取舍。 */
  const copyIn = async (e: ReturnType<typeof env>, ws: string | undefined) =>
    (await e.store.readRaw(ws === undefined ? { kind: 'global' } : { kind: 'workspace', workspacePath: ws }, { includeArchive: true }))
      .records.find(l => l.record.id === 'mem_dup')?.record

  it('forget 指明别的项目：先要 allowCrossWorkspace，带上后只软删那一份', async () => {
    const e = env()
    await seedCopies(e)
    const body = err(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: other }))
    expect(body).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_dup', workspacePath: OTHER_WS }] })
    expect((await copyIn(e, OTHER_WS))!.status).toBe('active')
    expect((await copyIn(e, SESSION_WS))!.status).toBe('active')

    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true }))
    expect((await copyIn(e, OTHER_WS))!.status).toBe('deleted')
    expect((await copyIn(e, SESSION_WS))!.status).toBe('active')
  })

  it('forget 指明会话自己的项目：不用确认，只动这一份', async () => {
    const e = env()
    await seedCopies(e)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: own }))
    expect((await copyIn(e, SESSION_WS))!.status).toBe('deleted')
    expect((await copyIn(e, OTHER_WS))!.status).toBe('active')
  })

  it('restore 指明别的项目：恢复那一份（要 allowCrossWorkspace），会话项目里活着的那份不碰', async () => {
    const e = env()
    await seedCopies(e)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true }))
    const live = await copyIn(e, SESSION_WS)

    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_dup', layer: other })).code).toBe('cross-workspace')
    expect((await copyIn(e, OTHER_WS))!.status).toBe('deleted')
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true }))
    expect((await copyIn(e, OTHER_WS))!.status).toBe('active')
    expect(await copyIn(e, SESSION_WS)).toEqual(live)
  })

  it('hard-delete 指明别的项目：先要 allowCrossWorkspace，带上后只物理删除那一份', async () => {
    const e = env()
    await seedCopies(e, `token ${FAKE_SECRET.sk}`)
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true })).code).toBe('has-secret')
    expect(err(await e.run({ cmd: 'hard-delete', memoryId: 'mem_dup', layer: other })).code).toBe('cross-workspace')
    expect(await copyIn(e, OTHER_WS)).toBeDefined()

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true }))
    expect(await copyIn(e, OTHER_WS)).toBeUndefined()
    expect((await copyIn(e, SESSION_WS))!.status).toBe('active')
  })

  it('forget 指明一份：账本里指向这个 id 的条目留着（别的项目那份还在），哪层都只剩这一份时才清', async () => {
    const e = env()
    await seedCopies(e)
    await e.store.create(record({ id: 'mem_y', scope: 'workspace', workspacePath: OTHER_WS }))
    const entry = (await e.decisions.upsert({ memoryIds: ['mem_dup', 'mem_y'], summary: '别的项目那份的冲突', fingerprint: 'fp-dup', workspaces: [OTHER_WS, OTHER_WS] }, 1)).entry
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: own }))
    expect(await allEntries(e)).toEqual([entry])

    // 只此一份的：照旧清掉指向它的条目
    await e.store.create(record({ id: 'mem_solo', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.decisions.upsert({ memoryIds: ['mem_solo', 'mem_y'], summary: '只此一份', fingerprint: 'fp-solo' }, 1)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_solo', layer: own }))
    expect(await allEntries(e)).toEqual([entry])
  })

  it('forget 指明一份：别的项目那份只在最近删除里，同样算还有副本，账本里指向这个 id 的条目留着', async () => {
    const e = env()
    await seedCopies(e)
    expect(await e.store.softDelete({ id: 'mem_dup', workspacePath: OTHER_WS }, { at: scopeAt(OTHER_WS), now: e.clock.now })).toBe(true)
    await e.store.create(record({ id: 'mem_y', scope: 'workspace', workspacePath: SESSION_WS }))
    const entry = (await e.decisions.upsert({ memoryIds: ['mem_dup', 'mem_y'], summary: '同 id 的冲突', fingerprint: 'fp-dup' }, 1)).entry
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: own }))
    expect((await copyIn(e, OTHER_WS))!.status).toBe('deleted')
    expect(await allEntries(e)).toEqual([entry])
  })

  it('forget 指明一份：路径只差末尾分隔符的另一个目录也是别处的副本，账本里指向这个 id 的条目留着', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_dup', scope: 'workspace', workspacePath: `${SESSION_WS}/` }))
    await e.store.create(record({ id: 'mem_y', scope: 'workspace', workspacePath: SESSION_WS }))
    const entry = (await e.decisions.upsert({ memoryIds: ['mem_dup', 'mem_y'], summary: '同 id 的冲突', fingerprint: 'fp-dup' }, 1)).entry
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: own }))
    expect((await copyIn(e, `${SESSION_WS}/`))!.status).toBe('active')
    expect(await allEntries(e)).toEqual([entry])
  })

  it('hard-delete 指明含密钥的一份：只脱敏这一层在快照里的副本，别的项目那份的快照照常能恢复', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', content: `token ${FAKE_SECRET.sk}`, scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', content: '普通内容', scope: 'workspace', workspacePath: OTHER_WS }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true }))
    const snap = (await e.snapshots.list())[0]!
    expect(snap.data[0]).toMatchObject({ name: '别的项目那份', workspacePath: OTHER_WS })

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_dup', layer: own }))
    expect(await copyIn(e, SESSION_WS)).toBeUndefined()
    expect((await e.snapshots.get(snap.id))!.data[0]).toMatchObject({ name: '别的项目那份', content: '普通内容' })
    expect((await e.snapshots.get(snap.id))!.data[0]!.redacted).toBeUndefined()
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true }))
    expect(await copyIn(e, OTHER_WS)).toMatchObject({ name: '别的项目那份', status: 'active' })
  })

  it('指明的那一层没有这个 id：not-found，不落到别的副本上', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', scope: 'workspace', workspacePath: SESSION_WS }))
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: other, allowCrossWorkspace: true })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: { kind: 'global' } })).code).toBe('not-found')
    expect((await copyIn(e, SESSION_WS))!.status).toBe('active')
  })

  it('指明全局：动全局那一份，项目里的同 id 副本不碰；恢复同理', async () => {
    const e = env()
    // 先建项目那份：写全局那份只清全局目录里的同 id 副本，反过来会把全局那份清掉
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', scope: 'workspace', workspacePath: OTHER_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '全局那份' }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: { kind: 'global' } }))
    expect((await copyIn(e, undefined))!.status).toBe('deleted')
    expect((await copyIn(e, OTHER_WS))!.status).toBe('active')
    // 视图：项目那份照常在全部记忆里，删掉的全局那份在最近删除里（页面据它的层恢复）
    const library = libraryViewSchema.parse(await e.readView('library'))
    expect(library.layers.map(l => [l.layer, l.items.map(m => m.name)])).toEqual([
      [{ kind: 'global' }, []], [{ kind: 'workspace', workspacePath: OTHER_WS }, ['别的项目那份']],
    ])
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => [i.memory.name, i.memory.scope])).toEqual([['全局那份', 'global']])
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_dup', layer: { kind: 'global' } }))
    expect((await copyIn(e, undefined))!.status).toBe('active')
    expect((await copyIn(e, OTHER_WS))!.status).toBe('active')
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })
})

describe('搬层之后按层硬删含密钥的记忆：搬层之前的快照也脱敏', () => {
  // 提升、移到项目后原层已没有这个 id：快照里原层那份是这条记忆自己的历史，不是别层副本的
  const expectAllRedacted = async (e: ReturnType<typeof env>, id: string) => {
    const hits = (await e.snapshots.list()).flatMap(s => s.data.filter(r => r.id === id).map(r => [s.operation, r.redacted === true, JSON.stringify(r).includes(FAKE_SECRET.sk)]))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    for (const [operation, isRedacted, hasPlain] of hits) expect([operation, isRedacted, hasPlain]).toEqual([operation, true, false])
  }

  it('提升到全局后在全局那份上硬删：提升前（项目层）的快照记录也脱敏', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_ps', name: '部署凭证', content: `token ${FAKE_SECRET.sk}`, scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'promote-memory', memoryId: 'mem_ps', layer: { kind: 'workspace', workspacePath: SESSION_WS } }))
    expect((await e.store.get('mem_ps'))!.scope).toBe('global')
    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_ps', layer: { kind: 'global' } }))
    expect(await e.store.get('mem_ps')).toBeUndefined()
    await expectAllRedacted(e, 'mem_ps')
  })

  it('移到项目后在项目那份上硬删：移动前（全局层）的快照记录也脱敏', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_ms', name: '部署凭证', content: `token ${FAKE_SECRET.sk}` }))
    ok(await e.run({ cmd: 'move-memory', memoryId: 'mem_ms', workspacePath: SESSION_WS }))
    expect((await e.store.get('mem_ms'))!.scope).toBe('workspace')
    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_ms', layer: { kind: 'workspace', workspacePath: SESSION_WS } }))
    expect(await e.store.get('mem_ms')).toBeUndefined()
    await expectAllRedacted(e, 'mem_ms')
  })
})

describe('最近删除：同层在用副本遮住的已删副本', () => {
  it('不列同层还有在用副本的已删副本（恢复定位到的是在用那份）；别层的已删副本照常列出，按它的层恢复', async () => {
    const e = env()
    const wsDir = join(root, workspaceDirName(SESSION_WS))
    // 先建项目那份：写全局那份只清全局目录里的同 id 副本
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '全局那份' }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: { kind: 'global' } }))
    // 本项目归档里还躺着一份更新的已删副本（手工拷进去的旧文件）
    const stale = record({ id: 'mem_dup', name: '本项目旧副本', scope: 'workspace', workspacePath: SESSION_WS, status: 'deleted', deletedAt: Date.now() + 60_000, updatedAt: Date.now() + 60_000 })
    await mkdir(join(wsDir, ARCHIVE_DIR), { recursive: true })
    await writeFile(join(wsDir, ARCHIVE_DIR, 'stale.md'), encodeRecord(stale, {}))
    ok(await e.run({ cmd: 'refresh-views' }))

    const items = deletedViewSchema.parse(await e.readView('deleted')).items
    expect(items.map(i => [i.memory.name, i.memory.scope])).toEqual([['全局那份', 'global']])
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_dup', layer: scopeOfMemory(items[0]!.memory) }))
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

  it('两个别层各有一份已删副本：最近删除里同一个 id 只列一份（页面按 id 作列表键）', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '别的项目那份', scope: 'workspace', workspacePath: OTHER_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '全局那份' }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: { kind: 'workspace', workspacePath: SESSION_WS } }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: { kind: 'workspace', workspacePath: OTHER_WS }, allowCrossWorkspace: true }))
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => i.memory.id)).toEqual(['mem_dup'])
  })
})

describe('同 id 在本项目和全局各有一份、全局那份更新', () => {
  // 页面在本项目层下列出的那一份：即使全局副本更新、按会话定位会取到全局那份，带了层也只动本项目这一份
  const own = { kind: 'workspace', workspacePath: SESSION_WS } as const
  const newer = Date.now() + 60_000
  const layerCopy = async (e: ReturnType<typeof env>, ws: string | undefined) =>
    (await e.store.readRaw(ws === undefined ? { kind: 'global' } : { kind: 'workspace', workspacePath: ws }, { includeArchive: true }))
      .records.find(l => l.record.id === 'mem_dup')?.record
  const seed = async (e: ReturnType<typeof env>, content = '内容', globalUpdatedAt = newer) => {
    // 先建项目那份：写全局那份只清全局目录里的同 id 副本
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', content, scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_dup', name: '全局那份', content, updatedAt: globalUpdatedAt }))
  }
  /** 全局那份还活着，且全部记忆视图的全局层照样列着它（用户没点它，不能跟着没了）。 */
  const expectGlobalLive = async (e: ReturnType<typeof env>) => {
    expect(await layerCopy(e, undefined)).toMatchObject({ name: '全局那份', status: 'active' })
    const library = libraryViewSchema.parse(await e.readView('library'))
    expect(library.layers.find(l => l.layer.kind === 'global')!.items.map(i => i.id)).toContain('mem_dup')
  }

  it('forget 带本项目的层：软删本项目那份', async () => {
    const e = env()
    await seed(e)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: own }))
    expect((await layerCopy(e, SESSION_WS))!.status).toBe('deleted')
    await expectGlobalLive(e)
  })

  it('restore 带本项目的层：恢复本项目那份，不拿更新的全局副本比对或覆盖', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: own }))
    await e.store.create(record({ id: 'mem_dup', name: '全局那份', updatedAt: newer }))
    const restored = ok(await e.run({ cmd: 'restore', memoryId: 'mem_dup', layer: own }))
    expect(restored.memoryIds).toEqual(['mem_dup'])
    expect(await layerCopy(e, SESSION_WS)).toMatchObject({ name: '本项目那份', status: 'active' })
    await expectGlobalLive(e)
  })

  it('hard-delete 带本项目的层：物理删除本项目那份', async () => {
    const e = env()
    await seed(e, `token ${FAKE_SECRET.sk}`)
    await e.store.markRecalled(['mem_dup'])
    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_dup', layer: own }))
    expect(await layerCopy(e, SESSION_WS)).toBeUndefined()
    await expectGlobalLive(e)
    // 召回统计按 id 一行：全局那份还在用，这一行留给它
    expect(await e.stats.get('mem_dup')).toMatchObject({ recallCount: 1 })
  })

  it('不带层时照旧按会话定位：取到更新的全局那份', async () => {
    const e = env()
    await seed(e)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup' }))
    expect((await layerCopy(e, undefined))!.status).toBe('deleted')
    expect((await layerCopy(e, SESSION_WS))!.status).toBe('active')
  })

  it('不带层时可见集合去重照旧：删本项目那份（同龄时本项目优先），全局的同 id 副本一并清掉', async () => {
    const e = env()
    await seed(e, '内容', 1)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup' }))
    expect((await layerCopy(e, SESSION_WS))!.status).toBe('deleted')
    expect(await layerCopy(e, undefined)).toBeUndefined()
  })
})

describe('hard-delete', () => {
  it('含密钥的记忆物理删除：文件没了、不进最近删除', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_s', content: `token ${FAKE_SECRET.sk}` }))
    const body = ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_s' }))
    expect(body.memoryIds).toEqual(['mem_s'])
    expect(await e.store.get('mem_s')).toBeUndefined()
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

  it('既有快照里这条记忆的副本一律换成脱敏占位（不可恢复），同快照的其他记录不动；盘上不留明文', async () => {
    const e = env()
    const secret = record({ id: 'mem_s', name: '部署凭证', content: `token ${FAKE_SECRET.sk}` })
    const other = record({ id: 'mem_o', name: '旁人', content: '用 pnpm' })
    await e.store.create(secret)
    await e.store.create(other)
    const both = await e.snapshots.capture({ operation: 'manual', description: '两条', records: [secret, other] }, NOW - 3)
    const alone = await e.snapshots.capture({ operation: 'pre-update', description: '只有它', records: [secret] }, NOW - 2)
    const unrelated = await e.snapshots.capture({ operation: 'manual', description: '无关', records: [other] }, NOW - 1)

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_s' }))
    const byId = new Map((await e.snapshots.list()).map(s => [s.id, s]))
    for (const id of [both.id, alone.id]) {
      const copy = byId.get(id)!.data.find(r => r.id === 'mem_s')!
      expect(copy).toMatchObject({ redacted: true, content: REDACTED_PLACEHOLDER })
    }
    expect(byId.get(both.id)!.data.find(r => r.id === 'mem_o')).toEqual(other)
    expect(byId.get(unrelated.id)!.data).toEqual([other])
    // 删除前那份 pre-forget 快照也只存脱敏副本
    const preForget = [...byId.values()].find(s => s.operation === 'pre-forget')!
    expect(preForget.data).toEqual([expect.objectContaining({ id: 'mem_s', redacted: true, content: REDACTED_PLACEHOLDER })])
    const snapDir = join(root, STATE_DIR, 'snapshots')
    for (const file of await readdir(snapDir)) expect(await readFile(join(snapDir, file), 'utf8')).not.toContain(FAKE_SECRET.sk)
    // 不能从快照恢复回来
    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_s' })).code).toBe('not-found')
  })

  it('不含密钥的记忆不走硬删：failed，什么都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_plain' }))
    expect(err(await e.run({ cmd: 'hard-delete', memoryId: 'mem_plain' })).code).toBe('failed')
    expect((await e.store.get('mem_plain'))!.status).toBe('active')
  })
})

describe('最近删除里彻底删除', () => {
  // 不等 14 天到期：归档文件、召回统计行、快照里的副本现在就清掉，之后撤销、恢复都找不回来
  const own = { kind: 'workspace', workspacePath: SESSION_WS } as const
  const other = { kind: 'workspace', workspacePath: OTHER_WS } as const
  const snapshotIds = async (e: ReturnType<typeof env>, id: string) =>
    (await e.snapshots.list()).filter(s => s.data.some(r => r.id === id)).map(s => s.id)
  /** 记忆目录下所有文件（含 .state/ 侧表、视图）的原文里都找不到这段文字。 */
  const expectNowhereOnDisk = async (text: string) => {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      expect(await readFile(path, 'utf8'), path).not.toContain(text)
    }
  }

  it('forget 删掉的记忆：文件、召回统计行、所有快照里的副本都没了；同快照里的别的记录不动', async () => {
    const e = env()
    const target = record({ id: 'mem_p', name: '要抹掉的', content: '紫藤架下的旧约定', scope: 'workspace', workspacePath: SESSION_WS })
    const bystander = record({ id: 'mem_o', name: '旁人', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS })
    await e.store.create(target)
    await e.store.create(bystander)
    await e.store.markRecalled(['mem_p', 'mem_o'])
    const both = await e.snapshots.capture({ operation: 'manual', description: '两条', records: [target, bystander] }, NOW - 1)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_p', layer: own }))
    expect(await snapshotIds(e, 'mem_p')).toHaveLength(2)
    expect(await e.stats.get('mem_p')).toBeDefined()

    const body = ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_p', layer: own }))
    expect(body.memoryIds).toEqual(['mem_p'])
    expect(await e.store.get('mem_p')).toBeUndefined()
    expect(await e.stats.get('mem_p')).toBeUndefined()
    expect(await snapshotIds(e, 'mem_p')).toEqual([])
    // forget 那份快照只有它，空了整份删掉；两条的那份只剩旁人
    expect((await e.snapshots.list()).map(s => [s.id, s.memoryIds, s.data])).toEqual([[both.id, ['mem_o'], [bystander]]])
    expect(await e.stats.get('mem_o')).toBeDefined()
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
    await expectNowhereOnDisk('紫藤架下的旧约定')
  })

  it('之后恢复、按快照恢复都找不回来', async () => {
    const e = env()
    const target = record({ id: 'mem_p', content: '紫藤架下的旧约定', scope: 'workspace', workspacePath: SESSION_WS })
    await e.store.create(target)
    const manual = await e.snapshots.capture({ operation: 'manual', description: '手动', records: [target, record({ id: 'mem_o' })] }, NOW - 1)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_p', layer: own }))
    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_p', layer: own }))

    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_p', layer: own })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_p' })).code).toBe('not-found')
    const r = await executeSnapshotTool({ action: 'restore', snapshotId: manual.id, memoryIds: ['mem_p'] }, { workspacePath: SESSION_WS }, { store: e.store, snapshots: e.snapshots, now: () => NOW })
    expect(r).toMatchObject({ kind: 'restored', restored: [] })
    expect(await e.store.get('mem_p')).toBeUndefined()
  })

  it('裁决删掉的：彻底删除后撤销裁决按找不到处理，账本条目一并清掉', async () => {
    const e = env()
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => [i.memory.id, i.cause?.decisionId])).toEqual([['mem_b', entry.id]])

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_b', layer: { kind: 'global' } }))
    expect(await allEntries(e)).toEqual([])
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_b' })).code).toBe('not-found')
    expect(await e.store.get('mem_b')).toBeUndefined()
    expect(await snapshotIds(e, 'mem_b')).toEqual([])
    expect((await e.store.get('mem_a'))!.status).toBe('active')
  })

  it('同一份快照里的别的记忆：撤销条目留着，只清指向被抹那条的', async () => {
    // 一次保存改写 T、同时替代 R1、R2：三条拍进同一份快照，各记一条撤销条目
    const e = env()
    const t = record({ id: 'mem_t', name: '改写的', content: '新说法' })
    const r1 = record({ id: 'mem_r1', name: '被替代一', content: '旧说法一' })
    const r2 = record({ id: 'mem_r2', name: '被替代二', content: '旧说法二' })
    for (const r of [t, r1, r2]) await e.store.create(r)
    const snap = await e.snapshots.capture({ operation: 'pre-update', description: '保存前', records: [t, r1, r2] }, NOW - 1)
    const settled = async (id: string, kind: 'rewrite' | 'supersede') =>
      e.decisions.addSettled({ kind, memoryIds: [id], summary: id, workspaces: ['global'], fingerprint: `fp-${id}` }, kind === 'rewrite' ? 'rewritten' : 'superseded', NOW - 1, { snapshotId: snap.id })
    const [et, er1, er2] = [await settled('mem_t', 'rewrite'), await settled('mem_r1', 'supersede'), await settled('mem_r2', 'supersede')]
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_r1', layer: { kind: 'global' } }))

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_r1', layer: { kind: 'global' } }))
    const left = (await e.decisions.listSettled()).map(d => d.id)
    expect(left).toContain(et.id)
    expect(left).toContain(er2.id)
    expect(left).not.toContain(er1.id)
    expect((await e.snapshots.list()).find(s => s.id === snap.id)?.memoryIds.sort()).toEqual(['mem_r2', 'mem_t'])
  })

  it('同 id 另一层仍在用的副本不受影响：文件、内容、它在快照里的副本都在；不带层时不会落到它头上', async () => {
    const e = env()
    const layerCopy = async (ws: string | undefined) =>
      (await e.store.readRaw(ws === undefined ? { kind: 'global' } : { kind: 'workspace', workspacePath: ws }, { includeArchive: true }))
        .records.find(l => l.record.id === 'mem_dup')?.record
    const ownCopy = record({ id: 'mem_dup', name: '本项目那份', content: '紫藤架下的旧约定', scope: 'workspace', workspacePath: SESSION_WS })
    await e.store.create(ownCopy)
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_dup', layer: own }))
    // 先删本项目那份再建全局那份：写全局那份只清全局目录里的同 id 副本
    const globalCopy = record({ id: 'mem_dup', name: '全局那份', content: '全局里的说法' })
    await e.store.create(globalCopy)
    const globalSnap = await e.snapshots.capture({ operation: 'manual', description: '全局那份', records: [globalCopy] }, NOW - 1)
    await e.store.markRecalled(['mem_dup'])
    const live = await layerCopy(undefined)
    expect(live).toMatchObject({ status: 'active', recallCount: 1 })

    // 不带层按会话定位取到在用的全局那份：它不含密钥，不动
    expect(err(await e.run({ cmd: 'hard-delete', memoryId: 'mem_dup' })).code).toBe('failed')
    expect(await layerCopy(SESSION_WS)).toMatchObject({ status: 'deleted' })

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_dup', layer: own }))
    expect(await layerCopy(SESSION_WS)).toBeUndefined()
    expect(await layerCopy(undefined)).toEqual(live)
    expect(await e.stats.get('mem_dup')).toMatchObject({ recallCount: 1 })
    const copies = (await e.snapshots.list()).flatMap(s => s.data.filter(r => r.id === 'mem_dup').map(r => [s.id, r.scope]))
    expect(copies).toEqual([[globalSnap.id, 'global']])
    const library = libraryViewSchema.parse(await e.readView('library'))
    expect(library.layers.find(l => l.layer.kind === 'global')!.items.map(i => i.name)).toEqual(['全局那份'])
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

  it('定位之后、物理删除之前被别处恢复：不删，failed 说明刚被恢复，恢复的那份照旧在用', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_p', content: '紫藤架下的旧约定', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_p', layer: own }))
    // 抹快照落在定位与物理删除之间：借它插入另一个标签页的恢复
    const purge = e.snapshots.purge.bind(e.snapshots)
    e.snapshots.purge = async isPurged => {
      await purge(isPurged)
      expect(await e.store.restoreArchived({ id: 'mem_p', workspacePath: SESSION_WS }, { at: scopeAt(SESSION_WS), now: e.clock.now })).toBe(true)
    }
    const body = err(await e.run({ cmd: 'hard-delete', memoryId: 'mem_p', layer: own }))
    expect(body.code).toBe('failed')
    expect(body.detail).toContain('刚被恢复')
    expect(await e.store.get('mem_p', { workspacePath: SESSION_WS })).toMatchObject({ status: 'active', content: '紫藤架下的旧约定' })
  })

  it('快照已抹、物理删除失败：裁决条目已一并清掉，再恢复只是普通恢复，不说冲突会回到待处理', async () => {
    const e = env()
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    // 归档目录只读：归档文件删不掉
    const archive = join(root, GLOBAL_DIR, ARCHIVE_DIR)
    await chmod(archive, 0o500)
    try {
      expect(err(await e.run({ cmd: 'hard-delete', memoryId: 'mem_b', layer: { kind: 'global' } }))).toMatchObject({ code: 'failed', detail: expect.stringContaining('EACCES') })
    } finally {
      await chmod(archive, 0o700)
    }
    expect(await snapshotIds(e, 'mem_b')).toEqual([])
    expect(await allEntries(e)).toEqual([])
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => [i.memory.id, i.cause])).toEqual([['mem_b', undefined]])

    const restored = ok(await e.run({ cmd: 'restore', memoryId: 'mem_b', layer: { kind: 'global' } }))
    expect(restored.decisionId).toBeUndefined()
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect(await allEntries(e)).toEqual([])
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('not-found')
  })

  it('别的项目里的：先要 allowCrossWorkspace，什么都不动；带上才彻底删除', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_far', scope: 'workspace', workspacePath: OTHER_WS }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_far', layer: other, allowCrossWorkspace: true }))
    const body = err(await e.run({ cmd: 'hard-delete', memoryId: 'mem_far', layer: other }))
    expect(body).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_far', workspacePath: OTHER_WS }] })
    expect((await e.store.get('mem_far', { workspacePath: OTHER_WS }))!.status).toBe('deleted')
    expect(await snapshotIds(e, 'mem_far')).toHaveLength(1)

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_far', layer: other, allowCrossWorkspace: true }))
    expect(await e.store.get('mem_far')).toBeUndefined()
    expect(await snapshotIds(e, 'mem_far')).toEqual([])
  })
})