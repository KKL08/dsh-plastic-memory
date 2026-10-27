import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, checkupViewSchema } from '../src/gui/contract.ts'
import { record } from './helpers/record.ts'
import { DAY, NOW } from './helpers/clock.ts'

// 自动体检的跨进程认领（测试切入点 2 的跨进程部分）：两个独立的 Node 子进程各跑一份调度，共用一个记忆根。
// 子进程脚本见 helpers/auto-checkup-worker.ts；时钟、计时服务和模型调用由测试经 stdin 推进，不靠 sleep。

const WORKER = fileURLToPath(new URL('./helpers/auto-checkup-worker.ts', import.meta.url))
const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }

let root: string
let workers: ChildProcess[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-auto-two-proc-')) })
afterEach(async () => {
  for (const child of workers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGCONT')
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  await rm(root, { recursive: true, force: true })
})

type Line = { event?: string; reply?: string }

/** 起一个宿主进程（子进程），等它就绪。send 发一条命令并等它的回复；waitEvent 等一个事件（之前收到的也算）。 */
async function startHost(findings: 'conflict' | 'none' = 'none') {
  const child = spawn(process.execPath, [WORKER, root, String(NOW), findings], { stdio: ['pipe', 'pipe', 'inherit'] })
  workers.push(child)
  const seen: Line[] = []
  let waiters: Array<{ match: (l: Line) => boolean; resolve: (l: Line) => void }> = []
  createInterface({ input: child.stdout! }).on('line', text => {
    const line = JSON.parse(text) as Line
    const waiter = waiters.find(w => w.match(line))
    if (waiter === undefined) seen.push(line)
    else {
      waiters = waiters.filter(w => w !== waiter)
      waiter.resolve(line)
    }
  })
  const wait = (match: (l: Line) => boolean) => {
    const index = seen.findIndex(match)
    if (index !== -1) return Promise.resolve(seen.splice(index, 1)[0]!)
    return new Promise<Line>(resolve => { waiters.push({ match, resolve }) })
  }
  const host = {
    child,
    /** 已收到、还没被等走的事件。 */
    events: () => seen.filter(l => l.event !== undefined).map(l => l.event),
    waitEvent: (event: string) => wait(l => l.event === event),
    async send(command: string) {
      child.stdin!.write(`${command}\n`)
      await wait(l => l.reply === command.split(' ')[0])
    },
  }
  await host.waitEvent('ready')
  return host
}

/** 测试进程自己读写同一个记忆根（相当于第三个进程）。 */
function inspect() {
  const sidecar = new SidecarStore({ root, schemas })
  return {
    store: new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats),
    checkups: new CheckupRecordStore(sidecar.checkups),
    autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups),
    decisions: new PendingDecisionsStore(sidecar.pending),
    cache: sidecar.scanCache,
  }
}

const readView = async () => checkupViewSchema.parse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_CHECKUP_VIEW_FILE), 'utf8')))
const readGlobalClaim = async () => JSON.parse(await readFile(
  join(root, '.state', 'checkups', `${createHash('sha1').update('global').digest('hex')}.claim`), 'utf8')) as { pid: number }

/** 全局有两条记忆，「全部」设成每天，从没体检过：一开就到期。 */
async function seedDueGlobal() {
  const t = inspect()
  await t.store.create(record({ id: 'mem_x', name: '端口甲', content: '端口 3000' }))
  await t.store.create(record({ id: 'mem_y', name: '端口乙', content: '端口 4000' }))
  await t.autoCheckups.set({ kind: 'all' }, 1)
  return t
}

