import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { FileVersionHistory, STATE_CHANGE_VERSION, type HistoryVersion } from '../src/storage/history.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, HISTORY_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { commitChange } from '../src/commit-change.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executePromote } from '../src/tools/promote.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { scopeAt } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'

// 历史版本跟着记忆走：软删、恢复、取代不动；彻底删除、到期清扫、密钥硬删连目录一起删；提升、移到项目、撤销搬家随迁；
// 整份核对时，记忆已不在这一层的历史目录先按 id 到各处找，找到就迁过去，找不到才清。真实临时目录上的文件表和侧表。

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const WS = '/tmp/pm-history-lifecycle'
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const GLOBAL = { kind: 'global' } as const

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-history-lifecycle-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function env() {
  const clock = { now: T0 }
  const now = () => clock.now
  const sidecar = new SidecarStore({ root, log: quiet, now, schemas: sidecarSchemas })
  const table = new FileTable({ root, stats: sidecar.recallStats, log: quiet, now })
  const store = new MemoryStore(table, quiet, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending, sidecar.lock)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  return { clock, now, table, store, decisions, snapshots, ignores }
}
type Env = ReturnType<typeof env>

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = () => join(root, workspaceDirName(WS))
const historyDir = (dir: string, id: string) => join(dir, HISTORY_DIR, encodeURIComponent(id))
const exists = (path: string) => stat(path).then(() => true, () => false)
/** 这一层里这条记忆的历史版本，按改前正文列出。 */
const versionsIn = async (e: Env, dir: string, id: string) => (await e.store.history.list({ dir, loc: { scope: 'global' } }, id)).map(v => v.record.content)

/** 建一条记忆，再做一次状态变化：它的历史里有一版（改前正文「第一版」）。 */
async function withVersion(e: Env, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const made = record({ name: '部署方式', content: '第一版', createdAt: T0, updatedAt: T0, ...partial })
  await e.store.create(made)
  e.clock.now += MINUTE
  const target = (await e.store.get(made.id, scopeAt(made.workspacePath)))!
  const r = await commitChange({ target, kind: 'state-change', fields: { content: partial.content === undefined ? '第二版' : `${partial.content}（新）` }, by: 'main', sessionId: 's1', reason: '换了', at: e.clock.now }, e)
  if (r.kind !== 'written') throw new Error(JSON.stringify(r))
  return r.record
}

const inWs = { scope: 'workspace', workspacePath: WS } as const

/** 模拟旧版本搬家只搬记忆文件：把已经跟过去的历史目录挪回原来那一层。 */
async function leaveBehind(fromDir: string, toDir: string, id: string) {
  await mkdir(join(toDir, HISTORY_DIR), { recursive: true })
  await rename(historyDir(fromDir, id), historyDir(toDir, id))
}

/** 把一条记忆从项目移到全局，再把历史目录挪回项目：记忆在全局，它以前那一层还留着历史。 */
async function movedToGlobalLeavingHistory(e: Env, m: MemoryRecord): Promise<MemoryRecord> {
  const moved = await e.store.update(m, ({ workspacePath: _w, ...cur }) => ({ ...cur, scope: 'global' }), scopeAt(WS))
  await leaveBehind(globalDir(), wsDir(), m.id)
  return moved
}

/** 让一个历史目录删不掉：里面放一个不可读的子目录。返回恢复权限的函数。 */
async function unremovable(dir: string): Promise<() => Promise<void>> {
  const locked = join(dir, 'locked')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'x'), '')
  await chmod(locked, 0)
  return () => chmod(locked, 0o700)
}

describe('留在原处的几种', () => {
  it('软删进最近删除、再从最近删除恢复：历史目录都留在原处不动', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    expect(await e.store.softDelete(m, { now: e.now() })).toBe(true)
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
    expect(await e.store.restoreArchived(m, { now: e.now() })).toBe(true)
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('被别的记忆取代：历史目录跟着被取代的那条留在原处', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await e.store.update(m, r => ({ ...r, status: 'superseded' }))
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })
})

