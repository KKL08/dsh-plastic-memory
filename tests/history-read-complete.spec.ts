import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { FileVersionHistory, STATE_CHANGE_VERSION, layerOf, type HistoryLayer, type HistoryVersion } from '../src/storage/history.ts'
import { historyWithMerged } from '../src/merged-history.ts'
import { GLOBAL_DIR, HISTORY_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { commitChange } from '../src/commit-change.ts'
import { withdrawVersion } from '../src/tools/changeset.ts'
import { scopeAt } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

// 历史版本读没读全：列目录列不出、版本文件读不出或解析不了时如实报「读不全」，目录不存在才是「没有历史」。
// 读一版分得清在、不在、读不出；数版本只数文件名。读不全时状态变化不并进上一版、撤销没找到那一版要记一笔。真实临时目录。

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const WS = '/tmp/pm-history-read-complete'
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-history-read-complete-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await chmod(root, 0o700).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

function env() {
  const clock = { now: T0 }
  const now = () => clock.now
  const sidecar = new SidecarStore({ root, log: quiet, now, schemas: sidecarSchemas })
  const table = new FileTable({ root, stats: sidecar.recallStats, log: quiet, now })
  const store = new MemoryStore(table, quiet, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  return { clock, now, store, snapshots }
}
type Env = ReturnType<typeof env>

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = () => join(root, workspaceDirName(WS))
const historyDir = (dir: string, id: string) => join(dir, HISTORY_DIR, encodeURIComponent(id))
const GLOBAL_LAYER = (): HistoryLayer => ({ dir: globalDir(), loc: { scope: 'global' } })

/** 一版：内容给定，结束时刻给定，其余按缺省。 */
function versionOf(id: string, versionId: string, content: string, endedAt: number): HistoryVersion {
  return {
    versionId, record: record({ id, content, createdAt: T0, updatedAt: T0, lastConfirmedAt: T0 }), extras: {},
    startedAt: T0, endedAt, kind: STATE_CHANGE_VERSION, writes: [{ op: `op-${versionId}`, at: endedAt, reason: `原因 ${versionId}` }],
  }
}

/** 在历史目录里放一个名字合版本写法、内容解析不了的文件。 */
async function putGarbage(dir: string, id: string, versionId = '19990101T000000000Z') {
  await mkdir(historyDir(dir, id), { recursive: true })
  await writeFile(join(historyDir(dir, id), `${versionId}.md`), '这不是一个版本文件\n')
}

/** 让这条记忆的历史目录列不出：在它的位置放一个普通文件（列目录报 ENOTDIR）。 */
async function blockHistoryDir(dir: string, id: string) {
  await mkdir(join(dir, HISTORY_DIR), { recursive: true })
  await writeFile(historyDir(dir, id), '不是目录')
}

/** 建一条记忆，再做一次状态变化：它的历史里有一版（改前正文「第一版」）。 */
async function withVersion(e: Env, partial: Partial<MemoryRecord> = {}, sessionId?: string): Promise<MemoryRecord> {
  const made = record({ name: '部署方式', content: '第一版', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await e.store.create(made)
  e.clock.now += MINUTE
  const target = (await e.store.get(made.id, scopeAt(made.workspacePath)))!
  const r = await commitChange({ target, kind: 'state-change', fields: { content: '第二版' }, by: 'main', reason: '换了', at: e.clock.now, ...(sessionId !== undefined ? { sessionId } : {}) }, e)
  if (r.kind !== 'written') throw new Error(JSON.stringify(r))
  return r.record
}

describe('列历史版本：读没读全', () => {
  it('没有历史目录算读全的空列表；有版本文件解析不了时读不全，读得出的照常给出', async () => {
    const history = new FileVersionHistory()
    expect(await history.list(GLOBAL_LAYER(), 'mem_a')).toEqual({ versions: [], isComplete: true })
    await history.write(GLOBAL_LAYER(), versionOf('mem_a', '20231114T221400000Z', '甲', T0 + MINUTE))
    await putGarbage(globalDir(), 'mem_a')
    const listed = await history.list(GLOBAL_LAYER(), 'mem_a')
    expect(listed.isComplete).toBe(false)
    expect(listed.versions.map(v => v.record.content)).toEqual(['甲'])
  })

  it('有版本文件读不出（没有读权限）：读不全', async () => {
    const history = new FileVersionHistory()
    await history.write(GLOBAL_LAYER(), versionOf('mem_a', '20231114T221400000Z', '甲', T0 + MINUTE))
    await history.write(GLOBAL_LAYER(), versionOf('mem_a', '20231114T221500000Z', '乙', T0 + 2 * MINUTE))
    await chmod(join(historyDir(globalDir(), 'mem_a'), '20231114T221500000Z.md'), 0)
    const listed = await history.list(GLOBAL_LAYER(), 'mem_a')
    expect(listed.isComplete).toBe(false)
    expect(listed.versions.map(v => v.record.content)).toEqual(['甲'])
  })

  it('历史目录列不出（不是目录不存在）：读不全，不当成没有历史', async () => {
    const history = new FileVersionHistory()
    await blockHistoryDir(globalDir(), 'mem_a')
    expect(await history.list(GLOBAL_LAYER(), 'mem_a')).toEqual({ versions: [], isComplete: false })
  })
})

describe('按版本标识读一版', () => {
  it('在的读出来，不在的说不在，文件在但解析不了的说读不出', async () => {
    const history = new FileVersionHistory()
    await history.write(GLOBAL_LAYER(), versionOf('mem_a', '20231114T221400000Z', '甲', T0 + MINUTE))
    await putGarbage(globalDir(), 'mem_a', '20231114T221500000Z')
    const found = await history.read(GLOBAL_LAYER(), 'mem_a', '20231114T221400000Z')
    expect(found.kind).toBe('found')
    expect(found.kind === 'found' && found.version.record.content).toBe('甲')
    expect(await history.read(GLOBAL_LAYER(), 'mem_a', '20231114T221600000Z')).toEqual({ kind: 'missing' })
    expect(await history.read(GLOBAL_LAYER(), 'mem_a', '20231114T221500000Z')).toEqual({ kind: 'unreadable' })
  })

  it('这条记忆连历史目录都没有：说不在', async () => {
    expect(await new FileVersionHistory().read(GLOBAL_LAYER(), 'mem_none', '20231114T221400000Z')).toEqual({ kind: 'missing' })
  })
})

describe('数版本文件', () => {
  it('没有目录为 0；只数名字合版本写法的文件，解析不了的也算，写到一半的临时文件不算', async () => {
    const history = new FileVersionHistory()
    expect(await history.countVersions(globalDir(), 'mem_a')).toBe(0)
    await history.write(GLOBAL_LAYER(), versionOf('mem_a', '20231114T221400000Z', '甲', T0 + MINUTE))
    await putGarbage(globalDir(), 'mem_a')
    await writeFile(join(historyDir(globalDir(), 'mem_a'), '20231114T221500000Z.md.tmp-1-abcdef'), '半截')
    expect(await history.countVersions(globalDir(), 'mem_a')).toBe(2)
  })

  it('历史目录列不出：给不出数，不当成 0', async () => {
    await blockHistoryDir(globalDir(), 'mem_a')
    expect(await new FileVersionHistory().countVersions(globalDir(), 'mem_a')).toBeUndefined()
  })
})

describe('连同并进来的一起读：读没读全', () => {
  async function mergedAway(e: Env, from: MemoryRecord, into: MemoryRecord) {
    const mergedInto = { id: into.id, scopeKey: into.workspacePath ?? 'global', as: 'merge' as const }
    expect(await e.store.softDeleteUnlessSecret(from, { at: scopeAt(from.workspacePath), now: e.now(), mergedInto })).toBe('deleted')
  }

  it('自己和并进来的都读得全时为真；并进来的那条的历史里有解析不了的文件时整体读不全，读得出的照常给出', async () => {
    const e = env()
    const keeper = await withVersion(e, { name: '留下的' })
    const gone = await withVersion(e, { name: '并进去的', scope: 'workspace', workspacePath: WS })
    await mergedAway(e, gone, keeper)
    const located = () => e.store.locate(keeper.id, { kind: 'global' }).then(f => f!)
    const whole = await historyWithMerged(e.store, await located())
    expect(whole.isComplete).toBe(true)
    expect(whole.versions).toHaveLength(2)
    await putGarbage(wsDir(), gone.id)
    const partial = await historyWithMerged(e.store, await located())
    expect(partial.isComplete).toBe(false)
    expect(partial.versions).toHaveLength(2)
  })

  it('自己这份历史读不全：整体读不全', async () => {
    const e = env()
    const keeper = await withVersion(e)
    await putGarbage(globalDir(), keeper.id)
    const listed = await historyWithMerged(e.store, (await e.store.locate(keeper.id, { kind: 'global' }))!)
    expect(listed.isComplete).toBe(false)
    expect(listed.versions.map(v => v.record.content)).toEqual(['第一版'])
  })

  it('找待删记录时有记忆文件解析不了：分不清它是不是并进这条的，整体读不全', async () => {
    const e = env()
    const keeper = await withVersion(e)
    await writeFile(join(globalDir(), '坏掉的.md'), '没有 frontmatter 的文件\n')
    const listed = await historyWithMerged(e.store, (await e.store.locate(keeper.id, { kind: 'global' }))!)
    expect(listed.isComplete).toBe(false)
    expect(listed.versions.map(v => v.record.content)).toEqual(['第一版'])
  })
})

describe('读不全时的写入和撤销', () => {
  it('历史读不全时，同一会话窗口内的下一次状态变化不并进上一版，另留一版', async () => {
    const e = env()
    const m = await withVersion(e, {}, 's1')
    await putGarbage(globalDir(), m.id)
    e.clock.now += MINUTE
    const target = (await e.store.get(m.id, { kind: 'global' }))!
    const r = await commitChange({ target, kind: 'state-change', fields: { content: '第三版' }, by: 'main', reason: '又换了', sessionId: 's1', at: e.clock.now }, e)
    if (r.kind !== 'written') throw new Error(JSON.stringify(r))
    expect(r.version?.isMerged).toBe(false)
    const located = (await e.store.locate(m.id, { kind: 'global' }))!
    expect((await e.store.history.list(layerOf(located), m.id)).versions.map(v => v.record.content)).toEqual(['第一版', '第二版'])
  })

  it('历史读不全、又没找到这次写入的那一版：记一条 warn，已有的版本不动，撤销照常往下走', async () => {
    const e = env()
    const m = await withVersion(e)
    await putGarbage(globalDir(), m.id)
    const log = { ...quiet, warn: vi.fn() }
    const putBack = await withdrawVersion(e.store, { ...m, content: '第一版' }, 'snap_not_here', log)
    expect(log.warn).toHaveBeenCalledTimes(1)
    await putBack()
    const located = (await e.store.locate(m.id, { kind: 'global' }))!
    expect((await e.store.history.list(layerOf(located), m.id)).versions.map(v => v.record.content)).toEqual(['第一版'])
  })
})
