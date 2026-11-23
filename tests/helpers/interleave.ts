import { promises as realFs, rmSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import fc from 'fast-check'

/**
 * 交错测试夹具：让 fast-check 的调度器决定文件系统调用的全序。
 *
 * 用法：测试文件里把 `node:fs/promises` 换成这里的 `interleavedFs`（vi.mock 的工厂里动态 import 本文件），
 * 存储层照常 import，拿到的是包过一层的函数。夹具自己的读写走 `node:fs` 的 promises（不经包装）。
 *
 * 两种模式：
 *  - 直通（缺省）：原样调用。播种、串行重放、收尾检查都在这个模式下跑。
 *  - 受调度：每次调用先向调度器要一个放行令牌，放行后才发出真实调用；驱动每放行一个令牌，都等这次真实调用
 *    落定（成功或失败）、调用方的后续同步逻辑跑到下一次排队或结束，才放行下一个。同一时刻只有一个真实调用
 *    在途，文件系统副作用的全序完全由调度器（即种子和路径）决定。
 *
 * 调度器里每个令牌的标签是 `op<i>:<操作名> <调用>(<相对路径>)`；失败输出带 fast-check 的种子与路径、
 * 操作输入和调度报告（scheduler.report() 的放行顺序），按种子和路径原样重放即可复现。
 * fast-check 不缩减调度，报告的就是搜到的那一条调度，不保证最短。
 */

/** 写锁的形状（与存储层的记忆根写锁同形）。Subject.lock 给了就交给世界构造函数，由它传给各存储模块。 */
export interface WriteLock { run<T>(fn: () => Promise<T>): Promise<T>; runUnqueued<T>(fn: () => Promise<T>): Promise<T> }

type FsPromises = typeof realFs

/** 存储层用到的调用：读、写、改名、硬链接、删、列目录、stat、建目录、复制。 */
const WRAPPED = ['readFile', 'writeFile', 'appendFile', 'rename', 'link', 'copyFile', 'rm', 'unlink', 'readdir', 'stat', 'lstat', 'mkdir', 'open'] as const
/** 这些调用的目标路径（第二个参数）是新出现的名字，其余调用看第一个参数。 */
const TWO_PATH = new Set<string>(['rename', 'link', 'copyFile'])

/** 内部生成的随机 id（genId：前缀 + 时间与随机段）。 */
const RANDOM_ID_RE = /\b(?:snap|pd|sg|ck)_[a-z0-9]{6,}/g

interface OpContext { index: number; label: string }

const control: {
  scheduler: TaskScheduler | undefined
  root: string | undefined
  inflight: Set<Promise<unknown>>
  /** 随机 id → 第一次以它为名落盘的操作下标与该操作内的先后序号。 */
  idOwners: Map<string, { index: number; nth: number }>
} = { scheduler: undefined, root: undefined, inflight: new Set(), idOwners: new Map() }

const currentOp = new AsyncLocalStorage<OpContext>()

function pathLabel(arg: unknown): string {
  if (typeof arg !== 'string' || control.root === undefined) return '?'
  return relative(control.root, arg).replace(TMP_RE, '.tmp-*')
}

/** 记下操作新落盘的名字里的随机 id 是谁生成的（受调度、直通两种模式都记）。 */
function noteCreatedIds(name: string, args: readonly unknown[]): void {
  const op = currentOp.getStore()
  const target = TWO_PATH.has(name) ? args[1] : name === 'writeFile' || name === 'appendFile' ? args[0] : undefined
  if (op === undefined || typeof target !== 'string') return
  // 认领文件借条目的 id 起名、用完即删，不算生成：认领不到的操作只碰过它，按没发生过处理时不能占着这个 id 的出处
  if (/\.claim(\.tmp-[^/]*)?$/.test(target)) return
  for (const id of target.match(RANDOM_ID_RE) ?? []) {
    if (control.idOwners.has(id)) continue
    const nth = [...control.idOwners.values()].filter(o => o.index === op.index).length
    control.idOwners.set(id, { index: op.index, nth })
  }
}

function wrap<K extends typeof WRAPPED[number]>(name: K): FsPromises[K] {
  const real = realFs[name] as (...args: unknown[]) => Promise<unknown>
  return (async (...args: unknown[]) => {
    noteCreatedIds(name, args)
    const s = control.scheduler
    if (s === undefined) return real.apply(realFs, args)
    const op = currentOp.getStore()
    const label = `${op === undefined ? 'other' : `op${op.index}:${op.label}`} ${name}(${pathLabel(args[0])}${TWO_PATH.has(name) ? ` → ${pathLabel(args[1])}` : ''})`
    await s.schedule(Promise.resolve(), label)
    const p = real.apply(realFs, args)
    control.inflight.add(p)
    try { return await p } finally { control.inflight.delete(p) }
  }) as FsPromises[K]
}

/** 替换 `node:fs/promises` 用的模块对象。 */
export const interleavedFs: FsPromises & { default: FsPromises } = (() => {
  const mod = { ...realFs } as FsPromises
  for (const name of WRAPPED) (mod as Record<string, unknown>)[name] = wrap(name)
  return { ...mod, default: mod }
})()

/** 放行一个令牌之后：等这次真实调用落定、调用方后续的同步逻辑跑到下一次排队（或结束），再交还调度器。 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  while (control.inflight.size > 0) {
    await Promise.allSettled([...control.inflight])
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** 性质里用它代替 `fc.scheduler()`：每次放行都带上 settle。 */
export function interleaveScheduler(): fc.Arbitrary<fc.Scheduler> {
  return fc.scheduler({ act: async f => { await f(); await settle() } })
}

/** 夹具对调度器的全部要求；fc.scheduler() 与 phasedScheduler() 都满足。 */
export type TaskScheduler = Pick<fc.Scheduler, 'schedule' | 'waitFor' | 'waitIdle' | 'report'>

/** 固定回归里的一段：只放行 op 号操作的调用，直到放行了一个 until 认得的调用（不给 until 就一直到该操作跑完）。 */
export interface Phase { op: number; until?: (call: string) => boolean }

/**
 * 固定回归用的确定调度：按阶段依次偏向某个操作，用调用标签（如 `readdir(proj-x)`）而不是令牌序号指定窗口，
 * 被测代码在窗口之外多了、少了调用，调度照样落在同一个窗口上。
 * 当前阶段的操作没有排队的调用（在等别的操作，或已经结束）时，放行最早排队的调用；阶段用完后按排队先后放行。
 */
export function phasedScheduler(phases: readonly Phase[]): TaskScheduler {
  type Task = { id: number; label: string; release: () => void; done: boolean }
  const tasks: Task[] = []
  let phase = 0
  const releaseOne = async (): Promise<boolean> => {
    const pending = tasks.filter(t => !t.done)
    if (pending.length === 0) return false
    const current = phases[phase]
    const own = current === undefined ? undefined : pending.find(t => t.label.startsWith(`op${current.op}:`))
    const next = own ?? pending[0]!
    if (own !== undefined && current?.until?.(own.label.slice(own.label.indexOf(' ') + 1)) === true) phase++
    next.done = true
    next.release()
    await settle()
    return true
  }
  return {
    schedule: <T>(task: Promise<T>, label?: string) => new Promise<T>((resolve, reject) => {
      tasks.push({ id: tasks.length + 1, label: label ?? '', done: false, release: () => { task.then(resolve, reject) } })
    }),
    waitFor: async <T>(unscheduled: Promise<T>) => {
      let isSettled = false
      const watched = unscheduled.finally(() => { isSettled = true })
      while (!isSettled) {
        if (!(await releaseOne())) await new Promise<void>(resolve => setImmediate(resolve))
      }
      return watched
    },
    waitIdle: async () => { while (await releaseOne()) { /* 放完为止 */ } },
    report: () => tasks.map(t => ({ status: t.done ? 'resolved' as const : 'pending' as const, schedulingType: 'promise' as const, taskId: t.id, label: t.label })),
  }
}

// —— 次数与种子 ——

const DEFAULT_RUNS = 50
const DEFAULT_SEED = 20261115

/** 每条性质的次数：缺省 defaultRuns（不给是 50；单次很贵的性质给小一点，保证常规测试里整个文件 5 秒内），`PM_INTERLEAVE_RUNS` 统一覆盖。 */
export function interleaveRuns(defaultRuns = DEFAULT_RUNS): number {
  const n = Number(process.env.PM_INTERLEAVE_RUNS)
  return Number.isInteger(n) && n > 0 ? n : defaultRuns
}

/** 种子：缺省固定，`PM_INTERLEAVE_SEED` 覆盖（填 random 取随机种子，并打印出来）。 */
export function interleaveSeed(): number {
  const raw = process.env.PM_INTERLEAVE_SEED
  if (raw === 'random') {
    const seed = Math.floor(Math.random() * 0x7fffffff)
    console.info(`[interleave] PM_INTERLEAVE_SEED=random → ${seed}`)
    return seed
  }
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isInteger(n) ? n : DEFAULT_SEED
}

/** fc.assert / fc.check 的参数。反例输出里 fast-check 自带种子和路径，判据的错误消息里带操作输入与调度报告。 */
export function interleaveParams(defaultRuns?: number): { seed: number; numRuns: number } {
  return { seed: interleaveSeed(), numRuns: interleaveRuns(defaultRuns) }
}

// —— 临时目录、盘面、残留 ——

/** 全新临时目录，用完删掉。 */
export async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await realFs.realpath(await realFs.mkdtemp(join(tmpdir(), 'pm-interleave-')))
  try {
    return await fn(root)
  } finally {
    await realFs.rm(root, { recursive: true, force: true })
  }
}

