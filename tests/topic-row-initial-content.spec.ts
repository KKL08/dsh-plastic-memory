import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { newWriteOp } from '../src/storage/table.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { readIndexFiles } from '../src/storage/index-store.ts'
import { createdAtOf, UNSORTED_PAGE } from '../src/topic-index.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

it('主题索引缺少未整理页时首次放行只建标题，不带建立时刻', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-row-initial-'))
  try {
    const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: { info() {}, warn() {}, error() {} } })
    await table.create(record({ id: 'mem_topic' }), newWriteOp({ topic: { kind: 'choose', name: '部署', maxTopics: 30 } }))
    expect((await readIndexFiles(join(root, GLOBAL_DIR)))!.pages[UNSORTED_PAGE]).toBeUndefined()
    await table.create(record({ id: 'mem_unsorted', name: '其他约定' }))
    const text = (await readIndexFiles(join(root, GLOBAL_DIR)))!.pages[UNSORTED_PAGE]!
    expect(text.startsWith('# 未整理\n\n')).toBe(true)
    expect(createdAtOf(text)).toBeUndefined()
    expect(text).toContain('mem_unsorted')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