describe('物理删除连目录一起删', () => {
  it('最近删除里的彻底删除：这条记忆的整个历史目录删掉，别的记忆的历史不动', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const other = await withVersion(e, { ...inWs, name: '别的', content: '旁边那条' })
    await e.store.softDelete(m, { now: e.now() })
    expect(await e.store.hardDelete(m, { at: scopeAt(WS) })).toBe(true)
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
    expect(await versionsIn(e, wsDir(), other.id)).toEqual(['旁边那条'])
  })

  it('最近删除过了保留期被清扫：历史目录一起删', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await e.store.softDelete(m, { now: e.now() })
    e.clock.now += RETENTION_MS + MINUTE
    await e.store.maintain(scopeAt(WS))
    expect(await e.store.get(m.id, scopeAt(WS))).toBeUndefined()
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  it('还没到期的最近删除，清扫时历史目录留着', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await e.store.softDelete(m, { now: e.now() })
    e.clock.now += RETENTION_MS - MINUTE
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('含密钥的记忆被遗忘：先把快照里的明文换成脱敏副本，再删它在各层的历史目录（含以前住过的那层），最后删记忆文件', async () => {
    const e = env()
    const m = await withVersion(e, { ...inWs, content: `连接串 ${FAKE_SECRET.sk}` })
    expect((await versionsIn(e, wsDir(), m.id))[0]).toContain(FAKE_SECRET.sk)
    // 旧版本把它搬到全局时历史留在了项目；到了全局又改过一次，全局那层也有一版
    const moved = await movedToGlobalLeavingHistory(e, m)
    e.clock.now += MINUTE
    const r2 = await commitChange({ target: (await e.store.get(m.id, GLOBAL))!, kind: 'state-change', fields: { content: `连接串 ${FAKE_SECRET.sk}（第三版）` }, by: 'main', sessionId: 's1', reason: '又换了', at: e.clock.now }, e)
    expect(r2.kind).toBe('written')
    expect((await versionsIn(e, globalDir(), m.id))[0]).toContain(FAKE_SECRET.sk)
    expect(moved.scope).toBe('global')
    const filePath = (await e.store.locate(m.id, GLOBAL))!.filePath
    const order: string[] = []
    const redact = e.snapshots.redact.bind(e.snapshots)
    vi.spyOn(e.snapshots, 'redact').mockImplementation(async (ids, isCopy) => {
      await redact(ids, isCopy)
      order.push('快照脱敏')
    })
    const removeAll = e.table.history.removeAll.bind(e.table.history)
    vi.spyOn(e.table.history, 'removeAll').mockImplementation(async (dir, id) => {
      order.push(`删历史时记忆文件${(await exists(filePath)) ? '还在' : '已删'}`)
      await removeAll(dir, id)
    })
    const r = await executeForget({ ids: [m.id], reason: '含密钥' }, { workspacePath: WS }, e)
    expect(r.hardDeleted).toEqual([m.id])
    // 全局和以前住过的项目各删一次，都在记忆文件删掉之前
    expect(order.slice(0, 3)).toEqual(['快照脱敏', '删历史时记忆文件还在', '删历史时记忆文件还在'])
    for (const dir of [globalDir(), wsDir()]) expect(await readdir(join(dir, HISTORY_DIR)), dir).toEqual([])
    expect(await exists(filePath)).toBe(false)
    expect(JSON.stringify(await e.snapshots.list())).not.toContain(FAKE_SECRET.sk)
  })

  it('以前住过的那层里有同 id 的另一条记忆：那层的历史是那一条的，不动', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const moved = await movedToGlobalLeavingHistory(e, m)
    await e.store.create(record({ id: m.id, name: '项目里同 id 的另一条', ...inWs }))
    await e.store.softDelete(moved, { at: GLOBAL, now: e.now() })
    expect(await e.store.hardDelete(moved, { at: GLOBAL })).toBe(true)
    expect(await e.store.get(m.id, GLOBAL)).toBeUndefined()
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('有历史目录删不掉：彻底删除报错，记忆文件还在', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const moved = await movedToGlobalLeavingHistory(e, m)
    await e.store.softDelete(moved, { at: GLOBAL, now: e.now() })
    const filePath = (await e.store.locate(m.id, GLOBAL))!.filePath
    const restore = await unremovable(historyDir(wsDir(), m.id))
    try {
      await expect(e.store.hardDelete(moved, { at: GLOBAL })).rejects.toThrow()
      expect(await exists(filePath)).toBe(true)
    } finally {
      await restore()
    }
  })

  it('记忆根目录列不出来、分不出它以前住过哪些层：彻底删除报错，记忆文件还在', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const moved = await movedToGlobalLeavingHistory(e, m)
    await e.store.softDelete(moved, { at: GLOBAL, now: e.now() })
    const filePath = (await e.store.locate(m.id, GLOBAL))!.filePath
    await chmod(root, 0o100)
    try {
      await expect(e.store.hardDelete(moved, { at: GLOBAL })).rejects.toThrow()
    } finally {
      await chmod(root, 0o700)
    }
    expect(await exists(filePath)).toBe(true)
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('到期清扫也清它以前住过的那层留下的历史', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const moved = await movedToGlobalLeavingHistory(e, m)
    await e.store.softDelete(moved, { at: GLOBAL, now: e.now() })
    e.clock.now += RETENTION_MS + MINUTE
    await e.store.maintain(GLOBAL)
    expect(await e.store.get(m.id, GLOBAL)).toBeUndefined()
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  it('到期清扫时以前住过的那层历史删不掉：不报错，这条记忆这次先不清；能删了再维护一次，记忆和历史一起清掉', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const moved = await movedToGlobalLeavingHistory(e, m)
    await e.store.softDelete(moved, { at: GLOBAL, now: e.now() })
    const filePath = (await e.store.locate(m.id, GLOBAL))!.filePath
    e.clock.now += RETENTION_MS + MINUTE
    await chmod(historyDir(wsDir(), m.id), 0o500)
    try {
      await e.store.maintain(GLOBAL)
    } finally {
      await chmod(historyDir(wsDir(), m.id), 0o700)
    }
    expect(await exists(filePath)).toBe(true)
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
    await e.store.maintain(GLOBAL)
    expect(await exists(filePath)).toBe(false)
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  describe('同一层里在用的那份读不出时，到期的同 id 副本被清扫：历史不当成没人要的删掉', () => {
    /** 全局有一条在用、带历史的记忆，最近删除里还有一份同 id、早已过了保留期的副本。 */
    async function liveWithExpiredDuplicate(e: Env) {
      const m = await withVersion(e)
      await mkdir(join(globalDir(), ARCHIVE_DIR), { recursive: true })
      await writeFile(join(globalDir(), ARCHIVE_DIR, '早已删掉的副本.md'), encodeRecord({ ...m, status: 'deleted', deletedAt: e.now() - RETENTION_MS - MINUTE }, {}))
      return { m, filePath: (await e.store.locate(m.id, GLOBAL))!.filePath }
    }

    it('在用的那份读不了（没有读权限）', async () => {
      const e = env()
      const { m, filePath } = await liveWithExpiredDuplicate(e)
      await chmod(filePath, 0)
      try {
        await e.table.maintain([globalDir()])
      } finally {
        await chmod(filePath, 0o600)
      }
      expect(await versionsIn(e, globalDir(), m.id)).toEqual(['第一版'])
    })

    it('在用的那份解析不了（frontmatter 写坏了）', async () => {
      const e = env()
      const { m, filePath } = await liveWithExpiredDuplicate(e)
      await writeFile(filePath, `---\nid: ${m.id}\nname: [坏掉\n---\n第二版\n`)
      await e.table.maintain([globalDir()])
      expect(await versionsIn(e, globalDir(), m.id)).toEqual(['第一版'])
    })
  })
})

describe('记忆 id 的边界', () => {
  it('id 为空的记录到期清扫：这一层别的记忆的历史不动', async () => {
    const e = env()
    const other = await withVersion(e, inWs)
    await e.table.create(record({ id: '', name: '空 id', ...inWs, status: 'deleted', deletedAt: T0 - RETENTION_MS }))
    e.clock.now += MINUTE
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, wsDir(), other.id)).toEqual(['第一版'])
  })

  it('历史版本不收 id 为空的记忆：读写和删除、搬移都拒绝', async () => {
    const history = new FileVersionHistory()
    const dir = join(root, 'a')
    await expect(history.removeAll(dir, '')).rejects.toThrow()
    await expect(history.move(dir, join(root, 'b'), '')).rejects.toThrow()
    await expect(new InMemoryTable('/in-memory', () => T0).history.removeAll(dir, '')).rejects.toThrow()
  })

  it('id 里带换行的记忆搬走了：按解析出的 id 找到它，历史迁过去，不清掉', async () => {
    const e = env()
    const id = 'mem_多行\n第二行'
    // 记忆已在全局，历史还留在它以前住的项目里
    await e.store.create(record({ name: '项目里的另一条', ...inWs }))
    await e.store.create(record({ id, name: '多行 id', content: '第一版' }))
    const version: HistoryVersion = { versionId: '20261124T000000000Z', record: record({ id, content: '第一版' }), extras: {}, startedAt: 1, endedAt: 2, kind: STATE_CHANGE_VERSION, writes: [] }
    await e.store.history.write({ dir: globalDir(), loc: { scope: 'global' } }, version)
    await leaveBehind(globalDir(), wsDir(), id)
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, globalDir(), id)).toEqual(['第一版'])
  })
})

