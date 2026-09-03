import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportMemories } from '../scripts/export-kv-memories.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm15-export-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** 真机验证过的旧 KV 库信封结构：{ unit, global, tables: { memories: { <id>: record } } }。 */
function kvJson(memories: Record<string, unknown>) {
  return { unit: { name: 'plastic_memory', version: 1 }, global: null, tables: { memories } }
}

async function load(root: string) {
  const t = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
  await t.load()
  return t
}

it('导出 global + workspace 记录，坏记录进 skipped 不中断；FileTable 读回全字段往返', async () => {
  const kv = kvJson({
    mem_global: {
      id: 'mem_global', name: '包管理用 pnpm', type: 'preference', scope: 'global',
      tags: ['pnpm', 'npm'], content: '这个项目的包管理一律用 pnpm，不要用 npm', summary: '包管理选型',
      source: { sessionId: 'session-1', eventRange: [0, 2212], sourceMode: 'user-explicit' },
      createdAt: 1787166378210, updatedAt: 1787166913000, lastConfirmedAt: 1787166378210,
      lastRecalledAt: 1787166994463, recallCount: 2, status: 'active', confidence: 0.9,
    },
    mem_ws: {
      id: 'mem_ws', name: '部署脚本密钥', type: 'knowledge', scope: 'workspace',
      workspacePath: '/home/dev/example-project',
      tags: [], content: '密钥已挪进环境变量，此条留作记录', summary: '部署脚本里硬编码的密钥',
      source: { sessionId: 'session-2', eventRange: [0, 4363], sourceMode: 'user-explicit' },
      createdAt: 1787166378178, updatedAt: 1787166720840, lastConfirmedAt: 1787166720840,
      lastRecalledAt: null, recallCount: 0, status: 'active', confidence: 0.9,
    },
    mem_bad: {
      // 缺 confidence（必填字段）→ memoryRecordSchema.safeParse 失败 → 进 skipped，不中断整体导出
      id: 'mem_bad', name: '坏记录', type: 'knowledge', scope: 'global',
      tags: [], content: 'x', summary: 'x',
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'user-explicit' },
      createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null, recallCount: 0, status: 'active',
    },
  })

  const result = await exportMemories(kv, root)
  expect(result.exported).toBe(2)
  expect(result.skipped).toHaveLength(1)
  expect(result.skipped[0]).toContain('mem_bad')

  const t = await load(root)

  const g = t.get('mem_global')!
  expect(g).toBeDefined()
  expect(g.scope).toBe('global')
  expect(g.name).toBe('包管理用 pnpm')
  expect(g.tags).toEqual(['pnpm', 'npm'])
  expect(g.content).toBe('这个项目的包管理一律用 pnpm，不要用 npm')
  expect(g.summary).toBe('包管理选型')
  expect(g.source).toEqual({ sessionId: 'session-1', eventRange: [0, 2212], sourceMode: 'user-explicit' })
  expect(g.createdAt).toBe(1787166378210)
  expect(g.updatedAt).toBe(1787166913000)
  expect(g.lastConfirmedAt).toBe(1787166378210)
  expect(g.status).toBe('active')
  expect(g.confidence).toBe(0.9)
  // recallCount/lastRecalledAt 是 sidecar-only 字段（frontmatter 不承载），导出脚本不写 KvTable 侧车，
  // 因此 FileTable.load 在无侧车行时按文档默认注入 0/null——这是有意的、非本脚本职责范围内的已知损失。
  expect(g.recallCount).toBe(0)
  expect(g.lastRecalledAt).toBeNull()
  // 可选键（validFrom/validTo/supersedes）原始记录未携带 → 往返后仍不出现
  expect(g.validFrom).toBeUndefined()
  expect(g.validTo).toBeUndefined()
  expect(g.supersedes).toBeUndefined()

  const w = t.get('mem_ws')!
  expect(w).toBeDefined()
  expect(w.scope).toBe('workspace')
  expect(w.workspacePath).toBe('/home/dev/example-project') // .workspace 标记无损还原
  expect(w.name).toBe('部署脚本密钥')
  expect(w.tags).toEqual([])
  expect(w.content).toBe('密钥已挪进环境变量，此条留作记录')
  expect(w.summary).toBe('部署脚本里硬编码的密钥')
  expect(w.source).toEqual({ sessionId: 'session-2', eventRange: [0, 4363], sourceMode: 'user-explicit' })
  expect(w.createdAt).toBe(1787166378178)
  expect(w.updatedAt).toBe(1787166720840)

  expect(t.get('mem_bad')).toBeUndefined()
})

it('同目录内 name slug 撞名 → 缀 id 兜底，两条记录都能落盘且互不覆盖', async () => {
  const kv = kvJson({
    mem_one: {
      id: 'mem_one', name: '同名记录', type: 'knowledge', scope: 'global',
      tags: [], content: '第一条', summary: 's1',
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'user-explicit' },
      createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null, recallCount: 0,
      status: 'active', confidence: 0.9,
    },
    mem_two: {
      id: 'mem_two', name: '同名记录', type: 'knowledge', scope: 'global',
      tags: [], content: '第二条', summary: 's2',
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'user-explicit' },
      createdAt: 2, updatedAt: 2, lastConfirmedAt: 2, lastRecalledAt: null, recallCount: 0,
      status: 'active', confidence: 0.9,
    },
  })

  const result = await exportMemories(kv, root)
  expect(result.exported).toBe(2)
  expect(result.skipped).toHaveLength(0)

  const t = await load(root)
  expect(t.get('mem_one')!.content).toBe('第一条')
  expect(t.get('mem_two')!.content).toBe('第二条')
})

