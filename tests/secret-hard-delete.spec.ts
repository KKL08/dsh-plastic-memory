import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { ARCHIVE_DIR, INDEX_FILE, STATE_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { MemoryStore, InMemoryTable, type MemoryLogger } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import {
  REDACTED_PLACEHOLDER, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, type MemorySnapshot,
} from '../src/governance/schema.ts'
import { runRuleScan } from '../src/governance/rule-scan.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { createSaveTool } from '../src/tools/save-tool.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { RejectCode, WarningCode } from '../src/contract-codes.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord, candidate } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 票 13（S1）：含密钥的记忆被遗忘时立即物理删除，所有快照里不留明文，且不破坏快照里的其他记录；
// 疑似密钥保存时被拦下确认（docs/design-storage-file-is-memory.md §10，ARCHITECTURE.md ⑥-6c）。
// forget 场景全部用真实目录（FileTable + .state 侧表）。

const WS = '/home/dev/proj-s1'
const SECRET_CRITICAL: RejectCode = 'secret-critical'
const SECRET_SUSPECTED_REJECT: RejectCode = 'secret-suspected'
const SECRET_SUSPECTED_WARNING: WarningCode = 'secret-suspected'
/** 疑似级（无厂商特征）的样本：只命中「通用 api_key 赋值」 */
const SUSPECTED_TEXT = 'api_key: TESTONLY0000000000000'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-secret-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const wsDir = () => join(root, workspaceDirName(WS))
const snapDir = () => join(root, STATE_DIR, 'snapshots')
const wsRec = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', scope: 'workspace', workspacePath: WS,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_000_000,
  ...partial,
})

function harness() {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  return {
    store, snapshots, sidecar,
    forget: (ids: string[], reason = '含密钥', log?: MemoryLogger) =>
      executeForget({ ids, reason }, { workspacePath: WS }, { store, snapshots, decisions, ...(log !== undefined ? { log } : {}) }),
    snapshot: (args: Parameters<typeof executeSnapshotTool>[0]) => executeSnapshotTool(args, { workspacePath: WS }, { store, snapshots }),
  }
}

/** 记忆目录下（.state/ 除外）全部文件与目录的相对路径。 */
async function listTree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (relative(base, path) === STATE_DIR) continue
    out.push(relative(base, path))
    if (entry.isDirectory()) out.push(...await listTree(path, base))
  }
  return out.sort()
}
/** 递归 mtime 快照：相对路径 → mtimeMs（.state/ 除外）。 */
async function mtimes(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const rel of await listTree(root)) out.set(rel, (await stat(join(root, rel))).mtimeMs)
  return out
}
/** 快照文件的原始 JSON（不过 schema，按落盘字节读）。 */
async function rawSnapshot(id: string): Promise<{ text: string; json: { data: Array<Record<string, unknown>> } }> {
  const text = await readFile(join(snapDir(), `${id}.json`), 'utf8')
  return { text, json: JSON.parse(text) }
}
const rawRecordJson = async (snapId: string, memId: string) =>
  JSON.stringify((await rawSnapshot(snapId)).json.data.find(r => r.id === memId))

/** 记忆目录（.state/ 除外）里所有文件文本拼起来，查明文残留用。 */
async function allMemoryText(): Promise<string> {
  const texts: string[] = []
  for (const rel of await listTree(root)) {
    if ((await stat(join(root, rel))).isFile()) texts.push(await readFile(join(root, rel), 'utf8'))
  }
  return texts.join('\n')
}

