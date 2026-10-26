import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, INDEX_FILE, STATE_DIR, WORKSPACE_MARKER, deriveFileId, workspaceDirName } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotCache } from '../src/runtime.ts'
import { COLD_START_TEXT, coldStartUnparseableText } from '../src/snapshot.ts'
import { HAND_EDITED_NOTE } from '../src/index-line.ts'
import { executeSearch, renderSearchResult } from '../src/tools/search.ts'
import { executeHealth, renderHealthResult, type HealthToolDeps } from '../src/tools/health.ts'
import { executeScan, renderScanResult, type ScanToolDeps } from '../src/tools/scan.ts'
import { executeSource, renderSourceResult, type ReadEventFn } from '../src/tools/source.ts'
import { executeSave } from '../src/tools/save.ts'
import { executeForget } from '../src/tools/forget.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, type Finding } from '../src/governance/schema.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { resolveHealthThresholds } from '../src/governance/health-presets.ts'
import type { DirectoryNoteCode } from '../src/contract-codes.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { SECRET_MASK } from '../src/secrets.ts'

// 票 09：执行器切到按范围读取与两级定位。全部用真实目录（FileTable + .state 侧表），
// 只 mock 进程边界（sessionQuery.readEvent）；文件直接写盘模拟用户手编、git、其他进程。

const WS = '/home/dev/proj-a'
const OTHER = '/home/dev/proj-b'
const DAY = 86_400_000
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

const MARKER_MISSING: DirectoryNoteCode = 'marker-missing'
const DIR_UNREADABLE: DirectoryNoteCode = 'dir-unreadable'
const RESERVED_KEYS: DirectoryNoteCode = 'reserved-keys'
const DUPLICATE_ID: DirectoryNoteCode = 'duplicate-id'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-exec-read-')) })
afterEach(async () => {
  await chmod(join(root, 'locked-dir'), 0o755).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = (p: string) => join(root, workspaceDirName(p))

const rec = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', createdAt: 1, updatedAt: 1, lastConfirmedAt: Date.now(), ...partial,
})
const wsRec = (partial: Partial<MemoryRecord> = {}, ws = WS) => rec({ scope: 'workspace', workspacePath: ws, ...partial })

async function ensureDir(dir: string, ws?: string) {
  await mkdir(dir, { recursive: true })
  if (ws !== undefined) await writeFile(join(dir, WORKSPACE_MARKER), ws + '\n')
}
/** 往记忆目录直接写一个文件（插件格式）。ws 给出时顺带写 .workspace 标记。 */
async function writeMem(dir: string, fileName: string, r: MemoryRecord, ws?: string): Promise<string> {
  await ensureDir(dir, ws)
  const path = join(dir, fileName)
  await writeFile(path, encodeRecord(r, {}))
  return path
}
async function writeRaw(dir: string, fileName: string, text: string, ws?: string): Promise<string> {
  await ensureDir(dir, ws)
  const path = join(dir, fileName)
  await writeFile(path, text)
  return path
}
/** 用户手写的记忆文件：只有 name / type / 正文。 */
const handBuilt = (name: string, body: string, type = 'preference') => `---\nname: ${name}\ntype: ${type}\n---\n\n${body}\n`

