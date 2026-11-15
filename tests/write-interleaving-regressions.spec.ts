import { describe, expect, it, vi } from 'vitest'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { executeSnapshotTool } from '../src/tools/snapshot.ts'
import { scopeKey } from '../src/scope.ts'
import { assertSerialEquivalent, observeConcurrent, observeSerial, phasedScheduler, scheduleTrace } from './helpers/interleave.ts'
import { IDS, W, memorySubject, secretProblems, type MemOp, type Seed } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

const PROJ = workspaceDirName(W)

/** 调度报告里第一个满足条件的调用的位置：op 号操作发出、调用（不含操作名）是 call 或满足 call。 */
function firstCall(trace: readonly string[], op: number, call: string | ((call: string) => boolean), from = 0): number {
  const matches = typeof call === 'string' ? (c: string) => c === call : call
  return trace.findIndex((label, i) => i >= from && label.startsWith(`op${op}:`) && matches(label.slice(label.indexOf(' ') + 1)))
}

// 锁外按 id 定位、按范围读都是先列目录、后读文件。同进程另一次写入挪文件（恢复、归档、改名：先 link 新位置再删旧位置）
// 正好夹在中间时，新旧两处都可能看不到。下面的调度把窗口钉住：先列的目录里还没有、后看的位置已经没了。
// 快照落盘后的复核按作用域找，记录被搬到别的作用域时原作用域里也看不到，同样不算被删。
describe('锁外读撞上挪文件：在用的记录不被当成不存在', () => {
  it('从最近删除恢复 × 软删同一条：软删列完项目目录、恢复把文件从 .archive/ 挪回顶层、软删再看 .archive/，软删仍删到它', async () => {
    const seed: Seed = { a: 'workspace', b: 'deleted', isSameName: false }
    const ops: MemOp[] = [{ kind: 'restore', id: 'b' }, { kind: 'softDelete', id: 'b' }]
    const s = phasedScheduler([
      { op: 1, until: call => call === `readdir(${PROJ})` },
      { op: 0, until: call => call === `rm(${PROJ}/.archive/beta.md)` },
      { op: 1 },
    ])
    await assertSerialEquivalent(memorySubject(seed), s, ops)
    // 窗口确实出现了：两处都不经 ENOENT 落空（跨目录挪动）
    const trace = scheduleTrace(s)
    const listed = firstCall(trace, 1, `readdir(${PROJ})`)
    const linked = firstCall(trace, 0, `link(${PROJ}/beta.md.tmp-* → ${PROJ}/beta.md)`)
    const removed = firstCall(trace, 0, `rm(${PROJ}/.archive/beta.md)`)
    expect(listed).toBeGreaterThanOrEqual(0)
    expect(listed).toBeLessThan(linked)
    expect(firstCall(trace, 1, `readdir(${PROJ}/.archive)`, listed)).toBeGreaterThan(removed)
  })

  it('模型改写改名 × 界面编辑拍快照：快照落盘后的复核列完全局目录、改名把 alpha.md 换成 beta.md，快照里这条不被脱敏', async () => {
    const seed: Seed = { a: 'workspace', b: 'global', isSameName: true }
    const ops: MemOp[] = [{ kind: 'modelRewrite', id: 'b', isForced: true }, { kind: 'guiEdit', id: 'b' }]
    const s = phasedScheduler([
      { op: 0, until: call => call === 'readdir(.state/snapshots)' },
      { op: 1, until: call => call.startsWith('rename(.state/snapshots/') },
      { op: 1, until: call => call === `readdir(${GLOBAL_DIR})` },
      { op: 0, until: call => call === `rm(${GLOBAL_DIR}/alpha.md)` },
      { op: 1 },
    ])
    await assertSerialEquivalent(memorySubject(seed), s, ops)
    const trace = scheduleTrace(s)
    const snapshotted = firstCall(trace, 1, call => call.startsWith('rename(.state/snapshots/'))
    const listed = firstCall(trace, 1, `readdir(${GLOBAL_DIR})`, snapshotted)
    const linked = firstCall(trace, 0, `link(${GLOBAL_DIR}/beta.md.tmp-* → ${GLOBAL_DIR}/beta.md)`)
    const removed = firstCall(trace, 0, `rm(${GLOBAL_DIR}/alpha.md)`)
    expect(snapshotted).toBeGreaterThanOrEqual(0)
    expect(listed).toBeGreaterThan(snapshotted)
    expect(listed).toBeLessThan(linked)
    // 复核的按范围读（含 .archive/）横跨了这次挪动
    expect(firstCall(trace, 1, `readdir(${GLOBAL_DIR}/.archive)`, listed)).toBeGreaterThan(removed)
  })

  it('模型改写改名 × 界面编辑：编辑的预读列完全局目录、改名把 alpha.md 换成 beta.md 后才看 .archive/，编辑仍找到它', async () => {
    // 预读不带「没找到在锁内确认」：靠扫描期间有写入在跑这一条进锁确认
    const seed: Seed = { a: 'workspace', b: 'global', isSameName: true }
    const ops: MemOp[] = [{ kind: 'modelRewrite', id: 'b', isForced: true }, { kind: 'guiEdit', id: 'b' }]
    const s = phasedScheduler([
      { op: 1, until: call => call === `readdir(${GLOBAL_DIR})` },
      { op: 0, until: call => call === `rm(${GLOBAL_DIR}/alpha.md)` },
      { op: 1 },
    ])
    await assertSerialEquivalent(memorySubject(seed), s, ops)
    const trace = scheduleTrace(s)
    const listed = firstCall(trace, 1, `readdir(${GLOBAL_DIR})`)
    const linked = firstCall(trace, 0, `link(${GLOBAL_DIR}/beta.md.tmp-* → ${GLOBAL_DIR}/beta.md)`)
    const removed = firstCall(trace, 0, `rm(${GLOBAL_DIR}/alpha.md)`)
    expect(listed).toBeGreaterThanOrEqual(0)
    expect(listed).toBeLessThan(linked)
    expect(firstCall(trace, 1, `readdir(${GLOBAL_DIR}/.archive)`, listed)).toBeGreaterThan(removed)
  })

  it('两次提升同一条：两份快照都落盘后，后一次复核完先把它从项目搬到全局，前一次再复核，它的快照里这条不被脱敏', async () => {
    const seed: Seed = { a: 'workspace', b: 'workspace', isSameName: false }
    const ops: MemOp[] = [{ kind: 'promote', id: 'b' }, { kind: 'promote', id: 'b' }]
    const s = phasedScheduler([
      { op: 1, until: call => call.startsWith('rename(.state/snapshots/') },
      { op: 0, until: call => call.startsWith('rename(.state/snapshots/') },
      { op: 1, until: call => call === `rm(${PROJ}/beta.md)` },
      { op: 0 },
    ])
    // 复核按作用域找：项目里已经没有这条，但它是搬到了全局，不是被彻底删除
    await assertSerialEquivalent(memorySubject(seed), s, ops)
    // 前一次的快照在搬家之前落盘，复核（按范围读项目目录）在搬家之后
    const trace = scheduleTrace(s)
    const snapshotted = firstCall(trace, 0, call => call.startsWith('rename(.state/snapshots/'))
    const moved = firstCall(trace, 1, `rm(${PROJ}/beta.md)`)
    expect(snapshotted).toBeGreaterThanOrEqual(0)
    expect(moved).toBeGreaterThan(snapshotted)
    expect(firstCall(trace, 0, `readdir(${PROJ})`, snapshotted)).toBeGreaterThan(moved)
  })
})