it('KV JSON 顶层缺 tables.memories 时直接抛错（信封损坏，不当作 0 条静默通过）', async () => {
  await expect(exportMemories({ unit: {}, global: null, tables: {} }, root)).rejects.toThrow('tables.memories')
})

/** 构造一条通过 schema 的完整记录，按需覆写。 */
const makeRecord = (id: string, name: string, overrides: Partial<MemoryRecord> = {}) =>
  record({ id, name, content: `${id} 的内容`, summary: `${id} 摘要`, ...overrides })

it('可选键在场时无损往返（validFrom/validTo/supersedes 走 ISO 编解码），deleted 状态记录也还原', async () => {
  // 真实备份数据里存在带 validTo 和 status: deleted 的记录——这两条编解码路径必须被钉住。
  const now = Date.now() // deleted 且新鲜（14 天内）：load 期 sweep 不应清它
  const kv = kvJson({
    mem_valid: makeRecord('mem_valid', '带有效期', {
      validFrom: 1754697600000, validTo: 1754784000000, supersedes: ['mem_old1', 'mem_old2'],
    }),
    mem_del: makeRecord('mem_del', '已删除记录', {
      status: 'deleted', createdAt: now, updatedAt: now, lastConfirmedAt: now,
    }),
  })
  const result = await exportMemories(kv, root)
  expect(result.exported).toBe(2)
  expect(result.skipped).toHaveLength(0)

  const t = await load(root)
  const v = t.get('mem_valid')!
  expect(v.validFrom).toBe(1754697600000)
  expect(v.validTo).toBe(1754784000000)
  expect(v.supersedes).toEqual(['mem_old1', 'mem_old2'])
  expect(t.get('mem_del')!.status).toBe('deleted')
})

it('目标目录已有其他 id 的同名文件时不覆盖：改走 id 兜底名；两个名都被占则 skipped', async () => {
  // 模拟"硬约束②被违反"：新系统已写过一条同 slug、不同 id 的记录
  const { encodeRecord } = await import('../src/storage/frontmatter.ts')
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')
  const { memoryRecordSchema } = await import('../src/record-schema.ts')
  const existing = memoryRecordSchema.parse(makeRecord('mem_new_sys', '同名记录'))
  await mkdir(join(root, 'global'), { recursive: true })
  await writeFile(join(root, 'global', '同名记录.md'), encodeRecord(existing, {}), 'utf8')

  const result = await exportMemories(kvJson({ mem_old_kv: makeRecord('mem_old_kv', '同名记录') }), root)
  expect(result.exported).toBe(1)
  expect(result.skipped).toHaveLength(0)
  // 原文件未被动过，导出的记录落在 id 兜底名
  expect(await readFile(join(root, 'global', '同名记录.md'), 'utf8')).toContain('id: mem_new_sys')
  const t = await load(root)
  expect(t.get('mem_new_sys')!.content).toBe('mem_new_sys 的内容')
  expect(t.get('mem_old_kv')!.content).toBe('mem_old_kv 的内容')

  // 基础名与兜底名都被其他 id 占用 → skipped，绝不覆盖
  const frag = 'mem_third'.slice(-6)
  await writeFile(join(root, 'global', `同名记录-${frag}.md`),
    encodeRecord(memoryRecordSchema.parse(makeRecord('mem_occupy', '占位')), {}), 'utf8')
  const r2 = await exportMemories(kvJson({ mem_third: makeRecord('mem_third', '同名记录') }), root)
  expect(r2.exported).toBe(0)
  expect(r2.skipped).toHaveLength(1)
  expect(r2.skipped[0]).toContain('未写入')
})

it('同源重复运行幂等：同 id 覆盖自身，不产生副本也不 skipped', async () => {
  const kv = kvJson({ mem_re: makeRecord('mem_re', '幂等记录') })
  await exportMemories(kv, root)
  const r2 = await exportMemories(kv, root)
  expect(r2.exported).toBe(1)
  expect(r2.skipped).toHaveLength(0)
  const { readdir } = await import('node:fs/promises')
  const files = (await readdir(join(root, 'global'))).filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
  expect(files).toEqual(['幂等记录.md'])
})

it('名字 slug 为保留名 memory 时避让（APFS 上 memory.md 会与索引 MEMORY.md 相互覆盖）', async () => {
  const kv = kvJson({ mem_rsv: makeRecord('mem_rsv', 'memory') })
  const result = await exportMemories(kv, root)
  expect(result.exported).toBe(1)
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(join(root, 'global'))
  expect(files).not.toContain('memory.md')
  expect(files).toContain(`memory-${'mem_rsv'.slice(-6)}.md`)
  const t = await load(root) // 索引再生后记录仍在、未被隔离
  expect(t.get('mem_rsv')!.content).toBe('mem_rsv 的内容')
})