const TMP_RE = /\.tmp-\d+-[a-z0-9]+/g
/** 记忆文件里的提交标记：每次写入一个新的操作 id，和内容无关。 */
const WRITE_STAMP_RE = /^lastWriteOp: .*$/gm

/**
 * 归一化文本：只替换临时根路径、tmp 名的随机段和提交标记，内部生成的随机 id 换成「哪个操作生成的第几个」。
 * 时间戳不动（各测试注入确定的时钟），引用关系（谁引用谁、几次、在哪）原样保留。认不出出处的随机 id 原样留着，比较时自然不等。
 */
export function normalizeText(text: string, root: string, ids: ReadonlyMap<string, string> = new Map()): string {
  return text.split(root).join('<root>').replace(TMP_RE, '.tmp-*').replace(WRITE_STAMP_RE, 'lastWriteOp: *').replace(RANDOM_ID_RE, id => ids.get(id) ?? id)
}

/** 本次世界里随机 id 的出处表：`snap_…` → `snap@op1#0`。 */
function idNames(): Map<string, string> {
  return new Map([...control.idOwners].map(([id, o]) => [id, `${id.slice(0, id.indexOf('_'))}@op${o.index}#${o.nth}`]))
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries
  try { entries = await realFs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
}

/** 根下全部文件（相对路径，统一用 /）。 */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  await walk(root, out)
  return out.map(p => relative(root, p).split(sep).join('/')).sort()
}