function harness(opts: { readEvent?: ReadEventFn; now?: number } = {}) {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
  const table = new FileTable({ root, stats: sidecar.recallStats })
  const store = new MemoryStore(table, undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const session = { id: 's-test', lastSeq: 10, turnStartSeq: 5 }
  /** ws 传 null 表示没有工作目录的会话（global 层视图）；默认当前项目。 */
  const ctx = (ws: string | null) => async () => ({ workspacePath: ws ?? undefined, session })
  const now = () => opts.now ?? Date.now()
  const healthDeps = (ws: string | null = WS): HealthToolDeps => ({
    store, registry, decisions, cache: sidecar.scanCache, thresholds: resolveHealthThresholds('normal'), resolveContext: ctx(ws), now,
  })
  const scanDeps = (ws: string | null = WS): ScanToolDeps => ({
    store, registry, decisions, cache: sidecar.scanCache, getBaseline: () => null, getLlm: () => null, resolveContext: ctx(ws), now,
  })
  const cache = new SnapshotCache({ store, registry, budget: 4000, memoryRoot: root })
  return {
    table, store, sidecar, decisions,
    search: (query: string, ws: string | null = WS) => executeSearch({ query }, fakeExec(), { store, registry, resolveContext: ctx(ws) }),
    /** 每次一个新 session（对应新开会话）：读盘组装、冻结。 */
    assemble: async (ws: string | null = WS) => {
      const s = {}
      cache.setWorkspacePath(s, ws ?? undefined)
      return cache.assemble(s)
    },
    health: async (args: { scope?: string } = {}, ws: string | null = WS) => executeHealth(args, healthDeps(ws), fakeExec()),
    scan: async (args: { scope?: string; scopes?: string[] } = {}, ws: string | null = WS) => executeScan({ layers: 'rule', ...args }, scanDeps(ws), fakeExec()),
    source: (memoryId: string, ws: string | null = WS) =>
      executeSource({ memoryId }, { workspacePath: ws ?? undefined }, { store, getReadEvent: () => opts.readEvent ?? null }),
    save: (args: Parameters<typeof executeSave>[0], ws: string | null = WS) =>
      executeSave(args, fakeExec(), { store, registry, resolveContext: ctx(ws), snapshots }),
    forget: (ids: string[]) => executeForget({ ids, reason: '测试' }, { workspacePath: WS }, { store, snapshots, decisions }),
  }
}

/** 递归快照：相对路径 → mtime（目录与文件都计）；.state/（侧表，含召回统计）不计。 */
async function treeSnapshot(dir: string, prefix = ''): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (rel === STATE_DIR) continue
    out[rel] = (await stat(join(dir, entry.name))).mtimeMs
    if (entry.isDirectory()) Object.assign(out, await treeSnapshot(join(dir, entry.name), `${rel}/`))
  }
  return out
}

function single<T extends { kind: string }>(r: T): Extract<T, { kind: 'single' }> {
  if (r.kind !== 'single') throw new Error(`expected single, got ${r.kind}`)
  return r as Extract<T, { kind: 'single' }>
}
function checkup<T extends { kind: string }>(r: T): Extract<T, { kind: 'checkup' }> {
  if (r.kind !== 'checkup') throw new Error(`expected checkup, got ${r.kind}`)
  return r as Extract<T, { kind: 'checkup' }>
}

