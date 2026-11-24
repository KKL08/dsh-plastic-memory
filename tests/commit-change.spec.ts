import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { commitChange } from '../src/commit-change.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { layerOf } from '../src/storage/history.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// 落盘原语：只管把一次声明了性质的改动写下去。没有会话、没有工作目录、没有确认码也能调，前台的规则不在这一层。

const T0 = 1_700_000_000_000

function world() {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  return { store, snapshots, deps: { store, snapshots } }
}
async function seeded(w: ReturnType<typeof world>, partial: Partial<MemoryRecord> = {}) {
  const rec = record({ id: 'mem_a', name: '回复语言', content: '回复用中文', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await w.store.create(rec)
  return (await w.store.get(rec.id, { workspacePath: rec.workspacePath }))!
}
const versionsOf = async (w: ReturnType<typeof world>, rec: MemoryRecord) =>
  w.store.history.list(layerOf((await w.store.locate(rec.id, { workspacePath: rec.workspacePath }))!), rec.id)

describe('落盘原语', () => {
  it('没有会话也能改全局记忆：不要确认码，出处原样不动，记下是谁改的', async () => {
    const w = world()
    const target = await seeded(w)
    const r = await commitChange({ target, kind: 'correct', fields: { content: '回复用简体中文' }, by: 'dreams', at: T0 + 1000 }, w.deps)
    expect(r).toMatchObject({ kind: 'written', before: target })
    const now = (await w.store.get('mem_a'))!
    expect(now).toMatchObject({ content: '回复用简体中文', updatedAt: T0 + 1000, lastConfirmedAt: T0, source: target.source })
    expect(now.sourceTrail).toBeUndefined()
    expect(now.lastChange).toEqual({ kind: 'correct', at: T0 + 1000, op: expect.stringMatching(/^op_/), by: 'dreams' })
    expect((await w.snapshots.list()).map(s => s.data[0]!.content)).toEqual(['回复用中文'])
  })

  it('别的子会话存下、还没接受的记录照样能改：归属规则是前台的事', async () => {
    const w = world()
    const delegation = { sessionId: 'child-1', depth: 1, parentSessionId: 'root' }
    const target = await seeded(w, { scope: 'workspace', workspacePath: '/proj', delegation })
    const r = await commitChange({ target, kind: 'refine', fields: { content: '回复用中文，术语保留英文' }, by: 'dreams', at: T0 + 1000 }, w.deps)
    expect(r).toMatchObject({ kind: 'written', record: { content: '回复用中文，术语保留英文', delegation } })
  })

  it('没有会话的状态变化每次都留档，不进合并窗口', async () => {
    const w = world()
    let target = await seeded(w)
    for (const [i, content] of ['第二版', '第三版'].entries()) {
      const r = await commitChange({ target, kind: 'state-change', fields: { content }, by: 'dreams', reason: `原因${i + 1}`, at: T0 + (i + 1) * 1000 }, w.deps)
      expect(r).toMatchObject({ kind: 'written', version: { isMerged: false } })
      target = (await w.store.get('mem_a'))!
    }
    expect((await versionsOf(w, target)).map(v => [v.record.content, v.startedAt, v.endedAt, v.sessionId])).toEqual([
      ['回复用中文', T0, T0 + 1000, undefined],
      ['第二版', T0 + 1000, T0 + 2000, undefined],
    ])
  })

  it('补证不拍快照；带着这次的出处时加一个锚', async () => {
    const w = world()
    const target = await seeded(w)
    const anchor = { sessionId: 's9', eventRange: [3, 4] as [number, number], sourceMode: 'environment-observed' }
    const r = await commitChange({ target, kind: 'corroborate', anchor, by: 'dreams', at: T0 + 1000 }, w.deps)
    expect(r).toMatchObject({ kind: 'written', record: { content: '回复用中文', lastConfirmedAt: T0 + 1000, updatedAt: T0, source: anchor } })
    expect(r.kind === 'written' && r.snapshotId).toBeUndefined()
    expect(await w.snapshots.list()).toEqual([])
  })

  it('调用方读到之后别处改了别的字段：这次的改动落在最新版上，别处改的都留着，改前快照拍的是最新版', async () => {
    const w = world()
    const target = await seeded(w)
    await w.store.update(target, r => ({ ...r, tags: ['别处加的'], recall: 'pinned', locked: true, validTo: T0 + 86_400_000 }))
    const r = await commitChange({ target, kind: 'correct', fields: { content: '甲' }, by: 'dreams', at: T0 + 1000 }, w.deps)
    expect(r).toMatchObject({ before: { ...target, tags: ['别处加的'], recall: 'pinned', locked: true, validTo: T0 + 86_400_000 } })
    expect(r.kind).toBe('written')
    expect(await w.store.get('mem_a')).toMatchObject({ content: '甲', tags: ['别处加的'], recall: 'pinned', locked: true, validTo: T0 + 86_400_000 })
    expect((await w.snapshots.list()).map(s => s.data[0]!.tags)).toEqual([['别处加的']])
  })

  it('调用方读到之后目标被软删、换了状态或搬了作用域：不写，交回当前内容；调用方另给的条件同样在锁内判', async () => {
    const moves: Array<[string, (w: ReturnType<typeof world>, target: MemoryRecord) => Promise<unknown>]> = [
      ['软删', (w, target) => w.store.softDelete(target, { now: T0 + 500 })],
      ['被取代', (w, target) => w.store.update(target, r => ({ ...r, status: 'superseded' }))],
      ['提升为全局', (w, target) => w.store.update(target, ({ workspacePath: _, ...r }) => ({ ...r, scope: 'global' }))],
    ]
    for (const [label, move] of moves) {
      const w = world()
      const target = await seeded(w, { scope: 'workspace', workspacePath: '/proj' })
      await move(w, target)
      const r = await commitChange({ target, kind: 'correct', fields: { content: '甲' }, by: 'dreams', at: T0 + 1000 }, w.deps)
      expect(r.kind, label).toBe('changed')
      expect((await w.store.get('mem_a', { workspacePath: '/proj' }))!.content, label).toBe('回复用中文')
      expect(await w.snapshots.list(), label).toEqual([])
    }
    const w = world()
    const target = await seeded(w)
    const blocked = await commitChange({ target, kind: 'correct', fields: { content: '甲' }, by: 'dreams', at: T0 + 1000, isBlocked: () => true }, w.deps)
    expect(blocked.kind).toBe('changed')
    expect((await w.store.get('mem_a'))!.content).toBe('回复用中文')
  })

  it('调用方的时刻早于别处刚写下的那一版：落盘时间不往回写，状态变化留的历史版本起止不颠倒', async () => {
    const w = world()
    const target = await seeded(w)
    const other = await commitChange({ target, kind: 'state-change', fields: { content: '第二版' }, by: 'main', sessionId: 's2', at: T0 + 3000 }, w.deps)
    expect(other.kind).toBe('written')
    // 这一次开始得早（时刻 T0+1000）、落盘得晚
    const r = await commitChange({ target, kind: 'state-change', fields: { content: '第三版' }, by: 'main', sessionId: 's1', at: T0 + 1000 }, w.deps)
    expect(r).toMatchObject({ kind: 'written', record: { content: '第三版', updatedAt: T0 + 3000, stateSince: T0 + 3000 }, version: { isMerged: false } })
    expect((await versionsOf(w, target)).map(v => [v.record.content, v.startedAt, v.endedAt])).toEqual([
      ['回复用中文', T0, T0 + 3000],
      ['第二版', T0 + 3000, T0 + 3000],
    ])
  })

  it('要改什么看了最新内容才定：按锁内读到的那一版算；叫停就不写、不拍快照', async () => {
    const w = world()
    const target = await seeded(w)
    await w.store.update(target, r => ({ ...r, content: '回复用中文，代码注释也用中文' }))
    const r = await commitChange({ target, kind: 'refine', prepare: current => ({ fields: { content: `${current.content}。术语保留英文` } }), by: 'dreams', at: T0 + 1000 }, w.deps)
    expect(r).toMatchObject({ kind: 'written', record: { content: '回复用中文，代码注释也用中文。术语保留英文' } })
    const stopped = await commitChange({ target, kind: 'refine', prepare: () => ({ stop: '不改了' }), by: 'dreams', at: T0 + 2000 }, w.deps)
    expect(stopped).toEqual({ kind: 'stopped', stop: '不改了' })
    expect(await w.snapshots.list()).toHaveLength(1)
  })

  it('拼出来的记录过不了格式校验：不写', async () => {
    const w = world()
    const target = await seeded(w)
    const r = await commitChange({ target, kind: 'correct', fields: { name: '' }, by: 'dreams', at: T0 + 1000 }, w.deps)
    expect(r.kind).toBe('invalid')
    expect((await w.store.get('mem_a'))!.name).toBe('回复语言')
  })

  it('模块本身不依赖保存管线和工具层', async () => {
    const source = await readFile(new URL('../src/commit-change.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]!)
    expect(imports.filter(path => /pipeline|\/tools\/|subagent/.test(path))).toEqual([])
  })
})