// 提升在锁外预读、按读数拍「提升前」快照，再在锁内搬家。两步之间别的写入改了这条时，搬走的会是新版本而快照里是旧版本；被另一次提升先搬走时，
// 快照里是搬走前的位置、结果却报已提升。提升在搬家前按预读的内容和位置核对，对不上就不动，计入 skipped。
describe('提升读完、搬家之前同一条被改过或搬走', () => {
  it('模型改写插在提升的预读与搬家之间：不提升，计入 skipped；项目里是改写后的那一版，全局没有它', async () => {
    const seed: Seed = { a: 'workspace', b: 'workspace', isSameName: false }
    const ops: MemOp[] = [{ kind: 'promote', id: 'a' }, { kind: 'modelRewrite', id: 'a', isForced: false }]
    const obs = await observeSerial(memorySubject(seed), ops, [{ index: 0, part: 'read' }, { index: 1, part: 'all' }, { index: 0, part: 'commit' }])
    const result = (obs.outcomes[0] as { value: { promoted: unknown[]; skipped: string[] } }).value
    expect(result.promoted).toEqual([])
    expect(result.skipped).toEqual(['mem_a'])
    const file = (path: string) => obs.state.find(([p]) => p === path)?.[1]
    expect(file(`${PROJ}/alpha.md`)).toContain('模型改写 1')
    expect(file(`${GLOBAL_DIR}/alpha.md`)).toBeUndefined()
  })

  it('两次提升同一条，后一次插在前一次的预读与搬家之间：先读的那次计入 skipped，不把已在全局的这条当成刚提升的', async () => {
    const seed: Seed = { a: 'workspace', b: 'workspace', isSameName: false }
    const ops: MemOp[] = [{ kind: 'promote', id: 'b' }, { kind: 'promote', id: 'b' }]
    const obs = await observeSerial(memorySubject(seed), ops, [{ index: 0, part: 'read' }, { index: 1, part: 'all' }, { index: 0, part: 'commit' }])
    const [first, second] = obs.outcomes.map(o => (o as { value: { promoted: unknown[]; skipped: string[] } }).value)
    expect(first.promoted).toEqual([])
    expect(first.skipped).toEqual(['mem_b'])
    expect(second.promoted).toEqual([{ id: 'mem_b', target: 'global' }])
    const file = (path: string) => obs.state.find(([p]) => p === path)?.[1]
    expect(file(`${GLOBAL_DIR}/beta.md`)).toContain('id: mem_b')
    expect(file(`${PROJ}/beta.md`)).toBeUndefined()
  })
})

