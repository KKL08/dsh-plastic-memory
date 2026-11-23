import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { memorySubject, runGui, W, IDS, STORE_NOW, seedArb, writeOpArb, keyArb, type MemOp, type MemoryWorld } from './helpers/memory-subject.ts'
import { assertSerialEquivalent, interleaveSeed, interleaveRuns, observeConcurrent, type TaskScheduler } from './helpers/interleave.ts'
import { checkSequence, sequenceCase } from './helpers/random-sequence.ts'
import { record, candidate } from './helpers/record.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { editFingerprint } from '../src/governance/snapshots.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import type { MemoryRecord } from '../src/record-schema.ts'

vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

const hooks = { beforeCommit: async () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const initial = { a: 'workspace', b: 'workspace', isSameName: false } as const
const base = memorySubject(initial)
const kinds = ['新建', '整条更新', '精确修改', '补证', '删除', '提升', '界面批量写入'] as const
type Kind = typeof kinds[number]
interface Write { writer: number; index: number; kind: Kind }
const ref = (r: MemoryRecord) => ({ memoryId: r.id, layer: { kind: 'workspace' as const, workspacePath: W }, base: { updatedAt: r.updatedAt, digest: editFingerprint(r) } })

/** 每种写法集中定义生成器和断言；执行器只负责调度、记录完成及检查撤销隔离。 */
const generators: Record<Kind, (w: MemoryWorld, op: Write, before: MemoryRecord) => Promise<void>> = {
  新建: async (w, op) => {
    const r = record({ id: `mem_new_${op.index}`, name: `新记忆${op.index}`, scope: 'workspace', workspacePath: W, content: `新增正文${op.index}`, createdAt: STORE_NOW, updatedAt: STORE_NOW })
    await w.store.create(r)
    expect(await w.store.get(r.id, { workspacePath: W })).toMatchObject({ content: r.content })
  },
  整条更新: async (w, op, before) => {
    const content = `整条替换${op.index}`
    const result = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: before.id, name: before.name, content, force: true }), { store: w.store, registry, workspacePath: W, snapshots: w.snapshots, session: { id: `会话${op.writer}`, lastSeq: op.index + 1 }, now: () => STORE_NOW })
    expect(result.kind).toBe('updated')
    expect(await w.store.get(before.id, { workspacePath: W })).toMatchObject({ content })
  },
  精确修改: async (w, op, before) => {
    const content = `精确修改${op.index}`
    const result = await runSavePipeline({ action: 'update', change: 'correct', id: before.id, sourceMode: 'user-explicit', edits: [{ oldString: before.content, newString: content }] }, { store: w.store, registry, workspacePath: W, snapshots: w.snapshots, session: { id: `会话${op.writer}`, lastSeq: op.index + 1 }, now: () => STORE_NOW })
    expect(result.kind).toBe('updated')
    expect(await w.store.get(before.id, { workspacePath: W })).toMatchObject({ content })
  },
  补证: async (w, op, before) => {
    const result = await runSavePipeline({ action: 'update', change: 'corroborate', id: before.id, sourceMode: 'user-explicit' }, { store: w.store, registry, workspacePath: W, snapshots: w.snapshots, session: { id: `会话${op.writer}`, lastSeq: op.index + 1 }, now: () => STORE_NOW })
    expect(result.kind).toBe('updated')
    expect(await w.store.get(before.id, { workspacePath: W })).toMatchObject({ content: before.content, updatedAt: before.updatedAt, lastConfirmedAt: STORE_NOW })
  },
  删除: async (w, _op, before) => {
    await w.store.softDelete({ id: before.id, workspacePath: W }, { now: STORE_NOW })
    expect(await w.store.get(before.id, { workspacePath: W })).toMatchObject({ status: 'deleted' })
  },
  提升: async (w, op, before) => {
    const result = await base.run(w, { kind: 'promote', id: op.writer === 0 ? 'a' : 'b' }, op.index, hooks)
    expect(result).toMatchObject({ promoted: [{ id: before.id, target: 'global' }] })
    expect(await w.store.get(before.id, { workspacePath: W })).toMatchObject({ scope: 'global' })
  },
  界面批量写入: async (w, op, before) => {
    const content = `批量改写${op.index}`
    const second = { ...before, id: `mem_batch_${op.index}`, name: `同批记忆${op.index}` }
    await w.store.create(second)
    const result = await runGui(w, hooks, STORE_NOW, { cmd: 'apply-edits', ops: [before, second].map(r => ({ ...ref(r), kind: 'edit', name: r.name, summary: r.summary, tags: r.tags, content })) })
    expect(await w.store.get(second.id, { workspacePath: W })).toMatchObject({ content })
    expect(result).toMatchObject({ ok: true })
    expect(await w.store.get(before.id, { workspacePath: W })).toMatchObject({ content })
  },
}