describe('票 13 验收：S1 密钥硬删', () => {
  it('forget 对每条目标跑密钥检测，命中任一级 → 物理删除文件（顶层与 .archive/ 都没有），结果注明硬删条目', async () => {
    const h = harness()
    const inContent = wsRec({ id: 'mem_c', name: '正文带密钥', content: `部署用 ${FAKE_SECRET.sk}` })
    const inName = wsRec({ id: 'mem_n', name: FAKE_SECRET.github, content: '干净正文' })
    const inSummary = wsRec({ id: 'mem_s', name: '摘要带疑似密钥', summary: SUSPECTED_TEXT })
    const inTags = wsRec({ id: 'mem_t', name: '标签带密钥', tags: [FAKE_SECRET.aws] })
    const clean = wsRec({ id: 'mem_clean', name: '干净条目', content: '用 pnpm 管理依赖' })
    for (const r of [inContent, inName, inSummary, inTags, clean]) await h.store.create(r)

    const result = await h.forget(['mem_c', 'mem_n', 'mem_s', 'mem_t', 'mem_clean'])

    expect(result.ok).toBe(true)
    expect([...result.hardDeleted].sort()).toEqual(['mem_c', 'mem_n', 'mem_s', 'mem_t'])
    expect([...result.forgotten].sort()).toEqual(['mem_c', 'mem_clean', 'mem_n', 'mem_s', 'mem_t'])
    for (const id of result.hardDeleted) {
      expect(result.message).toContain(id)
      expect(await h.store.get(id, { workspacePath: WS })).toBeUndefined()
    }
    // 顶层与 .archive/ 只剩软删的干净条目
    const tree = await listTree(wsDir())
    expect(tree.filter(p => p.endsWith('.md') && p !== INDEX_FILE)).toEqual([join(ARCHIVE_DIR, '干净条目.md')])
    expect((await h.store.get('mem_clean', { workspacePath: WS }))?.status).toBe('deleted')
    const text = await allMemoryText()
    for (const secret of [FAKE_SECRET.sk, FAKE_SECRET.github, FAKE_SECRET.aws, SUSPECTED_TEXT]) expect(text).not.toContain(secret)
  })

  it('本次快照与 .state/snapshots/ 里所有含该 id 的既有快照：命中字段替换为占位文本，其余字段与其他记录一字不动，仍过 schema，tmp + rename 原子重写', async () => {
    const h = harness()
    const secret = wsRec({ id: 'mem_key', name: '部署凭证', summary: '部署脚本的凭证', tags: ['deploy'], content: `token 是 ${FAKE_SECRET.sk}` })
    const other = wsRec({ id: 'mem_other', name: '包管理', content: '用 pnpm' })
    await h.store.create(secret)
    await h.store.create(other)
    const withBoth = await h.snapshot({ action: 'create', memoryIds: ['mem_key', 'mem_other'] })
    const onlyOther = await h.snapshot({ action: 'create', memoryIds: ['mem_other'] })
    if (withBoth.kind !== 'created' || onlyOther.kind !== 'created') throw new Error('snapshot create failed')
    const otherBefore = await rawRecordJson(withBoth.snapshotId, 'mem_other')
    const untouchedBefore = await rawSnapshot(onlyOther.snapshotId)
    const inoBefore = (await stat(join(snapDir(), `${withBoth.snapshotId}.json`))).ino
    const untouchedIno = (await stat(join(snapDir(), `${onlyOther.snapshotId}.json`))).ino

    const result = await h.forget(['mem_key'])
    expect(result.hardDeleted).toEqual(['mem_key'])

    for (const snapId of [withBoth.snapshotId, result.snapshotId!]) {
      const { text, json } = await rawSnapshot(snapId)
      expect(text).not.toContain(FAKE_SECRET.sk)
      expect(memorySnapshotSchema.safeParse(json).success).toBe(true)
      const redacted = json.data.find(r => r.id === 'mem_key')!
      expect(redacted.redacted).toBe(true)
      expect(redacted.content).toBe(REDACTED_PLACEHOLDER)
      // 未命中的字段原样保留
      expect(redacted).toMatchObject({ name: '部署凭证', summary: '部署脚本的凭证', tags: ['deploy'], createdAt: secret.createdAt })
    }
    // 同快照里的其他记录字节级不变
    expect(await rawRecordJson(withBoth.snapshotId, 'mem_other')).toBe(otherBefore)
    // 不含该 id 的快照不重写
    expect((await rawSnapshot(onlyOther.snapshotId)).text).toBe(untouchedBefore.text)
    expect((await stat(join(snapDir(), `${onlyOther.snapshotId}.json`))).ino).toBe(untouchedIno)
    // 原子路径：重写换了 inode（tmp + rename，不是原地覆盖），不留 tmp
    expect((await stat(join(snapDir(), `${withBoth.snapshotId}.json`))).ino).not.toBe(inoBefore)
    expect((await readdir(snapDir())).filter(n => n.includes('.tmp-'))).toEqual([])
  })

  it('验收场景：含三条记录的手动快照，硬删其中一条后另两条字节级不变、show 与 diff 正常、restore 恢复另两条并把脱敏那条计入 skipped 且说明已硬删；除被删文件外记忆目录目录项与 mtime 不变；重写中途失败只会是旧版或新版', async () => {
    const h = harness()
    await h.store.create(wsRec({ id: 'mem_x', name: '测试框架', content: '用 vitest' }))
    await h.store.create(wsRec({ id: 'mem_y', name: '提交语言', content: 'commit 用英文' }))
    await h.store.create(wsRec({ id: 'mem_z', name: '数据库口令', summary: `连接串 ${SUSPECTED_TEXT}`, content: '库在 staging' }))
    const manual = await h.snapshot({ action: 'create', memoryIds: ['mem_x', 'mem_y', 'mem_z'] })
    if (manual.kind !== 'created') throw new Error(manual.kind)
    const xBefore = await rawRecordJson(manual.snapshotId, 'mem_x')
    const yBefore = await rawRecordJson(manual.snapshotId, 'mem_y')
    const zFile = join(workspaceDirName(WS), '数据库口令.md')
    const before = await mtimes()
    expect(before.has(zFile)).toBe(true)
    const inoBefore = (await stat(join(snapDir(), `${manual.snapshotId}.json`))).ino

    const forgot = await h.forget(['mem_z'])
    expect(forgot.hardDeleted).toEqual(['mem_z'])

    // 除被删文件外，目录项与 mtime 不变。例外两处是删除的必然结果：所在目录自身的 mtime（少了一个目录项）、
    // MEMORY.md（派生索引必须去掉被删条目那一行）。
    const after = await mtimes()
    const derived = new Set([workspaceDirName(WS), join(workspaceDirName(WS), INDEX_FILE)])
    const expected = new Map([...before].filter(([rel]) => rel !== zFile))
    expect([...after.keys()]).toEqual([...expected.keys()])
    for (const [rel, mtime] of expected) if (!derived.has(rel)) expect(after.get(rel)).toBe(mtime)
    expect(await readFile(join(wsDir(), INDEX_FILE), 'utf8')).not.toContain('mem_z')
    expect(await allMemoryText()).not.toContain(SUSPECTED_TEXT)

    // 另两条字节级不变；快照仍过 schema，经原子路径重写
    expect(await rawRecordJson(manual.snapshotId, 'mem_x')).toBe(xBefore)
    expect(await rawRecordJson(manual.snapshotId, 'mem_y')).toBe(yBefore)
    expect(memorySnapshotSchema.safeParse((await rawSnapshot(manual.snapshotId)).json).success).toBe(true)
    expect((await stat(join(snapDir(), `${manual.snapshotId}.json`))).ino).not.toBe(inoBefore)
    expect((await readdir(snapDir())).filter(n => n.includes('.tmp-'))).toEqual([])

    // show / diff 正常
    const shown = await h.snapshot({ action: 'show', snapshotId: manual.snapshotId })
    if (shown.kind !== 'shown') throw new Error(shown.kind)
    expect(shown.entries.map(e => e.id)).toEqual(['mem_x', 'mem_y', 'mem_z'])
    expect(shown.entries.filter(e => e.changedAfterSnapshot)).toEqual([])
    expect(shown.entries.find(e => e.id === 'mem_z')!.current).toBeUndefined()
    expect(shown.message).toContain('mem_z')

    // restore：恢复另两条，脱敏那条计入 skipped 且说明已硬删，不把占位文本恢复成记忆
    const restored = await h.snapshot({ action: 'restore', snapshotId: manual.snapshotId })
    if (restored.kind !== 'restored') throw new Error(restored.kind)
    expect(restored.restored).toEqual(['mem_x', 'mem_y'])
    expect(restored.skipped).toEqual(['mem_z'])
    expect(restored.redacted).toEqual(['mem_z'])
    expect(restored.message).toContain('mem_z')
    expect(await h.store.get('mem_z', { workspacePath: WS })).toBeUndefined()
    expect(await allMemoryText()).not.toContain(REDACTED_PLACEHOLDER)
    // overwriteChanged 也不恢复脱敏记录
    const forced = await h.snapshot({ action: 'restore', snapshotId: manual.snapshotId, overwriteChanged: true })
    if (forced.kind !== 'restored') throw new Error(forced.kind)
    expect(forced.redacted).toEqual(['mem_z'])
    expect(await h.store.get('mem_z', { workspacePath: WS })).toBeUndefined()
  })

  it('save：critical 仍拒绝；suspected 拒绝并返回 secret-suspected，force: true 放行并保留警告；force 工具说明改为「跳过结构去重与疑似密钥拦截（用户已确认）」', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const deps = { store, registry, workspacePath: WS, session: { id: 's', lastSeq: 1 } }

    const critical = await runSavePipeline(candidate({ scope: 'workspace', content: `密钥 ${FAKE_SECRET.sk}` }), deps)
    expect(critical).toMatchObject({ kind: 'rejected', code: SECRET_CRITICAL })
    const criticalForced = await runSavePipeline(candidate({ scope: 'workspace', content: `密钥 ${FAKE_SECRET.sk}`, force: true }), deps)
    expect(criticalForced).toMatchObject({ kind: 'rejected', code: SECRET_CRITICAL })

    const suspected = await runSavePipeline(candidate({ scope: 'workspace', content: `内部约定 ${SUSPECTED_TEXT}` }), deps)
    expect(suspected).toMatchObject({ kind: 'rejected', code: SECRET_SUSPECTED_REJECT })
    expect(await store.query({})).toHaveLength(0)

    const forced = await runSavePipeline(candidate({ scope: 'workspace', content: `内部约定 ${SUSPECTED_TEXT}`, force: true }), deps)
    if (forced.kind !== 'saved') throw new Error(forced.kind)
    expect(forced.warnings?.map(w => w.code)).toEqual([SECRET_SUSPECTED_WARNING])

    // update 同样拦截，force 放行
    const update = { action: 'update' as const, id: forced.record.id, scope: 'workspace' as const, content: '密码:TESTONLYpassw0rd' }
    expect(await runSavePipeline(candidate(update), deps)).toMatchObject({ kind: 'rejected', code: SECRET_SUSPECTED_REJECT })
    const updated = await runSavePipeline(candidate({ ...update, force: true }), deps)
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(updated.warnings?.map(w => w.code)).toEqual([SECRET_SUSPECTED_WARNING])

    const tool = createSaveTool({ store, registry, resolveContext: async () => ({ workspacePath: WS, session: { id: 's', lastSeq: 1 } }) })
    const params = (tool.parameters as unknown as { properties: Record<string, { description?: string }> }).properties
    expect(params.force.description).toBe('跳过结构去重与疑似密钥拦截（用户已确认）')
  })

  it('规则层 secret finding 建议文案改为「memory_forget 会立即物理删除，不进 14 天回收，并轮换凭证」', () => {
    const findings = runRuleScan([baseRecord({ id: 'mem_s', content: `密钥 ${FAKE_SECRET.sk}` })], () => undefined, 1)
    const secret = findings.find(f => f.type === 'secret')!
    expect(secret.suggestedAction).toContain('memory_forget 会立即物理删除，不进 14 天回收')
    expect(secret.suggestedAction).toContain('轮换')
  })

  it('稳定码进 contract-codes，测试断常量不断文案', async () => {
    // RejectCode / WarningCode 两边都收 secret-suspected：不带 force 是拒绝码，带 force 是警告码
    const store = new MemoryStore(new InMemoryTable())
    const deps = { store, registry, workspacePath: WS, session: { id: 's', lastSeq: 1 } }
    const rejected = await runSavePipeline(candidate({ scope: 'workspace', summary: SUSPECTED_TEXT }), deps)
    if (rejected.kind !== 'rejected') throw new Error(rejected.kind)
    expect(rejected.code).toBe(SECRET_SUSPECTED_REJECT)
    const saved = await runSavePipeline(candidate({ scope: 'workspace', summary: SUSPECTED_TEXT, force: true }), deps)
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect(saved.warnings?.[0].code).toBe(SECRET_SUSPECTED_WARNING)
  })
})

