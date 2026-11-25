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
import { basisOf, scopeKeyOf } from '../src/governance/changeset.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { runDreams } from '../src/tools/dreams-run.ts'
import { promises as fsp } from 'node:fs'
import { checkupEnv, bigRecord, findingKeys, type CheckupEnv } from './helpers/checkup-env.ts'
import { instructionsOf, noInstructions } from './helpers/instructions.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { batchMembers, findingsRows, memberIdOf, roundOf } from '../src/governance/checkup-plan.ts'
import { isSemanticAdmitted, planSemanticBatches, type SemanticLlm } from '../src/governance/semantic-scan.ts'
import type { ReadInstructions } from '../src/governance/instructions.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { isFullyCovered } from '../src/gui/contract.ts'

vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

const hooks = { beforeCommit: async () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const initial = { a: 'workspace', b: 'workspace', isSameName: false } as const
const base = memorySubject(initial)
const kinds = ['新建', '整条更新', '精确修改', '补证', '删除', '提升', '界面批量写入', '梦境改写'] as const
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
    const result = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: before.id, name: before.name, content, allowSecret: true }), { store: w.store, registry, workspacePath: W, snapshots: w.snapshots, session: { id: `会话${op.writer}`, lastSeq: op.index + 1 }, now: () => STORE_NOW })
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
  // 记忆梦境的一次完整运行（认领、记开始、读基线、步骤里应用一条变更集操作、记结果），和前台的写入抢同一把锁、同一本账
  梦境改写: async (w, op, before) => {
    const content = `梦境改写${op.index}`
    const scope = { kind: 'workspace', workspacePath: W } as const
    const checkups = new CheckupRecordStore(w.sidecar.checkups)
    const result = await runDreams(scope, { by: 'manual' }, {
      store: w.store, snapshots: w.snapshots, decisions: w.decisions, dreams: new DreamsStore(w.sidecar.dreams, w.sidecar.dreamMarks), log: { info() {}, warn() {}, error() {} },
      claimScope: async () => {
        const claimed = await checkups.claim([scope])
        return 'busy' in claimed ? claimed : { release: async () => { for (const claim of claimed.claims) await claim.release() } }
      },
      activity: async () => ({ isComplete: true, workspaces: new Map() }),
      resolveLlm: async () => ({ llm: null, isSelected: false, fellBack: false }),
      config: () => DREAMS_DEFAULTS,
      isGovernanceEnabled: () => true,
      plan: [{
        name: 'edit', needsChanges: false,
        run: async (ctx) => {
          const read = (await w.store.get(before.id, { workspacePath: W }))!
          const applied = await ctx.apply([{ id: `dream_${op.index}`, kind: 'edit', memoryId: read.id, scopeKey: scopeKeyOf(read), basis: [basisOf(read)], patch: { content }, expect: { content: read.content } }])
          expect(applied.outcomes.map(o => o.kind)).toEqual(['applied'])
        },
      }],
      interval: () => () => {},
      now: () => STORE_NOW,
      newRunId: () => `pd_dream_${op.index}`,
    })
    expect(result).toMatchObject({ kind: 'completed', entryId: `pd_dream_${op.index}` })
    expect(await w.store.get(before.id, { workspacePath: W })).toMatchObject({ content, lastChange: { by: 'dreams' } })
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
  fc.constant<MemOp>({ kind: 'groupMerge' }),
  fc.record({ kind: fc.constant('lock' as const), id: keyArb }),
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
  modelRewrite: id => ({ kind: 'modelRewrite', id, allowsSecret: true }),
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
      ? [{ kind: 'modelRewrite', id: later, allowsSecret: true }] : []
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
              // 界面批量写入每项各拍一份改前快照，其余写法一次一份
              const targets = kind === 'guiBatch' ? [0, 1] : [id === 'a' ? 0 : 1]
              expect(added).toHaveLength(targets.length)
              snapshotId = added[0]!.id
              const snapped = added.flatMap(s => s.data)
              expect(snapped).toHaveLength(targets.length)
              expect(snapped).toEqual(expect.arrayContaining(targets.map(i => before[i])))
              decisionId = (await w.decisions.listSettled()).find(d => added.some(s => s.id === d.settled?.snapshotId))?.id
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
    undoGenerators[kind]('a'), { kind: 'modelRewrite', id: 'a', allowsSecret: true }, { kind: 'guiEdit', id: 'a' },
  ], { minLength: 3, maxLength: 3 }), 3)
  await checkSequence(seed, ops, turns, async (xs, scheduler) => {
    await assertSerialEquivalent(base, scheduler, xs)
  })
}, 30_000)

