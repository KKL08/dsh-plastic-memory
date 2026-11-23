import { describe, it, expect, vi, afterEach } from 'vitest'
import { basename } from 'node:path'
import { env, ok, SESSION_WS as WS } from './helpers/gui-command-env.ts'
import { SNAPSHOT_RETENTION_MS } from '../src/governance/snapshots.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { locateCopy } from '../src/tools/workspace-gate.ts'
import { scopeAt } from '../src/scope.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 恢复读完快照、还没逐条写回时，彻底删除整个插进来，而且快照整份不在了（被清空删掉，或刚好过期被清扫）。
// 恢复不能按开头读到的内容写回：写回会清掉全局同 id 的独立副本，删掉的密钥也会回到项目里。
// 停点放在文件读取的边界上：快照文件第几次被读完时停住，等测试放行。

const pause = vi.hoisted(() => ({ afterRead: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const value = await fs.readFile(...args)
      await pause.afterRead?.(String(args[0]))
      return value
    },
  }
})

afterEach(() => { pause.afterRead = undefined })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const GLOBAL_CONTENT = '全局那份独立的内容'

/** 项目里一条带密钥的记忆、全局同 id 的独立副本、一份只含项目那条的快照；恢复读完快照（第 3 次读快照文件）后停住，这时在界面上彻底删除项目那条。 */
async function restoreWithHardDeleteBetween(opts: { snapshotAge: number; isSoftDeletedFirst: boolean }) {
  const t = Date.now()
  const e = env({ now: t })
  const rec = record({ id: 'mem_a', name: 'project', scope: 'workspace', workspacePath: WS, content: FAKE_SECRET.sk, updatedAt: t, createdAt: t })
  await e.store.create(rec)
  await e.store.create({ ...rec, scope: 'global', workspacePath: undefined, name: 'global', content: GLOBAL_CONTENT })
  const snap = await e.snapshots.capture({ operation: 'manual', description: '恢复点', records: [rec] }, t - opts.snapshotAge)
  if (opts.isSoftDeletedFirst) await e.store.softDelete(rec, { at: scopeAt(WS), now: t })
  let reads = 0
  const paused = deferred()
  const resume = deferred()
  pause.afterRead = async path => {
    if (basename(path) !== `${snap.id}.json` || ++reads !== 3) return
    paused.resolve()
    await resume.promise
  }
  const restoring = executeSnapshotTool({ action: 'restore', snapshotId: snap.id, overwriteChanged: true }, { workspacePath: WS }, { ...e, now: () => e.clock.now })
  await paused.promise
  pause.afterRead = undefined
  e.clock.now = t + 2
  ok(await e.run({ cmd: 'hard-delete', memoryId: rec.id, layer: scopeAt(WS) }))
  const isSnapshotLeft = (await e.snapshots.get(snap.id)) !== undefined
  resume.resolve()
  const result = await restoring
  return {
    isSnapshotLeft,
    result: result.kind === 'restored' ? result.restored : result.kind,
    project: (await locateCopy(e.store, rec.id, scopeAt(WS)))?.content,
    global: (await locateCopy(e.store, rec.id, scopeAt(undefined)))?.content,
  }
}

describe('恢复读完快照后，彻底删除插进来、整份快照随之不在', () => {
  it('彻底删除最近删除里的这条，快照被清空删掉：没写回的跳过，全局独立副本留着', async () => {
    const r = await restoreWithHardDeleteBetween({ snapshotAge: 0, isSoftDeletedFirst: true })
    expect(r).toEqual({ isSnapshotLeft: false, result: [], project: undefined, global: GLOBAL_CONTENT })
  })

  it('快照恢复途中刚过保留期，密钥硬删前清扫掉它：删掉的密钥不回到项目，全局独立副本留着', async () => {
    const r = await restoreWithHardDeleteBetween({ snapshotAge: SNAPSHOT_RETENTION_MS - 1, isSoftDeletedFirst: false })
    expect(r).toEqual({ isSnapshotLeft: false, result: [], project: undefined, global: GLOBAL_CONTENT })
  })

  it('对照：快照还在、里面这条已脱敏：跳过，全局独立副本留着', async () => {
    const r = await restoreWithHardDeleteBetween({ snapshotAge: 0, isSoftDeletedFirst: false })
    expect(r).toEqual({ isSnapshotLeft: true, result: [], project: undefined, global: GLOBAL_CONTENT })
  })
})