/** 残留的原子写临时文件。 */
export async function leftoverTmp(root: string): Promise<string[]> {
  return (await listFiles(root)).filter(p => /\.tmp-\d+-[a-z0-9]+$/.test(p))
}

/**
 * 盘面：每个文件一项 [路径, 原文]（路径和原文都还没归一化，归一化在观测时统一做）。
 * include 决定哪些文件进盘面（缺省全部）。
 */
export async function diskState(root: string, include: (path: string) => boolean = () => true): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = []
  for (const rel of (await listFiles(root)).filter(include)) out.push([rel, await realFs.readFile(join(root, rel), 'utf8')])
  return out
}

// —— 执行 ——

/** 一个操作的结果：返回值或抛出的错误（类名加消息）。 */
export type Outcome = { value: unknown } | { error: string }

async function outcomeOf(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { value: await fn() }
  } catch (err) {
    return { error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err) }
  }
}

/** 调度报告：按放行顺序的令牌标签（scheduler.report()）。 */
export function scheduleTrace(s: TaskScheduler): string[] {
  return s.report().filter(t => t.status !== 'pending').map(t => t.label)
}

/**
 * 操作的提交点：操作在第一次写入存储之前 await 它。并发执行时立即放行；串行重放把这个操作拆成「提交点之前」
 * 「提交点之后」两段时，在这里停住，等排在中间的操作跑完再继续（见 Subject.splitTag、serialOrders）。
 */
