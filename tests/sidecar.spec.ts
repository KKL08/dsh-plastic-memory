import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { SidecarStore, STATE_DIR, KV_IMPORT_MARKER, KV_IMPORT_LOCK, RECALL_STATS_FILE, type LegacyKvTables } from '../src/storage/sidecar.ts'
import { kvImportMarkerSchema } from '../src/storage/schema.ts'
import {
  memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema,
  type MemorySnapshot, type PendingDecision, type ScanCacheEntry,
} from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema }

function snap(id: string, partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return { id, createdAt: 1, operation: 'manual', description: id, memoryIds: [], data: [], ...partial }
}
function pd(id: string, partial: Partial<PendingDecision> = {}): PendingDecision {
  return { id, memoryIds: ['mem_a', 'mem_b'], summary: id, firstSeenAt: 1, ...partial }
}
function cacheEntry(id: string): ScanCacheEntry {
  return { id, scannedAt: 1, scope: 'all', findings: [] }
}

/** 收集 warn，坏文件跳过要留痕。 */
function makeLog() {
  const warns: string[] = []
  return { warns, log: { info() {}, warn: (m: string) => { warns.push(m) }, error() {} } }
}

let root: string
let state: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-sidecar-'))
  state = join(root, STATE_DIR)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function exists(path: string) {
  return stat(path).then(() => true, () => false)
}

/** 递归列出 .state 下所有文件（相对路径）。 */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) out.push(...await listFiles(join(dir, e.name), `${prefix}${e.name}/`))
    else out.push(prefix + e.name)
  }
  return out.sort()
}

