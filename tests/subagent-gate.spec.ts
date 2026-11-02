import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.ts'
import type { ToolGateCode } from '../src/contract-codes.ts'
import { delegationDepthOf, subagentModeOf } from '../src/tools/subagent-gate.ts'
import { lastVisibleSnapshot } from '../src/snapshot-message.ts'
import { decodeFile } from '../src/storage/frontmatter.ts'
import { isPendingDelegated, type MemoryRecord } from '../src/record-schema.ts'
import { fakeExec } from './helpers/exec.ts'

// 子 agent 只读门：宿主子 agent 会话的 header 带 delegationDepth（父深度 + 1），主会话缺省。
// 经 apply() 注册后的真实工具定义走一遍，宿主对象只按最小结构伪造（进程边界）。

const SUBAGENT_READONLY: ToolGateCode = 'subagent-readonly'
const WRITE_TOOLS = ['memory_save', 'memory_forget', 'memory_confirm', 'memory_promote', 'memory_snapshot', 'memory_scan'] as const

type ToolDef = {
  name: string
  description: string
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> }
}

const tmpDirs: string[] = []
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plastic-memory-gate-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

/** 递归快照：相对路径 → mtime（目录与文件都计，含 .state/）。 */
async function treeSnapshot(dir: string, prefix = ''): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    out[rel] = (await stat(join(dir, entry.name))).mtimeMs
    if (entry.isDirectory()) Object.assign(out, await treeSnapshot(join(dir, entry.name), `${rel}/`))
  }
  return out
}

/** 起插件：最小宿主 ctx（工具注册、事件、llm 与 sessionQuery 服务），留住注册后的工具定义。governance 缺省开启。 */
async function boot(opts: { governance?: boolean } = {}) {
  const defs = new Map<string, ToolDef>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const llm = {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '{"findings":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const sessionQuery = { readEvent: async () => ({ events: [], startSeq: 0, endSeq: 0 }) }
  const ctx = {
    // 同名重复注册在宿主里直接抛错：重注册必须先注销
    tools: {
      register: (def: ToolDef) => {
        if (defs.has(def.name)) throw new Error(`tool "${def.name}" already registered`)
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      },
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
    get: (name: string) => (name === 'llm' ? llm : name === 'sessionQuery' ? sessionQuery : undefined),
    inject: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const memoryRoot = await makeTmp()
  const cwd = await makeTmp() // resolveWorkspacePath 走 realpath，cwd 必须真实存在
  const config = new Config({ memoryRoot, governance: { enabled: opts.governance ?? true } } as never)
  await apply(ctx as never, config)

  // 子会话的 parentSession 指向上一层（深度 1 的父会话是 sess-main）
  const parentOf = (depth: number) => (depth <= 1 ? 'sess-main' : `sess-d${depth - 1}`)
  const session = (delegationDepth?: number) => ({
    header: {
      id: delegationDepth === undefined ? 'sess-main' : `sess-d${delegationDepth}`, cwd,
      ...(delegationDepth === undefined ? {} : { delegationDepth, ...(delegationDepth >= 1 ? { parentSession: parentOf(delegationDepth) } : {}) }),
    },
    seq: 3,
    requestHeader: () => undefined,
  })
  const execAt = (delegationDepth?: number) =>
    fakeExec({ agent: { session: session(delegationDepth), options: { provider: 'p', model: 'm' } } as unknown as ToolRunContext['agent'] })
  const call = (tool: string, args: unknown, delegationDepth?: number) => defs.get(tool)!.execute(args, execAt(delegationDepth))
  /** 宿主真会话走一次第 2 步的 pre-step（空决定），取会话里最后一份可见快照。 */
  const assemble = async (delegationDepth?: number) => {
    const id = (delegationDepth === undefined ? 'sess-main' : `sess-d${delegationDepth}`) as SessionId
    const hostSession = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd, ...(delegationDepth === undefined ? {} : { delegationDepth }),
    })
    hostSession.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    const payload = { agent: { session: hostSession }, messages: [], turn: 1, step: 2, signal: new AbortController().signal }
    await listeners.get('agent/pre-step')!(payload, async () => ({ kind: 'enter', messages: [] }))
    return lastVisibleSnapshot(hostSession.deriveMessages()) ?? ''
  }
  /** 治理开关热切换：Loader 写入新值后发 loader/volatile-update（同宿主），等监听器跑完。 */
  const setGovernance = async (enabled: boolean) => {
    const ref = config.governance.enabled as unknown as Record<symbol, (v: unknown) => void>
    ref[Symbol.for('cosmokit.volatile.write')]!(enabled)
    await listeners.get('loader/volatile-update')!([['governance', 'enabled']])
  }
  return { defs, memoryRoot, call, assemble, setGovernance }
}

/** 从磁盘读回一条记录（不经插件内存）：在 memoryRoot 下按 id 找文件并解码，返回记录与所在目录。 */
async function readBack(memoryRoot: string, id: string): Promise<{ record: MemoryRecord; dir: string }> {
  for (const dir of await readdir(memoryRoot)) {
    if (dir.startsWith('.')) continue
    for (const file of await readdir(join(memoryRoot, dir))) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue
      const path = join(memoryRoot, dir, file)
      const decoded = decodeFile(await readFile(path, 'utf8'), { path, loc: dir === 'global' ? { scope: 'global' } : { scope: 'workspace', workspacePath: '/ws' } })
      if (decoded.ok && decoded.record.id === id) return { record: decoded.record, dir }
    }
  }
  throw new Error(`记录 ${id} 不在磁盘上`)
}

