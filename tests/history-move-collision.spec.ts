import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileVersionHistory, STATE_CHANGE_VERSION, type HistoryVersion } from '../src/storage/history.ts'
import { record } from './helpers/record.ts'

// 历史目录并进目标层时，另一个写者恰好在同一个版本 id 上落下一版：在进程边界（node:fs/promises）插进这次写入，
// 看搬移会不会盖掉它。

const race = vi.hoisted(() => ({ target: '', write: undefined as undefined | (() => Promise<void>) }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  // 搬移把版本文件放到目标名上之前，先让另一个写者占住这个名字
  const before = (key: 'link' | 'rename') => async (...args: unknown[]) => {
    const write = race.write
    if (write !== undefined && String(args[1]) === race.target) {
      race.write = undefined
      await write()
    }
    return (actual[key] as (...a: unknown[]) => Promise<unknown>)(...args)
  }
  return { ...actual, link: before('link'), rename: before('rename') }
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-history-collision-')) })
afterEach(async () => {
  race.write = undefined
  await rm(root, { recursive: true, force: true })
})

it('并进目标层时另一个写者正好写下同一个版本 id：三版都留着，谁也不盖掉谁', async () => {
  const history = new FileVersionHistory()
  const a = { dir: join(root, 'a'), loc: { scope: 'global' } as const }
  const b = { dir: join(root, 'b'), loc: { scope: 'global' } as const }
  const base = record({ id: 'mem_x' })
  const VERSION = '20261124T000000000Z'
  const version = (versionId: string, content: string): HistoryVersion => ({ versionId, record: { ...base, content }, extras: {}, startedAt: 1, endedAt: 2, kind: STATE_CHANGE_VERSION, writes: [] })
  await history.write(a, version(VERSION, '源头那版'))
  await history.write(b, version(VERSION, '目标层原有的'))
  // 源头那版同名不同内容，要换成 -02 放进去；就在这时另一个写者先写下了 -02
  race.target = join(b.dir, '.history', 'mem_x', `${VERSION}-02.md`)
  race.write = () => history.write(b, version(`${VERSION}-02`, '另一个写者刚写的'))
  await history.move(a.dir, b.dir, 'mem_x')
  expect(race.write).toBeUndefined()
  expect((await history.list(b, 'mem_x')).versions.map(v => v.record.content).sort()).toEqual(['另一个写者刚写的', '源头那版', '目标层原有的'].sort())
  expect(await history.memoryIds(a.dir)).toEqual([])
})