describe('自动体检：两个宿主进程共用一个记忆根', () => {
  it('同一范围到期时只有一个跑；两边看到的设置、下次时间、进行中都一样', async () => {
    const t = await seedDueGlobal()
    const [a, b] = await Promise.all([startHost(), startHost()])
    await a.send('check')
    await a.waitEvent('llm')
    // a 正在查全局：b 的检查跳过它
    await b.send('check')
    await b.send('idle')
    expect(b.events()).toEqual([])
    const during = await readView()
    expect(during.scopes).toEqual([{ scope: { kind: 'global' }, frequency: 1, isOwn: false, lastCheckupAt: null, nextCheckupAt: null, isDue: true, isInProgress: true, failure: null, modelUnavailable: null, lastResult: null }])

    await a.send('open')
    await a.send('idle')
    await a.waitEvent('scanned')
    expect(Object.fromEntries((await t.checkups.list()).map(r => [r.id, r.completed]))).toEqual({ global: { startedAt: NOW, completedAt: NOW, by: 'auto' } })
    expect((await t.decisions.list()).map(d => d.memoryIds)).toEqual([])
    const after = await readView()
    expect(after.scopes).toEqual([{ scope: { kind: 'global' }, frequency: 1, isOwn: false, lastCheckupAt: NOW, nextCheckupAt: NOW + DAY, isDue: false, isInProgress: false, failure: null, modelUnavailable: null, lastResult: expect.objectContaining({ by: 'auto' }) }])

    // b 再查：不到期了，不跑；它重写的体检视图和 a 写的一样
    await b.send('check')
    await b.send('idle')
    expect(b.events()).toEqual([])
    expect(await readView()).toEqual(after)
  }, 30_000)

  it('跑的那个进程被杀掉：认领按残留清掉，另一个接手查完', async () => {
    const t = await seedDueGlobal()
    const [a, b] = await Promise.all([startHost(), startHost()])
    await a.send('check')
    await a.waitEvent('llm')
    a.child.kill('SIGKILL')
    await once(a.child, 'exit')
    await b.send('check')
    await b.waitEvent('llm')
    expect((await readGlobalClaim()).pid).toBe(b.child.pid)
    await b.send('open')
    await b.send('idle')
    expect((await t.checkups.list()).map(r => r.completed)).toEqual([{ startedAt: NOW, completedAt: NOW, by: 'auto' }])
    expect((await readView()).scopes[0]).toMatchObject({ isInProgress: false, isDue: false })
  }, 30_000)

  it('持有者卡住不刷新：60 秒内别人接不了，60 秒后另一个接手；旧持有者恢复后发现认领不是自己的了，停下、不再提交', async () => {
    const t = await seedDueGlobal()
    // a 的模型会报一个冲突，b 的什么都不报：a 要是提交了，账本里会多出这张卡
    const [a, b] = await Promise.all([startHost('conflict'), startHost('none')])
    await a.send('check')
    await a.waitEvent('llm')
    a.child.kill('SIGSTOP')

    await b.send(`clock ${NOW + 59_000}`)
    await b.send('check')
    await b.send('idle')
    expect(b.events()).toEqual([])
    expect((await readGlobalClaim()).pid).toBe(a.child.pid)

    await b.send(`clock ${NOW + 61_000}`)
    await b.send('check')
    await b.waitEvent('llm')
    expect((await readGlobalClaim()).pid).toBe(b.child.pid)

    // a 恢复：下一次心跳发现认领已是 b 的；之后模型才返回
    a.child.kill('SIGCONT')
    await a.send('advance 10000')
    await a.waitEvent('lost')
    await a.send('open')
    await a.send('idle')
    expect(a.events()).toEqual([])
    // a 没删 b 的认领
    expect((await readGlobalClaim()).pid).toBe(b.child.pid)
    expect((await readView()).scopes[0]).toMatchObject({ isInProgress: true })

    await b.send('open')
    await b.send('idle')
    await b.waitEvent('scanned')
    // 缓存、账本、完成记录里都只有 b 的这次
    expect((await t.checkups.list()).map(r => r.completed)).toEqual([{ startedAt: NOW + 61_000, completedAt: NOW + 61_000, by: 'auto' }])
    expect(await t.decisions.list()).toEqual([])
    expect((await t.cache.list()).map(([, c]) => [c.scannedAt, c.findings])).toEqual([[NOW + 61_000, []]])
    expect((await readView()).scopes[0]).toMatchObject({ isInProgress: false, lastCheckupAt: NOW + 61_000 })
  }, 30_000)
})
