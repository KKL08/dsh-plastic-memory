import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'
import { STATE_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { HAND_EDITED_NOTE } from '../src/index-line.ts'
import { executeSearch, renderSearchResult } from '../src/tools/search.ts'
import { executeSave } from '../src/tools/save.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executePromote } from '../src/tools/promote.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore, restoreProjection } from '../src/governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema, type MemorySnapshot } from '../src/governance/schema.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { formatValidity } from '../src/validity.ts'

// 票 12：手编检测与恢复比较投影（docs/design-storage-file-is-memory.md §2、§13）。
// 全部用真实目录（FileTable + .state 侧表）；文件直接改盘模拟用户手编。

const WS = '/home/dev/proj-h'
const DAY = 86_400_000
const SESSION = { id: 's-ticket12', lastSeq: 10, turnStartSeq: 5 }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-hand-edit-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const wsDir = () => join(root, workspaceDirName(WS))
const wsRec = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', scope: 'workspace', workspacePath: WS,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_000_000,
  source: { sessionId: 's-old', eventRange: [1, 2], sourceMode: 'user-explicit' },
  ...partial,
})

async function writeMem(fileName: string, r: MemoryRecord): Promise<string> {
  await mkdir(wsDir(), { recursive: true })
  await writeFile(join(wsDir(), WORKSPACE_MARKER), WS + '\n')
  const path = join(wsDir(), fileName)
  await writeFile(path, encodeRecord(r, {}))
  return path
}
/** 用户手编：直接改文件文本，不动其余 frontmatter。 */
async function handEdit(path: string, from: string, to: string): Promise<void> {
  const text = await readFile(path, 'utf8')
  expect(text).toContain(from)
  await writeFile(path, text.replace(from, to))
}
const frontmatter = async (path: string) => splitFrontmatter(await readFile(path, 'utf8')).data
const iso = (ms: number) => new Date(ms).toISOString()

function harness() {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const table = new FileTable({ root, stats: sidecar.recallStats })
  const store = new MemoryStore(table, undefined, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const ctx = async () => ({ workspacePath: WS, session: SESSION })
  const cache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: root })
  return {
    store, snapshots, decisions,
    search: (query: string) => executeSearch({ query }, fakeExec(), { store, registry, resolveContext: ctx }),
    assemble: async () => {
      const s = {}
      cache.setWorkspacePath(s, WS)
      return cache.assemble(s)
    },
    save: (args: Parameters<typeof executeSave>[0]) => executeSave(args, fakeExec(), { store, registry, resolveContext: ctx, snapshots }),
    snapshot: (args: Parameters<typeof executeSnapshotTool>[0]) => executeSnapshotTool(args, { workspacePath: WS }, { store, snapshots }),
  }
}

function restored<T extends { kind: string }>(r: T): Extract<T, { kind: 'restored' }> {
  if (r.kind !== 'restored') throw new Error(`expected restored, got ${r.kind}`)
  return r as Extract<T, { kind: 'restored' }>
}

