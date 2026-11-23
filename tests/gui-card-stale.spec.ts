import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { editFingerprint } from '../src/governance/snapshots.ts'
import { computeDigest, encodeRecord } from '../src/storage/frontmatter.ts'
import { libraryViewSchema, type MemoryCommand } from '../src/gui/contract.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { suggestionBasis } from '../src/governance/decisions.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { record } from './helpers/record.ts'
import { noInstructions } from './helpers/instructions.ts'
import { env, ok, err } from './helpers/gui-command-env.ts'

const fields: Array<[string, Partial<MemoryRecord>]> = [
  ['名称', { name: '手改名称' }], ['摘要', { summary: '手改摘要' }],
  ['正文', { content: '手改正文' }], ['标签', { tags: ['手改标签'] }],
]

const draft = { name: '卡片名称', summary: '卡片摘要', content: '卡片正文', tags: ['卡片标签'] }

/** 两条全局记忆（甲创建得早，直接合并时保留甲、删乙），刷新视图后按卡片上的版本拼引用。 */
async function openCards() {
  const e = env()
  await e.store.create(record({ id: 'mem_a', name: '甲', content: '原正文', createdAt: 1 }))
  await e.store.create(record({ id: 'mem_b', name: '乙', content: '原正文', createdAt: 2 }))
  ok(await e.run({ cmd: 'refresh-views' }))
  const cards = libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items)
  const baseOf = (id: string) => {
    const card = cards.find(c => c.id === id)!
    return { updatedAt: card.updatedAt, digest: card.digest! }
  }
  const ref = (id: string) => ({ memoryId: id, layer: { kind: 'global' as const }, base: baseOf(id) })
  return { e, ref, baseOf }
}

/** 手改文件（不经插件、updatedAt 不变），返回改后的文件内容。 */
async function handEdit(e: ReturnType<typeof env>, id: string, changes: Partial<MemoryRecord>) {
  const located = (await e.store.locate(id))!
  await writeFile(located.filePath, encodeRecord({ ...located.record, ...changes }, located.extras))
  return { path: located.filePath, content: await readFile(located.filePath) }
}

// 用卡片版本核对的入口：卡片打开期间手改了哪条记忆的哪个字段，提交都判陈旧，文件原样、不拍快照
const cardEntries: Array<[string, string, (c: Awaited<ReturnType<typeof openCards>>) => Promise<MemoryCommand>]> = [
  ['直接编辑', 'mem_a', async ({ ref }) => ({ cmd: 'edit-memory', ...ref('mem_a'), ...draft })],
  ['直接合并：改了保留的那条', 'mem_a', async ({ ref }) => ({ cmd: 'merge-memories', memories: [ref('mem_a'), ref('mem_b')], ...draft })],
  ['直接合并：改了要删的那条', 'mem_b', async ({ ref }) => ({ cmd: 'merge-memories', memories: [ref('mem_a'), ref('mem_b')], ...draft })],
  ['整理所选应用：改写项', 'mem_a', async ({ ref }) => ({ cmd: 'apply-edits', ops: [{ kind: 'edit', ...ref('mem_a'), ...draft }] })],
  ['整理所选应用：只核对的承接项', 'mem_b', async ({ ref }) => ({ cmd: 'apply-edits', ops: [{ kind: 'forget', ...ref('mem_a'), into: 'mem_b' }], keep: [ref('mem_b')] })],
  ['整理计划', 'mem_a', async ({ ref }) => ({ cmd: 'plan-edits', memories: [ref('mem_a'), ref('mem_b')], request: '合成一条' })],
  ['按计划出稿', 'mem_a', async ({ ref }) => ({ cmd: 'draft-plan', memories: [ref('mem_a'), ref('mem_b')], request: '合成一条', ops: [{ memoryId: 'mem_a', reason: '合成一条' }] })],
  ['按要求出方案', 'mem_a', async ({ e, baseOf }) => {
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '内容冲突' }, 1)
    return { cmd: 'draft-proposal', decisionId: entry.id, request: '保留甲', bases: [baseOf('mem_a'), baseOf('mem_b')] }
  }],
  ['忽略建议', 'mem_a', async ({ ref }) => ({ cmd: 'ignore-advice', type: 'redundancy', memories: [ref('mem_a'), ref('mem_b')] })],
]

describe('卡片版本核对：打开期间手改任何字段都判陈旧', () => {
  describe.each(cardEntries)('%s', (_label, changedId, commandOf) => {
    it.each(fields)('手改%s：判陈旧并保留文件原样', async (_field, changes) => {
      const cards = await openCards()
      const command = await commandOf(cards)
      const { e } = cards
      const edited = await handEdit(e, changedId, changes)
      expect(err(await e.run(command)).code).toBe('stale')
      expect(await readFile(edited.path)).toEqual(edited.content)
      expect(await e.snapshots.list()).toEqual([])
      expect((await e.store.get('mem_a'))!.status).toBe('active')
      expect((await e.store.get('mem_b'))!.status).toBe('active')
    })
  })
})

