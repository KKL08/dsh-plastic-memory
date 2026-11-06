import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { STATE_DIR } from '../src/storage/sidecar.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { isPendingDelegated, type MemoryRecord } from '../src/record-schema.ts'
import { lastVisibleSnapshot } from '../src/snapshot-message.ts'
import { MEMORY_COMMAND_NAME, encodeMemoryCommand, type MemoryCommand } from '../src/gui/contract.ts'
import type { MemoryCommandDefinition } from '../src/gui/commands.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'

// 权限面（spec「权限面」表逐行）：经 apply() 的完整注册包装（registerWrite、只读门、宿主会话适配器）调用每个工具，
// 在进程边界与存储入口打观察点：模型调用（宿主 llm.stream）、sessionQuery.readEvent / filterSessions、记录表的写入口
// （FileTable 的 create / put / update / delete）、待决账本与快照的写方法、node:fs 的写调用（按路径看 global 目录、语义缓存）。
// 观察点只记录、照常透传。「必须不发生」只断言业务层；框架旁路写（召回统计、目录维护、超限账本、会话视图、归属对照）不断言。

// node:fs 的写调用：on 期间记下函数名与路径（rename、link、copyFile 两个路径都记）。读调用不记。
const { fsTrace, FS_WRITES } = vi.hoisted(() => ({
  fsTrace: { on: false, writes: [] as string[] },
  FS_WRITES: new Set(['writeFile', 'appendFile', 'rename', 'rm', 'unlink', 'mkdir', 'link', 'copyFile', 'symlink', 'utimes', 'rmdir']),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && FS_WRITES.has(key)
    ? (...args: unknown[]) => {
      if (fsTrace.on) for (const arg of args.slice(0, 2)) if (typeof arg === 'string') fsTrace.writes.push(arg)
      return (value as (...a: unknown[]) => unknown)(...args)
    }
    : value]))
})

type ToolDef = { name: string; execute(args: unknown, exec: ToolRunContext): Promise<unknown> }
type Out = { kind: string; code?: string; record?: MemoryRecord; warnings?: Array<{ code: string }>; hits?: Array<{ id: string }>; lines?: string[]; reason?: string }

const tmpDirs: string[] = []
/** 本文件起过的插件的卸载入口（计时、视图写入器收尾）：afterEach 先卸载、再删临时目录。 */
const liveDisposers: Array<() => Promise<void>> = []
async function makeTmp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'plastic-memory-surface-')))
  tmpDirs.push(dir)
  return dir
}

/** 一次调用期间各观察点记下的副作用。 */
interface Effects {
  llmCalls: number
  readEvents: Array<{ sessionId: string }>
  headerLookups: string[]
  /** FileTable 写入口：方法名与写入后的记录（delete 只有键）。 */
  recordWrites: Array<{ method: string; record?: MemoryRecord; key?: string }>
  ledgerWrites: string[]
  snapshotWrites: string[]
  fsWrites: string[]
  defaultModelReads: number
  timerArms: number
}
const effects: Effects = { llmCalls: 0, readEvents: [], headerLookups: [], recordWrites: [], ledgerWrites: [], snapshotWrites: [], fsWrites: [], defaultModelReads: 0, timerArms: 0 }
const resetEffects = () => {
  Object.assign(effects, { llmCalls: 0, readEvents: [], headerLookups: [], recordWrites: [], ledgerWrites: [], snapshotWrites: [], defaultModelReads: 0, timerArms: 0 })
  fsTrace.writes = []
  effects.fsWrites = fsTrace.writes
}

/** 给原型方法套透传观察：调用照常执行，结束后（抛错也算一次尝试）把方法名、参数与结果交给 note。 */
function observe<T extends object>(proto: T, names: ReadonlyArray<keyof T & string>, note: (name: string, args: unknown[], result: unknown) => void) {
  for (const name of names) {
    const original = proto[name] as unknown as (...args: unknown[]) => unknown
    vi.spyOn(proto, name as never).mockImplementation(async function (this: unknown, ...args: unknown[]) {
      let result: unknown
      try {
        return result = await original.apply(this, args)
      } finally {
        note(name, args, result)
      }
    } as never)
  }
}

