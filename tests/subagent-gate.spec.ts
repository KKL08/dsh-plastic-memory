import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.ts'
import type { ToolGateCode } from '../src/contract-codes.ts'
import { delegationDepthOf } from '../src/tools/subagent-gate.ts'
import { fakeExec } from './helpers/exec.ts'

// 子 agent 只读门（票 15）：宿主子 agent 会话的 header 带 delegationDepth（父深度 + 1），主会话缺省。
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

/** 起插件：最小宿主 ctx（工具注册、提示词、事件、llm 与 sessionQuery 服务），留住注册后的工具定义。 */
async function boot() {
  const defs = new Map<string, ToolDef>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const contextTexts = new Map<string, (assembleCtx?: AssembleContext) => string>()
  const llm = {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '{"findings":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const sessionQuery = { readEvent: async () => ({ events: [], startSeq: 0, endSeq: 0 }) }
  const ctx = {
    tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => {} } },
    systemPrompt: {
      context: (c: { name: string; text: (assembleCtx?: AssembleContext) => string }) => { contextTexts.set(c.name, c.text); return () => {} },
      variable: () => () => {},
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
    get: (name: string) => (name === 'llm' ? llm : name === 'sessionQuery' ? sessionQuery : undefined),
    inject: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const memoryRoot = await makeTmp()
  const cwd = await makeTmp() // resolveWorkspacePath 走 realpath，cwd 必须真实存在
  await apply(ctx as never, new Config({ memoryRoot } as never))

  const session = (delegationDepth?: number) => ({
    header: { id: delegationDepth === undefined ? 'sess-main' : `sess-d${delegationDepth}`, cwd, ...(delegationDepth === undefined ? {} : { delegationDepth }) },
    seq: 3,
    requestHeader: () => undefined,
  })
  const execAt = (delegationDepth?: number) =>
    fakeExec({ agent: { session: session(delegationDepth), options: { provider: 'p', model: 'm' } } as unknown as ToolRunContext['agent'] })
  const call = (tool: string, args: unknown, delegationDepth?: number) => defs.get(tool)!.execute(args, execAt(delegationDepth))
  const assemble = async (delegationDepth?: number) => {
    const assembleCtx = { scope: { session: session(delegationDepth) } } as unknown as AssembleContext
    const assembly: PromptAssembly = { sections: [], contexts: [{ name: 'plastic-memory', text: '' }], tools: [], variables: {} }
    await listeners.get('system-prompt/assemble')!(assembly, assembleCtx, async () => assembly)
    return assembly.contexts[0]!.text
  }
  return { defs, memoryRoot, call, assemble }
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

  it('depth 为 1 时五个写工具返回 subagent-readonly，磁盘零变化；search、source、快照组装照常', async () => {
    const h = await boot()
    const { id, snapshotId } = await seed(h)
    const before = await treeSnapshot(h.memoryRoot)

    const attempts: Array<[string, unknown]> = [
      ['memory_save', saveArgs('子代理想存的', '子代理的新事实')],
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
    expect(await h.call('memory_save', saveArgs('孙代理想存的', '孙代理的新事实'), 2)).toMatchObject({ code: SUBAGENT_READONLY })
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
    const h = await boot()
    for (const tool of WRITE_TOOLS) {
      const def = h.defs.get(tool)!
      expect(def.description, tool).toContain('带回主会话')
      const out = await h.call(tool, {}, 1) as Gated
      expect(out.message, tool).toContain('把要记的事实或治理动作带回主会话')
      expect(def.output.render({}, out)[0]!.text, tool).toBe(out.message)
    }
    for (const tool of ['memory_search', 'memory_source', 'memory_health']) {
      expect(h.defs.get(tool)!.description, tool).not.toContain('带回主会话')
    }
  })
})
