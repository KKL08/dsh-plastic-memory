import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage, type Message, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.ts'
import { CHANGE_NOTICE_HEADING, SNAPSHOT_SOURCE_KIND, changeNoticeMessageBody, snapshotTextOf } from '../src/snapshot-message.ts'
import { fakeExec } from './helpers/exec.ts'
import { readUserTurn, USER_TURN_BOUNDARY } from './helpers/session-log.ts'

// 发送点接线：经 apply() 注册的真实监听和写入工具走一遍，宿主对象只按最小结构伪造（进程边界）。
// 别的会话经写入工具改了本会话注入过的记忆，本会话下一个发送点在快照之后补一条变化通知；本会话自己改的不补。

type ToolDef = { name: string; execute(args: unknown, exec: ToolRunContext): Promise<unknown> }
type Decision = { kind: 'enter'; messages: UserMessage[] }

const tmpDirs: string[] = []
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-notice-wiring-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function boot() {
  const defs = new Map<string, ToolDef>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const llm = {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '{"findings":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const sessionQuery = { readEvent: async () => ({ events: [], startSeq: 0, endSeq: 0 }), readSession: readUserTurn }
  const turnProjection = { stateOf: (_s: object, key: string) => (key === 'turnBoundary' ? USER_TURN_BOUNDARY : undefined) }
  const ctx = {
    tools: { register: (def: ToolDef) => { defs.set(def.name, def); return () => { defs.delete(def.name) } } },
    on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
    get: (name: string) => (name === 'llm' ? llm : name === 'sessionQuery' ? sessionQuery : name === 'sessionProjections' ? turnProjection : undefined),
    inject: () => () => {},
    effect: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const memoryRoot = await makeTmp()
  const cwd = await makeTmp()
  await apply(ctx as never, new Config({ memoryRoot } as never))

  /** 以某个会话的名义调写入工具（宿主执行上下文里带着会话头）。 */
  const save = (sessionId: string, args: object) => defs.get('memory_save')!.execute(args, fakeExec({
    agent: { session: { header: { id: sessionId, cwd }, seq: 3, requestHeader: () => undefined }, options: { provider: 'p', model: 'm' } } as unknown as ToolRunContext['agent'],
  })) as Promise<{ kind: string; record: { id: string } }>
  /** 本会话：宿主真会话，第 1 步的系统提示词已写入。 */
  const main = Session.create('sess-main' as SessionId, [], { version: SESSION_FORMAT_VERSION, id: 'sess-main' as SessionId, createdAt: 0, isSeeded: false, cwd })
  main.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
  /** 宿主走一步：pre-step 交出 decision，宿主按序写入 decision 的消息。 */
  const step = async (n: number, messages: UserMessage[] = []) => {
    const decision = await listeners.get('agent/pre-step')!(
      { agent: { session: main }, messages, turn: 1, step: n, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages }),
    ) as Decision
    for (const m of decision.messages) main.append('user/message', m, { surfaceOp: 'append' })
    return decision
  }
  /** 一次请求失败，里层监听决定重试。 */
  const retry = () => listeners.get('agent/request-error')!({
    agent: { session: main }, turn: 1, step: 2, provider: 'deepseek', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'overflow' },
    retryPolicy: undefined, signal: new AbortController().signal,
  }, async () => ({ kind: 'retry' }))
  const compacted = () => listeners.get('session/event')!(main, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'cmp', turn: 1 } })
  const messages = () => main.deriveMessages()
  return { save, step, retry, compacted, messages }
}

const create = (name: string, summary: string, content: string) => ({
  action: 'create', name, summary, content, type: 'preference', scope: 'workspace', sourceMode: 'user-explicit', tags: [], force: true,
})
const update = (id: string, name: string, summary: string, content: string) => ({
  action: 'update', change: 'correct', id, name, summary, content, type: 'preference', scope: 'workspace', sourceMode: 'user-explicit', tags: [], force: true,
})

/** 消息里给模型看的部分和来源（宿主另加的 id、role 不比）。 */
const shapeOf = (m: Pick<Message, 'content' | 'source'>) => ({ content: m.content, source: m.source })
const expectedNotice = (lines: string[], summary: string) =>
  changeNoticeMessageBody({ text: [CHANGE_NOTICE_HEADING, ...lines].join('\n'), summary })