describe('票 12 验收：手编检测与恢复比较投影', () => {
  it('改正文不改 frontmatter → 渲染带手编标注；维护点后文件里 handEdited: true、lastConfirmedAt 等于 mtime；memory_save update 后标记清除且 source 更新', async () => {
    const path = await writeMem('pnpm.md', wsRec({ id: 'mem_h', name: '包管理', summary: '用 pnpm', content: '包管理用 pnpm' }))
    await handEdit(path, '包管理用 pnpm', '包管理用 pnpm，锁文件必须提交')
    const editedAt = Date.now() - 3 * DAY
    await utimes(path, editedAt / 1000, editedAt / 1000)
    const mtime = (await stat(path)).mtimeMs
    const h = harness()

    // 渲染：search 与注入都带手编标注
    const hit = (await h.search('锁文件')).hits[0]
    expect(hit.id).toBe('mem_h')
    expect(renderSearchResult({ hits: [hit] })).toContain(HAND_EDITED_NOTE)
    const injected = await h.assemble()          // 快照冻结 = 维护点
    expect(injected).toContain(HAND_EDITED_NOTE)

    // 维护点后落盘
    const fm = await frontmatter(path)
    expect(fm.handEdited).toBe(true)
    expect(fm.lastConfirmedAt).toBe(iso(mtime))
    expect(fm.updatedAt).toBe(iso(mtime))

    // memory_save update：手改过的先拒（手改保护），问过用户带 force 重发后标记清除，source 指向本次会话
    const args = { action: 'update', id: 'mem_h', name: '包管理', type: 'preference', scope: 'workspace', content: '包管理用 pnpm，锁文件必须提交', summary: '用 pnpm', sourceMode: 'user-explicit' } as const
    expect(await h.save(args)).toMatchObject({ kind: 'rejected', code: 'hand-edited' })
    const updated = await h.save({ ...args, force: true })
    expect(updated.kind).toBe('updated')
    const after = await frontmatter(path)
    expect(after).not.toHaveProperty('handEdited')
    expect(after.source).toMatchObject({ sessionId: SESSION.id })
    const again = (await h.store.get('mem_h'))!
    expect(again.handEdited).toBeUndefined()
    expect(again.source?.sessionId).toBe(SESSION.id)
    expect(renderSearchResult({ hits: (await h.search('锁文件')).hits })).not.toContain(HAND_EDITED_NOTE)
  })

  it('恢复比较投影（name、type、tags、summary、正文、validFrom、validTo、confidence、supersedes、source）在比较时刻由当前文件与快照记录各算一份，不读文件里的 digest', async () => {
    // 字段集合钉死：时间戳、status、handEdited、digest、位置、召回统计都不在里面
    expect(Object.keys(restoreProjection(wsRec())).sort()).toEqual([
      'confidence', 'content', 'name', 'source', 'summary', 'supersedes', 'tags', 'type', 'validFrom', 'validTo',
    ])
    const MIN = 60_000   // 有效期按分钟比（文件里写到分钟）
    const base = wsRec({ id: 'mem_p', content: '第一行\n第二行', validFrom: 10 * MIN, validTo: 20 * MIN, supersedes: ['mem_x'] })
    const same = (a: MemoryRecord) => isDeepStrictEqual(restoreProjection(a), restoreProjection(base))
    expect(same({ ...base, updatedAt: 9, lastConfirmedAt: 9, status: 'superseded', handEdited: true, recallCount: 7, scope: 'global', workspacePath: undefined })).toBe(true)
    expect(same({ ...base, content: base.content.replace(/\n/g, '\r\n') })).toBe(true)
    // 旧版本快照里不在整分钟上的有效期：按向外取整后比，和转换后的文件视为相同
    expect(same({ ...base, validFrom: 10 * MIN + 59_999, validTo: 20 * MIN - 59_999 })).toBe(true)
    const changes: Array<Partial<MemoryRecord>> = [
      { name: '别名' }, { type: 'knowledge' }, { tags: ['新'] }, { summary: '新摘要' }, { content: '新正文' },
      { validFrom: 11 * MIN }, { validTo: 21 * MIN }, { confidence: 0.5 }, { supersedes: ['mem_y'] },
      { source: { sessionId: 's-other', eventRange: [1, 2], sourceMode: 'user-explicit' } },
    ]
    for (const c of changes) expect(same({ ...base, ...c }), JSON.stringify(c)).toBe(false)

    // 不读 digest：文件里的 digest 被改坏（读侧因此标手编），但投影与快照一致 → 照常恢复；
    // 快照之后 updatedAt 被推后（非内容变化）也不算修改
    const h = harness()
    const path = await writeMem('p.md', wsRec({ id: 'mem_p', content: '投影探针' }))
    const created = await h.snapshot({ action: 'create', memoryIds: ['mem_p'] })
    if (created.kind !== 'created') throw new Error(created.kind)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text
      .replace(/^digest: .*$/m, 'digest: d1:0000000000000000')
      .replace(/^updatedAt: .*$/m, `updatedAt: ${iso(Date.now() + DAY)}`))
    expect((await h.store.get('mem_p'))!.handEdited).toBe(true)
    const r = restored(await h.snapshot({ action: 'restore', snapshotId: created.snapshotId }))
    expect(r.restored).toEqual(['mem_p'])
    expect(r.skipped).toEqual([])
  })

  it('手改正文、tags 或 validTo 后立即 restore → 该记录计入 skipped；旧格式快照（记录无 digest）照常比对', async () => {
    const h = harness()
    const paths = {
      body: await writeMem('body.md', wsRec({ id: 'mem_body', name: '正文', content: '原正文' })),
      tags: await writeMem('tags.md', wsRec({ id: 'mem_tags', name: '标签', tags: ['old-tag'] })),
      validTo: await writeMem('valid.md', wsRec({ id: 'mem_valid', name: '时效', validTo: Date.parse('2099-01-01T00:00:00.000Z') })),
      same: await writeMem('same.md', wsRec({ id: 'mem_same', name: '未改' })),
    }
    const created = await h.snapshot({ action: 'create', memoryIds: ['mem_body', 'mem_tags', 'mem_valid', 'mem_same'] })
    if (created.kind !== 'created') throw new Error(created.kind)

    // 立即手编（updatedAt 不动，同一毫秒内也要判出）
    await handEdit(paths.body, '原正文', '手改后的正文')
    await handEdit(paths.tags, '- old-tag', '- new-tag')
    await handEdit(paths.validTo, `validTo: ${formatValidity(Date.parse('2099-01-01T00:00:00.000Z'))}`, `validTo: ${formatValidity(Date.parse('2098-01-01T00:00:00.000Z'))}`)
    const editedTexts = await Promise.all([paths.body, paths.tags, paths.validTo].map(p => readFile(p, 'utf8')))

    const r = restored(await h.snapshot({ action: 'restore', snapshotId: created.snapshotId }))
    expect(r.skipped.sort()).toEqual(['mem_body', 'mem_tags', 'mem_valid'])
    expect(r.restored).toEqual(['mem_same'])
    expect(r.message).toContain('被修改')
    expect(await Promise.all([paths.body, paths.tags, paths.validTo].map(p => readFile(p, 'utf8')))).toEqual(editedTexts)

    // 旧格式快照：0.1.x 写下的记录没有 digest / handEdited / deletedAt，当前文件带 digest
    const oldA = wsRec({ id: 'mem_old_a', name: '旧甲', content: '旧甲正文' })
    const oldB = wsRec({ id: 'mem_old_b', name: '旧乙', content: '旧乙正文' })
    const pathA = await writeMem('old-a.md', oldA)
    await writeMem('old-b.md', oldB)
    expect(await readFile(pathA, 'utf8')).toMatch(/^digest: d1:/m)
    const legacy: MemorySnapshot = {
      id: 'snap_legacy', createdAt: Date.now() - DAY, operation: 'pre-forget', description: '0.1.x 快照',
      memoryIds: [oldA.id, oldB.id], data: [oldA, oldB],
    }
    expect(JSON.stringify(legacy)).not.toContain('digest')
    await mkdir(join(root, STATE_DIR, 'snapshots'), { recursive: true })
    await writeFile(join(root, STATE_DIR, 'snapshots', 'snap_legacy.json'), JSON.stringify(legacy))
    await handEdit(pathA, '旧甲正文', '旧甲手改')

    const r2 = restored(await h.snapshot({ action: 'restore', snapshotId: 'snap_legacy' }))
    expect(r2.skipped).toEqual(['mem_old_a'])
    expect(r2.restored).toEqual(['mem_old_b'])
  })

  it('旧版本写的有效期（UTC 毫秒 ISO、不在整分钟上）：快照、转换、恢复都精确，不误判成「快照后被修改」', async () => {
    const h = harness()
    const raw = { validFrom: Date.parse('2099-01-01T09:30:45.000Z'), validTo: Date.parse('2099-02-01T18:00:00.123Z') }
    const legacy = (r: MemoryRecord) => encodeRecord(r, {})
      .replace(/^validFrom: .*$/m, `validFrom: ${iso(r.validFrom!)}`)
      .replace(/^validTo: .*$/m, `validTo: ${iso(r.validTo!)}`)
    // 升级前留在 .state 里的旧快照：记录里还是原始毫秒
    const before = wsRec({ id: 'mem_old_v', name: '旧有效期', content: '升级前的正文', ...raw })
    const path = await writeMem('old-v.md', before)
    await writeFile(path, legacy(before))
    const preUpgrade: MemorySnapshot = {
      id: 'snap_pre_upgrade', createdAt: Date.now() - DAY, operation: 'manual', description: '升级前',
      memoryIds: [before.id], data: [before],
    }
    await mkdir(join(root, STATE_DIR, 'snapshots'), { recursive: true })
    await writeFile(join(root, STATE_DIR, 'snapshots', 'snap_pre_upgrade.json'), JSON.stringify(preUpgrade))
    // 升级后读旧文件时拍的快照
    const created = await h.snapshot({ action: 'create', memoryIds: [before.id] })
    if (created.kind !== 'created') throw new Error(created.kind)

    await h.assemble()   // 快照冻结 = 维护点：旧文件改写成本机时间
    const convertedText = await readFile(path, 'utf8')
    expect(convertedText).toContain(`validTo: ${formatValidity(Date.parse('2099-02-01T18:01:00.000Z'))}`)

    for (const snapshotId of [created.snapshotId, 'snap_pre_upgrade']) {
      const r = restored(await h.snapshot({ action: 'restore', snapshotId }))
      expect(r.restored).toEqual([before.id])
      expect(r.skipped).toEqual([])
      expect(await readFile(path, 'utf8')).toBe(convertedText)
    }
  })

  it('confirm refresh / promote dismiss 不改 updatedAt 的特殊处理保持不动', async () => {
    const h = harness()
    const path = await writeMem('keep.md', wsRec({ id: 'mem_keep', globalCandidate: true }))
    const before = (await frontmatter(path)).updatedAt

    const confirmed = await executeConfirm({ action: 'refresh', memoryId: 'mem_keep' }, { workspacePath: WS }, { store: h.store, decisions: h.decisions, snapshots: h.snapshots })
    expect(confirmed.kind).toBe('refreshed')
    expect((await frontmatter(path)).updatedAt).toBe(before)

    const agentsMd = createAgentsMdWriter(join(root, 'AGENTS.md'))
    const dismissed = await executePromote({ confirmedIds: ['mem_keep'], target: 'global', dismiss: true }, { workspacePath: WS }, { store: h.store, agentsMd, snapshots: h.snapshots })
    expect(dismissed.dismissed).toEqual(['mem_keep'])
    const fm = await frontmatter(path)
    expect(fm.updatedAt).toBe(before)
    expect(fm).not.toHaveProperty('globalCandidate')
  })
})