describe('票 09 验收：执行器走按范围读取与两级定位', () => {
  it('外部写入可见：进程跑过一次操作后直接写 / 改 / 删文件，下一次 search、快照组装、health 都反映新状态，不经任何刷新', async () => {
    const h = harness()
    await ensureDir(wsDir(WS), WS)
    expect((await h.search('探针')).hits).toEqual([])
    expect(await h.assemble()).toBe(COLD_START_TEXT)
    expect(single(await h.health()).totalMemories).toBe(0)

    const path = await writeMem(wsDir(WS), 'probe.md', wsRec({ id: 'mem_probe', name: '外部探针', content: '外部写入的探针正文' }))
    expect((await h.search('探针')).hits.map(x => x.content)).toEqual(['外部写入的探针正文'])
    expect(await h.assemble()).toContain('外部写入的探针正文')
    expect(single(await h.health()).totalMemories).toBe(1)

    await writeFile(path, encodeRecord(wsRec({ id: 'mem_probe', name: '外部探针', content: '外部改过的探针正文' }), {}))
    expect((await h.search('探针')).hits.map(x => x.content)).toEqual(['外部改过的探针正文'])
    expect(await h.assemble()).toContain('外部改过的探针正文')

    await rm(path)
    expect((await h.search('探针')).hits).toEqual([])
    expect(await h.assemble()).toBe(COLD_START_TEXT)
    expect(single(await h.health()).totalMemories).toBe(0)
  })

  it('读路径零写入端到端：含 tmp 残留、重复 id、过期 deleted、手改 MEMORY.md 的真实目录 → search / health / source → 记忆目录全部目录项与 mtime 不变（recall-stats 除外）', async () => {
    const old = Date.now() - 30 * DAY
    await writeMem(globalDir(), 'g.md', rec({ id: 'mem_g', name: '全局探针', content: '零写入 全局' }))
    await writeMem(globalDir(), 'dup.md', rec({ id: 'mem_dup', name: '重复', content: '零写入 旧副本', updatedAt: 100 }))
    await writeMem(wsDir(WS), 'dup.md', wsRec({ id: 'mem_dup', name: '重复', content: '零写入 新副本', updatedAt: 200 }), WS)
    await writeMem(wsDir(WS), 'gone.md', wsRec({ id: 'mem_gone', status: 'deleted', updatedAt: old, deletedAt: old }))
    await writeMem(join(wsDir(WS), ARCHIVE_DIR), 'gone2.md', wsRec({ id: 'mem_gone2', status: 'deleted', updatedAt: old, deletedAt: old }))
    await writeRaw(wsDir(WS), `dup.md.tmp-${process.pid}-stale1`, '本进程的残留')
    await writeRaw(wsDir(WS), 'hand.md', handBuilt('手建', '零写入 手建正文'))
    await writeRaw(wsDir(WS), INDEX_FILE, '# 用户手改过的索引\n')
    await writeRaw(globalDir(), INDEX_FILE, '# 另一个手改索引\n')
    await new Promise(r => setTimeout(r, 5))
    const before = await treeSnapshot(root)

    const h = harness({ now: Date.now() + 10 * DAY })   // 远超保留期与 tmp 陈旧阈值：读路径也不能清
    expect((await h.search('零写入')).hits.map(x => x.id).sort()).toEqual(['mem_dup', 'mem_g', deriveFileId(relative(root, join(wsDir(WS), 'hand.md')))].sort())
    await h.health()
    await h.health({ scope: 'all' })
    await h.scan()
    await h.source('mem_dup')
    await h.source('mem_gone')
    await h.source(deriveFileId(relative(root, join(wsDir(WS), 'hand.md'))))

    expect(await treeSnapshot(root)).toEqual(before)
  })

  it('search 的文件路径与注入同口径：name 含密钥的不给路径，手起名的文件名带密钥的遮掉', async () => {
    await writeMem(globalDir(), `deploy-${FAKE_SECRET.sk}.md`, rec({ id: 'mem_h', name: '部署说明', content: 'pathalpha 手起名' }))
    await writeMem(globalDir(), 'gw.md', rec({ id: 'mem_n', name: `网关 ${FAKE_SECRET.github}`, content: 'pathbravo 名字带密钥' }))
    const h = harness()
    const named = (await h.search('pathalpha')).hits
    expect(named.map(x => x.path)).toEqual([join(globalDir(), `deploy-${SECRET_MASK}.md`)])
    const secretName = await h.search('pathbravo')
    expect(secretName.hits.map(x => x.id)).toEqual(['mem_n'])
    expect(secretName.hits[0].path).toBeUndefined()
    for (const text of [renderSearchResult(secretName), renderSearchResult({ hits: named })]) {
      expect(text).not.toContain(FAKE_SECRET.sk)
      expect(text).not.toContain(FAKE_SECRET.github)
    }
  })

  it('重复 id 说明里的路径同口径：name 含密钥的那份不给文件名，文件名带密钥的遮掉', async () => {
    await writeMem(wsDir(WS), 'kept.md', wsRec({ id: 'mem_d', name: `网关 ${FAKE_SECRET.github}`, content: '在用', updatedAt: 500 }), WS)
    await writeMem(globalDir(), `copy-${FAKE_SECRET.sk}.md`, rec({ id: 'mem_d', name: '网关', content: '副本', updatedAt: 400 }))
    const h = harness()
    const r = checkup(await h.health({ scope: 'all' }))
    const notes = r.directoryNotes.filter(n => n.code === DUPLICATE_ID)
    expect(notes.map(n => [n.path, n.keptPath])).toEqual([[join(globalDir(), `copy-${SECRET_MASK}.md`), join(wsDir(WS), SECRET_MASK)]])
    const text = renderHealthResult(r)
    expect(text).not.toContain(FAKE_SECRET.sk)
    expect(text).not.toContain(FAKE_SECRET.github)
  })

  it('保留键、缺标记目录说明里的路径同口径：name 含密钥的给目录加占位，路径带密钥的遮掉', async () => {
    const reservedBody = (name: string) => `---\nname: ${name}\ntype: preference\nrecallCount: 3\n---\n\n正文\n`
    await writeRaw(wsDir(WS), 'gw.md', reservedBody(`网关 ${FAKE_SECRET.github}`), WS)
    await writeRaw(wsDir(WS), `deploy-${FAKE_SECRET.sk}.md`, reservedBody('部署说明'))
    const stray = join(root, `stray-${FAKE_SECRET.sk}`)
    await writeMem(stray, 'x.md', rec({ id: 'mem_stray' }))
    const h = harness()
    for (const r of [single(await h.health()), checkup(await h.health({ scope: 'all' }))]) {
      expect(r.directoryNotes.filter(n => n.code === RESERVED_KEYS).map(n => n.path).sort()).toEqual([
        join(wsDir(WS), SECRET_MASK), join(wsDir(WS), `deploy-${SECRET_MASK}.md`),
      ].sort())
      expect(r.directoryNotes.find(n => n.code === MARKER_MISSING)?.path).toBe(join(root, `stray-${SECRET_MASK}`))
      const text = renderHealthResult(r)
      expect(JSON.stringify(r.directoryNotes)).not.toContain(FAKE_SECRET.sk)
      expect(JSON.stringify(r.directoryNotes)).not.toContain(FAKE_SECRET.github)
      expect(text).not.toContain(FAKE_SECRET.sk)
      expect(text).not.toContain(FAKE_SECRET.github)
    }
  })

  it('重复 id：search 返回一条且规则正确；副本在另一个项目时 health 报出、不删', async () => {
    // updatedAt 新者优先，压过目录偏好
    await writeMem(globalDir(), 'n.md', rec({ id: 'mem_n', content: 'dupalpha global 新', updatedAt: 300 }))
    await writeMem(wsDir(WS), 'n.md', wsRec({ id: 'mem_n', content: 'dupalpha 本项目 旧', updatedAt: 200 }), WS)
    // updatedAt 相同：当前 workspace 优先于 global
    await writeMem(globalDir(), 't.md', rec({ id: 'mem_t', content: 'dupbravo global', updatedAt: 200 }))
    await writeMem(wsDir(WS), 't.md', wsRec({ id: 'mem_t', content: 'dupbravo 本项目', updatedAt: 200 }))
    const h = harness()
    expect((await h.search('dupalpha')).hits.map(x => x.content)).toEqual(['dupalpha global 新'])
    expect((await h.search('dupbravo')).hits.map(x => x.content)).toEqual(['dupbravo 本项目'])

    // 本项目一条记录被复制到另一个项目：全库体检报出副本路径，两份文件都还在
    await writeMem(wsDir(WS), 'c.md', wsRec({ id: 'mem_c', content: '原件', updatedAt: 500 }))
    const copy = await writeMem(wsDir(OTHER), 'c.md', wsRec({ id: 'mem_c', content: '副本', updatedAt: 400 }, OTHER), OTHER)
    const r = checkup(await h.health({ scope: 'all' }))
    const note = r.directoryNotes.find(n => n.code === DUPLICATE_ID && n.path === copy)
    expect(note).toBeDefined()
    expect(note!.text).toContain(join(wsDir(WS), 'c.md'))
    expect(renderHealthResult(r)).toContain(copy)
    await stat(copy)
    await stat(join(wsDir(WS), 'c.md'))
  })

  it('重复 id：别层那份已不是 active（手改成 deleted、还没归档）时，不遮住仍在用的这份：search 与快照照常带它', async () => {
    await writeMem(globalDir(), 'd.md', rec({ id: 'mem_d', content: 'dupcharlie global 已删', status: 'deleted', deletedAt: 300, updatedAt: 300 }))
    await writeMem(wsDir(WS), 'd.md', wsRec({ id: 'mem_d', name: '本项目那份', content: 'dupcharlie 本项目 在用', updatedAt: 200 }), WS)
    const h = harness()
    expect((await h.search('dupcharlie')).hits.map(x => x.content)).toEqual(['dupcharlie 本项目 在用'])
    expect(await h.assemble()).toContain('dupcharlie 本项目 在用')
  })

  it('定位覆盖格式：带引号 id 能定位；只有 name/type/正文的手建文件 search 返回派生 id 后，维护点之前用该 id 做 source / update / forget 都能定位', async () => {
    await writeRaw(wsDir(WS), 'quoted.md', '---\nid: "mem_quoted"\nname: 引号\ntype: preference\n---\n\n带引号 id 的记忆\n', WS)
    await writeRaw(wsDir(WS), 'h1.md', handBuilt('手建一', '格式探针 用于回查'))
    await writeRaw(wsDir(WS), 'h2.md', handBuilt('手建二', '格式探针 用于更新'))
    await writeRaw(wsDir(WS), 'h3.md', handBuilt('手建三', '格式探针 用于遗忘'))
    const h = harness()

    expect((await h.search('带引号')).hits.map(x => x.id)).toEqual(['mem_quoted'])
    expect((await h.source('mem_quoted')).kind).toBe('no-source')

    const hits = await h.search('格式探针')
    const idOf = (file: string) => deriveFileId(relative(root, join(wsDir(WS), file)))
    expect(hits.hits.map(x => x.id).sort()).toEqual([idOf('h1.md'), idOf('h2.md'), idOf('h3.md')].sort())

    expect((await h.source(idOf('h1.md'))).kind).toBe('no-source')
    const updated = await h.save({ action: 'update', id: idOf('h2.md'), name: '手建二', type: 'preference', scope: 'workspace', content: '格式探针 已更新', summary: '更新过', sourceMode: 'user-explicit' })
    expect(updated.kind).toBe('updated')
    const forgot = await h.forget([idOf('h3.md'), 'mem_quoted'])
    expect(forgot.forgotten.sort()).toEqual([idOf('h3.md'), 'mem_quoted'].sort())
    expect(forgot.missing).toEqual([])
  })

  it('隔离条目按所在目录归层出 malformed finding；缺标记 / 不可读目录、含保留键的文件在 health / scan 结果里列出', async () => {
    await writeMem(wsDir(WS), 'ok.md', wsRec({ id: 'mem_ok' }), WS)
    const wsBad = await writeRaw(wsDir(WS), 'bad.md', '没有 frontmatter\n')
    const globalBad = await writeRaw(globalDir(), 'gbad.md', '---\nname: [未闭合\n---\n正文\n')
    await writeRaw(wsDir(OTHER), 'obad.md', '没有 frontmatter\n', OTHER)
    await writeMem(wsDir(OTHER), 'ofine.md', wsRec({ id: 'mem_other' }, OTHER))
    const reserved = await writeRaw(wsDir(WS), 'reserved.md', '---\nname: 保留键\ntype: preference\nrecallCount: 3\n---\n\n正文\n')
    const stray = join(root, 'stray-dir')
    await writeMem(stray, 'x.md', rec({ id: 'mem_stray' }))
    const locked = join(root, 'locked-dir')
    await writeMem(locked, 'y.md', rec({ id: 'mem_locked' }), '/home/dev/locked')
    await chmod(locked, 0o000)
    const h = harness()

    const ws = single(await h.health())
    expect(ws.breakdown.ruleLayer.malformed).toBe(1)
    const codes = ws.directoryNotes.map(n => [n.code, n.path])
    expect(codes).toContainEqual([MARKER_MISSING, stray])
    expect(codes).toContainEqual([DIR_UNREADABLE, locked])
    expect(codes).toContainEqual([RESERVED_KEYS, reserved])
    const rendered = renderHealthResult(ws)
    expect(rendered).toContain(stray)
    expect(rendered).toContain(locked)
    expect(rendered).toContain(reserved)

    expect(single(await h.health({}, null)).breakdown.ruleLayer.malformed).toBe(1)   // global 层只算 gbad

    const scan = single(await h.scan())
    const malformed = scan.findings.filter(f => f.type === 'malformed')
    expect(malformed.map(f => f.summary.includes(wsBad))).toEqual([true])
    expect(scan.directoryNotes.map(n => n.code)).toEqual(expect.arrayContaining([MARKER_MISSING, DIR_UNREADABLE, RESERVED_KEYS]))
    expect(renderScanResult(scan)).toContain(stray)
    const globalScan = single(await h.scan({}, null))
    expect(globalScan.findings.filter(f => f.type === 'malformed').map(f => f.summary.includes(globalBad))).toEqual([true])

    const all = checkup(await h.health({ scope: 'all' }))
    expect(all.rows.map(r => [r.workspacePath ?? 'global', r.issueSummary.includes('malformed 1')])).toEqual([
      ['global', true], [WS, true], [OTHER, true],
    ])
    expect(all.directoryNotes.map(n => n.code)).toEqual(expect.arrayContaining([MARKER_MISSING, DIR_UNREADABLE]))
    const scanAll = checkup(await h.scan({ scope: 'all' }))
    expect(scanAll.directoryNotes.map(n => n.code)).toEqual(expect.arrayContaining([MARKER_MISSING, DIR_UNREADABLE]))
  })

  it('冷启动文案：可见集合为空且无隔离文件才说记忆库为空；有隔离文件说「有 N 个文件无法解析」', async () => {
    const h = harness()
    await writeRaw(wsDir(OTHER), 'obad.md', '没有 frontmatter\n', OTHER)   // 别的项目的坏文件不在可见集合
    expect(await h.assemble()).toBe(COLD_START_TEXT)

    await writeRaw(wsDir(WS), 'bad1.md', '没有 frontmatter\n', WS)
    await writeRaw(globalDir(), 'bad2.md', '没有 frontmatter\n')
    const text = await h.assemble()
    expect(text).toBe(coldStartUnparseableText(2))
    expect(text).toContain('有 2 个文件无法解析')
    expect(text).not.toContain('记忆库当前为空')
  })

  it('过期（validTo 已过）的 active 文件留在顶层、不注入不检索；expired finding 建议文案同时给出「延长 validTo」和「memory_forget」', async () => {
    const path = await writeMem(wsDir(WS), 'expired.md', wsRec({ id: 'mem_exp', name: '过期探针', content: '过期 探针正文', validTo: Date.now() - DAY }), WS)
    await writeMem(wsDir(WS), 'live.md', wsRec({ id: 'mem_live', name: '有效', content: '有效 探针正文' }))
    const mtime = (await stat(path)).mtimeMs
    const h = harness()

    expect((await h.search('探针正文')).hits.map(x => x.id)).toEqual(['mem_live'])
    const text = await h.assemble()
    expect(text).toContain('有效 探针正文')
    expect(text).not.toContain('过期 探针正文')
    expect((await stat(path)).mtimeMs).toBe(mtime)

    const expired = single(await h.scan()).findings.find(f => f.type === 'expired')
    expect(expired?.memoryIds).toEqual(['mem_exp'])
    expect(expired!.suggestedAction).toContain('延长 validTo')
    expect(expired!.suggestedAction).toContain('memory_forget')
  })

  it('handEdited 记录渲染带「已手编，出处可能不对应」，memory_source 对无 source 返回「无出处」', async () => {
    const edited = wsRec({ id: 'mem_edit', name: '手编探针', content: '原文', source: { sessionId: 'sess-1', eventRange: [3, 4], sourceMode: 'agent-inferred' } })
    const path = await writeMem(wsDir(WS), 'edit.md', edited, WS)
    await writeFile(path, (await readFile(path, 'utf8')).replace('原文', '手编探针 用户改过的正文'))
    await writeRaw(wsDir(WS), 'nosrc.md', handBuilt('无出处探针', '手编探针 手写的'))
    const readEvent: ReadEventFn = async () => ({ events: [{ type: 'agent/inbox/spliced', seq: 3, data: { inserted: [{ role: 'user', content: [{ type: 'text', text: '当时的话' }] }] } }] })
    const h = harness({ readEvent })

    const hit = (await h.search('用户改过')).hits[0]
    expect(hit.id).toBe('mem_edit')
    expect(renderSearchResult({ hits: [hit] })).toContain(HAND_EDITED_NOTE)
    expect(HAND_EDITED_NOTE).toContain('已手编，出处可能不对应')
    expect(await h.assemble()).toContain(HAND_EDITED_NOTE)

    const src = await h.source('mem_edit')
    expect(src.kind).toBe('ok')
    expect(renderSourceResult(src)).toContain('已手编，出处可能不对应')

    const noSourceId = deriveFileId(relative(root, join(wsDir(WS), 'nosrc.md')))
    const none = await h.source(noSourceId)
    expect(none.kind).toBe('no-source')
    expect(renderSourceResult(none)).toContain('无出处')
  })

  it('health / scan 的预读从 PR1 的「全库 active + superseded + deleted」收窄到目标层（含该层 .archive/）；orphan 与跨层存活核对需要的跨层引用改为按 id 定位，不再整库预读', async () => {
    // 本项目：一条记录 supersedes 三个目标——另一个项目里活着的、本层归档里已删的、哪儿都没有的
    await writeMem(wsDir(WS), 'a1.md', wsRec({ id: 'mem_a1', supersedes: ['mem_b_alive', 'mem_a_archived', 'mem_nowhere'] }), WS)
    await writeMem(join(wsDir(WS), ARCHIVE_DIR), 'a0.md', wsRec({ id: 'mem_a_archived', status: 'deleted', deletedAt: Date.now() }))
    await writeMem(wsDir(OTHER), 'b.md', wsRec({ id: 'mem_b_alive' }, OTHER), OTHER)
    await writeMem(wsDir(OTHER), 'b2.md', wsRec({ id: 'mem_b_other' }, OTHER))
    const h = harness()
    // 语义缓存里一条跨层冗余（本项目 + 另一个项目的活记录）：存活核对要按 id 定位到对方
    const redundancy: Finding = { type: 'redundancy', layer: 'semantic', severity: 'info', memoryIds: ['mem_a1', 'mem_b_alive'], summary: '', suggestedAction: '' }
    await h.sidecar.scanCache.put(`cache_${WS}`, { id: `cache_${WS}`, scannedAt: Date.now(), scope: WS, findings: [redundancy] })

    const readScope = vi.spyOn(h.table, 'readScope')
    const locate = vi.spyOn(h.table, 'locate')
    const r = single(await h.health())
    const dirsRead = readScope.mock.calls.flatMap(c => c[0])
    expect(dirsRead).not.toContain(wsDir(OTHER))
    expect(readScope.mock.calls.every(c => c[1]?.includeArchive === true)).toBe(true)
    expect(locate.mock.calls.map(c => c[0]).sort()).toEqual(['mem_b_alive', 'mem_nowhere'])
    expect(r.breakdown.ruleLayer.orphan).toBe(1)
    expect(r.breakdown.semanticLayer.redundancy).toBe(1)

    readScope.mockClear()
    const scan = single(await h.scan())
    expect(readScope.mock.calls.flatMap(c => c[0])).not.toContain(wsDir(OTHER))
    const orphan = scan.findings.find(f => f.type === 'orphan')
    expect(orphan?.summary).toContain('mem_a_archived')
    expect(orphan?.summary).toContain('mem_nowhere')
    expect(orphan?.summary).not.toContain('mem_b_alive')
  })

  it('快照冻结计召回从同一次读取判断存活，不逐 id 定位', async () => {
    await writeMem(wsDir(WS), 'core.md', wsRec({ id: 'mem_core', content: '核心偏好' }), WS)
    const h = harness()
    const locate = vi.spyOn(h.table, 'locate')
    expect(await h.assemble()).toContain('核心偏好')
    expect(locate).not.toHaveBeenCalled()
    expect((await h.sidecar.recallStats.get('mem_core'))?.recallCount).toBe(1)
  })
})