const saveArgs = (name: string, content: string) => ({
  action: 'create', name, summary: name, content, type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', tags: [], force: true,
})
type Saved = { kind: string; record: { id: string } }
type Gated = { kind: string; code: string; message: string }

/** 主会话先存一条记忆、拍一张快照——给子 agent 的每个写工具一个真实目标。 */
async function seed(h: Awaited<ReturnType<typeof boot>>) {
  const saved = await h.call('memory_save', saveArgs('子代理门探针', '只读门探针正文 zebra')) as Saved
  expect(saved.kind).toBe('saved')
  const snap = await h.call('memory_snapshot', { action: 'create', description: 'seed' }) as { kind: string; snapshotId: string }
  expect(snap.kind).toBe('created')
  return { id: saved.record.id, snapshotId: snap.snapshotId }
}

describe('子 agent 只读门', () => {
  it('执行上下文随 workspace 一起解析 delegationDepth（主会话 0 或缺省）', () => {
    expect(delegationDepthOf(undefined)).toBe(0)
    expect(delegationDepthOf({ header: {} })).toBe(0)
    expect(delegationDepthOf({ header: { delegationDepth: 0 } })).toBe(0)
    expect(delegationDepthOf({ header: { delegationDepth: 1 } })).toBe(1)
    expect(delegationDepthOf({ header: { delegationDepth: 2 } })).toBe(2)
  })

  it('一次性 / 持久型现读宿主 subagent 投影的 identity.mode；读不到按一次性并说明原因', () => {
    const session = Session.create('sess-d1' as SessionId, [], { version: SESSION_FORMAT_VERSION, id: 'sess-d1' as SessionId, createdAt: 0, isSeeded: false, delegationDepth: 1 })
    const registry = (state: unknown) => ({ stateOf: (_s: unknown, key: string) => (key === 'subagent' ? state : undefined) }) as never
    expect(subagentModeOf(registry({ identity: { mode: 'continuable', label: 'reviewer', seq: 0 } }), session)).toEqual({ mode: 'continuable' })
    expect(subagentModeOf(registry({ identity: { mode: 'one-shot', seq: 0 } }), session)).toEqual({ mode: 'one-shot' })
    // 没有有效描述符：宿主给 {}，是正常状态，不算退化
    expect(subagentModeOf(registry({}), session)).toEqual({ mode: 'one-shot' })
    expect(subagentModeOf(registry(undefined), session)).toEqual({ mode: 'one-shot', fallback: 'subagent projection is not registered' })
    expect(subagentModeOf(undefined, session)).toEqual({ mode: 'one-shot', fallback: 'sessionProjections service is absent' })
    const throwing = { stateOf: () => { throw new Error('projection exploded') } } as never
    expect(subagentModeOf(throwing, session).fallback).toContain('projection exploded')
  })

  it('depth 为 1 时 memory_save 以外的写工具返回 subagent-readonly，磁盘零变化；search、source、快照组装照常', async () => {
    const h = await boot()
    const { id, snapshotId } = await seed(h)
    const before = await treeSnapshot(h.memoryRoot)

    const attempts: Array<[string, unknown]> = [
      ['memory_forget', { ids: [id], reason: '子代理想删' }],
      ['memory_confirm', { action: 'refresh', memoryId: id }],
      ['memory_promote', { ids: [id] }],
      ['memory_snapshot', { action: 'restore', snapshotId }],
      ['memory_snapshot', { action: 'create', description: '子代理快照' }],
      ['memory_scan', {}],
    ]
    for (const [tool, args] of attempts) {
      const out = await h.call(tool, args, 1) as Gated
      expect(out, tool).toMatchObject({ kind: 'rejected', code: SUBAGENT_READONLY })
    }
    // 更深的子 agent 同样拒
    expect(await h.call('memory_forget', { ids: [id], reason: '孙代理想删' }, 2)).toMatchObject({ code: SUBAGENT_READONLY })
    expect(await treeSnapshot(h.memoryRoot)).toEqual(before)

    const search = await h.call('memory_search', { query: 'zebra' }, 1) as { hits: Array<{ id: string }> }
    expect(search.hits.map(x => x.id)).toEqual([id])
    expect(await h.call('memory_source', { memoryId: id }, 1)).toMatchObject({ kind: 'ok', memoryId: id })
    expect(await h.call('memory_health', {}, 1)).not.toMatchObject({ code: SUBAGENT_READONLY })
    expect(await h.assemble(1)).toContain(`[${id}] 子代理门探针`)
  })

  it('主会话不受影响；稳定码进 contract-codes', async () => {
    for (const depth of [undefined, 0]) {
      const h = await boot()
      const saved = await h.call('memory_save', saveArgs('主会话', '主会话的事实'), depth) as Saved
      expect(saved.kind).toBe('saved')
      expect(await h.call('memory_confirm', { action: 'refresh', memoryId: saved.record.id }, depth)).not.toMatchObject({ code: SUBAGENT_READONLY })
      expect(await h.call('memory_forget', { ids: [saved.record.id], reason: '不要了' }, depth)).not.toMatchObject({ code: SUBAGENT_READONLY })
      expect(await h.call('memory_snapshot', { action: 'list' }, depth)).not.toMatchObject({ code: SUBAGENT_READONLY })
      expect(await h.call('memory_scan', { layers: 'rule' }, depth)).not.toMatchObject({ code: SUBAGENT_READONLY })
    }
  })

  it('工具说明或拒绝消息提示「把要记的事实或治理动作带回主会话」', async () => {
    // memory_save 只在治理关闭时封住，单独在关闭的实例上查
    const cases: Array<[Awaited<ReturnType<typeof boot>>, readonly string[]]> = [
      [await boot(), WRITE_TOOLS.filter(t => t !== 'memory_save')],
      [await boot({ governance: false }), ['memory_save', 'memory_forget', 'memory_snapshot']],
    ]
    for (const [h, tools] of cases) {
      for (const tool of tools) {
        const def = h.defs.get(tool)!
        expect(def.description, tool).toContain('带回主会话')
        const out = await h.call(tool, {}, 1) as Gated
        expect(out.message, tool).toContain('把要记的事实或治理动作带回主会话')
        expect(def.output.render({}, out)[0]!.text, tool).toBe(out.message)
      }
      for (const tool of ['memory_search', 'memory_source']) {
        expect(h.defs.get(tool)!.description, tool).not.toContain('带回主会话')
      }
    }
  })
})