// 拍快照在锁外读记录、落盘后复核「读到的这条是不是已被彻底删除」。快照读完项目里那份含密钥的记录、还没落盘，
// 只删项目这一层的彻底删除整段做完（两遍脱敏都在这份快照落盘之前），复核时项目里已经没有它；全局另有一份 id、内容都相同的独立副本，
// 不能当成「搬走了」的证据，这份快照里的明文照样要脱敏，按快照恢复也恢复不出密钥
describe('快照读完、落盘前，同一条含密钥的记录只在项目这一层被彻底删除', () => {
  for (const hasCopy of [false, true]) {
    it(hasCopy ? '全局有一份相同的副本：快照里项目那份照样脱敏，恢复不出密钥' : '没有别的副本（对照）：快照里这条脱敏，恢复不出密钥', async () => {
      const seed: Seed = { a: 'workspace', b: 'workspace', isSameName: false, secret: 'a', ...(hasCopy ? { copy: 'a' as const } : {}) }
      const ops: MemOp[] = [{ kind: 'snapshot', ids: [] }, { kind: 'hardDelete', id: 'a', layer: 'workspace' }]
      const s = phasedScheduler([
        { op: 0, until: call => call === `readFile(${PROJ}/alpha.md)` },
        { op: 1 },
        { op: 0 },
      ])
      let problems: string[] = []
      let restoredInProject = false
      const obs = await observeConcurrent(memorySubject(seed), s, ops, async w => {
        problems = await secretProblems(w)
        for (const snap of await w.snapshots.list()) {
          await executeSnapshotTool({ action: 'restore', snapshotId: snap.id, overwriteChanged: true }, { workspacePath: W }, { store: w.store, snapshots: w.snapshots })
        }
        restoredInProject = (await w.store.copiesOf(IDS.a)).some(scope => scopeKey(scope) === W)
      })
      expect(obs.raw[1]).toMatchObject({ value: { ok: true, cmd: 'hard-delete', memoryIds: [IDS.a] } })
      // 窗口确实出现了：项目里那份在快照落盘之前就删掉了
      const trace = scheduleTrace(s)
      const removed = firstCall(trace, 1, `rm(${PROJ}/alpha.md)`)
      expect(removed).toBeGreaterThanOrEqual(0)
      expect(firstCall(trace, 0, call => call.startsWith('rename(.state/snapshots/'))).toBeGreaterThan(removed)
      expect({ problems, restoredInProject }).toEqual({ problems: [], restoredInProject: false })
    })
  }
})