async function run(input: readonly Write[], scheduler: TaskScheduler) {
  const completed: number[] = []
  const expected = new Map<string, MemoryRecord>()
  const subject = {
    ...base,
    seedKey: undefined,
    splitTag: undefined, isClaimed: undefined, invariant: undefined,
    run: async (w: MemoryWorld, writer: number) => {
      for (const op of input.filter(op => op.writer === writer)) {
        const id = writer === 0 ? IDS.a : IDS.b
        const before = (await w.store.get(id, { workspacePath: W }))!
        await generators[op.kind](w, op, before)
        expected.set(id, (await w.store.get(id, { workspacePath: W }))!)
        completed.push(op.index)
      }
    },
    label: (writer: number) => `写者${writer}`,
  }
  const observation = await observeConcurrent(subject, scheduler, [0, 1], async w => {
    for (const [id, value] of expected) expect(await w.store.get(id, { workspacePath: W })).toEqual(value)
  })
  expect(observation.raw).toEqual([{ value: undefined }, { value: undefined }])
  expect(completed.sort()).toEqual(input.map(op => op.index).sort())
  expect(observation.leftover).toEqual([])
  expect(observation.unhandled).toEqual([])
}

// 四组随机竞争另加两组必跑竞争；冒烟只取两组，把全套并行时的文件耗时留在三十秒内。
const firstSeed = interleaveSeed()
const seeds = Array.from({ length: interleaveRuns(4) }, (_, index) => firstSeed + index)
describe('多写者随机序列', () => {
  for (const seed of seeds.slice(0, 2)) it(`种子 ${seed}：合法写入全部完成且落盘内容不丢失`, async () => {
    const [ops, turns] = sequenceCase(seed, fc.shuffledSubarray([...kinds], { minLength: kinds.length, maxLength: kinds.length }))
    // 每种写法恰好出现一次；提升和删除放在所属写者的末尾，之后不向已移动或已删除的目标写入。
    const input = ops.map((kind, index) => ({ kind, index, writer: kind === '提升' ? 0 : kind === '删除' ? 1 : index % 2 }))
      .sort((a, b) => Number(a.kind === '提升' || a.kind === '删除') - Number(b.kind === '提升' || b.kind === '删除'))
    await checkSequence(seed, input, turns, run)
  }, 20_000)
})

// 保留各写各的冒烟；共享目标上的结果与完整盘面由串行等价判据另验。
const concurrentOpArb = fc.oneof(
  writeOpArb,
  fc.record({ kind: fc.constant('preciseEdit' as const), id: keyArb }),
  fc.record({ kind: fc.constant('corroborate' as const), id: keyArb }),
  fc.constant<MemOp>({ kind: 'guiBatch' }),
)
for (const seed of seeds) it(`种子 ${seed}：共享记忆的并发写入结果及盘面与串行一致`, async () => {
  const [[initial, ops], turns] = sequenceCase(seed, fc.tuple(seedArb, fc.array(concurrentOpArb, { minLength: 3, maxLength: 4 })), 4)
  await checkSequence(seed, ops, turns, async (xs, scheduler) => {
    await assertSerialEquivalent(memorySubject(initial), scheduler, xs)
  })
}, 30_000)

const undoKinds = ['modelRewrite', 'preciseEdit', 'guiEdit', 'guiBatch', 'forget', 'promote'] as const
type UndoKind = typeof undoKinds[number]
const undoNames: Record<UndoKind, string> = {
  modelRewrite: '整条更新', preciseEdit: '精确修改', guiEdit: '界面编辑',
  guiBatch: '界面批量写入', forget: '删除', promote: '提升',
}
/** 前序写法：可撤的几种之外再混入补证（不拍快照、不记撤销条目）。 */
const prefixKinds = ['modelRewrite', 'preciseEdit', 'guiEdit', 'guiBatch', 'corroborate'] as const
type PrefixKind = typeof prefixKinds[number]
const undoGenerators: Record<UndoKind, (id: 'a' | 'b') => MemOp> = {
  modelRewrite: id => ({ kind: 'modelRewrite', id, isForced: true }),
  preciseEdit: id => ({ kind: 'preciseEdit', id }),
  guiEdit: id => ({ kind: 'guiEdit', id }),
  guiBatch: () => ({ kind: 'guiBatch' }),
  forget: id => ({ kind: 'forget', id }),
  promote: id => ({ kind: 'promote', id }),
}
const prefixGenerators: Record<PrefixKind, (id: 'a' | 'b') => MemOp> = {
  modelRewrite: undoGenerators.modelRewrite, preciseEdit: undoGenerators.preciseEdit,
  guiEdit: undoGenerators.guiEdit, guiBatch: undoGenerators.guiBatch,
  corroborate: id => ({ kind: 'corroborate', id }),
}
const recordsOf = async (w: MemoryWorld) => Promise.all(
  (['a', 'b'] as const).map(key => w.store.get(IDS[key], { workspacePath: W })),
)