export interface OpHooks { beforeCommit(): Promise<void> }
const NO_HOOKS: OpHooks = { beforeCommit: async () => {} }

/**
 * 一套被测对象。世界在每个全新临时目录里各建一次：并发执行一次，每种串行顺序各一次。
 *  - world：接线层同款构造；lock 给了就注入，没给时由世界自己按接线层的做法建。
 *  - seed：直通模式下铺初始盘面。给了 seedKey 时同一个 key 只真正铺一次，之后复制那份盘面（省时间，盘面相同）。
 *  - prepare：每个世界铺好盘面之后、操作之前都跑一次（只读，比如读出界面卡片的 base）。
 *  - run：执行一个操作；index 是操作下标（各测试据此给操作固定时刻）。
 *  - state：收尾时的盘面（直通模式）；归一化由夹具统一做。
 *  - splitTag：并发时这个返回值说明操作在提交点前后被别的操作插了进来，允许串行重放把它拆成两段（见 serialOrders）。
 *    返回 'race' 表示竞争类拒绝（读后被改而放弃的写入），其他值是待定的已知问题，匹配时计数报告。
 *  - isClaimed：这个返回值是「认领不到、立即返回、什么都没动」（GUI 命令的 claimed）。串行重放复现不了它，判据把它当成
 *    没发生过，另查当时确有别的操作持有同一认领（见 assertSerialEquivalent）。
 *  - invariant：并发执行收尾时（直通模式）另查的不变量，返回问题描述；串行等价之外的要求写在这里。
 */
export interface Subject<W, Op> {
  world: (root: string, lock: WriteLock | undefined) => Promise<W> | W
  seed: (w: W, root: string) => Promise<void>
  seedKey?: string
  prepare?: (w: W, root: string) => Promise<void>
  run: (w: W, op: Op, index: number, hooks: OpHooks) => Promise<unknown>
  label: (op: Op) => string
  state: (w: W, root: string) => Promise<Array<[string, string]>>
  splitTag?: (value: unknown, op: Op) => string | undefined
  isClaimed?: (value: unknown, op: Op) => boolean
  invariant?: (w: W, ops: readonly Op[], outcomes: readonly Outcome[]) => Promise<string[]>
  lock?: (root: string) => WriteLock | Promise<WriteLock>
}

/** 一次观测：各操作结果加最终盘面，都已归一化。 */
export interface Observation { outcomes: Outcome[]; state: Array<[string, string]> }

async function observe<W, Op>(subject: Subject<W, Op>, w: W, root: string, outcomes: Outcome[]): Promise<Observation> {
  const ids = idNames()
  const norm = (text: string) => normalizeText(text, root, ids)
  const state = (await subject.state(w, root)).map(([p, t]) => [norm(p), norm(t)] as [string, string])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
  return {
    outcomes: outcomes.map(o => 'error' in o ? { error: norm(o.error) } : { value: JSON.parse(norm(JSON.stringify(o.value ?? null))) as unknown }),
    state,
  }
}

/** 铺好的初始盘面：seedKey → 模板目录。进程退出时删掉。 */
const templates = new Map<string, Promise<string>>()
let templateParent: string | undefined
process.once('exit', () => { if (templateParent !== undefined) rmSync(templateParent, { recursive: true, force: true }) })

