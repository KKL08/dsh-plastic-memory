import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.ts'
import type { ToolGateCode } from '../src/contract-codes.ts'
import { ACCEPT_SUBAGENT_GROUP_GUIDE, MEMORY_IDS_PARAM_DESCRIPTION } from '../src/tools/confirm-tool.ts'
import type { GroupAcceptResult } from '../src/tools/confirm.ts'
import { decodeFile } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR } from '../src/storage/paths.ts'
import { isPendingDelegated, type MemoryRecord } from '../src/record-schema.ts'
import { fakeExec } from './helpers/exec.ts'
import { readUserTurn, USER_TURN_BOUNDARY } from './helpers/session-log.ts'

// 子 agent 报上来一批待确认记录，主会话用 memory_confirm 的 memoryIds 一次接受，再用现有工具分步合并重叠的几条。
// 经 apply() 注册后的真实工具走一遍：宿主对象只按最小结构伪造（进程边界），模型服务是数调用次数的替身。

const SUBAGENT_READONLY: ToolGateCode = 'subagent-readonly'

type ToolDef = {
  name: string
  description: string
  parameters: { properties: Record<string, unknown>; required?: string[] }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> }
}

const tmpDirs: string[] = []
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-group-accept-plugin-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

/** 起插件：最小宿主 ctx（工具注册、事件、模型与 sessionQuery 服务），治理开着；模型服务数每次调用。 */
async function boot() {
  const defs = new Map<string, ToolDef>()
  const model = { calls: 0 }
  const llm = {
    async *stream(): AsyncIterable<StreamChunk> {
      model.calls++
      yield { type: 'text-delta', index: 0, text: '{"findings":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const sessionQuery = { readEvent: async () => ({ events: [], startSeq: 0, endSeq: 0 }), readSession: readUserTurn }
  const turnProjection = { stateOf: (_s: object, key: string) => (key === 'turnBoundary' ? USER_TURN_BOUNDARY : undefined) }
  const ctx = {
    tools: {
      register: (def: ToolDef) => {
        if (defs.has(def.name)) throw new Error(`tool "${def.name}" already registered`)
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      },
    },
    on: () => () => {},
    get: (name: string) => (name === 'llm' ? llm : name === 'sessionQuery' ? sessionQuery : name === 'sessionProjections' ? turnProjection : undefined),
    inject: () => () => {},
    effect: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const memoryRoot = await makeTmp()
  const cwd = await makeTmp()
  await apply(ctx as never, new Config({ memoryRoot, governance: { enabled: true } } as never))
  const session = (delegationDepth?: number) => ({
    header: {
      id: delegationDepth === undefined ? 'sess-main' : `sess-d${delegationDepth}`, cwd,
      ...(delegationDepth === undefined ? {} : { delegationDepth, parentSession: 'sess-main' }),
    },
    seq: 3,
    requestHeader: () => undefined,
  })
  const exec = (delegationDepth?: number) =>
    fakeExec({ agent: { session: session(delegationDepth), options: { provider: 'p', model: 'm' } } as unknown as ToolRunContext['agent'] })
  const call = (tool: string, args: unknown, delegationDepth?: number) => defs.get(tool)!.execute(args, exec(delegationDepth))
  return { defs, model, memoryRoot, call }
}

/** 从磁盘读回一条记录，连同最近删除（.archive/）里的：返回记录和它在不在 .archive/ 里。 */
async function readBack(memoryRoot: string, id: string): Promise<{ record: MemoryRecord; isArchived: boolean }> {
  for (const dir of await readdir(memoryRoot)) {
    if (dir.startsWith('.')) continue
    for (const [level, isArchived] of [[join(memoryRoot, dir), false], [join(memoryRoot, dir, ARCHIVE_DIR), true]] as const) {
      const files = await readdir(level).catch(() => [] as string[])
      for (const file of files) {
        if (!file.endsWith('.md') || file === 'MEMORY.md') continue
        const path = join(level, file)
        const decoded = decodeFile(await readFile(path, 'utf8'), { path, loc: dir === 'global' ? { scope: 'global' } : { scope: 'workspace', workspacePath: '/ws' } })
        if (decoded.ok && decoded.record.id === id) return { record: decoded.record, isArchived }
      }
    }
  }
  throw new Error(`记录 ${id} 不在磁盘上`)
}

const saveArgs = (name: string, summary: string, content: string) => ({
  action: 'create', name, summary, content, type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', tags: [], force: true,
})
/** 子 agent 能存的形状：依据是观察所得、不带 force。 */
const childSaveArgs = (name: string, summary: string, content: string) => ({ ...saveArgs(name, summary, content), sourceMode: 'environment-observed', force: false })
type Saved = { kind: string; record: { id: string } }

/** 主会话先有一条相关的主档；子 agent 存三条待确认记录，前两条几乎一样。 */
async function seed(h: Awaited<ReturnType<typeof boot>>) {
  const main = await h.call('memory_save', saveArgs('Ansible rollout', 'ansible playbook rollout', 'ansible playbook rollout canary hosts first then fleet')) as Saved
  expect(main.kind).toBe('saved')
  const ids: string[] = []
  for (const args of [
    childSaveArgs('Canary observation', 'canary hosts rollout observed', 'observed ansible canary hosts rollout succeeded before fleet wave'),
    childSaveArgs('Canary observation again', 'canary hosts rollout observed', 'observed ansible canary hosts rollout succeeded before fleet waves'),
    childSaveArgs('Quokka sighting', 'quokka island', 'quokka marsupial island sighting recorded'),
  ]) {
    const out = await h.call('memory_save', args, 1) as Saved
    expect(out.kind).toBe('saved')
    expect(isPendingDelegated((await readBack(h.memoryRoot, out.record.id)).record)).toBe(true)
    ids.push(out.record.id)
  }
  return { mainId: main.record.id, ids }
}

describe('成组接受经注册处', () => {
  it('一批待确认记录经 memoryIds 一次接受：按主题分组、标出组内近重复和与已有记忆的重叠；整条路径不调模型；再按两步合并：留下的那条写合并内容，其余几条进最近删除', async () => {
    const h = await boot()
    const { mainId, ids } = await seed(h)
    const [keep, merged, lonely] = ids as [string, string, string]

    const callsBefore = h.model.calls
    const out = await h.call('memory_confirm', { action: 'accept-subagent', memoryIds: ids }) as GroupAcceptResult
    expect(out.kind).toBe('group-accepted')
    expect(out.acceptedIds).toEqual(ids)
    expect(h.model.calls).toBe(callsBefore)
    expect(h.defs.get('memory_confirm')!.output.render({}, out)[0]!.text).toBe(out.message)
    const keepGroup = out.groups.find(g => g.items.some(i => i.memoryId === keep))!
    expect(keepGroup.nearDuplicatePairs).toEqual([[keep, merged]])
    const keepItem = keepGroup.items.find(i => i.memoryId === keep)!
    expect([keepItem.overlap?.duplicateOf?.id, ...(keepItem.overlap?.similar ?? []).map(s => s.id)]).toContain(mainId)
    for (const id of ids) {
      const { record } = await readBack(h.memoryRoot, id)
      expect(record.delegation?.reviewed?.by, id).toBe('main')
    }

    // 第一步：对留下的那条写合并后的内容；第二步：其余那条遗忘
    const content = 'observed ansible canary hosts rollout succeeded before every fleet wave'
    const updated = await h.call('memory_save', { ...saveArgs('Canary observation', 'canary hosts rollout observed', content), action: 'update', change: 'correct', id: keep, force: false }) as { kind: string }
    expect(updated.kind).toBe('updated')
    const forgot = await h.call('memory_forget', { ids: [merged], reason: '并进了留下的那条' }) as { forgotten: string[] }
    expect(forgot.forgotten).toEqual([merged])

    const kept = await readBack(h.memoryRoot, keep)
    expect(kept.isArchived).toBe(false)
    expect(kept.record).toMatchObject({ status: 'active', content })
    expect(isPendingDelegated(kept.record)).toBe(false)
    const gone = await readBack(h.memoryRoot, merged)
    expect(gone.isArchived).toBe(true)
    expect(gone.record.status).toBe('deleted')
    expect((await readBack(h.memoryRoot, lonely)).record).toMatchObject({ status: 'active' })
  })

  it('子会话（深度 1、2）带 memoryIds 调用：subagent-readonly，记录仍待确认', async () => {
    const h = await boot()
    const { ids } = await seed(h)
    for (const depth of [1, 2]) {
      expect(await h.call('memory_confirm', { action: 'accept-subagent', memoryIds: ids }, depth), `depth ${depth}`)
        .toMatchObject({ kind: 'rejected', code: SUBAGENT_READONLY })
    }
    for (const id of ids) expect(isPendingDelegated((await readBack(h.memoryRoot, id)).record), id).toBe(true)
  })

  it('工具参数带可选的 memoryIds（字符串数组），说明写明成组接受和合并怎么做；原来三个动作的说明还在', async () => {
    const h = await boot()
    const def = h.defs.get('memory_confirm')!
    expect(def.parameters.properties.memoryIds).toEqual({ type: 'array', items: { type: 'string' }, description: MEMORY_IDS_PARAM_DESCRIPTION })
    expect(def.parameters.required ?? []).not.toContain('memoryIds')
    expect(def.parameters.required ?? []).not.toContain('memoryId')
    expect(def.description).toContain(ACCEPT_SUBAGENT_GROUP_GUIDE)
    expect(def.description).toContain('action=accept-subagent 接受子 agent 存的待确认记忆，接受后和本项目其他记忆一样注入、检索')
    for (const text of [MEMORY_IDS_PARAM_DESCRIPTION, ACCEPT_SUBAGENT_GROUP_GUIDE]) expect(text.trim()).not.toBe('')
    expect(MEMORY_IDS_PARAM_DESCRIPTION).not.toBe(ACCEPT_SUBAGENT_GROUP_GUIDE)
  })
})
