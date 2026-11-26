import fc from 'fast-check'
import { expect, it } from 'vitest'
import { join } from 'node:path'
import { withInterleaveCase, interleavedFs, observeConcurrent, observeSerial, phasedScheduler, scheduleTrace } from './helpers/interleave.ts'

let release!: () => void
const gate = new Promise<void>(resolve => { release = resolve })
let old: Promise<unknown>
let oldSignal: AbortSignal
let reached!: () => void
const atGate = new Promise<void>(resolve => { reached = resolve })
const subject = { world: (root: string) => root, seed: async () => {}, label: () => '写入', state: async () => [] }

// 正文停在受控门上，预期超时；下一条放行它，检验真实超时之后的交叠。
it.fails('旧用例等待放行时仍按超时失败', async ({ signal }) => {
  oldSignal = signal
  old = withInterleaveCase(signal, () => observeConcurrent({ ...subject, run: async root => {
    reached()
    await gate
    await interleavedFs.writeFile(join(root, 'old.txt'), '旧用例')
  } }, phasedScheduler([]), [0]))
  await old
}, 30)

it('旧用例收尾不把操作混进新报告，也不关闭新调度器', async () => {
  const scheduler = phasedScheduler([])
  await observeConcurrent({ ...subject, run: async root => {
    await atGate
    expect(oldSignal.aborted).toBe(true)
    release()
    await expect(old).rejects.toBe(oldSignal.reason)
    await interleavedFs.writeFile(join(root, 'next.txt'), '新用例')
  } }, scheduler, [0])
  expect(scheduleTrace(scheduler)).toEqual(['op0:写入 writeFile(next.txt)'])
})


it('取消传到性质顶层，不当业务结果，也不继续缩减或进入下一轮', async () => {
  const controller = new AbortController()
  const reason = new Error('用例已取消')
  let runs = 0
  await expect(withInterleaveCase(controller.signal, async () => {
    await fc.assert(fc.asyncProperty(fc.nat(), async () => {
      runs++
      await observeConcurrent({ ...subject, run: async root => {
        controller.abort(reason)
        await interleavedFs.writeFile(join(root, 'cancelled.txt'), '不能写入')
      } }, phasedScheduler([]), [0])
    }), { numRuns: 10 })
  })).rejects.toBe(reason)
  expect(runs).toBe(1)
})

// 子进程装载原恢复文件及其真实 fs mock，避免两个文件的 mock 在同一个模块图里互相覆盖。
it('恢复用例超时后，旧正文和收尾只碰自己的故障与资源', async () => {
  const { promises: fs } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const root = process.cwd()
  const dir = await fs.mkdtemp(join(tmpdir(), 'pm-isolation-probe-'))
  try {
    await fs.symlink(join(root, 'node_modules'), join(dir, 'node_modules'))
    for (const name of ['state-change-recovery', 'op-recovery-edges']) {
      const source = await fs.readFile(join(root, 'tests', `${name}.spec.ts`), 'utf8')
      const faultField = name === 'state-change-recovery' ? 'remaining' : 'unreadable'
      const initial = name === 'state-change-recovery' ? '123' : "'本用例'"
      const old = name === 'state-change-recovery' ? '456' : "'旧用例'"
      const probe = `
let releaseIsolation!: () => void
const isolationGate = new Promise<void>(resolve => { releaseIsolation = resolve })
let oldIsolation: Promise<void>
let oldRoot: string
let oldSignal: AbortSignal
let ready!: () => void
const atGate = new Promise<void>(resolve => { ready = resolve })
const test = (name: string, fn: () => Promise<void>) => {
  if (name.endsWith('旧正文按超时失败')) return probeTest.fails(name, async ({ signal }) => {
    oldSignal = signal
    oldIsolation = fn()
    await oldIsolation
  }, 30)
  return probeTest(name, fn)
}
// 超时失败是预期结果；下一条用例才放行旧正文，制造确定的交叠。
it('隔离探针：旧正文按超时失败', async () => {
    oldRoot = scope().root
    const journal = new OpJournal({ path: join(${name === 'state-change-recovery' ? 'scope().journalDir' : 'scope().base'}, 'probe.sqlite'), log: quiet })
    scope().journals.push(journal)
    ready()
    await isolationGate
    expect(journal.pending()).toEqual([])
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await actual.writeFile(join(${name === 'state-change-recovery' ? 'scope().root' : 'scope().base'}, 'old-alive'), '正文结束前目录仍可用')
    scope().fault.${faultField} = ${old}
})
it('隔离探针：下一条保有自己的故障和目录', async () => {
    await atGate
    expect(oldSignal.aborted).toBe(true)
    scope().fault.${faultField} = ${initial}
    const ownRoot = scope().root
    const journal = new OpJournal({ path: join(${name === 'state-change-recovery' ? 'scope().journalDir' : 'scope().base'}, 'probe.sqlite'), log: quiet })
    scope().journals.push(journal)
    releaseIsolation()
    await oldIsolation
    expect(journal.pending()).toEqual([])
    expect(scope().fault.${faultField}).toBe(${initial})
    expect(scope().root).toBe(ownRoot)
    expect(ownRoot).not.toBe(oldRoot)
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const parent = ${name === 'state-change-recovery' ? 'ownRoot' : 'scope().base'}
    expect((await real.stat(parent)).isDirectory()).toBe(true)
    ${name === 'state-change-recovery'
      ? "scope().fault.remaining = 0; await expect(writeFile(join(parent, 'blocked'), 'x')).rejects.toThrow('进程在 writeFile 之前退出')"
      : "scope().fault.unreadable = join(parent, 'blocked'); await expect(readFile(scope().fault.unreadable)).rejects.toMatchObject({ code: 'EACCES' })"}
    await expect(real.stat(${name === 'state-change-recovery' ? 'oldRoot' : "(await import('node:path')).dirname(oldRoot)"})).rejects.toMatchObject({ code: 'ENOENT' })
})
`
      const fixture = source.slice(0, source.search(/\n(?:describe|it)\(/))
      const relocated = fixture.replace('it as test', 'it as probeTest').replace(/from '(\.\.?\/[^']+)'/g, (_match, path: string) => `from '${join(root, 'tests', path)}'`)
      await fs.writeFile(join(dir, `${name}.spec.ts`), relocated + probe)
    }
    await fs.writeFile(join(dir, 'vitest.config.mts'), `export default { test: { include: ['*.spec.ts'] } }`)
    const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'vitest.config.mts')], { cwd: dir })
    expect(stdout).toContain('4 passed')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 20_000)

