import { describe, expect, it, vi } from 'vitest'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { observeSerial } from './helpers/interleave.ts'
import { W, memorySubject, type MemOp, type Seed } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

const PROJ = workspaceDirName(W)

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