describe('SidecarStore：四张表落 .state/', () => {
  it('构造不做 I/O：.state/ 不存在', async () => {
    new SidecarStore({ root, schemas })
    expect(await exists(state)).toBe(false)
  })

  it('snapshots：每条一个 snapshots/<id>.json，get / list / delete', async () => {
    const s = new SidecarStore({ root, schemas })
    await s.snapshots.put('snap_a', snap('snap_a'))
    await s.snapshots.put('snap_b', snap('snap_b', { data: [record({ id: 'mem_x' })] }))
    const raw = JSON.parse(await readFile(join(state, 'snapshots', 'snap_b.json'), 'utf8'))
    expect(memorySnapshotSchema.parse(raw).data[0]!.id).toBe('mem_x')
    expect((await s.snapshots.get('snap_a'))?.description).toBe('snap_a')
    expect((await s.snapshots.list()).map(([k]) => k).sort()).toEqual(['snap_a', 'snap_b'])
    expect(await s.snapshots.delete('snap_a')).toBe(true)
    expect(await s.snapshots.delete('snap_a')).toBe(false)
    expect(await s.snapshots.get('snap_a')).toBeUndefined()
    expect(await exists(join(state, 'snapshots', 'snap_a.json'))).toBe(false)
  })

  it('pending：每条一个 pending/<id>.json；覆盖写取最新值', async () => {
    const s = new SidecarStore({ root, schemas })
    await s.pending.put('pd_a', pd('pd_a'))
    await s.pending.put('pd_a', pd('pd_a', { summary: '改过' }))
    expect(await listFiles(join(state, 'pending'))).toEqual(['pd_a.json'])
    expect((await s.pending.get('pd_a'))?.summary).toBe('改过')
    expect(await s.pending.list()).toEqual([['pd_a', pd('pd_a', { summary: '改过' })]])
  })

  it('scan-cache：文件名是 sha1(桶键)，list 还原原始桶键', async () => {
    const s = new SidecarStore({ root, schemas })
    const key = 'cache_/home/dev/proj'
    await s.scanCache.put(key, cacheEntry(key))
    const hashed = createHash('sha1').update(key).digest('hex')
    expect(await listFiles(join(state, 'scan-cache'))).toEqual([`${hashed}.json`])
    expect(await s.scanCache.get(key)).toEqual(cacheEntry(key))
    expect(await s.scanCache.list()).toEqual([[key, cacheEntry(key)]])
    expect(await s.scanCache.delete(key)).toBe(true)
    expect(await s.scanCache.list()).toEqual([])
  })

  it('recall-stats：整张表一个 recall-stats.json；删不存在的键不建文件', async () => {
    const s = new SidecarStore({ root, schemas })
    expect(await s.recallStats.delete('mem_none')).toBe(false)
    expect(await s.recallStats.get('mem_none')).toBeUndefined()
    expect(await exists(state)).toBe(false)

    await s.recallStats.put('mem_a', { id: 'mem_a', recallCount: 1, lastRecalledAt: 10 })
    await s.recallStats.put('mem_b', { id: 'mem_b', recallCount: 2, lastRecalledAt: null })
    const raw = JSON.parse(await readFile(join(state, RECALL_STATS_FILE), 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(['mem_a', 'mem_b'])
    expect(await s.recallStats.get('mem_b')).toEqual({ id: 'mem_b', recallCount: 2, lastRecalledAt: null })
    expect(await s.recallStats.delete('mem_a')).toBe(true)
    expect((await s.recallStats.list()).map(([k]) => k)).toEqual(['mem_b'])
  })

  it('recall-stats.putMany：一次写入多条、与已有条目合并，只换一次文件', async () => {
    const s = new SidecarStore({ root, schemas })
    await s.recallStats.put('mem_a', { id: 'mem_a', recallCount: 1, lastRecalledAt: 1 })
    const before = (await stat(join(state, RECALL_STATS_FILE))).ino
    await s.recallStats.putMany([
      ['mem_b', { id: 'mem_b', recallCount: 2, lastRecalledAt: 2 }],
      ['mem_c', { id: 'mem_c', recallCount: 3, lastRecalledAt: 3 }],
    ])
    expect((await s.recallStats.list()).map(([k]) => k).sort()).toEqual(['mem_a', 'mem_b', 'mem_c'])
    expect((await stat(join(state, RECALL_STATS_FILE))).ino).not.toBe(before) // tmp + rename 换了文件
    expect((await listFiles(state)).filter(f => f.includes('.tmp-'))).toEqual([])
  })

  it('recall-stats 跨实例可见：另一个实例（模拟另一进程）写入后本实例读到新值', async () => {
    const a = new SidecarStore({ root, schemas })
    const b = new SidecarStore({ root, schemas })
    await a.recallStats.put('mem_a', { id: 'mem_a', recallCount: 1, lastRecalledAt: 1 })
    expect((await b.recallStats.get('mem_a'))?.recallCount).toBe(1)
    await b.recallStats.put('mem_a', { id: 'mem_a', recallCount: 5, lastRecalledAt: 2 })
    expect((await a.recallStats.get('mem_a'))?.recallCount).toBe(5)
  })

  it('原子写：并发写入后没有 tmp 残留，单文件表的并发 put 不丢条目（进程内串行）', async () => {
    const s = new SidecarStore({ root, schemas })
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => s.snapshots.put(`snap_${i}`, snap(`snap_${i}`))),
      ...Array.from({ length: 10 }, (_, i) => s.pending.put(`pd_${i}`, pd(`pd_${i}`))),
      ...Array.from({ length: 10 }, (_, i) => s.scanCache.put(`cache_${i}`, cacheEntry(`cache_${i}`))),
      ...Array.from({ length: 10 }, (_, i) => s.recallStats.put(`mem_${i}`, { id: `mem_${i}`, recallCount: i, lastRecalledAt: null })),
    ])
    const files = await listFiles(state)
    expect(files.filter(f => f.includes('.tmp-'))).toEqual([])
    expect(files.filter(f => f.startsWith('snapshots/'))).toHaveLength(10)
    expect(files.filter(f => f.startsWith('pending/'))).toHaveLength(10)
    expect(files.filter(f => f.startsWith('scan-cache/'))).toHaveLength(10)
    expect(await s.recallStats.list()).toHaveLength(10)
  })

  it('坏 JSON 与不合 schema 的文件跳过并记日志，不抛；在途 tmp 文件不当成条目', async () => {
    const { warns, log } = makeLog()
    const s = new SidecarStore({ root, schemas, log })
    await s.snapshots.put('snap_ok', snap('snap_ok'))
    await writeFile(join(state, 'snapshots', 'snap_broken.json'), '{ not json', 'utf8')
    await writeFile(join(state, 'snapshots', 'snap_shape.json'), JSON.stringify({ id: 'snap_shape' }), 'utf8')
    await writeFile(join(state, 'snapshots', 'snap_x.json.tmp-1-abc'), JSON.stringify(snap('snap_x')), 'utf8')
    expect((await s.snapshots.list()).map(([k]) => k)).toEqual(['snap_ok'])
    expect(await s.snapshots.get('snap_broken')).toBeUndefined()
    expect(await s.snapshots.get('snap_shape')).toBeUndefined()
    expect(warns.some(w => w.includes('snap_broken.json'))).toBe(true)
    expect(warns.some(w => w.includes('snap_shape.json'))).toBe(true)
  })

  it('recall-stats.json 整体坏掉按空表读、不抛；单条不合 schema 只跳过那一条', async () => {
    const { warns, log } = makeLog()
    const s = new SidecarStore({ root, schemas, log })
    await mkdir(state, { recursive: true })
    await writeFile(join(state, RECALL_STATS_FILE), 'garbage', 'utf8')
    expect(await s.recallStats.list()).toEqual([])
    expect(warns.length).toBeGreaterThan(0)

    await writeFile(join(state, RECALL_STATS_FILE), JSON.stringify({
      mem_ok: { id: 'mem_ok', recallCount: 1, lastRecalledAt: null },
      mem_bad: { id: 'mem_bad', recallCount: 'many' },
    }), 'utf8')
    expect((await s.recallStats.list()).map(([k]) => k)).toEqual(['mem_ok'])
    expect(warns.some(w => w.includes('mem_bad'))).toBe(true)
  })

  it('put 的键必须等于值的 id（list 从文件内容还原键）', async () => {
    const s = new SidecarStore({ root, schemas })
    await expect(s.snapshots.put('snap_a', snap('snap_b'))).rejects.toThrow()
    await expect(s.scanCache.put('k1', cacheEntry('k2'))).rejects.toThrow()
  })
})