it('令牌放行后取消，排队的调用不再真正写盘', async () => {
  const controller = new AbortController()
  const reason = new Error('放行后取消')
  const scheduler = phasedScheduler([])
  const schedule = scheduler.schedule.bind(scheduler)
  scheduler.schedule = async (task, label) => {
    const value = await schedule(task, label)
    controller.abort(reason)
    return value
  }
  let didWrite = true
  await expect(withInterleaveCase(controller.signal, () => observeConcurrent({ ...subject, run: async root => {
    const path = join(root, 'queued.txt')
    try { await interleavedFs.writeFile(path, '不能写入') } finally {
      const { promises: fs } = await import('node:fs')
      didWrite = await fs.stat(path).then(() => true, () => false)
    }
  } }, scheduler, [0]))).rejects.toBe(reason)
  expect(scheduleTrace(scheduler)).toEqual(['op0:写入 writeFile(queued.txt)'])
  expect(didWrite).toBe(false)
})

it('准备阶段把取消转成普通错误，也不进入缩减正文', async () => {
  const controller = new AbortController()
  const reason = new Error('准备期间取消')
  let runs = 0
  await expect(withInterleaveCase(controller.signal, () => fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async () => {
    runs++
    await observeConcurrent({ ...subject, prepare: async () => {
      controller.abort(reason)
      throw new Error('业务转译后的错误')
    }, run: async () => {} }, phasedScheduler([]), [0])
  }), { seed: 42, numRuns: 10 }))).rejects.toBe(reason)
  expect(runs).toBe(1)
})

it('等待拍数期间取消，剩余令牌和业务操作都不启动', async () => {
  const controller = new AbortController()
  const reason = new Error('等待期间取消')
  const scheduler = phasedScheduler([])
  const schedule = scheduler.schedule.bind(scheduler)
  scheduler.schedule = async (task, label) => {
    const value = await schedule(task, label)
    controller.abort(reason)
    return value
  }
  let started = false
  await expect(withInterleaveCase(controller.signal, () => observeConcurrent({ ...subject, run: async () => {
    started = true
  } }, scheduler, [0], undefined, [10]))).rejects.toBe(reason)
  expect(scheduleTrace(scheduler)).toEqual(['等待 op0'])
  expect(started).toBe(false)
})

it('串行重放取消时放行已暂停的操作，等其退出后收尾', async () => {
  const controller = new AbortController()
  const reason = new Error('串行期间取消')
  let exited = false
  const started: number[] = []
  await expect(withInterleaveCase(controller.signal, () => observeSerial({ ...subject, run: async (_root, _op, index, hooks) => {
    started.push(index)
    if (index === 0) {
      try { await hooks.beforeCommit() } finally { exited = true }
    } else {
      controller.abort(reason)
    }
  } }, [0, 1, 2], [{ index: 0, part: 'read' }, { index: 1, part: 'all' }, { index: 2, part: 'all' }, { index: 0, part: 'commit' }]))).rejects.toBe(reason)
  expect(started).toEqual([0, 1])
  expect(exited).toBe(true)
})