async function templateFor<W, Op>(subject: Subject<W, Op>, key: string): Promise<string> {
  let dir = templates.get(key)
  if (dir === undefined) {
    dir = (async () => {
      templateParent ??= await realFs.realpath(await realFs.mkdtemp(join(tmpdir(), 'pm-interleave-seed-')))
      const root = await realFs.mkdtemp(join(templateParent, 's-'))
      await subject.seed(await subject.world(root, undefined), root)
      return root
    })()
    templates.set(key, dir)
  }
  return dir
}

async function freshWorld<W, Op>(subject: Subject<W, Op>, root: string): Promise<W> {
  if (subject.seedKey !== undefined) await realFs.cp(await templateFor(subject, subject.seedKey), root, { recursive: true })
  control.idOwners = new Map()
  const w = await subject.world(root, await subject.lock?.(root))
  if (subject.seedKey === undefined) await subject.seed(w, root)
  await subject.prepare?.(w, root)
  return w
}

/** 在全新临时目录里铺初始盘面后并发（受调度）跑一遍。after 在收尾观测之前跑（直通模式）。 */
/**
 * headStart：各操作开始前先空等几拍调度（每拍是一个受调度的空令牌，不碰文件系统，不进调度报告的操作行），模拟后到的操作。
 * 调度器在排队的令牌里均匀挑，开始前调用多的操作几乎总是后提交；强制模板靠它让两个操作都有机会先提交。
 */
