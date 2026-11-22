import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { anchorsOf, type MemoryRecord } from '../src/record-schema.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { splitFrontmatter } from '../src/storage/frontmatter.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { openRelease020Table } from './helpers/release-020.ts'

// 新旧版本共用一个记忆根：用 0.2.0 发布包对同一个临时记忆根读写，再由新版本读，对照 spec「兼容与迁移」的表。
// 这里先覆盖格式定稿涉及的两行，后面的票各自补自己那一行。

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const global = { kind: 'global' } as const
const NEW_KEYS = ['sourceTrail', 'stateSince', 'factTime', 'lastChange', 'lastWriteOp', 'related', 'premises', 'recall', 'locked', 'lockedUntil'] as const

let root: string
let stats: InMemoryKvTable<RecallStats>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-compat-020-'))
  stats = new InMemoryKvTable<RecallStats>()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const current = () => new FileTable({ root, stats, log: quiet })
const withNewKeys = (): MemoryRecord => record({
  name: '发版步骤', type: 'project', createdAt: Date.UTC(2026, 10, 1), updatedAt: Date.UTC(2026, 10, 2), lastConfirmedAt: Date.UTC(2026, 10, 2),
  source: { sessionId: 's2', eventRange: [5, 9], sourceMode: 'user-explicit' },
  sourceTrail: [{ sessionId: 's2', eventRange: [5, 9], sourceMode: 'user-explicit', at: Date.UTC(2026, 10, 2), initiator: 'user', evidence: { user: true, tool: false }, change: 'refine', by: 'main' }],
  stateSince: Date.UTC(2026, 10, 1), factTime: '2026-11', lastChange: { kind: 'refine', at: Date.UTC(2026, 10, 2), op: 'op_1', by: 'main' },
  lastWriteOp: 'op_1', related: ['mem_rel'], premises: [{ id: 'mem_pre', digest: 'd1:0123456789abcdef' }], recall: 'search-only',
  locked: true, lockedUntil: Date.UTC(2027, 0, 1),
})
const pick = (r: MemoryRecord) => Object.fromEntries(NEW_KEYS.map(k => [k, r[k]]))
const globalFile = async () => {
  const dir = join(root, 'global')
  const name = (await readdir(dir)).find(f => f.endsWith('.md') && f !== 'MEMORY.md')!
  return join(dir, name)
}

describe('新旧版本共用一个记忆根（0.2.0 发布包）', () => {
  it('0.2.0 整条更新一条记忆：顶层的新键原样保留', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const old = await openRelease020Table({ root, stats })
    await old.update(rec.id, global, r => ({ ...r, content: '旧版本改过的正文', updatedAt: r.updatedAt + 1000 }))
    const after = await current().locate(rec.id, global)
    expect(after?.record.content).toBe('旧版本改过的正文')
    expect(pick(after!.record)).toEqual(pick(rec))
  })

  it('0.2.0 整条替换一条记忆并换了出处：新键照旧保留，换上的出处补成出处清单最前一个没有发起方的锚', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const old = await openRelease020Table({ root, stats })
    const seen = (await old.locate(rec.id, global))!.record
    expect(seen).not.toHaveProperty('sourceTrail')
    const replaced = { sessionId: 's9', eventRange: [20, 22] as [number, number], sourceMode: 'agent-inferred' as const }
    await old.put({ ...seen, content: '旧版本整条替换的正文', source: replaced, updatedAt: Date.UTC(2026, 10, 3) }, global)
    const after = (await current().locate(rec.id, global))!.record
    expect(after.content).toBe('旧版本整条替换的正文')
    expect(pick(after)).toEqual(pick(rec))
    const anchors = anchorsOf(after)
    expect(anchors[0]).toEqual({ ...replaced, at: Date.UTC(2026, 10, 3) })
    expect(anchors.slice(1)).toEqual(rec.sourceTrail)
  })

  it('0.2.0 写入一条记忆：新版本照读，不带新键', async () => {
    const old = await openRelease020Table({ root, stats })
    const rec = record({ name: '旧版本写的', createdAt: 5, updatedAt: 5, lastConfirmedAt: 5 })
    await old.create(rec)
    const after = await current().locate(rec.id, global)
    expect(after?.record.name).toBe('旧版本写的')
    expect(pick(after!.record)).toEqual(Object.fromEntries(NEW_KEYS.map(k => [k, undefined])))
  })

  it('两边轮流写同一条：键的顺序一致，只改正文时文件里只有正文和 digest 两行变', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const old = await openRelease020Table({ root, stats })
    await old.update(rec.id, global, r => ({ ...r, content: '旧版本改过的正文' }))
    const byOld = await readFile(await globalFile(), 'utf8')
    await current().update(rec.id, global, r => ({ ...r, content: '新版本改过的正文' }))
    const byNew = await readFile(await globalFile(), 'utf8')
    expect(Object.keys(splitFrontmatter(byNew).data)).toEqual(Object.keys(splitFrontmatter(byOld).data))
    const oldLines = byOld.split('\n')
    const changed = byNew.split('\n').flatMap((line, i) => line === oldLines[i] ? [] : [line.split(':')[0]])
    expect(changed).toEqual(['digest', '新版本改过的正文'])
  })

  it('0.2.0 丢掉 source 里它不认识的子字段，所以锚的新字段放在出处清单里', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const file = await globalFile()
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace('sourceMode: user-explicit\n', 'sourceMode: user-explicit\n  initiator: user\n'))
    expect(splitFrontmatter(await readFile(file, 'utf8')).data.source).toHaveProperty('initiator', 'user')
    const old = await openRelease020Table({ root, stats })
    await old.update(rec.id, global, r => ({ ...r, summary: '旧版本改过的摘要' }))
    const fm = splitFrontmatter(await readFile(await globalFile(), 'utf8')).data
    expect(fm.source).not.toHaveProperty('initiator')
    expect((fm.sourceTrail as Array<Record<string, unknown>>)[0]).toMatchObject({ initiator: 'user', by: 'main' })
  })
})
