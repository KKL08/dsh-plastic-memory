import { describe, expect, it } from 'vitest'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { UNSORTED_TITLE, readIndex } from '../src/topic-index.ts'
import { env, ok, err, SESSION_WS } from './helpers/gui-command-env.ts'
import { record } from './helpers/record.ts'

// organize-index 命令：借会话的模型整理一个范围的主题索引，结果交给 undo 整批撤销。模型换成按顺序回复的桩，其余是真的。

const global = { kind: 'global' } as const

function modelOf(replies: unknown[][]): SemanticLlm {
  let calls = 0
  return { model: 'stub', complete: async () => JSON.stringify({ operations: replies[calls++] ?? [] }) }
}

async function seed(e: ReturnType<typeof env>) {
  await e.store.create(record({ id: 'mem_a', name: '发版步骤', summary: '怎么发版', content: '发版的正文' }))
  await e.store.create(record({ id: 'mem_b', name: '回复语言', summary: '用中文回复', content: '回复语言的正文' }))
}
const topics = async (e: ReturnType<typeof env>) => {
  const { topics, unsorted } = readIndex((await e.store.readIndex(global))!)
  return { ...Object.fromEntries(topics.map(t => [t.name, t.memberIds])), [UNSORTED_TITLE]: [...unsorted].sort() }
}
const ASSIGN = { op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '发版', about: '发版的步骤。' }

describe('organize-index', () => {
  it('整理全局的索引：回做成和跳过的个数、这次整理的记录；再发 undo 整批撤回', async () => {
    const e = env({ llm: modelOf([[ASSIGN, { op: 'rename', topic: '没有的', name: '新名' }]]) })
    await seed(e)
    const r = ok(await e.run({ cmd: 'organize-index', scope: global }))
    expect(r.organized).toEqual({ applied: 1, skipped: 1 })
    expect(r.isPartial).toBeUndefined()
    expect(await topics(e)).toEqual({ 发版: ['mem_a'], [UNSORTED_TITLE]: ['mem_b'] })
    const undone = ok(await e.run({ cmd: 'undo', decisionId: r.decisionId! }))
    expect(undone.undoSkipped).toBeUndefined()
    expect(await topics(e)).toEqual({ [UNSORTED_TITLE]: ['mem_a', 'mem_b'] })
    expect(await e.decisions.listSettled()).toEqual([])
  })

  it('模型什么都不改：成功，没有可撤的记录', async () => {
    const e = env({ llm: modelOf([]) })
    await seed(e)
    const r = ok(await e.run({ cmd: 'organize-index', scope: global }))
    expect(r.organized).toEqual({ applied: 0, skipped: 0 })
    expect(r.decisionId).toBeUndefined()
  })

  it('体检关着也能整理、也能撤', async () => {
    const e = env({ llm: modelOf([[ASSIGN]]), governanceEnabled: false })
    await seed(e)
    const r = ok(await e.run({ cmd: 'organize-index', scope: global }))
    expect(r.organized).toEqual({ applied: 1, skipped: 0 })
    ok(await e.run({ cmd: 'undo', decisionId: r.decisionId! }))
    expect(await topics(e)).toEqual({ [UNSORTED_TITLE]: ['mem_a', 'mem_b'] })
  })

  it('借来的会话拿不到模型、是子 agent 会话、项目路径不是绝对路径：各回各的错误，什么都不动', async () => {
    const noModel = env()
    await seed(noModel)
    expect(err(await noModel.run({ cmd: 'organize-index', scope: global })).code).toBe('llm-unavailable')
    const sub = env({ llm: modelOf([[ASSIGN]]), delegationDepth: 1 })
    expect(err(await sub.run({ cmd: 'organize-index', scope: global })).code).toBe('subagent-readonly')
    const relative = env({ llm: modelOf([]) })
    expect(err(await relative.run({ cmd: 'organize-index', scope: { kind: 'workspace', workspacePath: 'relative/path' } })).code).toBe('invalid-args')
  })

  it('这个范围正在体检：回忙；整理期间它的记录也撤不了', async () => {
    const e = env({ llm: modelOf([[ASSIGN]]) })
    await seed(e)
    const r = ok(await e.run({ cmd: 'organize-index', scope: global }))
    const held = await e.checkups.claim([global])
    expect(err(await e.run({ cmd: 'organize-index', scope: global })).code).toBe('busy')
    expect(err(await e.run({ cmd: 'undo', decisionId: r.decisionId! })).code).toBe('busy')
    if ('claims' in held) for (const c of held.claims) await c.release()
    ok(await e.run({ cmd: 'undo', decisionId: r.decisionId! }))
  })

  it('整理一个项目的索引：只动这个项目的，全局的不动', async () => {
    const e = env({ llm: modelOf([[{ op: 'assign', memoryIds: ['mem_w'], from: UNSORTED_TITLE, to: '项目约定', about: '这个项目的约定。' }]]) })
    await seed(e)
    await e.store.create(record({ id: 'mem_w', name: '分支命名', summary: '分支怎么起名', content: '分支命名的正文', scope: 'workspace', workspacePath: SESSION_WS }))
    const r = ok(await e.run({ cmd: 'organize-index', scope: { kind: 'workspace', workspacePath: SESSION_WS } }))
    expect(r.organized).toEqual({ applied: 1, skipped: 0 })
    const project = readIndex((await e.store.readIndex({ kind: 'workspace', workspacePath: SESSION_WS }))!)
    expect(project.topics.map(t => [t.name, t.memberIds])).toEqual([['项目约定', ['mem_w']]])
    expect((await e.decisions.listSettled())[0]!.workspaces).toEqual([SESSION_WS])
    expect((await e.store.readIndex(global)) === undefined || readIndex((await e.store.readIndex(global))!).topics.length === 0).toBe(true)
  })
})