// 记忆梦境逐条整理，调模型期间用户上锁、界面改了另一条：锁定的那条跳过，改过的那条按读到的依据对不上跳过，结果仍与某个串行顺序一致
for (const seed of seeds) it(`种子 ${seed}：梦境整理与上锁、界面编辑交错仍与串行一致`, async () => {
  const [ops, turns] = sequenceCase(seed, fc.shuffledSubarray<MemOp>([{ kind: 'dreamTidy' }, { kind: 'lock', id: 'b' }, { kind: 'guiEdit', id: 'a' }], { minLength: 3, maxLength: 3 }), 3)
  await checkSequence(seed, ops, turns, async (xs, scheduler) => {
    await assertSerialEquivalent(base, scheduler, xs)
  })
}, 30_000)

// 成组方案和单条写入、上锁交错：组要么全做成、要么撤干净，结果仍与某个串行顺序一致
for (const [name, rival] of [
  ['单条写入', [{ kind: 'modelRewrite', id: 'a', allowsSecret: true }, { kind: 'preciseEdit', id: 'b' }]],
  ['上锁', [{ kind: 'lock', id: 'b' }, { kind: 'guiEdit', id: 'a' }]],
] as const satisfies ReadonlyArray<readonly [string, readonly MemOp[]]>) {
  for (const seed of seeds) it(`种子 ${seed}：成组方案与${name}交错仍与串行一致`, async () => {
    const [ops, turns] = sequenceCase(seed, fc.shuffledSubarray<MemOp>([{ kind: 'groupMerge' }, ...rival], { minLength: 3, maxLength: 3 }), 3)
    await checkSequence(seed, ops, turns, async (xs, scheduler) => {
      await assertSerialEquivalent(base, scheduler, xs)
    })
  }, 30_000)
}

// —— 增量体检：带小上限的体检和前台写入、界面裁决交错 ——

const PROJECT = '/work/proj'
const PROJECT_SCOPE = { kind: 'workspace', workspacePath: PROJECT } as const
const UNCAPPED = Number.MAX_SAFE_INTEGER
/** 小记忆的垫字：一批装得下一条长记忆加两条小记忆，三条长记忆把小记忆分到不同的批。 */
const PADDING = '字'.repeat(10_000)
const findingKey = (f: { type: string; memoryIds: readonly string[] }) => `${f.type}:${[...f.memoryIds].sort().join('+')}`

/**
 * 按内容出结论的模型桩：正文带「模糊」的报一条说不清；同一批里带同一个冲突标记的两两报冲突。结论只由批成员和上下文决定。
 * 带「新指令」的指令文件进了提示词时，说不清的结论只报带「新」的记忆。gate 给了时每次调用先等它（插入前台写入、卡住一次体检）。
 */