describe('forget 读过之后另一个会话才写进密钥', () => {
  it('锁内看到密钥就改走硬删：本次快照与其他快照里的副本都脱敏，.archive/ 不留明文', async () => {
    const h = harness()
    const rec = wsRec({ id: 'mem_late', name: '部署说明', content: '用 CI 部署' })
    await h.store.create(rec)
    const capture = h.snapshots.capture.bind(h.snapshots)
    let otherSnapId: string | undefined
    h.snapshots.capture = async (input, now) => {
      const snap = await capture(input, now)
      // 快照落盘之后、删除之前：另一个会话贴进密钥，还留了一份含密钥的手动快照
      const edited = await h.store.update(rec, r => ({ ...r, content: `用 CI 部署，token ${FAKE_SECRET.sk}` }))
      otherSnapId = (await capture({ operation: 'manual', description: '另一个会话', records: [edited] }, now)).id
      return snap
    }

    const result = await h.forget(['mem_late'])

    expect(result.forgotten).toEqual(['mem_late'])
    expect(result.hardDeleted).toEqual(['mem_late'])
    expect(result.message).toContain('物理删除')
    expect(await h.store.get('mem_late', { workspacePath: WS })).toBeUndefined()
    expect(await allMemoryText()).not.toContain(FAKE_SECRET.sk)
    for (const snapId of [result.snapshotId!, otherSnapId!]) {
      const { text, json } = await rawSnapshot(snapId)
      expect(text).not.toContain(FAKE_SECRET.sk)
      expect(json.data.find(r => r.id === 'mem_late')!.redacted).toBe(true)
    }
  })
})

describe('SnapshotStore.redact', () => {
  it('旧版本里没有命中的字段不动，仍打脱敏标记；重复调用不重写', async () => {
    const table = new InMemoryKvTable<MemorySnapshot>()
    const snapshots = new SnapshotStore(table)
    const old = baseRecord({ id: 'mem_v', content: '旧版本还没贴密钥' })
    const snap = await snapshots.capture({ operation: 'manual', description: 'm', records: [old] }, Date.now())
    await snapshots.redact(new Set(['mem_v']))
    const once = await snapshots.get(snap.id)
    expect(once!.data[0]).toEqual({ ...old, redacted: true })
    let writes = 0
    const put = table.put.bind(table)
    table.put = async (k, v) => { writes++; return put(k, v) }
    await snapshots.redact(new Set(['mem_v']))
    expect(writes).toBe(0)
  })
})