beforeEach(() => {
  observe(FileTable.prototype, ['create', 'put', 'update', 'delete'], (method, args, result) => {
    if (method === 'create') effects.recordWrites.push({ method, record: args[0] as MemoryRecord })
    else if (method === 'put') effects.recordWrites.push({ method, record: args[0] as MemoryRecord })
    else if (method === 'update') effects.recordWrites.push({ method, record: result as MemoryRecord })
    else effects.recordWrites.push({ method, key: args[0] as string })
  })
  observe(PendingDecisionsStore.prototype, [
    'upsert', 'settle', 'sweep', 'unsettle', 'syncOverflow', 'syncPromoteCandidates', 'addSettled', 'markUndone', 'remove', 'removeByMemoryIds', 'dropDependingOn', 'withClaim',
  ], name => { effects.ledgerWrites.push(name) })
  observe(SnapshotStore.prototype, ['capture', 'sweep', 'redact', 'purge', 'restore'], name => { effects.snapshotWrites.push(name) })
})
afterEach(async () => {
  fsTrace.on = false
  await Promise.all(liveDisposers.splice(0).map(dispose => dispose()))
  vi.restoreAllMocks()
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

/**
 * 起插件：最小宿主 ctx（工具注册、事件、commands 与 timer 可选注册）；llm、sessionQuery、sessionProjections、
 * agentDefaultModel 是进程边界上的替身，调用记进 effects。modes 给出各子会话的 subagent 投影（缺省按一次性）。
 */
async function boot() {
  const defs = new Map<string, ToolDef>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  let command: MemoryCommandDefinition | undefined
  const llm = {
    async *stream(): AsyncIterable<StreamChunk> {
      effects.llmCalls++
      yield { type: 'text-delta', index: 0, text: '{"findings":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const memoryRoot = await makeTmp()
  const ws = await makeTmp() // 会话 cwd；resolveWorkspacePath 走 realpath，已是真实路径
  // 子会话日志：保存点之前一条宿主 tool/result（形状对齐宿主 agent-loop）
  const toolResult = (seq: number, text: string) => ({
    type: 'tool/result', seq, time: 0,
    data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: `call-${seq}` }, toolCallId: `call-${seq}`, content: [{ type: 'text', text }], isError: false } },
  })
  const headers = new Map<string, Pick<SessionHeader, 'id' | 'delegationDepth' | 'parentSession'>>()
  const sessionQuery = {
    readEvent: async (request: { sessionId: string; seq: number }) => {
      effects.readEvents.push({ sessionId: request.sessionId })
      return { events: [toolResult(request.seq, `${request.sessionId} 的工具输出`)], startSeq: 0, endSeq: request.seq }
    },
    filterSessions: async (filters: Array<{ kind: string; values: string[] }>) => {
      const ids = filters.find(f => f.kind === 'id')?.values ?? []
      effects.headerLookups.push(...ids)
      return ids.flatMap(id => {
        const header = headers.get(id)
        return header ? [{ header: { version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, ...header }, live: true, persisted: false }] : []
      })
    },
  }
  const modes = new Map<string, 'one-shot' | 'continuable'>()
  const projections = {
    stateOf: (session: { header: { id: string } }, key: string) => {
      if (key !== 'subagent') return undefined
      const mode = modes.get(session.header.id)
      return mode === undefined ? {} : { identity: { mode } }
    },
  }
  const agentDefaultModel = { currentSelection: () => { effects.defaultModelReads++; return { provider: 'p', model: 'm' } } }
  const timer = {
    timeout: () => { effects.timerArms++; return () => {} },
    interval: () => { effects.timerArms++; return () => {} },
  }
  const services: Record<string, unknown> = { llm, sessionQuery, sessionProjections: projections, agentDefaultModel }
  const disposers: Array<() => unknown> = []
  const ctx = {
    tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => { defs.delete(def.name) } } },
    on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
    get: (name: string) => services[name],
    // commands、timer 依赖齐了才回调；sessionProjections 的投影注册不模拟
    inject: (deps: string[], callback: (child: Record<string, unknown>) => unknown) => {
      const collect = (dispose: unknown) => { if (typeof dispose === 'function') disposers.push(dispose as () => unknown) }
      if (deps.includes('commands')) collect(callback({ commands: { register: (def: MemoryCommandDefinition) => { command = def; return () => {} } } }))
      if (deps.includes('timer')) collect(callback(timer))
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  const config = new Config({ memoryRoot } as never)
  await apply(ctx as never, config)
  liveDisposers.push(async () => { for (const d of disposers.splice(0).reverse()) await d() })

  /** 宿主真 Session；子会话的 header 同时登记给 sessionQuery（根会话解析经它读祖先 header）。 */
  const session = (id: string, header: { delegationDepth?: number; parentSession?: string; mode?: 'one-shot' | 'continuable' } = {}) => {
    const { mode, ...meta } = header
    if (mode !== undefined) modes.set(id, mode)
    headers.set(id, { id: id as SessionId, ...meta as Partial<SessionHeader> })
    return Session.create(id as SessionId, [], {
      version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: 0, isSeeded: false, cwd: ws, ...meta as Partial<SessionHeader>,
    })
  }
  const exec = (s: Session) => fakeExec({ agent: { session: s, options: { provider: 'p', model: 'm' } } as unknown as ToolRunContext['agent'] })
  /** 调一个工具，只观察这次调用：进入前清空 effects、打开 fs 记录，返回结果。 */
  const call = async (s: Session, tool: string, args: unknown) => {
    resetEffects()
    fsTrace.on = true
    try {
      return await defs.get(tool)!.execute(args, exec(s)) as Out
    } finally {
      fsTrace.on = false
    }
  }
  /** 不清空 effects 地调用（准备数据用）。 */
  const prepare = (s: Session, tool: string, args: unknown) => defs.get(tool)!.execute(args, exec(s)) as Promise<Out>
  /** 借 s 执行一条 /memory 命令（同 GUI），只观察这次调用。 */
  const runCommand = async (s: Session, c: MemoryCommand) => {
    resetEffects()
    fsTrace.on = true
    try {
      const r = await command!.handler({ rawInput: encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length), agent: { session: s, options: { provider: 'p', model: 'm' } } })
      return JSON.parse(r.text!) as { ok: boolean; code?: string }
    } finally {
      fsTrace.on = false
    }
  }
  /** 宿主走第 2 步的 pre-step（空 decision），只观察这次组装，返回会话里最后一份可见快照。 */
  const inject = async (s: Session) => {
    s.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    resetEffects()
    fsTrace.on = true
    try {
      await listeners.get('agent/pre-step')!({ agent: { session: s }, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    } finally {
      fsTrace.on = false
    }
    return lastVisibleSnapshot(s.deriveMessages()) ?? ''
  }
  /** 直接在 global 目录放一条记录文件（手建的全局记忆）。 */
  const seedGlobal = async (partial: Partial<MemoryRecord>) => {
    const r = record({ scope: 'global', ...partial })
    await mkdir(join(memoryRoot, 'global'), { recursive: true })
    await writeFile(join(memoryRoot, 'global', `${r.id}.md`), encodeRecord(r, {}), 'utf8')
    return r
  }
  const globalDir = join(memoryRoot, 'global') + sep
  /** 这次调用在 global 目录里新建或改写的记录文件（索引 MEMORY.md 不算记录）。 */
  const globalRecordWrites = (writes = effects.fsWrites) => writes.filter(p => p.startsWith(globalDir) && !basename(p).startsWith('MEMORY.md'))
  /** 这次调用写进语义缓存、体检记录侧表的路径。 */
  const stateWrites = (dir: string) => effects.fsWrites.filter(p => p.startsWith(join(memoryRoot, STATE_DIR, dir) + sep))
  return { defs, memoryRoot, ws, session, call, prepare, runCommand, inject, seedGlobal, globalRecordWrites, stateWrites }
}

const SAVE = { action: 'create', type: 'knowledge', scope: 'workspace', tags: [] }
/** 子 agent 能存的形状：依据是观察所得（写入约束见 tests/pipeline.spec.ts）。实体用引号短语，各条互不撞重复。 */
const childSave = (name: string, extra: object = {}) =>
  ({ ...SAVE, name, summary: `${name}摘要`, content: `子会话看到「${name}」`, sourceMode: 'environment-observed', ...extra })
const mainSave = (name: string, content: string) =>
  ({ ...SAVE, name, summary: `${name}摘要`, content, sourceMode: 'user-explicit', force: true })

/** 业务层的「什么都没写」：记录表、账本、快照、语义缓存都没有写调用。 */
function expectNoBusinessWrites(h: Awaited<ReturnType<typeof boot>>, label: string) {
  expect(effects.recordWrites, `${label}: 记录`).toEqual([])
  expect(effects.ledgerWrites, `${label}: 账本`).toEqual([])
  expect(effects.snapshotWrites, `${label}: 快照`).toEqual([])
  expect(h.stateWrites('scan-cache'), `${label}: 语义缓存`).toEqual([])
}

describe('权限面：子 agent 调每个工具只触发权限内的副作用', () => {
  it('memory_save：写进当前项目目录、可读祖先 header；不碰 global 目录、不调模型、不读任何会话事件', async () => {
    const h = await boot()
    const global = await h.seedGlobal({ name: '全局约定', content: '全局里已有的「约定」' })
    h.session('sess-main')
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })

    const created = await h.call(child, 'memory_save', childSave('新观察'))
    expect(created.kind).toBe('saved')
    expect(isPendingDelegated(created.record!)).toBe(true)
    expect(effects.headerLookups).toEqual(['sess-main']) // 允许：经 sessionQuery 读祖先 header 解析根会话
    expect(created.record!.delegation).toMatchObject({ rootSessionId: 'sess-main' })
    const writes = [{ ...effects }]

    const downgraded = await h.call(child, 'memory_save', childSave('想放全局', { scope: 'global' }))
    expect(downgraded.kind).toBe('saved')
    expect(downgraded.warnings?.map(w => w.code)).toContain('subagent-scope-local')
    writes.push({ ...effects })

    const updated = await h.call(child, 'memory_save', { ...childSave('新观察'), action: 'update', id: created.record!.id, content: '子会话看到「新观察」又补了一句' })
    expect(updated.kind).toBe('updated')
    writes.push({ ...effects })

    // 被拒的两种：改全局那条、带 supersedes
    for (const args of [{ ...childSave('改全局'), action: 'update', id: global.id }, childSave('替代', { supersedes: [global.id] })]) {
      expect(await h.call(child, 'memory_save', args)).toMatchObject({ kind: 'rejected', code: 'subagent-restricted' })
      expect(effects.recordWrites).toEqual([])
      writes.push({ ...effects })
    }

    for (const [i, e] of writes.entries()) {
      // 允许：当前项目目录内写记录
      for (const w of e.recordWrites) expect(w.record, `调用 ${i}`).toMatchObject({ scope: 'workspace', workspacePath: h.ws })
      // 必须不发生：global 目录新建或改写记录、模型调用、读任何会话事件
      expect(h.globalRecordWrites(e.fsWrites), `调用 ${i}`).toEqual([])
      expect(e.llmCalls, `调用 ${i}`).toBe(0)
      expect(e.readEvents, `调用 ${i}`).toEqual([])
    }
    expect(writes.slice(0, 3).every(e => e.recordWrites.length > 0 && e.fsWrites.length > 0)).toBe(true)
  })

  it('memory_search：两段排序照常；不调模型、不改写记录内容', async () => {
    const h = await boot()
    const main = h.session('sess-main')
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    const pending = await h.prepare(child, 'memory_save', childSave('斑马待确认', { content: '子会话看到 zebra「待确认」' }))
    const settled = await h.prepare(main, 'memory_save', mainSave('斑马主档', '主会话记下 zebra「主档」'))

    const out = await h.call(child, 'memory_search', { query: 'zebra' })
    expect(out.hits!.map(x => x.id)).toEqual([settled.record!.id, pending.record!.id])
    expect(effects.llmCalls).toBe(0)
    expect(effects.recordWrites).toEqual([])
    expect(h.globalRecordWrites()).toEqual([])
  })

  it('memory_source：只读自己会话的事件；查出处在别的会话的记录回 subagent-restricted，不读那个会话', async () => {
    const h = await boot()
    const main = h.session('sess-main')
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    const own = await h.prepare(child, 'memory_save', childSave('自己的观察'))
    const theirs = await h.prepare(main, 'memory_save', mainSave('主会话的', '主会话的「事实」'))

    const ok = await h.call(child, 'memory_source', { memoryId: own.record!.id })
    expect(ok.kind).toBe('ok')
    expect(ok.lines!.join('\n')).toContain('sess-child 的工具输出')
    expect(effects.readEvents).toEqual([{ sessionId: 'sess-child' }])

    const rejected = await h.call(child, 'memory_source', { memoryId: theirs.record!.id })
    expect(rejected).toMatchObject({ kind: 'rejected', code: 'subagent-restricted' })
    expect(effects.readEvents).toEqual([])
  })

  it('memory_health：照常可用；不调模型、不写记录', async () => {
    const h = await boot()
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    await h.prepare(child, 'memory_save', childSave('体检对象'))
    const out = await h.call(child, 'memory_health', {})
    expect(out.kind).toBe('single')
    expect(effects.llmCalls).toBe(0)
    expect(effects.recordWrites).toEqual([])
  })

  it('memory_confirm / forget / snapshot / scan / promote：subagent-readonly；记录、账本、快照、语义缓存都不写，不调模型', async () => {
    const h = await boot()
    const main = h.session('sess-main')
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    const own = await h.prepare(child, 'memory_save', childSave('待接受'))
    const settled = await h.prepare(main, 'memory_save', mainSave('主会话的', '主会话的「事实」'))
    const snap = await h.prepare(main, 'memory_snapshot', { action: 'create', description: 'seed' }) as Out & { snapshotId: string }
    const attempts: Array<[string, unknown]> = [
      ['memory_confirm', { action: 'accept-subagent', memoryId: own.record!.id }],
      ['memory_confirm', { action: 'refresh', memoryId: settled.record!.id }],
      ['memory_confirm', { action: 'resolve', decisionId: 'pd_x', verdict: 'dismiss' }],
      ['memory_forget', { ids: [settled.record!.id], reason: '子 agent 想删' }],
      ['memory_snapshot', { action: 'create', description: '子 agent 的快照' }],
      ['memory_snapshot', { action: 'list' }],
      ['memory_snapshot', { action: 'restore', snapshotId: snap.snapshotId }],
      ['memory_scan', { layers: 'full' }],
      ['memory_promote', { ids: [settled.record!.id] }],
    ]
    for (const depth of [1, 2]) {
      const s = depth === 1 ? child : h.session('sess-grandchild', { delegationDepth: 2, parentSession: 'sess-child' })
      for (const [tool, args] of attempts) {
        const label = `${tool} ${JSON.stringify(args)} @${depth}`
        expect(await h.call(s, tool, args), label).toMatchObject({ kind: 'rejected', code: 'subagent-readonly' })
        expectNoBusinessWrites(h, label)
        expect(effects.llmCalls, label).toBe(0)
      }
    }
  })

  it('GUI 借子会话执行写命令：subagent-readonly；记录与账本都不写，不调模型', async () => {
    const h = await boot()
    const main = h.session('sess-main')
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    const own = await h.prepare(child, 'memory_save', childSave('待接受'))
    const settled = await h.prepare(main, 'memory_save', mainSave('主会话的', '主会话的「事实」'))
    const layer = { kind: 'workspace', workspacePath: h.ws } as const
    const base = { updatedAt: own.record!.updatedAt, digest: 'sha1:0' }
    const edit = { content: '用户改的', name: '待接受', summary: '用户改的', tags: [] }
    const commands: MemoryCommand[] = [
      { cmd: 'edit-memory', memoryId: own.record!.id, layer, base, ...edit },
      { cmd: 'merge-memories', memories: [{ memoryId: own.record!.id, layer, base }, { memoryId: settled.record!.id, layer, base }], ...edit },
      { cmd: 'forget', memoryId: settled.record!.id, layer },
      { cmd: 'hard-delete', memoryId: settled.record!.id, layer },
      { cmd: 'confirm', memoryId: own.record!.id, layer },
      { cmd: 'resolve', decisionId: 'pd_x', verdict: 'keep-left' },
      { cmd: 'promote-memory', memoryId: settled.record!.id, layer },
      { cmd: 'draft-edit', adviceType: 'unclear', memories: [{ memoryId: own.record!.id, layer }] } as MemoryCommand,
      { cmd: 'scan', workspacePath: h.ws },
      { cmd: 'migrate-type', from: 'knowledge', action: 'forget' },
    ]
    for (const c of commands) {
      const out = await h.runCommand(child, c)
      expect(out, c.cmd).toMatchObject({ ok: false, code: 'subagent-readonly' })
      expect(effects.recordWrites, c.cmd).toEqual([])
      expect(effects.ledgerWrites, c.cmd).toEqual([])
      expect(effects.llmCalls, c.cmd).toBe(0)
    }
  })

  it('快照注入：持久型子会话带自己的待确认、不带兄弟的，一次性都不带；不调模型、不改写记录内容', async () => {
    const h = await boot()
    const main = h.session('sess-main')
    const keeper = h.session('sess-keeper', { delegationDepth: 1, parentSession: 'sess-main', mode: 'continuable' })
    const sibling = h.session('sess-sibling', { delegationDepth: 1, parentSession: 'sess-main', mode: 'one-shot' })
    const mine = await h.prepare(keeper, 'memory_save', childSave('持久型自己的'))
    const theirs = await h.prepare(sibling, 'memory_save', childSave('兄弟的'))
    const settled = await h.prepare(main, 'memory_save', mainSave('主会话的', '主会话的「事实」'))

    const cases: Array<[Session, string[], string[]]> = [
      [h.session('sess-keeper-2', { delegationDepth: 1, parentSession: 'sess-main', mode: 'continuable' }), [settled.record!.id], [mine.record!.id, theirs.record!.id]],
      [keeper, [settled.record!.id, mine.record!.id], [theirs.record!.id]],
      [sibling, [settled.record!.id], [mine.record!.id, theirs.record!.id]],
    ]
    for (const [s, present, absent] of cases) {
      const text = await h.inject(s)
      for (const id of present) expect(text, `${s.header.id} 应带 ${id}`).toContain(id)
      for (const id of absent) expect(text, `${s.header.id} 不应带 ${id}`).not.toContain(id)
      expect(effects.llmCalls).toBe(0)
      expect(effects.recordWrites).toEqual([])
      expect(effects.snapshotWrites).toEqual([])
      expect(h.stateWrites('scan-cache')).toEqual([])
    }
  })

  it('子级存下记忆后主会话没有新消息：下一步照旧，不补注入、不发通知', async () => {
    const h = await boot()
    const main = h.session('sess-main')
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main' })
    await h.inject(main)
    const before = main.deriveMessages().length
    expect((await h.call(child, 'memory_save', childSave('子级新观察'))).kind).toBe('saved')
    expect(main.deriveMessages()).toHaveLength(before)
    await h.inject(main)
    expect(main.deriveMessages()).toHaveLength(before + 1) // 只多了 inject 自己追加的那条系统提示词
  })

  it('自动体检不经会话：子会话的保存、检索、注入都不触发它（不读默认模型、不排计时、不写体检记录、不调模型）', async () => {
    const h = await boot()
    const child = h.session('sess-child', { delegationDepth: 1, parentSession: 'sess-main', mode: 'continuable' })
    const steps: Array<() => Promise<unknown>> = [
      () => h.call(child, 'memory_save', childSave('子观察')),
      () => h.call(child, 'memory_search', { query: '子观察' }),
      () => h.inject(child),
    ]
    for (const [i, step] of steps.entries()) {
      await step()
      expect(effects.defaultModelReads, `步骤 ${i}`).toBe(0)
      expect(effects.timerArms, `步骤 ${i}`).toBe(0)
      expect(h.stateWrites('checkups'), `步骤 ${i}`).toEqual([])
      expect(effects.llmCalls, `步骤 ${i}`).toBe(0)
    }
  })
})
