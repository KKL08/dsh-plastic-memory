import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, renameSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { newWriteOp } from '../src/storage/table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'

const T0 = 1_700_000_000_000
const WS = '/proj'
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const mem = (p: Partial<MemoryRecord> = {}) => record({ id: 'mem_p', name: 'stray', scope: 'workspace', workspacePath: WS, createdAt: T0 - 300, updatedAt: T0 - 200, ...p })

describe('写入段复核失败的日志行和带主题的写入', () => {
  let root: string
  let journal: OpJournal
  let table: FileTable
  let store: MemoryStore
  const at = { workspacePath: WS }
  const wsDir = () => join(root, workspaceDirName(WS))
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pm-write-retry-'))
    journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quietLog })
    const lock = createRootLock({ root, log: quietLog })
    const { recallStats: stats } = new SidecarStore({ root, log: quietLog, schemas: sidecarSchemas, lock })
    table = new FileTable({ root, stats, log: quietLog, now: () => T0, journal, lock })
    store = new MemoryStore(table, quietLog, stats)
  })
  afterEach(async () => { journal.close(); await rm(root, { recursive: true, force: true }) })

  it('占名时目标名被同 id 的另一份占着：这一轮的日志行撤掉，重来原样返回，不留未完成行', async () => {
    await store.create(mem())
    const op = newWriteOp()
    let round = 0
    const pendingSeen: boolean[] = []
    const w = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => {
      round++
      if (round === 1) {
        // 别的写者在目标名上落了同 id 的一份（不在 known 里）
        writeFileSync(join(wsDir(), 'renamed.md'), encodeRecord({ ...cur, content: 'other' }, {}))
        return { ...cur, name: 'renamed', content: 'mine' }
      }
      pendingSeen.push(table.isOpPending(op.id))
      return cur
    }, at, op)
    expect(round).toBe(2)
    expect(pendingSeen).toEqual([false])   // 第二轮开始时第一轮的行已撤
    expect(table.isOpPending(op.id)).toBe(false)
    expect(journal.hasPending()).toBe(false)
    expect(w.status).toBe('active')
  })

  it('占名后发现原文件被改：撤回新文件、撤掉日志行，重来原样返回，不留未完成行', async () => {
    await store.create(mem())
    const first = (await store.locate('mem_p', at))!
    const op = newWriteOp()
    const proto = Object.getPrototypeOf(table) as { claimAndWrite: (...a: unknown[]) => Promise<unknown> }
    const orig = proto.claimAndWrite
    let hooked = false
    ;(table as unknown as { claimAndWrite: (...a: unknown[]) => Promise<unknown> }).claimAndWrite = async function (this: unknown, ...a: unknown[]) {
      const claim = await orig.apply(this, a)
      if (!hooked) { hooked = true; appendFileSync(first.filePath, '\n手改\n') }
      return claim
    }
    let round = 0
    await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => {
      round++
      return round === 1 ? { ...cur, name: 'renamed2' } : cur
    }, at, op)
    expect(hooked).toBe(true)
    expect(round).toBe(2)
    expect(table.isOpPending(op.id)).toBe(false)
    expect(journal.hasPending()).toBe(false)
    expect(readdirSync(wsDir())).not.toContain('renamed2.md')
  })

  it('given 带调用方步骤：第一轮复核失败撤行，第二轮写成，随后 finishOp 步骤只跑一次、日志清空', async () => {
    let ran = 0
    table.registerStep('probe-step', async () => { ran++ })
    await store.create(mem())
    const first = (await store.locate('mem_p', at))!
    const op = newWriteOp({ steps: [{ kind: 'probe-step' } as never] })
    let round = 0
    const w = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => {
      round++
      if (round === 1) appendFileSync(first.filePath, '\n手改\n')   // 落盘前被手改：原地覆盖前复核失败
      return { ...cur, content: `round${round}` }
    }, at, op)
    expect(round).toBe(2)
    expect(w.content).toBe('round2')
    expect(table.isOpPending(op.id)).toBe(true)   // given：提交后留行等调用方结
    await store.finishOp(op, w)
    expect(ran).toBe(1)
    expect(journal.hasPending()).toBe(false)
  })

  it('given：第一轮复核失败撤行，第二轮判没变不写，调用方照旧 finishOp：不报错、日志清空', async () => {
    let ran = 0
    table.registerStep('probe-step', async () => { ran++ })
    await store.create(mem())
    const first = (await store.locate('mem_p', at))!
    const archived = join(dirname(first.filePath), ARCHIVE_DIR, basename(first.filePath))
    const op = newWriteOp({ steps: [{ kind: 'probe-step' } as never] })
    let round = 0
    const w = await store.update({ id: 'mem_p', workspacePath: WS }, (cur) => {
      round++
      if (round === 1) { mkdirSync(dirname(archived), { recursive: true }); renameSync(first.filePath, archived); return { ...cur, content: 'x' } }
      return cur
    }, at, op)
    expect(w.status).toBe('deleted')
    await store.finishOp(op, w)
    expect(journal.hasPending()).toBe(false)
    expect(ran).toBe(1)   // 现有约定：finishOp 照跑调用方步骤（与改动前同）
    expect(await readdir(wsDir())).not.toContain(basename(first.filePath))
  })

  it('在用记录只改召回统计、带主题：照旧挪主题（记一行日志等调用方结），统计照写', async () => {
    await store.create(mem())
    const op = newWriteOp({ topic: { kind: 'choose', name: '上线', maxTopics: 30 } })
    const w = await table.update('mem_p', at, r => ({ ...r, recallCount: 5 }), op)
    expect(w.recallCount).toBe(5)
    expect(table.isOpPending(op.id)).toBe(true)
  })
})