describe('换作用域时历史目录随迁', () => {
  const promoteDeps = (e: Env) => ({ store: e.store, snapshots: e.snapshots, now: e.now, agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')) })

  it('提升到全局：历史版本搬到全局目录下，项目目录下不再有', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const r = await executePromote({ confirmedIds: [m.id], target: 'global' }, { workspacePath: WS }, promoteDeps(e))
    expect(r.promoted).toEqual([{ id: m.id, target: 'global' }])
    expect(await versionsIn(e, globalDir(), m.id)).toEqual(['第一版'])
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  it('全局记忆移到项目，再撤销这次搬家：历史版本先跟到项目，再跟回全局', async () => {
    const e = env()
    const m = await withVersion(e)
    const written = await e.store.update(m, cur => ({ ...cur, scope: 'workspace', workspacePath: WS }), GLOBAL)
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
    expect(await exists(historyDir(globalDir(), m.id))).toBe(false)
    const snapshot = await e.snapshots.capture({ operation: 'pre-update', description: '移到项目前', records: [m] }, e.now())
    const entry = await e.decisions.addMove(written, { summary: m.summary, workspace: WS }, snapshot.id, e.now())
    const undone = await executeUndo({ decisionId: entry.id }, { workspacePath: WS }, e)
    expect(undone.kind, JSON.stringify(undone)).not.toBe('error')
    expect((await e.store.get(m.id, GLOBAL))?.scope).toBe('global')
    expect(await versionsIn(e, globalDir(), m.id)).toEqual(['第一版'])
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  it('撤销提升（按改前快照搬回项目）：历史版本跟回项目', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const r = await executePromote({ confirmedIds: [m.id], target: 'global' }, { workspacePath: WS }, promoteDeps(e))
    const snapshot = (await e.snapshots.get(r.snapshotId!))!
    const restored = await e.snapshots.restore(snapshot, [m.id], e.store, { target: 'hint', overwrite: true, now: e.now })
    expect(restored.restored).toEqual([m.id])
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
    expect(await exists(historyDir(globalDir(), m.id))).toBe(false)
  })
})

describe('整份核对：记忆已不在这一层的历史目录', () => {
  it('记忆已搬到别的作用域：目录迁过去，不清掉', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await e.store.update(m, ({ workspacePath: _w, ...cur }) => ({ ...cur, scope: 'global' }), scopeAt(WS))
    await leaveBehind(globalDir(), wsDir(), m.id)
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, globalDir(), m.id)).toEqual(['第一版'])
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  it('记忆在别的作用域的最近删除里：也算找到，迁过去', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const moved = await e.store.update(m, ({ workspacePath: _w, ...cur }) => ({ ...cur, scope: 'global' }), scopeAt(WS))
    await e.store.softDelete(moved, { at: GLOBAL, now: e.now() })
    await leaveBehind(globalDir(), wsDir(), m.id)
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, globalDir(), m.id)).toEqual(['第一版'])
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  it('哪个作用域都找不到这条记忆：清掉', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await rm((await e.store.locate(m.id, scopeAt(WS)))!.filePath)
    await e.store.maintain(scopeAt(WS))
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })

  it('这一层有解析不了的记忆文件时不清：坏掉的可能就是这条记忆', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const { filePath } = (await e.store.locate(m.id, scopeAt(WS)))!
    await writeFile(filePath, `---\nid: ${m.id}\nname: [坏掉\n---\n正文\n`)
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('最近删除读不了：不清，删掉的那份可能就是这条记忆', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await e.store.softDelete(m, { now: e.now() })
    const archive = join(wsDir(), ARCHIVE_DIR)
    await chmod(archive, 0)
    try {
      await e.store.maintain(scopeAt(WS))
    } finally {
      await chmod(archive, 0o700)
    }
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('全局目录读不了：不清，记忆可能搬到了那里', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await movedToGlobalLeavingHistory(e, m)
    await chmod(globalDir(), 0)
    try {
      await e.store.maintain(scopeAt(WS))
    } finally {
      await chmod(globalDir(), 0o700)
    }
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('记忆搬去的那层里它的文件解析不了：不清也不搬', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await movedToGlobalLeavingHistory(e, m)
    await writeFile((await e.store.locate(m.id, GLOBAL))!.filePath, `---\nid: ${m.id}\nname: [坏掉\n---\n正文\n`)
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('这一层的记忆文件坏了、全局恰好有同 id 的另一条：历史不搬给全局那条', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    const { filePath } = (await e.store.locate(m.id, scopeAt(WS)))!
    await writeFile(filePath, `---\nid: ${m.id}\nname: [坏掉\n---\n正文\n`)
    await e.store.create(record({ id: m.id, name: '全局同 id 的另一条' }))
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
    expect(await versionsIn(e, globalDir(), m.id)).toEqual([])
  })

  it('写锁不跨进程互斥时不动：另一个进程可能正把这条记忆搬进搬出', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await rm((await e.store.locate(m.id, scopeAt(WS)))!.filePath)
    const lock = createRootLock({ root, log: quiet, loadSqlite: () => undefined })
    const table = new FileTable({ root, stats: new SidecarStore({ root, log: quiet, now: e.now, schemas: sidecarSchemas }).recallStats, log: quiet, now: e.now, lock })
    await table.maintain([wsDir()])
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('一个历史目录处理出错不挡别的：维护照常走完，别的孤儿照常清掉', async () => {
    const e = env()
    const stuck = await withVersion(e, inWs)
    const gone = await withVersion(e, { ...inWs, name: '另一条' })
    for (const m of [stuck, gone]) await rm((await e.store.locate(m.id, scopeAt(WS)))!.filePath)
    const restore = await unremovable(historyDir(wsDir(), stuck.id))
    try {
      await e.store.maintain(scopeAt(WS))
    } finally {
      await restore()
    }
    expect(await exists(historyDir(wsDir(), gone.id))).toBe(false)
  })

  it('拿不准的孤儿在这个进程里只查一次：之后的维护不再为它扫各个作用域', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await movedToGlobalLeavingHistory(e, m)
    await writeFile((await e.store.locate(m.id, GLOBAL))!.filePath, `---\nid: ${m.id}\nname: [坏掉\n---\n正文\n`)
    await e.table.maintain([wsDir()])
    const listings = vi.spyOn(e.table, 'listWorkspaceDirs')
    await e.table.maintain([wsDir()])
    expect(listings).not.toHaveBeenCalled()
    expect(await versionsIn(e, wsDir(), m.id)).toEqual(['第一版'])
  })

  it('目标层已有这条记忆的历史：并进去，同名不同内容的换一个版本 id，两版都留着', async () => {
    const e = env()
    const m = await withVersion(e, inWs)
    await e.store.update(m, ({ workspacePath: _w, ...cur }) => ({ ...cur, scope: 'global' }), scopeAt(WS))
    // 旧版本在项目这层另留了一个同名、内容不同的版本，记忆随后被搬走
    const [moved] = await e.store.history.list({ dir: globalDir(), loc: { scope: 'global' } }, m.id)
    await e.store.history.write({ dir: wsDir(), loc: inWs }, { ...moved!, record: { ...moved!.record, content: '另一台机器上的第一版' } })
    await e.store.maintain(scopeAt(WS))
    expect(await versionsIn(e, globalDir(), m.id)).toEqual(['第一版', '另一台机器上的第一版'])
    expect(await exists(historyDir(wsDir(), m.id))).toBe(false)
  })
})

describe('历史目录的搬移', () => {
  it('能重复执行：源头已经没有就什么都不做；同名同内容去掉源头，同名不同内容换版本 id', async () => {
    const history = new FileVersionHistory()
    const a = { dir: join(root, 'a'), loc: { scope: 'global' } as const }
    const b = { dir: join(root, 'b'), loc: { scope: 'global' } as const }
    const base = record({ id: 'mem_x', content: '一' })
    const version = (content: string): HistoryVersion => ({ versionId: '20261124T000000000Z', record: { ...base, content }, extras: {}, startedAt: 1, endedAt: 2, kind: STATE_CHANGE_VERSION, writes: [] })
    await history.write(a, version('一'))
    await history.write(b, version('一'))
    await history.move(a.dir, b.dir, 'mem_x')
    expect((await history.list(b, 'mem_x')).map(v => v.record.content)).toEqual(['一'])
    await history.write(a, version('二'))
    await history.move(a.dir, b.dir, 'mem_x')
    await history.move(a.dir, b.dir, 'mem_x')
    expect((await history.list(b, 'mem_x')).map(v => [v.versionId, v.record.content])).toEqual([['20261124T000000000Z', '一'], ['20261124T000000000Z-02', '二']])
    expect(await exists(historyDir(a.dir, 'mem_x'))).toBe(false)
    expect(await history.memoryIds(b.dir)).toEqual(['mem_x'])
    expect(await history.memoryIds(a.dir)).toEqual([])
  })

  it('id 整段是点的记忆：按编码后的目录名找回 id', async () => {
    const history = new FileVersionHistory()
    const layer = { dir: join(root, 'a'), loc: { scope: 'global' } as const }
    await history.write(layer, { versionId: '20261124T000000000Z', record: record({ id: '..' }), extras: {}, startedAt: 1, endedAt: 2, kind: STATE_CHANGE_VERSION, writes: [] })
    expect(await readdir(join(layer.dir, HISTORY_DIR))).toEqual(['%2E%2E'])
    expect(await history.memoryIds(layer.dir)).toEqual(['..'])
  })
})

describe('内存表（测试用的参考实现）', () => {
  it('同样跟着记忆走：换作用域随迁、到期清扫和彻底删除连目录删、记忆不在这一层的迁到它所在的那一层', async () => {
    const clock = { now: T0 }
    const table = new InMemoryTable('/in-memory', () => clock.now)
    const g = table.globalDir
    const ws = join('/in-memory', workspaceDirName(WS))
    const version = (r: MemoryRecord): HistoryVersion => ({ versionId: '20261124T000000000Z', record: r, extras: {}, startedAt: 1, endedAt: 2, kind: STATE_CHANGE_VERSION, writes: [] })
    const listed = async (dir: string, id: string) => (await table.history.list({ dir, loc: { scope: 'global' } }, id)).length
    const a = record({ id: 'mem_a' })
    const b = record({ id: 'mem_b' })
    const c = record({ id: 'mem_c' })
    for (const r of [a, b, c]) {
      await table.create(r)
      await table.history.write({ dir: g, loc: { scope: 'global' } }, version(r))
    }
    await table.update(a.id, GLOBAL, r => ({ ...r, scope: 'workspace', workspacePath: WS }))
    expect([await listed(g, a.id), await listed(ws, a.id)]).toEqual([0, 1])
    expect(await table.delete(b.id, GLOBAL)).toBe(true)
    expect(await listed(g, b.id)).toBe(0)
    await table.update(c.id, GLOBAL, r => ({ ...r, status: 'deleted', deletedAt: clock.now }))
    await table.history.write({ dir: ws, loc: { scope: 'global' } }, version(record({ id: 'mem_gone' })))
    await table.history.move(ws, g, a.id)
    clock.now += RETENTION_MS + MINUTE
    await table.maintain([g, ws])
    expect([await listed(g, c.id), await listed(ws, 'mem_gone'), await listed(g, a.id), await listed(ws, a.id)]).toEqual([0, 0, 0, 1])
  })
})
