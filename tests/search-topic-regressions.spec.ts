import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { MemoryStore } from '../src/store.ts'
import { findTopicCandidates } from '../src/search/topic-context.ts'
import { executeSearch, type SearchArgs } from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { writeTopicIndex } from './helpers/topic-fixture.ts'

const T0 = 1_700_000_000_000
const DAY = 86_400_000
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-topic-regressions-'))
  await mkdir(join(root, GLOBAL_DIR))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

// 保留真实文件读取，仅记录读取次数和参数。
class CountingStore extends MemoryStore {
  reads: Parameters<MemoryStore['readRaw']>[] = []
  override async readRaw(...args: Parameters<MemoryStore['readRaw']>) {
    this.reads.push(args)
    return super.readRaw(...args)
  }
}

function env() {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  const store = new CountingStore(new FileTable({ root, stats, now: () => T0 }), undefined, stats)
  const deps = { store, registry, now: () => T0, host: { contextOf: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }) } }
  return { store, deps, search: (args: SearchArgs) => executeSearch(args, fakeExec(), deps) }
}

async function write(name: string, value: ReturnType<typeof record>) {
  await writeFile(join(root, GLOBAL_DIR, name), encodeRecord(value, {}), 'utf8')
}

describe('主题检索的副本取舍与读取次数', () => {
  it.each([0, 1])('同作用域旧副本命中而新副本过期时，同主题其他可用成员数为 %i 且不为负', async otherCount => {
    await write('old.md', record({ id: 'dup', content: 'uniquealpha', updatedAt: T0 - DAY }))
    await write('new.md', record({ id: 'dup', type: 'decision', content: 'otherbeta', updatedAt: T0 - 1000, validTo: T0 - DAY }))
    if (otherCount === 1) await write('other.md', record({ id: 'other', type: 'decision', content: 'otherbeta' }))
    await writeTopicIndex(join(root, GLOBAL_DIR), [{ name: '测试主题', members: ['dup', ...(otherCount ? ['other'] : [])] }])
    const e = env()
    for (const args of [{ query: 'uniquealpha' }, { types: ['knowledge'] }]) {
      const result = await e.search({ ...args, scope: 'global' })
      expect(result.hits.map(h => h.id)).toEqual(['dup'])
      expect(result.hits[0]!.topic).toEqual({ scope: 'global', name: '测试主题', others: otherCount })
      expect(result.hits[0]!.topic!.others).toBeGreaterThanOrEqual(0)
    }
  })

  it.each([undefined, ['preference']])('按主题列出且类型筛选为 %j 时只整范围读取一次，诊断字段为空', async types => {
    await write('one.md', record({ id: 'one' }))
    await writeTopicIndex(join(root, GLOBAL_DIR), [{ name: '测试主题', members: ['one'] }])
    const e = env()
    const result = await e.search({ topic: '测试主题', types, scope: 'global' })
    expect(e.store.reads).toEqual([[{ kind: 'global' }]])
    expect(result.browse?.total).toBe(types === undefined ? 1 : 0)
    expect(result.browse?.sections[0]!.topic.count).toBe(1)
    e.store.reads = []
    const found = await findTopicCandidates({ topic: '测试主题', query: '  ', types, scope: { kind: 'global' } }, e.deps)
    expect(e.store.reads).toEqual([[{ kind: 'global' }]])
    expect(found.at).toBe(T0)
    expect(found.isDirectHit).toBe(false)
    expect(found.diagnostics).toEqual({ listedCount: 1, tokens: [], legacyTerms: [], groups: [], termHits: [] })
  })
})