const isSnapshot = (m: Message) => snapshotTextOf(m) !== undefined

describe('发送点补发变化通知', () => {
  it('别的会话改了本会话注入过的记忆：下一步在快照之后追加一条通知，之后不再重复；本会话自己改的不补', async () => {
    const t = await boot()
    const saved = await t.save('sess-other', create('提交规范', '提交前跑测试', '提交前先跑全套测试'))
    expect(saved.kind).toBe('saved')
    const id = saved.record.id
    await t.step(2)
    expect(t.messages().filter(isSnapshot)).toHaveLength(1)
    const afterFreeze = t.messages().length

    expect((await t.save('sess-main', update(id, '提交规范', '本会话改的摘要', '本会话改的正文'))).kind).toBe('updated')
    await t.step(3)
    expect(t.messages()).toHaveLength(afterFreeze)

    expect((await t.save('sess-other', update(id, '提交规范', '别的会话改的摘要', '别的会话改的正文'))).kind).toBe('updated')
    const expected = shapeOf(expectedNotice([`- [${id}] 提交规范（别的会话改的摘要）`], '1 条记忆有变化'))
    await t.step(4)
    const all = t.messages()
    expect(all).toHaveLength(afterFreeze + 1)
    expect(all.filter(isSnapshot)).toHaveLength(1)
    const notice = all.at(-1)!
    expect(shapeOf(notice)).toEqual(expected)
    const summary = (notice.source as { summary: string }).summary
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary).not.toContain('提交规范')

    await t.step(5)
    expect(t.messages()).toHaveLength(afterFreeze + 1)
  })

  it('decision 带着消息：通知排在 decision 的消息之前', async () => {
    const t = await boot()
    const id = (await t.save('sess-other', create('发版流程', '先打 tag', '发版先打 tag 再推'))).record.id
    await t.step(2)
    await t.save('sess-other', update(id, '发版流程', '先推再打 tag', '先推再打 tag'))
    const expected = shapeOf(expectedNotice([`- [${id}] 发版流程（先推再打 tag）`], '1 条记忆有变化'))
    const hello = createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } })
    const decision = await t.step(3, [hello])
    expect(decision.messages).toHaveLength(2)
    expect(shapeOf(decision.messages[0]!)).toEqual(expected)
    expect(decision.messages[1]).toBe(hello)
  })

  it('溢出恢复的重试同样补发通知', async () => {
    const t = await boot()
    const id = (await t.save('sess-other', create('代码风格', '两格缩进', '统一两格缩进'))).record.id
    await t.step(2)
    const before = t.messages().length
    await t.save('sess-other', update(id, '代码风格', '四格缩进', '统一四格缩进'))
    const expected = shapeOf(expectedNotice([`- [${id}] 代码风格（四格缩进）`], '1 条记忆有变化'))
    await t.retry()
    expect(t.messages()).toHaveLength(before + 1)
    expect(shapeOf(t.messages().at(-1)!)).toEqual(expected)
  })

  it('压缩之后重新冻结：补发的是新快照，不为压缩前的改动发通知；之后别处再改照常通知', async () => {
    const t = await boot()
    const id = (await t.save('sess-other', create('部署', '走流水线', '部署走流水线'))).record.id
    await t.step(2)
    await t.save('sess-other', update(id, '部署', '走手动脚本', '部署改走手动脚本'))
    await t.compacted()
    const before = t.messages().length
    await t.step(3)
    const sent = t.messages().slice(before)
    expect(sent).toHaveLength(1)
    expect(snapshotTextOf(sent[0]!)).toContain('部署改走手动脚本')
    await t.save('sess-other', update(id, '部署', '又改回流水线', '部署又改回流水线'))
    await t.step(4)
    expect(shapeOf(t.messages().at(-1)!)).toEqual(shapeOf(expectedNotice([`- [${id}] 部署（又改回流水线）`], '1 条记忆有变化')))
    expect(t.messages().at(-1)!.source.kind).toBe(SNAPSHOT_SOURCE_KIND)
  })
})