interface ContentModel extends SemanticLlm { calls: number; gate?: () => Promise<void> }
function contentModel(): ContentModel {
  const m: ContentModel = {
    provider: 'stub', model: 'model-a', calls: 0,
    complete: async ({ system, user }) => {
      if (system.includes('多个项目（workspace）')) return '{"duplicates":[]}'
      m.calls++
      await m.gate?.()
      const at = user.indexOf('## 记忆列表')
      const isNew = user.slice(0, at).includes('新指令')
      const blocks = [...user.slice(at).matchAll(/^- id=(\S+)[^\n]*\n((?: {2}[^\n]*(?:\n|$))*)/gm)]
        .map(x => ({ id: x[1]!, text: x[2]! }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
      const findings: object[] = []
      for (const b of blocks) {
        if (b.text.includes('模糊') && (!isNew || b.text.includes('新'))) findings.push({ type: 'unclear', memoryIds: [b.id], summary: '说得含糊', suggestedAction: '处理' })
      }
      for (const mark of ['冲突甲', '冲突乙']) {
        const tagged = blocks.filter(b => b.text.includes(mark))
        for (let i = 0; i < tagged.length; i++) for (let j = i + 1; j < tagged.length; j++) {
          findings.push({ type: 'conflict', memoryIds: [tagged[i]!.id, tagged[j]!.id], summary: `${mark}互相矛盾`, suggestedAction: '处理' })
        }
      }
      return JSON.stringify({ findings })
    },
  }
  return m
}

/** 项目范围里的全部记录（含删掉的）。体检开始前读一次，判定用的就是这一份。 */
async function projectRecords(e: CheckupEnv): Promise<MemoryRecord[]> {
  return (await e.store.readRaw(PROJECT_SCOPE)).records.map(x => x.record)
}
const scanProject = (e: CheckupEnv, llm: SemanticLlm) => e.scan({ llm, layers: 'semantic', target: { kind: 'scope', scope: PROJECT_SCOPE } })

/**
 * 视图里的每条发现，要么来自当前有有效结果的批（库里有成员对得上、没被全部重查作废的行），要么满足沿用的条件：
 * 出自过时或作废的行，引用的每条记忆现在的扫描指纹等于那一行记的，并且至少有一条在没有有效结果的批里。
 */
async function expectViewExplained(e: CheckupEnv, read: readonly MemoryRecord[], now: number): Promise<void> {
  const batches = planSemanticBatches(read.filter(r => isSemanticAdmitted(r, now))).map(batchMembers)
  const round = e.db.readRound(roundOf(PROJECT_SCOPE))
  if (round === undefined) throw new Error('读不到这一轮的库')
  const rows = findingsRows(round.rows)
  const same = (a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]) => JSON.stringify(a) === JSON.stringify(b)
  const validRows = rows.filter(r => r.checkedAt >= round.recheckBefore && batches.some(b => same(b, r.members)))
  const unresolved = new Set(batches.filter(b => !validRows.some(r => same(b, r.members))).flat().map(([copy]) => copy))
  const current = new Map(batches.flat())
  const valid = new Set(validRows.flatMap(r => r.result.map(findingKey)))
  const carried = new Set(rows.filter(r => !validRows.includes(r)).flatMap(r => r.result.filter(f => {
    const refs = f.memoryIds.map(id => r.members.find(([copy]) => memberIdOf(copy) === id)!)
    return refs.every(([copy, fp]) => current.get(copy) === fp) && refs.some(([copy]) => unresolved.has(copy))
  }).map(findingKey)))
  for (const k of findingKeys(await e.view(PROJECT_SCOPE))) expect(valid.has(k) || carried.has(k), k).toBe(true)
}

/** 冷热两路：先从热的这份拍快照（记忆文件和待决账本）给一份空缓存的环境，再各自不设上限查一遍，发现集合相等。 */
async function expectHotEqualsCold(hot: CheckupEnv, instructions: ReadInstructions = noInstructions): Promise<void> {
  const cold = await checkupEnv({ instructions, tokenCap: UNCAPPED })
  try {
    await fsp.cp(hot.memoryRoot, cold.memoryRoot, { recursive: true })
    for (const [key, value] of await hot.pending.list()) await cold.pending.put(key, value)
    cold.clock.now = hot.clock.now = hot.clock.now + 1000
    hot.tokenCap.value = UNCAPPED
    const warm = await scanProject(hot, contentModel())
    if (warm.kind !== 'single') throw new Error(warm.kind)
    expect(isFullyCovered(warm.rounds![0]!.coverage)).toBe(true)
    await scanProject(cold, contentModel())
    expect(findingKeys(await hot.view(PROJECT_SCOPE))).toEqual(findingKeys(await cold.view(PROJECT_SCOPE)))
  } finally {
    await cold.close()
  }
}

type ForegroundOp =
  | { kind: 'save'; mark: string }
  | { kind: 'edit'; target: number; mark: string }
  | { kind: 'delete'; target: number }
  | { kind: 'resolve'; verdict: 'keep-both' | 'dismiss' }
type CheckupStep = ForegroundOp | { kind: 'checkup'; cap: number; during: ForegroundOp[] }

const markArb = fc.constantFrom('', '模糊', '冲突甲', '冲突乙', '模糊 冲突甲')
const foregroundArb: fc.Arbitrary<ForegroundOp> = fc.oneof(
  fc.record({ kind: fc.constant('save' as const), mark: markArb }),
  fc.record({ kind: fc.constant('edit' as const), target: fc.nat(), mark: markArb }),
  fc.record({ kind: fc.constant('delete' as const), target: fc.nat() }),
  fc.record({ kind: fc.constant('resolve' as const), verdict: fc.constantFrom('keep-both' as const, 'dismiss' as const) }),
)
const checkupStepArb: fc.Arbitrary<CheckupStep> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant('checkup' as const), cap: fc.constantFrom(1, 30_000, 60_000), during: fc.array(foregroundArb, { maxLength: 2 }) }), weight: 2 },
  { arbitrary: foregroundArb, weight: 1 },
)