export async function observeConcurrent<W, Op>(subject: Subject<W, Op>, s: TaskScheduler, ops: readonly Op[], after?: (w: W, root: string, outcomes: readonly Outcome[]) => Promise<void>, headStart: readonly number[] = []):
  Promise<Observation & { raw: Outcome[]; leftover: string[]; unhandled: string[] }> {
  return withTempRoot(async root => {
    const w = await freshWorld(subject, root)
    const unhandled: string[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(String(reason)) }
    process.on('unhandledRejection', onUnhandled)
    control.scheduler = s
    control.root = root
    let outcomes: Outcome[]
    try {
      const all = Promise.all(ops.map(async (op, index) => {
        for (let k = 0; k < (headStart[index] ?? 0); k++) await s.schedule(Promise.resolve(), `等待 op${index}`)
        return currentOp.run({ index, label: subject.label(op) }, () => outcomeOf(() => subject.run(w, op, index, NO_HOOKS)))
      }))
      outcomes = await s.waitFor(all)
      // 操作都结束了，后台还排着的调用（不该有）也放完，再离开受调度模式
      await s.waitIdle()
    } finally {
      control.scheduler = undefined
      control.root = undefined
      process.off('unhandledRejection', onUnhandled)
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    const leftover = await leftoverTmp(root)
    await after?.(w, root, outcomes)
    return { ...(await observe(subject, w, root, outcomes)), raw: outcomes, leftover, unhandled }
  })
}

/** 串行顺序的一步：整个操作，或拆开时的「提交点之前」「提交点之后」。 */
export type Step = { index: number; part: 'all' | 'read' | 'commit' }

/** 在全新临时目录里按给定步骤串行跑一遍。 */
export async function observeSerial<W, Op>(subject: Subject<W, Op>, ops: readonly Op[], steps: readonly Step[]): Promise<Observation> {
  return withTempRoot(async root => {
    const w = await freshWorld(subject, root)
    const outcomes: Outcome[] = new Array(ops.length)
    const paused = new Map<number, { release: () => void; done: Promise<Outcome> }>()
    for (const step of steps) {
      const op = ops[step.index]!
      const start = (hooks: OpHooks) => currentOp.run({ index: step.index, label: subject.label(op) }, () => outcomeOf(() => subject.run(w, op, step.index, hooks)))
      if (step.part === 'all') {
        outcomes[step.index] = await start(NO_HOOKS)
      } else if (step.part === 'read') {
        let reached!: () => void
        const atCommit = new Promise<void>(resolve => { reached = resolve })
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        let isFirst = true
        const done = start({ beforeCommit: async () => { if (isFirst) { isFirst = false; reached(); await gate } } })
        await Promise.race([atCommit, done])
        paused.set(step.index, { release, done })
      } else {
        const p = paused.get(step.index)!
        p.release()
        outcomes[step.index] = await p.done
      }
    }
    return observe(subject, w, root, outcomes)
  })
}

/** 0..n-1 的全部排列。 */
export function permutations(n: number): number[][] {
  if (n <= 1) return [[...Array(n).keys()]]
  return permutations(n - 1).flatMap(p => [...Array(n).keys()].map(at => [...p.slice(0, at), n - 1, ...p.slice(at)]))
}

/**
 * 候选的串行顺序。先是整操作的全部排列（n ≤ 3 时最多 6 种）；split 里的操作另外允许拆成「提交点之前」「提交点之后」
 * 两步、中间夹别的操作——竞争类拒绝正是这样产生的，串行里同样复现得出来。没被拆的操作永远整段原子，
 * 读后被改却照写不误的丢更新因此仍判不等价。
 * position 给了就按它排（与并发时实际先后越接近越靠前），只为少重放几次，不影响判定。isAtomicFirst：整操作的顺序
 * 全部排在拆开的前面（拆开的理由不是竞争类拒绝时用，见 assertSerialEquivalent）。
 */
export function serialOrders(n: number, split: ReadonlySet<number>, position?: (step: Step) => number, isAtomicFirst = true): Step[][] {
  const atomic = permutations(n).map(p => p.map((index): Step => ({ index, part: 'all' })))
  const tokens = [...Array(n).keys()].flatMap((index): Step[] => split.has(index) ? [{ index, part: 'read' }, { index, part: 'commit' }] : [{ index, part: 'all' }])
  const splits: Step[][] = []
  const rec = (rest: Step[], acc: Step[]) => {
    if (rest.length === 0) { splits.push(acc); return }
    rest.forEach((s, i) => {
      // 同一个操作的「提交点之后」不能排在「提交点之前」前面
      if (s.part === 'commit' && !acc.some(a => a.index === s.index && a.part === 'read')) return
      rec([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, s])
    })
  }
  if (split.size > 0) rec(tokens, [])
  const isAtomic = (o: Step[]) => o.every((s, i) => s.part !== 'read' || o[i + 1]?.index === s.index)
  const byDistance = (orders: Step[][]) => {
    if (position === undefined) return orders
    // 逆序对数：顺序里前后两步的实际先后反了几对
    const distance = (o: Step[]) => o.reduce((sum, a, i) => sum + o.slice(i + 1).filter(b => position(b) < position(a)).length, 0)
    return orders.map(o => [distance(o), o] as const).sort((x, y) => x[0] - y[0]).map(([, o]) => o)
  }
  const rest = splits.filter(o => !isAtomic(o))
  return isAtomicFirst ? [...byDistance(atomic), ...byDistance(rest)] : byDistance([...atomic, ...rest])
}

/**
 * 强制模板的计数：对上的串行顺序按前两个操作（记作 X、Y）谁先、谁被拆开归类，记进 tally。各类都只有一种说明调度没起作用。
 */
export function tallyOrder(tally: Map<string, number>, order: readonly Step[]): void {
  const c = describeOrder(order.filter(st => st.index < 2)).replaceAll('0', 'X').replaceAll('1', 'Y')
  tally.set(c, (tally.get(c) ?? 0) + 1)
}

/** 各操作开始前空等的拍数（见 observeConcurrent 的 headStart），每个在 0..max 里取。 */
export const headStartArb = (n: number, max: number): fc.Arbitrary<number[]> => fc.array(fc.nat(max), { minLength: n, maxLength: n })

export const describeOrder = (steps: readonly Step[]) => steps.map(s => s.part === 'all' ? `${s.index}` : `${s.index}${s.part === 'read' ? '读' : '写'}`).join('→')

const sameObservation = (a: Observation, b: Observation) => JSON.stringify(a) === JSON.stringify(b)

const MUTATING_CALL_RE = / (writeFile|appendFile|rename|link|copyFile|rm|unlink|mkdir)\(/

/**
 * 并发时每一步的大致位置（调度报告里的下标）：整操作取它最后一次写盘（没写过盘取最后一次调用），
 * 拆开时「提交点之前」取第一次调用、「提交点之后」取最后一次写盘。只用来给候选顺序排先后。
 */
function observedPositions(s: TaskScheduler, n: number): (step: Step) => number {
  const first = new Array<number>(n).fill(Infinity)
  const last = new Array<number>(n).fill(-1)
  scheduleTrace(s).forEach((label, at) => {
    const m = /^op(\d+):/.exec(label)
    if (m === null) return
    const i = Number(m[1])
    first[i] = Math.min(first[i]!, at)
    if (MUTATING_CALL_RE.test(label) || last[i] === -1) last[i] = at
  })
  return step => step.part === 'read' ? first[step.index]! : last[step.index]!
}

/** 串行观测只由初始盘面、操作和顺序决定（重放确定性由夹具自检守着）：同一组输入在一轮性质里只跑一次。 */
const serialCache = new Map<string, Observation>()
async function observeSerialCached<W, Op>(subject: Subject<W, Op>, ops: readonly Op[], order: readonly Step[]): Promise<Observation> {
  if (subject.seedKey === undefined) return observeSerial(subject, ops, order)
  const key = JSON.stringify([subject.seedKey, ops, order])
  let obs = serialCache.get(key)
  if (obs === undefined) {
    obs = await observeSerial(subject, ops, order)
    if (serialCache.size > 5000) serialCache.clear()
    serialCache.set(key, obs)
  }
  return obs
}

/** 判据的结果：第一种对上的串行顺序（候选按与并发时实际先后的接近程度排），其中被拆开的操作各自的 splitTag，以及认领不到、按没发生过处理的操作。 */
export interface Equivalence { order: Step[]; splitTags: Map<number, string>; claimed: number[] }

/** 调度报告的一行：操作下标、调用名、目标路径（两个路径的取新名字）。 */
function parseTraceLine(label: string): { op: number; call: string; path: string } | undefined {
  const m = /^op(\d+):\S* (\w+)\((.*)\)$/.exec(label)
  if (m === null) return undefined
  const args = m[3]!
  const arrow = args.indexOf(' → ')
  return { op: Number(m[1]), call: m[2]!, path: arrow < 0 ? args : args.slice(arrow + 3) }
}

/**
 * 认领不到的操作 i，当时确有别的操作持有同一认领：按调度报告重演 i 最后一次排他创建（link 到 `*.claim`）的那个认领文件——
 * 空着时的 link 建成、占着时的 link 失败、持有者的 rm 释放——到 i 那次 link 时它被另一个操作占着。返回问题描述，对得上时返回 undefined。
 */
function claimHolderProblem(trace: readonly string[], i: number): string | undefined {
  const lines = trace.map(parseTraceLine)
  let at = -1
  for (const [k, l] of lines.entries()) if (l?.op === i && l.call === 'link' && l.path.endsWith('.claim')) at = k
  if (at < 0) return `op${i} 回了 claimed，却没有尝试过认领`
  const path = lines[at]!.path
  let holder: number | undefined
  for (const l of lines.slice(0, at)) {
    if (l === undefined || l.path !== path) continue
    if (l.call === 'link' && holder === undefined) holder = l.op
    else if ((l.call === 'rm' || l.call === 'unlink') && l.op === holder) holder = undefined
  }
  return holder !== undefined && holder !== i ? undefined : `op${i} 回了 claimed，但当时没有别的操作持有 ${path}`
}

/**
 * 串行等价判据：并发执行的「各操作结果 + 最终盘面」必须和某一种串行顺序完全一致，且无残留 tmp、无未处理的拒绝。
 * 不成立时抛错，消息里带操作输入、调度报告、并发观测和每种串行顺序的观测（fast-check 的反例输出另带种子和路径）。
 * headStart 见 observeConcurrent。
 */
export async function assertSerialEquivalent<W, Op>(subject: Subject<W, Op>, s: TaskScheduler, ops: readonly Op[], headStart: readonly number[] = []): Promise<Equivalence> {
  const problems: string[] = []
  const concurrent = await observeConcurrent(subject, s, ops, async (w, _root, outcomes) => {
    problems.push(...(await subject.invariant?.(w, ops, outcomes) ?? []))
  }, headStart)
  if (concurrent.leftover.length > 0) problems.push(`残留临时文件：${concurrent.leftover.join(', ')}`)
  if (concurrent.unhandled.length > 0) problems.push(`未处理的拒绝：${concurrent.unhandled.join('; ')}`)
  // 认领不到、立即返回的操作当成没发生过：其余操作的结果和盘面要与其余操作的某种串行顺序一致（被拒的一方因此不能留下写入）
  const claimed = concurrent.raw.flatMap((o, i) => ('value' in o && subject.isClaimed?.(o.value, ops[i]!) === true ? [i] : []))
  const trace = scheduleTrace(s)
  for (const i of claimed) {
    const problem = claimHolderProblem(trace, i)
    if (problem !== undefined) problems.push(problem)
  }
  const kept = ops.flatMap((_, i) => (claimed.includes(i) ? [] : [i]))
  const pick = (obs: Observation): Observation => ({ outcomes: kept.map(i => obs.outcomes[i]!), state: obs.state })
  const got = pick({ outcomes: concurrent.outcomes, state: concurrent.state })
  const tags = new Map(concurrent.raw.flatMap((o, i) => {
    const tag = 'value' in o && !claimed.includes(i) ? subject.splitTag?.(o.value, ops[i]!) : undefined
    return tag === undefined ? [] : [[i, tag] as const]
  }))
  const misses: Array<{ order: Step[]; obs: Observation }> = []
  let match: Step[] | undefined
  // 只有竞争类拒绝要拆时，拆开与整段的顺序一起按接近程度排；有别的拆开理由（待定问题）时整段的先试，免得把本来整段就对得上的算成它
  const isRaceOnly = [...tags.values()].every(t => t === 'race')
  // 候选顺序在留下的操作上排，步骤里换回原来的下标（各操作的时刻、生成的 id 都按原下标定）
  const position = observedPositions(s, ops.length)
  const local = serialOrders(kept.length, new Set(kept.flatMap((i, k) => (tags.has(i) ? [k] : []))), st => position({ ...st, index: kept[st.index]! }), !isRaceOnly)
  for (const order of local.map(o => o.map(st => ({ ...st, index: kept[st.index]! })))) {
    const obs = pick(await observeSerialCached(subject, ops, order))
    if (sameObservation(got, obs)) { match = order; break }
    misses.push({ order, obs })
  }
  if (match === undefined) problems.push('与任何一种串行顺序都不一致')
  if (problems.length === 0) {
    return { order: match!, splitTags: new Map(match!.filter(st => st.part === 'read').map(st => [st.index, tags.get(st.index)!] as const)), claimed }
  }
  throw new Error([
    ...problems,
    `操作：${ops.map((op, i) => `op${i}:${subject.label(op)}`).join(' | ')}${claimed.length > 0 ? `（认领不到：${claimed.map(i => `op${i}`).join('、')}）` : ''}`,
    `调度报告：\n  ${trace.join('\n  ')}`,
    `并发观测：${JSON.stringify(got, null, 1)}`,
    ...(match !== undefined ? [] : misses.map(({ order, obs }) => `串行 ${describeOrder(order)}：${JSON.stringify(obs, null, 1)}`)),
  ].join('\n'))
}