describe('子 agent 写入随治理开关', () => {
  it('治理开启：子会话新建一条，落当前项目目录，文件带 delegation，读回仍是待确认', async () => {
    const h = await boot()
    const out = await h.call('memory_save', saveArgs('子代理观察', '子代理看到 main 上 pnpm test 会挂'), 1) as Saved
    expect(out.kind).toBe('saved')
    const { record, dir } = await readBack(h.memoryRoot, out.record.id)
    expect(dir).not.toBe('global')
    expect(record.scope).toBe('workspace')
    expect(record.delegation).toEqual({ sessionId: 'sess-d1', depth: 1, parentSessionId: 'sess-main' })
    expect(isPendingDelegated(record)).toBe(true)
  })

  it('主会话（深度 0 或缺省）保存不带 delegation', async () => {
    for (const depth of [undefined, 0]) {
      const h = await boot()
      const out = await h.call('memory_save', saveArgs('主会话', '主会话的事实'), depth) as Saved
      expect((await readBack(h.memoryRoot, out.record.id)).record.delegation).toBeUndefined()
    }
  })

  it('治理关闭：子会话 memory_save 回 subagent-readonly、磁盘不动；开启后下一次调用放行，再关闭又封住', async () => {
    const h = await boot({ governance: false })
    await h.call('memory_save', saveArgs('主会话垫底', '先让目录存在')) // 主会话照常
    const before = await treeSnapshot(h.memoryRoot)
    expect(await h.call('memory_save', saveArgs('子代理想存的', '子代理的新事实'), 1)).toMatchObject({ kind: 'rejected', code: SUBAGENT_READONLY })
    expect(await treeSnapshot(h.memoryRoot)).toEqual(before)

    await h.setGovernance(true)
    const out = await h.call('memory_save', saveArgs('子代理想存的', '子代理的新事实'), 1) as Saved
    expect(out.kind).toBe('saved')
    expect(isPendingDelegated((await readBack(h.memoryRoot, out.record.id)).record)).toBe(true)

    await h.setGovernance(false)
    expect(await h.call('memory_save', saveArgs('又想存的', '子代理的另一条事实'), 1)).toMatchObject({ code: SUBAGENT_READONLY })
  })

  it('治理开启时其余写工具在子会话里仍 subagent-readonly（深度 1、2）', async () => {
    const h = await boot()
    const { id, snapshotId } = await seed(h)
    const attempts: Array<[string, unknown]> = [
      ['memory_forget', { ids: [id], reason: '子代理想删' }],
      ['memory_snapshot', { action: 'restore', snapshotId }],
      ['memory_confirm', { action: 'refresh', memoryId: id }],
      ['memory_scan', {}],
      ['memory_promote', { ids: [id] }],
    ]
    for (const [tool, args] of attempts) {
      for (const depth of [1, 2]) expect(await h.call(tool, args, depth), `${tool}@${depth}`).toMatchObject({ code: SUBAGENT_READONLY })
    }
  })
})