/** 三条长记忆各起一批，四条小记忆两两跟着前两条；两对冲突各在一批里，还有一条说不清。 */
async function seedCheckupWorld(e: CheckupEnv): Promise<void> {
  const rows: Array<[string, number, string | undefined]> = [
    ['mem_b1', 1, undefined], ['mem_s1', 2, '冲突甲'], ['mem_s2', 3, '冲突甲 模糊'], ['mem_b2', 4, undefined], ['mem_s3', 5, '冲突乙'], ['mem_s4', 6, '冲突乙'], ['mem_b3', 7, undefined],
  ]
  for (const [id, createdAt, mark] of rows) {
    const at = { scope: 'workspace' as const, workspacePath: PROJECT, createdAt }
    await e.store.put(mark === undefined ? bigRecord({ id, ...at }) : record({ id, name: id, content: `${id} 的正文 ${mark} ${PADDING}`, ...at }))
  }
}

async function runForeground(e: CheckupEnv, op: ForegroundOp, index: number): Promise<void> {
  const now = e.clock.now
  const pipelineDeps = { store: e.store, registry: e.deps.registry, workspacePath: PROJECT, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), session: { id: '前台会话', lastSeq: index + 1 }, now: () => now }
  // 只改、只删小记忆：长记忆留着撑出分批
  const small = (await projectRecords(e)).filter(r => r.status === 'active' && !r.id.startsWith('mem_b')).sort((a, b) => (a.id < b.id ? -1 : 1))
  const target = 'target' in op ? small[op.target % Math.max(small.length, 1)] : undefined
  switch (op.kind) {
    case 'save': {
      const saved = await runSavePipeline(candidate({ name: `前台新记忆${index}`, type: 'knowledge', scope: 'workspace', content: `第 ${index} 次保存的正文 ${op.mark}`, summary: `第 ${index} 次保存`, allowSecret: true }), pipelineDeps)
      expect(saved.kind).toBe('saved')
      return
    }
    case 'edit': {
      if (target === undefined) return
      const edited = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: target.id, name: target.name, content: `${target.id} 第 ${index} 次改 ${op.mark} ${PADDING}`, allowSecret: true }), pipelineDeps)
      expect(edited.kind).toBe('updated')
      return
    }
    case 'delete':
      if (target !== undefined) await e.store.softDelete({ id: target.id, workspacePath: PROJECT }, { now })
      return
    case 'resolve': {
      const open = (await e.decisions.list()).find(d => (d.kind ?? 'conflict') === 'conflict')
      if (open === undefined) return
      const resolved = await executeConfirm({ action: 'resolve', decisionId: open.id, verdict: op.verdict }, { workspacePath: PROJECT }, {
        store: e.store, decisions: e.decisions, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), instructions: noInstructions, now: () => now,
      })
      expect(resolved.kind).toBe('resolved')
    }
  }
}