describe('卡片版本核对：不进指纹的变化不算陈旧', () => {
  it.each([
    ['计了一次召回', async (e: ReturnType<typeof env>) => { await e.store.markRecalled(['mem_a'], 50) }],
    ['确认了一次新鲜度', async (e: ReturnType<typeof env>) => {
      const deps = { store: e.store, decisions: e.decisions, snapshots: e.snapshots, now: () => 50, instructions: noInstructions }
      expect((await executeConfirm({ action: 'refresh', memoryId: 'mem_a' }, { workspacePath: undefined }, deps)).kind).toBe('refreshed')
    }],
  ] as const)('卡片打开期间%s：提交照样成功', async (_label, change) => {
    const { e, ref } = await openCards()
    const command: MemoryCommand = { cmd: 'edit-memory', ...ref('mem_a'), ...draft }
    await change(e)
    ok(await e.run(command))
    expect((await e.store.get('mem_a'))!.content).toBe('卡片正文')
  })

  it('卡片打开期间主会话接受了子 agent 存的这条：提交照样成功', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_s', name: '子会话记的', content: '原正文', delegation: { sessionId: 'sess-sub', depth: 1, parentSessionId: 'sess-1' } }))
    ok(await e.run({ cmd: 'refresh-views' }))
    const card = libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items).find(c => c.id === 'mem_s')!
    const deps = { store: e.store, decisions: e.decisions, snapshots: e.snapshots, now: () => 50, instructions: noInstructions }
    expect((await executeConfirm({ action: 'accept-subagent', memoryId: 'mem_s' }, { workspacePath: undefined }, deps)).kind).toBe('accepted')
    ok(await e.run({ cmd: 'edit-memory', memoryId: 'mem_s', layer: { kind: 'global' }, base: { updatedAt: card.updatedAt, digest: card.digest! }, ...draft }))
    expect((await e.store.get('mem_s'))!.content).toBe('卡片正文')
  })
})

// 处理方案走账本里的依据核对，不看卡片版本；这一组防的是依据核对漏掉手改的字段（回归用）
const proposalKinds = ['冲突融合', '冲突改写', '采纳融合建议', '采纳改写建议'] as const
describe('处理方案的依据核对：打开期间手改任何字段都判陈旧', () => {
  describe.each(proposalKinds)('%s', (kind) => {
    it.each(fields)('手改%s：判陈旧并保留文件原样', async (_field, changes) => {
      const e = env()
      for (const id of ['mem_a', 'mem_b']) await e.store.create(record({ id, name: id === 'mem_a' ? '甲' : '乙', content: '原正文' }))
      const isMerge = kind === '冲突融合' || kind === '采纳融合建议'
      const ids = isMerge ? ['mem_a', 'mem_b'] : ['mem_a']
      const { entry } = await e.decisions.upsert({ memoryIds: ids, summary: '内容冲突', ...(!isMerge ? { baselineRef: '约定文件' } : {}) }, 1)
      const records = await Promise.all(ids.map(async id => (await e.store.get(id))!))
      let command: MemoryCommand = { cmd: 'apply-proposal', decisionId: entry.id, proposal: {
        action: isMerge ? 'merge' : 'rewrite', reason: '整理内容',
        ops: [{ kind: 'edit', memoryId: 'mem_a', ...draft }, ...(isMerge ? [{ kind: 'forget' as const, memoryId: 'mem_b' }] : [])],
        basis: suggestionBasis(entry, records),
      } }
      if (kind === '采纳融合建议' || kind === '采纳改写建议') {
        const suggestion = { ...command.proposal!, id: 'sg_卡片', isSourced: false, generatedAt: 1 }
        expect(await e.decisions.writeSuggestion(entry.id, { suggestion }, id => e.store.get(id))).toBe('written')
        command = { cmd: 'apply-proposal', decisionId: entry.id, suggestionId: suggestion.id }
      }
      const edited = await handEdit(e, 'mem_a', changes)
      expect(err(await e.run(command)).code).toBe('stale')
      expect(await readFile(edited.path)).toEqual(edited.content)
      expect(await e.snapshots.list()).toEqual([])
      expect((await e.store.get('mem_b'))!.status).toBe('active')
    })
  })
})

it('卡片与待决依据沿用编辑指纹', async () => {
  const e = env()
  await e.store.create(record({ id: 'mem_a' }))
  const r = (await e.store.get('mem_a'))!
  ok(await e.run({ cmd: 'refresh-views' }))
  const cards = libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items)
  expect(cards[0]!.digest).toBe(editFingerprint(r))
  expect(suggestionBasis({}, [r]).memories[0]!.fingerprint).toBe(editFingerprint(r))
})

it('旧版卡片摘要提交判陈旧并保留文件原样', async () => {
  const e = env()
  await e.store.create(record({ id: 'mem_a' }))
  const located = (await e.store.locate('mem_a'))!
  const r = located.record
  const before = await readFile(located.filePath)
  const result = err(await e.run({ cmd: 'edit-memory', memoryId: r.id,
    base: { updatedAt: r.updatedAt, digest: computeDigest(r.name, r.summary, r.content) },
    name: '卡片名称', summary: '卡片摘要', content: '卡片正文', tags: [],
  }))
  expect(result.code).toBe('stale')
  expect(result.detail).toBe('这条记忆刚被改过，界面已换成最新内容。未做任何改动')
  expect(await readFile(located.filePath)).toEqual(before)
})
