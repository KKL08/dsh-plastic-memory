import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { libraryViewSchema, type MemoryCommand } from '../src/gui/contract.ts'
import { scopeAt } from '../src/scope.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { NOW, SESSION_WS, env, ok, root } from './helpers/gui-command-env.ts'

// 界面里的直接改、直接合并也是内容改动：记下最近一次内容改动（操作 id 是这次写入的），最近改动记录里记一行不带会话的。
// 只改正文时名称、摘要都没变，靠最近一次内容改动的操作 id 判出来。

const LATER = NOW + 1000
const quiet = { info() {}, warn() {}, error() {} }
const journalDirs: string[] = []
const journals: OpJournal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of journalDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 命令环境换上带操作日志库的文件表。 */
async function envWithJournal() {
  const dir = await mkdtemp(join(tmpdir(), 'pm-notice-gui-'))
  journalDirs.push(dir)
  const journal = new OpJournal({ path: join(dir, 'op-journal.sqlite'), log: quiet })
  journals.push(journal)
  const e = env({ table: new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, journal }) })
  return { e, journal }
}

async function cardOf(e: ReturnType<typeof env>, id: string) {
  ok(await e.run({ cmd: 'refresh-views' }))
  return libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items).find(m => m.id === id)!
}

const rowsOf = (journal: OpJournal, scopes: readonly string[]) =>
  journal.changesSince(scopes, 0)!.rows.map(r => ({ memoryId: r.memoryId, change: r.change, session: r.session }))

describe('界面直接改、直接合并记下内容改动', () => {
  it('直接改（只改正文）：记一行不带会话的内容改动；记录上的最近一次内容改动是这次写入的，由界面发起', async () => {
    const { e, journal } = await envWithJournal()
    await e.store.create(record({ id: 'mem_e', name: '发版流程', summary: '发版摘要', content: '旧正文', type: 'project', scope: 'workspace', workspacePath: SESSION_WS }))
    const card = await cardOf(e, 'mem_e')
    e.clock.now = LATER
    const command: MemoryCommand = {
      cmd: 'edit-memory', memoryId: 'mem_e', layer: { kind: 'workspace', workspacePath: SESSION_WS }, base: { updatedAt: card.updatedAt, digest: card.digest! },
      content: '新正文', name: '发版流程', summary: '发版摘要', tags: [],
    }
    ok(await e.run(command))
    expect(rowsOf(journal, [SESSION_WS])).toEqual([{ memoryId: 'mem_e', change: 'content', session: undefined }])
    const located = (await e.store.locate('mem_e', scopeAt(SESSION_WS)))!
    expect(located.record.lastChange).toEqual({ kind: 'refine', at: LATER, op: located.writeOp, by: 'gui' })
  })

  it('直接合并：保留的那条记内容改动、带上这次写入的最近一次内容改动，并进去的那条记删除', async () => {
    const { e, journal } = await envWithJournal()
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '甲的正文', scope: 'workspace', workspacePath: SESSION_WS, createdAt: 100 }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '乙的正文', scope: 'workspace', workspacePath: SESSION_WS, createdAt: 200 }))
    const ref = async (id: string) => {
      const card = await cardOf(e, id)
      return { memoryId: id, layer: { kind: 'workspace' as const, workspacePath: SESSION_WS }, base: { updatedAt: card.updatedAt, digest: card.digest! } }
    }
    const first = await ref('mem_a')
    const second = await ref('mem_b')
    e.clock.now = LATER
    ok(await e.run({ cmd: 'merge-memories', memories: [first, second], content: '合并后的正文', name: '合并后', summary: '合并摘要', tags: [] }))
    expect(rowsOf(journal, [SESSION_WS])).toEqual([
      { memoryId: 'mem_a', change: 'content', session: undefined },
      { memoryId: 'mem_b', change: 'deleted', session: undefined },
    ])
    const located = (await e.store.locate('mem_a', scopeAt(SESSION_WS)))!
    expect(located.record.lastChange).toEqual({ kind: 'refine', at: LATER, op: located.writeOp, by: 'gui' })
  })
})