const checkupSeeds = Array.from({ length: interleaveRuns(60) }, (_, index) => firstSeed + index)
describe('增量体检随机序列', () => {
  for (const seed of checkupSeeds) it(`种子 ${seed}：带小上限的体检与前台保存、编辑、删除、界面裁决交错，视图里的发现都有来处；最后冷热两路发现相同`, async () => {
    const [steps, turns] = sequenceCase(seed, fc.array(checkupStepArb, { minLength: 3, maxLength: 6 }))
    await checkSequence(seed, steps, turns, async xs => {
      const e = await checkupEnv()
      try {
        await seedCheckupWorld(e)
        for (const [index, step] of xs.entries()) {
          e.clock.now += 1000
          if (step.kind !== 'checkup') {
            await runForeground(e, step, index)
            continue
          }
          e.tokenCap.value = step.cap
          const read = await projectRecords(e)
          const model = contentModel()
          // 前台写入插在这次体检读完记忆、调模型的时候；一批都没发（全命中）时体检完再做
          let during: ForegroundOp[] = [...step.during]
          model.gate = async () => {
            const ops = during
            during = []
            for (const op of ops) await runForeground(e, op, index)
          }
          await scanProject(e, model)
          await expectViewExplained(e, read, e.clock.now)
          for (const op of during) await runForeground(e, op, index)
        }
        await expectHotEqualsCold(e)
      } finally {
        await e.close()
      }
    })
  }, 30_000)

  it('并发：先开始的体检读了旧指令文件、晚到，视图仍是后开始那次的', async () => {
    const instruction = { text: '旧指令：用 npm' }
    const instructions = instructionsOf({ [PROJECT]: () => instruction.text })
    const e = await checkupEnv({ instructions })
    try {
      const at = { scope: 'workspace' as const, workspacePath: PROJECT }
      await e.store.put(record({ id: 'mem_old', name: 'old', content: '旧的说法 模糊', ...at }))
      await e.store.put(record({ id: 'mem_new', name: 'new', content: '新的说法 模糊', ...at }))
      const early = contentModel()
      let release!: () => void
      const reached = new Promise<void>(resolve => {
        early.gate = () => { resolve(); return new Promise<void>(r => { release = r }) }
      })
      const first = scanProject(e, early)
      await reached
      instruction.text = '新指令：用 pnpm'
      e.clock.now += 1000
      await scanProject(e, contentModel())
      const later = await e.view(PROJECT_SCOPE)
      expect(findingKeys(later)).toEqual(['unclear:mem_new'])
      release()
      await first
      // 晚到的那一刻：视图还是后开始那次的
      expect(await e.view(PROJECT_SCOPE)).toEqual(later)
      // 晚到的那次按它读到的算全覆盖，清理可能删掉后开始那次的行（下次重查，不承诺命中）；再跑一次，结果按新指令
      e.clock.now += 1000
      await scanProject(e, contentModel())
      expect(findingKeys(await e.view(PROJECT_SCOPE))).toEqual(['unclear:mem_new'])
      await expectHotEqualsCold(e, instructions)
    } finally {
      await e.close()
    }
  })

  for (const seed of checkupSeeds) it(`种子 ${seed}：两个体检同时查同一轮、按随机先后放行，再跑一次满足冷热等式`, async () => {
    const [[caps, order, edit], turns] = sequenceCase(seed, fc.tuple(
      fc.tuple(fc.constantFrom(1, 30_000, UNCAPPED), fc.constantFrom(1, 30_000, UNCAPPED)),
      fc.constantFrom([0, 1], [1, 0]),
      fc.option(fc.tuple(fc.nat(), markArb), { nil: undefined }),
    ))
    await checkSequence(seed, [order], turns, async xs => {
      const e = await checkupEnv()
      try {
        await seedCheckupWorld(e)
        const models = [contentModel(), contentModel()]
        const releases: Array<() => void> = []
        const reached = models.map((m, i) => new Promise<void>(resolve => {
          let isFirst = true
          m.gate = () => {
            if (!isFirst) return Promise.resolve()
            isFirst = false
            resolve()
            return new Promise<void>(r => { releases[i] = r })
          }
        }))
        // 先后开始，都在读完记忆、调第一批模型时卡住：两次都没看到对方的结果
        const runs: Array<Promise<unknown>> = []
        for (const [i, m] of models.entries()) {
          e.tokenCap.value = caps[i]
          runs.push(scanProject(e, m))
          await reached[i]
          e.clock.now += 1000
        }
        // 这时前台改一条，再按种子定的先后放行
        if (edit !== undefined) await runForeground(e, { kind: 'edit', target: edit[0], mark: edit[1] }, 0)
        for (const i of xs[0] ?? order) {
          releases[i]!()
          await runs[i]
        }
        await expectHotEqualsCold(e)
      } finally {
        await e.close()
      }
    })
  }, 30_000)
})