for (const [kindIndex, kind] of undoKinds.entries()) {
  for (const isChanged of [false, true]) it(`真实写入${undoNames[kind]}：撤销所选一次${isChanged ? '拒绝覆盖后续改动' : '恢复改前记录且保留其余记忆'}`, async () => {
    const seed = seeds[kindIndex % seeds.length]!
    // 选中位置、目标、前序写法由种子决定；每种写法都覆盖可撤与后来又改过两支。
    const [[prefix, id], turns] = sequenceCase(seed, fc.tuple(
      fc.array(fc.constantFrom<PrefixKind>(...prefixKinds), { minLength: 0, maxLength: 2 }),
      keyArb,
    ))
    const selected = prefix.length
    const later = isChanged ? id : id === 'a' ? 'b' : 'a'
    const suffix: MemOp[] = isChanged || kind !== 'guiBatch'
      ? [{ kind: 'modelRewrite', id: later, isForced: true }] : []
    const ops = [...prefix.map(k => prefixGenerators[k](id)), undoGenerators[kind](id), ...suffix]
    await checkSequence(seed, ops, turns, async (sequence, scheduler) => {
      // 缩减仍按原对象辨认所选操作；删掉它不构成撤销性质的反例。
      if (!sequence.includes(ops[selected]!)) return
      const subject = {
        ...base, seedKey: undefined, splitTag: undefined, isClaimed: undefined, invariant: undefined,
        label: () => '随机写入后撤销一次',
        run: async (w: MemoryWorld, _op: number) => {
          let before: Awaited<ReturnType<typeof recordsOf>> = []
          let snapshotId: string | undefined
          let decisionId: string | undefined
          for (const [index, op] of sequence.entries()) {
            // 删除后再次改写，先通过产品恢复入口恢复；这一步随该次后续改写一起缩减。
            if (op === suffix[0] && kind === 'forget' && isChanged) {
              expect(await runGui(w, hooks, STORE_NOW, { cmd: 'restore', memoryId: IDS[id] })).toMatchObject({ ok: true })
            }
            await base.prepare!(w, w.root)
            const current = await recordsOf(w)
            const oldSnapshots = new Set((await w.snapshots.list()).map(s => s.id))
            const result = await base.run(w, op, index, hooks)
            if (op.kind === 'modelRewrite' || op.kind === 'preciseEdit' || op.kind === 'corroborate') expect(result).toMatchObject({ kind: 'updated' })
            else if (op.kind === 'promote') expect(result).toMatchObject({ promoted: [{ id: IDS[id] }] })
            else expect(result).toMatchObject({ ok: true })
            if (op === ops[selected]) {
              before = current
              const added = (await w.snapshots.list()).filter(s => !oldSnapshots.has(s.id))
              expect(added).toHaveLength(1)
              snapshotId = added[0]!.id
              const targets = kind === 'guiBatch' ? [0, 1] : [id === 'a' ? 0 : 1]
              expect(added[0]!.data).toEqual(targets.map(i => before[i]))
              decisionId = (await w.decisions.listSettled()).find(d => d.settled?.snapshotId === snapshotId)?.id
              if (kind !== 'forget' && kind !== 'promote') expect(decisionId).toBeDefined()
            }
          }
          const hasLaterChange = isChanged && sequence.includes(suffix[0]!)
          const end = await recordsOf(w)
          if (decisionId !== undefined) {
            const result = await runGui(w, hooks, STORE_NOW, { cmd: 'undo', decisionId })
            expect(result).toMatchObject(hasLaterChange ? { ok: false, code: 'stale' } : { ok: true })
          } else {
            const result = await executeSnapshotTool({ action: 'restore', snapshotId }, { workspacePath: W },
              { store: w.store, snapshots: w.snapshots, now: () => STORE_NOW })
            expect(result).toMatchObject({
              kind: 'restored', restored: hasLaterChange ? [] : [IDS[id]], skipped: hasLaterChange ? [IDS[id]] : [],
            })
          }
          const expected = [...end]
          if (!hasLaterChange) for (const i of kind === 'guiBatch' ? [0, 1] : [id === 'a' ? 0 : 1]) expected[i] = before[i]
          expect(await recordsOf(w)).toEqual(expected)
        },
      }
      const observation = await observeConcurrent(subject, scheduler, [0])
      expect(observation.raw).toEqual([{ value: undefined }])
      expect(observation.leftover).toEqual([])
      expect(observation.unhandled).toEqual([])
    })
  }, 30_000)
}

for (const kind of ['preciseEdit', 'guiBatch'] as const) it(`共享记忆：${undoNames[kind]} 与整条改写、界面编辑交错仍与串行一致`, async () => {
  const seed = seeds[0]!
  const [ops, turns] = sequenceCase(seed, fc.shuffledSubarray<MemOp>([
    undoGenerators[kind]('a'), { kind: 'modelRewrite', id: 'a', isForced: true }, { kind: 'guiEdit', id: 'a' },
  ], { minLength: 3, maxLength: 3 }), 3)
  await checkSequence(seed, ops, turns, async (xs, scheduler) => {
    await assertSerialEquivalent(base, scheduler, xs)
  })
}, 30_000)