describe('SidecarStore：KV 导入协议', () => {
  /** 旧 KV 替身。open 在调用那一刻拷下两张表；discard 先跑 onDiscard（可抛错），不抛才清空两张表（像宿主那样删行）。 */
  function legacyOf(tables: Partial<LegacyKvTables>, opts: { onDiscard?: () => Promise<void> } = {}) {
    let calls = 0
    let discards = 0
    const rows = { snapshots: [...(tables.snapshots ?? [])], pending: [...(tables.pending ?? [])] }
    const open = async (): Promise<LegacyKvTables> => {
      calls++
      return {
        snapshots: [...rows.snapshots],
        pending: [...rows.pending],
        discard: async () => {
          discards++
          if (opts.onDiscard) await opts.onDiscard()
          rows.snapshots = []
          rows.pending = []
        },
      }
    }
    return { open, calls: () => calls, discards: () => discards }
  }
  async function readMarker() {
    return kvImportMarkerSchema.parse(JSON.parse(await readFile(join(state, KV_IMPORT_MARKER), 'utf8')))
  }

  it('无旧 KV：首次访问写 source: none 的标记', async () => {
    const s = new SidecarStore({ root, schemas, now: () => 42 })
    expect(await s.snapshots.list()).toEqual([])
    expect(await readMarker()).toEqual({ version: 1, importedAt: 42, source: 'none', counts: { snapshots: 0, pending: 0 } })
  })

  it('旧 KV 服务暂时缺席（openLegacyKv 返回 undefined）：不写标记，本进程只探测一次；下个实例重新探测，服务在了就导入', async () => {
    let probes = 0
    const absent = new SidecarStore({ root, schemas, openLegacyKv: async () => { probes++; return undefined } })
    await absent.snapshots.put('snap_n', snap('snap_n'))
    expect(await exists(join(state, KV_IMPORT_MARKER))).toBe(false)
    await absent.pending.list()
    await absent.scanCache.get('x')
    expect(probes).toBe(1)
    expect(await exists(join(state, KV_IMPORT_MARKER))).toBe(false)

    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]], pending: [['pd_a', pd('pd_a')]] })
    const next = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect((await next.snapshots.list()).map(([k]) => k).sort()).toEqual(['snap_a', 'snap_n'])
    expect((await next.pending.list()).map(([k]) => k)).toEqual(['pd_a'])
    expect(await readMarker()).toMatchObject({ source: 'kv', counts: { snapshots: 1, pending: 1 } })
    expect(legacy.calls()).toBe(1)
  })

  it('旧 KV 服务在但两张表都空：写 source: none 的标记，不丢弃', async () => {
    const legacy = legacyOf({})
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open, now: () => 9 })
    expect(await s.snapshots.list()).toEqual([])
    expect(await readMarker()).toEqual({ version: 1, importedAt: 9, source: 'none', counts: { snapshots: 0, pending: 0 } })
    expect(legacy.discards()).toBe(0)
  })

  it('有旧 KV：首次访问前导入 snapshots 与 pending，写 source: kv 的标记与条数', async () => {
    const legacy = legacyOf({
      snapshots: [['snap_a', snap('snap_a')], ['snap_b', snap('snap_b')]],
      pending: [['pd_a', pd('pd_a')]],
    })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open, now: () => 7 })
    expect((await s.pending.list()).map(([k]) => k)).toEqual(['pd_a'])
    expect((await s.snapshots.list()).map(([k]) => k).sort()).toEqual(['snap_a', 'snap_b'])
    expect(await readMarker()).toEqual({ version: 1, importedAt: 7, source: 'kv', counts: { snapshots: 2, pending: 1 }, discarded: true })
    expect(legacy.calls()).toBe(1)
  })

  it('并发首次访问只导入一次', async () => {
    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]] })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    await Promise.all([s.snapshots.list(), s.pending.list(), s.scanCache.get('x'), s.snapshots.put('snap_n', snap('snap_n'))])
    expect(legacy.calls()).toBe(1)
    expect((await s.snapshots.list()).map(([k]) => k).sort()).toEqual(['snap_a', 'snap_n'])
  })

  it('标记已存在：不再打开旧 KV', async () => {
    await new SidecarStore({ root, schemas }).snapshots.list() // 写 none 标记
    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]] })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect(await s.snapshots.list()).toEqual([])
    expect(legacy.calls()).toBe(0)
  })

  it('召回统计不经导入屏障：只碰 recall-stats 不触发导入', async () => {
    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]] })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    await s.recallStats.get('mem_a')
    await s.recallStats.put('mem_a', { id: 'mem_a', recallCount: 1, lastRecalledAt: null })
    expect(legacy.calls()).toBe(0)
    expect(await exists(join(state, KV_IMPORT_MARKER))).toBe(false)
  })

  it('导入中断后续传：已迁入且被改过的条目不被覆盖，缺的补上，标记出现', async () => {
    // 上次导入写了两条就崩了（无标记）；之后插件改过其中一条
    await mkdir(join(state, 'snapshots'), { recursive: true })
    await mkdir(join(state, 'pending'), { recursive: true })
    await writeFile(join(state, 'snapshots', 'snap_a.json'), JSON.stringify(snap('snap_a')), 'utf8')
    await writeFile(join(state, 'pending', 'pd_a.json'), JSON.stringify(pd('pd_a', { summary: '迁移后改过' })), 'utf8')
    const legacy = legacyOf({
      snapshots: [['snap_a', snap('snap_a')], ['snap_b', snap('snap_b')]],
      pending: [['pd_a', pd('pd_a', { summary: 'KV 里的旧值' })], ['pd_b', pd('pd_b')]],
    })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect((await s.pending.get('pd_a'))?.summary).toBe('迁移后改过')
    expect((await s.pending.get('pd_b'))?.id).toBe('pd_b')
    expect((await s.snapshots.list()).map(([k]) => k).sort()).toEqual(['snap_a', 'snap_b'])
    expect((await readMarker()).counts).toEqual({ snapshots: 2, pending: 2 })
    expect((await listFiles(state)).filter(f => f.includes('.tmp-'))).toEqual([])
  })

  it('旧 KV 里不合 schema 或键不能当文件名的条目跳过并记日志，其余照常导入', async () => {
    const { warns, log } = makeLog()
    const legacy = legacyOf({
      snapshots: [['snap_ok', snap('snap_ok')], ['snap_bad', { id: 'snap_bad' }], ['../evil', snap('../evil')]],
    })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open, log })
    expect((await s.snapshots.list()).map(([k]) => k)).toEqual(['snap_ok'])
    expect((await readMarker()).counts.snapshots).toBe(1)
    expect(warns.some(w => w.includes('snap_bad'))).toBe(true)
    expect(warns.some(w => w.includes('../evil'))).toBe(true)
    expect(await exists(join(root, 'evil.json'))).toBe(false)
  })

  it('打开旧 KV 失败：不写标记、记日志，侧表照常可用；下一个实例（下次启动）重试', async () => {
    const { warns, log } = makeLog()
    const s = new SidecarStore({ root, schemas, log, openLegacyKv: async () => { throw new Error('domain busy') } })
    await s.snapshots.put('snap_n', snap('snap_n'))
    expect((await s.snapshots.list()).map(([k]) => k)).toEqual(['snap_n'])
    expect(await exists(join(state, KV_IMPORT_MARKER))).toBe(false)
    expect(warns.some(w => w.includes('domain busy'))).toBe(true)

    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]] })
    const next = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect((await next.snapshots.list()).map(([k]) => k).sort()).toEqual(['snap_a', 'snap_n'])
    expect((await readMarker()).source).toBe('kv')
  })

  it('标记文件坏掉按缺失处理，重新导入（排他创建保证不覆盖）；损坏只告警一次', async () => {
    const { warns, log } = makeLog()
    await mkdir(state, { recursive: true })
    await writeFile(join(state, KV_IMPORT_MARKER), '{ broken', 'utf8')
    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]] })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open, log })
    expect((await s.snapshots.list()).map(([k]) => k)).toEqual(['snap_a'])
    expect(legacy.calls()).toBe(1)
    expect(warns.filter(w => w.includes('导入标记损坏'))).toHaveLength(1)
    expect((await readMarker()).source).toBe('kv')
  })

  it('导入完成后丢弃旧 KV 行：恰好一次，且发生在标记写下之后', async () => {
    let markerAtDiscard: boolean | undefined
    const legacy = legacyOf(
      { snapshots: [['snap_a', snap('snap_a')]], pending: [['pd_a', pd('pd_a')]] },
      { onDiscard: async () => { markerAtDiscard = await exists(join(state, KV_IMPORT_MARKER)) } },
    )
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    await s.snapshots.list()
    await s.pending.list()
    expect(legacy.discards()).toBe(1)
    expect(markerAtDiscard).toBe(true)
  })

  it('标记已存在：不丢弃旧 KV', async () => {
    await new SidecarStore({ root, schemas }).snapshots.list() // 写 none 标记
    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]] })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    await s.snapshots.list()
    expect(legacy.discards()).toBe(0)
  })

  it('丢弃失败只记日志：本次操作照常成功，标记保留', async () => {
    const { warns, log } = makeLog()
    const legacy = legacyOf(
      { snapshots: [['snap_a', snap('snap_a')]] },
      { onDiscard: async () => { throw new Error('kv locked') } },
    )
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open, log })
    expect((await s.snapshots.list()).map(([k]) => k)).toEqual(['snap_a'])
    expect(legacy.discards()).toBe(1)
    expect(warns.some(w => w.includes('kv locked'))).toBe(true)
    expect((await readMarker()).source).toBe('kv')
  })

  it('丢弃后标记再丢失：重新导入找不到旧行，期间删掉的待决不会复活', async () => {
    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]], pending: [['pd_a', pd('pd_a')]] })
    const first = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect((await first.pending.list()).map(([k]) => k)).toEqual(['pd_a'])
    expect(await first.pending.delete('pd_a')).toBe(true) // 冲突已处理
    await rm(join(state, KV_IMPORT_MARKER))

    const second = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect(await second.pending.list()).toEqual([])
    expect(legacy.calls()).toBe(2)
    expect((await readMarker()).counts).toEqual({ snapshots: 0, pending: 0 })
  })

  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    return { promise, resolve }
  }

  it('两个进程同时启动：先导完的一方之后被处理掉的待决，不会被晚一步的导入者写回来', async () => {
    const legacy = legacyOf({ pending: [['pd_p', pd('pd_p')]] })
    /** open 拷下行之后停在 gate 上，模拟取完旧行还没写盘的进程。 */
    const gatedOpen = (gate: Promise<void>, opened: () => void) => async () => {
      const tables = await legacy.open()
      opened()
      await gate
      return tables
    }
    const aGate = deferred(), aOpened = deferred(), bGate = deferred(), bOpened = deferred(), bReached = deferred()
    const a = new SidecarStore({ root, schemas, openLegacyKv: gatedOpen(aGate.promise, aOpened.resolve) })
    // B 的 now 被调到 = B 已越过标记检查（走到导入锁或写标记）；open 被调到同理
    const b = new SidecarStore({ root, schemas, openLegacyKv: gatedOpen(bGate.promise, bOpened.resolve), now: () => { bReached.resolve(); return Date.now() } })

    const aList = a.pending.list()
    await aOpened.promise // A 正在导入，标记未写
    const bList = b.pending.list()
    await Promise.race([bOpened.promise, bReached.promise])
    aGate.resolve()
    expect((await aList).map(([k]) => k)).toEqual(['pd_p'])
    expect(await a.pending.delete('pd_p')).toBe(true) // 迁移完成后用户处理掉了 P
    bGate.resolve()
    await bList

    expect(await b.pending.list()).toEqual([])
    expect(await a.pending.get('pd_p')).toBeUndefined()
    expect(legacy.calls()).toBe(1) // B 在锁内看到标记，没有再取旧行
  })

  it.each([
    ['早先版本写的标记（无 discarded 字段）', {}],
    ['discarded: false', { discarded: false }],
  ])('标记写下但旧行没删（%s）：下次启动补删旧行，不重新导入', async (_, extra) => {
    await mkdir(state, { recursive: true })
    await writeFile(join(state, KV_IMPORT_MARKER), JSON.stringify({ version: 1, importedAt: 1, source: 'kv', counts: { snapshots: 1, pending: 1 }, ...extra }), 'utf8')
    // 导入之后用户处理掉了 pd_a、删了 snap_a，旧行还留在 KV 里
    const legacy = legacyOf({ snapshots: [['snap_a', snap('snap_a')]], pending: [['pd_a', pd('pd_a')]] })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect(await s.pending.list()).toEqual([])
    expect(await s.snapshots.list()).toEqual([])
    expect(legacy.discards()).toBe(1)
    expect(await readMarker()).toEqual({ version: 1, importedAt: 1, source: 'kv', counts: { snapshots: 1, pending: 1 }, discarded: true })

    const again = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    await again.snapshots.list()
    expect(legacy.calls()).toBe(1) // 清理完成后不再打开旧 KV
  })

  it('删除旧行失败：标记记为未清理，下次启动重试删除，期间处理掉的待决不复活', async () => {
    const { warns, log } = makeLog()
    let attempts = 0
    const legacy = legacyOf({ pending: [['pd_a', pd('pd_a')]] }, { onDiscard: async () => { if (++attempts === 1) throw new Error('kv locked') } })
    const first = new SidecarStore({ root, schemas, openLegacyKv: legacy.open, log })
    expect((await first.pending.list()).map(([k]) => k)).toEqual(['pd_a'])
    expect(warns.some(w => w.includes('kv locked'))).toBe(true)
    expect((await readMarker()).discarded).toBe(false)
    expect(await first.pending.delete('pd_a')).toBe(true)

    const second = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect(await second.pending.list()).toEqual([])
    expect(legacy.discards()).toBe(2)
    expect((await readMarker()).discarded).toBe(true)
  })

  it('旧行待清理时宿主没有 KV 服务：标记保持未清理，服务回来后再删', async () => {
    await mkdir(state, { recursive: true })
    await writeFile(join(state, KV_IMPORT_MARKER), JSON.stringify({ version: 1, importedAt: 1, source: 'kv', counts: { snapshots: 0, pending: 1 }, discarded: false }), 'utf8')
    const absent = new SidecarStore({ root, schemas, openLegacyKv: async () => undefined })
    expect(await absent.pending.list()).toEqual([])
    expect((await readMarker()).discarded).toBe(false)

    const legacy = legacyOf({ pending: [['pd_a', pd('pd_a')]] })
    const next = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect(await next.pending.list()).toEqual([])
    expect(legacy.discards()).toBe(1)
    expect((await readMarker()).discarded).toBe(true)
  })

  it.each([
    ['持锁进程已退出', () => ({ pid: spawnSync(process.execPath, ['-e', '']).pid, at: Date.now() })],
    ['锁超时', () => ({ pid: process.pid, at: 0 })],
  ])('导入锁残留（%s）：清掉后照常导入，导完不留锁', async (_, lockOf) => {
    await mkdir(state, { recursive: true })
    await writeFile(join(state, KV_IMPORT_LOCK), JSON.stringify({ ...lockOf(), id: 'stale' }), 'utf8')
    const legacy = legacyOf({ pending: [['pd_a', pd('pd_a')]] })
    const s = new SidecarStore({ root, schemas, openLegacyKv: legacy.open })
    expect((await s.pending.list()).map(([k]) => k)).toEqual(['pd_a'])
    expect((await readMarker()).discarded).toBe(true)
    expect(await listFiles(state)).toEqual([KV_IMPORT_MARKER, 'pending/pd_a.json'])
  })

  it('持锁期间定时刷新锁的时间戳：慢导入超过 60 秒也不会被当成残留清掉，释放后不再刷新', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const lockPath = join(state, KV_IMPORT_LOCK)
      const lockAt = async () => (JSON.parse(await readFile(lockPath, 'utf8')) as { at: number }).at
      let clock = 0
      const legacy = legacyOf({ pending: [['pd_a', pd('pd_a')]] })
      const aGate = deferred(), aOpened = deferred()
      const a = new SidecarStore({
        root, schemas, now: () => clock,
        openLegacyKv: async () => { const t = await legacy.open(); aOpened.resolve(); await aGate.promise; return t },
      })
      const { warns, log } = makeLog()
      let bNowCalls = 0
      const b = new SidecarStore({ root, schemas, log, openLegacyKv: legacy.open, now: () => { bNowCalls++; return clock } })

      const aList = a.pending.list()
      await aOpened.promise // A 持锁，锁时间戳 0
      clock = 65_000
      vi.advanceTimersByTime(10_000)
      await vi.waitFor(async () => { expect(await lockAt()).toBe(65_000) })

      clock = 70_000 // 离加锁已超 60 秒，离上次刷新只有 5 秒
      const bList = b.pending.list()
      await vi.waitFor(() => { expect(bNowCalls).toBeGreaterThanOrEqual(3) }) // B 至少判过一轮锁
      expect(warns.filter(w => w.includes('导入锁残留'))).toEqual([])

      aGate.resolve()
      expect((await aList).map(([k]) => k)).toEqual(['pd_a'])
      await bList
      expect(legacy.calls()).toBe(1)
      expect(await exists(lockPath)).toBe(false)
      vi.advanceTimersByTime(30_000) // 释放后计时器已停，不会重建锁文件
      expect(await exists(lockPath)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
