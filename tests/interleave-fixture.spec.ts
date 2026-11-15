import { describe, expect, it, vi } from 'vitest'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import fc from 'fast-check'
import { atomicWrite, createExclusive } from '../src/storage/state-files.ts'
import {
  assertSerialEquivalent, diskState, interleaveParams, interleaveRuns, interleaveScheduler, observeConcurrent, scheduleTrace, type Subject,
} from './helpers/interleave.ts'

// 文件系统是进程边界：node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 调大 PM_INTERLEAVE_RUNS 时按次数放宽
const TIMEOUT_MS = Math.max(20_000, interleaveRuns() * 50)

describe('夹具自检', () => {
  // 故意写错的读改写：锁外读、锁内写。两次并发自增，两次读都落在任何一次写之前就丢一次更新
  interface Counter { path: string; chain: Promise<unknown> }
  const increment = (isReadInsideLock: boolean) => async (c: Counter): Promise<void> => {
    const read = async () => Number(await readFile(c.path, 'utf8'))
    const early = isReadInsideLock ? undefined : await read()
    const write = async () => {
      const n = early ?? await read()
      await writeFile(`${c.path}.tmp-1-a`, String(n + 1), 'utf8')
      await rename(`${c.path}.tmp-1-a`, c.path)
    }
    const next = c.chain.then(write, write)
    c.chain = next.catch(() => {})
    await next
  }
  const counter = (isReadInsideLock: boolean): Subject<Counter, 'inc'> => ({
    world: root => ({ path: join(root, 'counter.txt'), chain: Promise.resolve() }),
    seed: async c => { await writeFile(c.path, '0', 'utf8') },
    run: increment(isReadInsideLock),
    label: () => 'inc',
    state: async (_, root) => diskState(root),
  })
  const brokenCounter = fc.asyncProperty(interleaveScheduler(), async s => { await assertSerialEquivalent(counter(false), s, ['inc', 'inc']) })

  it('IL-05：锁外读、锁内写的计数器在缺省次数内被搜出丢更新，给出可复现的种子、路径和调度报告', async () => {
    const result = await fc.check(brokenCounter, interleaveParams())
    expect(result.failed).toBe(true)
    expect(result.numRuns).toBeLessThanOrEqual(interleaveRuns())
    expect(result.counterexamplePath).not.toBeNull()
    const message = String((result.errorInstance as Error).message)
    expect(message).toContain('与任何一种串行顺序都不一致')
    // 调度报告：两次读都在第一次改名之前
    const trace = message.split('调度报告：\n')[1]!.split('\n并发观测')[0]!.split('\n').map(l => l.trim())
    const firstRename = trace.findIndex(l => l.includes('rename('))
    expect(trace.filter((l, i) => l.includes('readFile(counter.txt)') && i < firstRename)).toHaveLength(2)
    // 按报告里的种子和路径重放：同一条调度、同一个反例
    const replay = await fc.check(brokenCounter, { seed: result.seed, path: result.counterexamplePath!, numRuns: 1 })
    expect(replay.failed).toBe(true)
    expect(String((replay.errorInstance as Error).message)).toBe(message)
  }, TIMEOUT_MS)

  it('IL-05：读也挪进锁内后，同样的搜索全部通过（判据不误报）', async () => {
    await fc.assert(fc.asyncProperty(interleaveScheduler(), async s => { await assertSerialEquivalent(counter(true), s, ['inc', 'inc']) }), interleaveParams())
  }, TIMEOUT_MS)

  // 调度控制的是调用何时发出，同一时刻只有一个真实调用在途：同一种子和路径重放，盘面、结果、调度报告每次都相同
  type RaceOp = { kind: 'exclusive'; text: string } | { kind: 'append'; text: string }
  const race: Subject<{ root: string }, RaceOp> = {
    world: root => ({ root }),
    seed: async ({ root }) => { await writeFile(join(root, 'shared.txt'), 'start', 'utf8') },
    run: async ({ root }, op) => {
      if (op.kind === 'exclusive') return createExclusive(join(root, 'claim.json'), op.text)
      const text = await readFile(join(root, 'shared.txt'), 'utf8')
      await atomicWrite(join(root, 'shared.txt'), `${text}+${op.text}`)
      return text
    },
    label: op => `${op.kind}(${op.text})`,
    state: async (_, root) => diskState(root),
  }
  const raceOps: RaceOp[] = [{ kind: 'exclusive', text: 'A' }, { kind: 'exclusive', text: 'B' }, { kind: 'append', text: 'C' }, { kind: 'append', text: 'D' }]

  it('重放确定：两个排他创建抢同一个名字、两个读改写同一个文件，同一种子和路径重放 20 次，观测完全相同', async () => {
    const observed: string[] = []
    const property = fc.asyncProperty(interleaveScheduler(), async s => {
      const run = await observeConcurrent(race, s, raceOps)
      observed.push(JSON.stringify({ outcomes: run.outcomes, state: run.state, trace: scheduleTrace(s) }))
    })
    const seeds = [interleaveParams().seed, 1, 2, 3, 4, 5]
    const distinct = new Set<string>()
    for (const seed of seeds) {
      observed.length = 0
      for (let i = 0; i < 20; i++) await fc.assert(property, { seed, path: '0', numRuns: 1 })
      expect(new Set(observed).size).toBe(1)
      distinct.add(observed[0]!)
    }
    // 换种子换得出不同的调度，说明重放相同不是因为调度没起作用
    expect(distinct.size).toBeGreaterThan(1)
  }, TIMEOUT_MS)

  // 认领不到立即返回 claimed：判据把它当成没发生过，另查当时确有别的操作持有同一认领。
  // 写错的版本在结果文件已经有了时也回 claimed（那时谁都没持有认领），判据要报出来
  const claimer = (isBroken: boolean): Subject<{ root: string }, 'take'> => ({
    world: root => ({ root }),
    seed: async () => {},
    run: async ({ root }, _op, index) => {
      if (isBroken) {
        try { await readFile(join(root, 'out.txt'), 'utf8'); return 'claimed' } catch { /* 还没有，照常认领 */ }
      }
      const claim = join(root, 'job.claim')
      if (!(await createExclusive(claim, String(index)))) return 'claimed'
      await atomicWrite(join(root, 'out.txt'), String(index))
      await rm(claim)
      return 'done'
    },
    label: () => 'take',
    state: async (_, root) => diskState(root),
    isClaimed: value => value === 'claimed',
  })

  it('认领不到的操作按没发生过比，且确有持有者；搜得到两边都认领到、一边认领不到两种情形', async () => {
    const seen = new Set<number>()
    await fc.assert(fc.asyncProperty(interleaveScheduler(), async s => {
      seen.add((await assertSerialEquivalent(claimer(false), s, ['take', 'take'])).claimed.length)
    }), interleaveParams())
    expect([...seen].sort()).toEqual([0, 1])
  }, TIMEOUT_MS)

  it('没人持有认领时回 claimed，判据报出来', async () => {
    // 写错的版本还有先查后做的竞争，也会被判成不串行等价；这里只看没人持有时回 claimed 的那些次报没报出来
    const messages: string[] = []
    await fc.assert(fc.asyncProperty(interleaveScheduler(), async s => {
      try { await assertSerialEquivalent(claimer(true), s, ['take', 'take']) } catch (err) { messages.push(String((err as Error).message)) }
    }), interleaveParams())
    expect(messages.some(m => m.includes('回了 claimed，却没有尝试过认领'))).toBe(true)
  }, TIMEOUT_MS)
})

