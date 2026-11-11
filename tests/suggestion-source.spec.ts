import { describe, expect, it } from 'vitest'
import type { ReadEventFn } from '../src/tools/source.ts'
import { readSuggestionSources } from '../src/gui/suggestion-source.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 处理建议的出处回查：按冲突所属作用域决定读不读，读的是记忆自己的出处锚；宿主读事件服务是进程边界，用假的读事件函数。

const P = '/w/app'
const Q = '/w/other'

const mem = (id: string, partial: Partial<MemoryRecord> = {}) => record({
  id, scope: 'workspace', workspacePath: P, source: { sessionId: `sess-${id}`, eventRange: [10, 14], sourceMode: 'user-explicit' }, ...partial,
})

/** 宿主落盘的事件形状：用户消息、收件箱插入、助手消息、工具调用与结果、结构事件。 */
const userMessage = (seq: number, text: string, id = `u${seq}`, kind = 'user') => ({ type: 'user/message', seq, data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind } } })
const inboxSplice = (seq: number, text: string, id = `u${seq}`) => ({ type: 'agent/inbox/spliced', seq, data: { inserted: [{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] } })
const assistantMessage = (seq: number, text: string) => ({
  type: 'assistant/message', seq,
  data: { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }], source: { kind: 'model' } } },
})
const toolCall = (seq: number) => ({ type: 'tool/call', seq, data: { name: 'bash', arguments: '{"cmd":"cat .env"}' } })
const toolResult = (seq: number, text: string) => ({ type: 'tool/result', seq, data: { message: { role: 'tool', content: [{ type: 'text', text }] } } })
const turnStart = (seq: number) => ({ type: 'turn/start', seq, data: { turn: 1 } })

/** 按会话 id 给事件；不认识的会话按宿主抛「not found」。记下问过哪些。 */
function sessions(bySession: Record<string, unknown[]>) {
  const asked: Array<{ sessionId: string; seq: number; before?: number; after?: number }> = []
  const readEvent: ReadEventFn = async (request) => {
    asked.push(request)
    const events = bySession[request.sessionId]
    if (events === undefined) throw new Error(`session "${request.sessionId}" not found`)
    return { session: { id: request.sessionId, cwd: P }, events: events as never }
  }
  return { readEvent, asked }
}

describe('处理建议的出处回查', () => {
  it('只取用户和助手的文字：工具调用、工具结果、推理、结构事件、注入的上下文都不带；收件箱里排队后撤回的消息不带，认领后的那条只取一次', async () => {
    const { readEvent, asked } = sessions({
      'sess-a': [
        turnStart(10), inboxSplice(9, '这句发错了，撤回', 'u-withdrawn'), inboxSplice(11, '以后部署统一跑 deploy.sh'), userMessage(12, '以后部署统一跑 deploy.sh', 'u11'),
        userMessage(13, '<AGENTS.md 内容>', 'inj', 'agent-instructions'), toolCall(14), toolResult(15, 'SECRET_FROM_TOOL'), assistantMessage(16, '好的，记下了'),
      ],
      'sess-b': [userMessage(11, '部署用 make deploy')],
    })
    const sources = await readSuggestionSources({ workspaces: [P, P], records: [mem('a'), mem('b')] }, readEvent)
    expect(sources).toEqual([
      [{ role: 'user', text: '以后部署统一跑 deploy.sh' }, { role: 'assistant', text: '好的，记下了' }],
      [{ role: 'user', text: '部署用 make deploy' }],
    ])
    // 开窗同 memory_source：从当轮起点往后读
    expect(asked[0]).toEqual({ sessionId: 'sess-a', seq: 10, before: 2, after: 4 })
  })

  it('按疑似级遮盖密钥后再截断：截断不会把半截密钥留下', async () => {
    const long = `${'前文'.repeat(190)}token ${FAKE_SECRET.github} 和 api_key=abcdefghijklmnop1234 ${'后文'.repeat(50)}`
    const { readEvent } = sessions({ 'sess-a': [userMessage(11, long)], 'sess-b': [userMessage(11, '用 npm')] })
    const [first] = await readSuggestionSources({ workspaces: [P, P], records: [mem('a'), mem('b')] }, readEvent)
    const text = first![0]!.text
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain('abcdefghijklmnop1234')
    expect(text).toContain(SECRET_MASK)
    expect(text.length).toBeLessThanOrEqual(401)
    expect(text.endsWith('…')).toBe(true)
  })

  it('一条出处很长时整段有上限，先说的先留', async () => {
    const lines = Array.from({ length: 24 }, (_, i) => userMessage(11 + i, `第 ${i} 句：${'字'.repeat(300)}`))
    const { readEvent } = sessions({ 'sess-a': lines, 'sess-b': [userMessage(11, '用 npm')] })
    const [first] = await readSuggestionSources({ workspaces: [P, P], records: [mem('a'), mem('b')] }, readEvent)
    expect(first![0]!.text.startsWith('第 0 句')).toBe(true)
    expect(first!.length).toBeLessThan(24)
    expect(first!.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(2000)
  })

  it('项目内的冲突：本项目和全局记忆的出处都读；无关项目的记忆一律不读', async () => {
    const { readEvent, asked } = sessions({ 'sess-a': [userMessage(11, '用 pnpm')], 'sess-g': [userMessage(11, '全局：用 npm')], 'sess-q': [userMessage(11, '别的项目')] })
    const global = mem('g', { scope: 'global', workspacePath: undefined })
    const foreign = mem('q', { workspacePath: Q })
    // 全局与项目之间的冲突：两个作用域都读
    expect(await readSuggestionSources({ workspaces: [P, 'global'], records: [mem('a'), global] }, readEvent)).toEqual([
      [{ role: 'user', text: '用 pnpm' }], [{ role: 'user', text: '全局：用 npm' }],
    ])
    // 记忆此刻在一个和冲突无关的项目里：不读它的会话
    asked.length = 0
    expect(await readSuggestionSources({ workspaces: [P, P], records: [mem('a'), foreign] }, readEvent)).toEqual([[{ role: 'user', text: '用 pnpm' }], undefined])
    expect(asked.map(r => r.sessionId)).toEqual(['sess-a'])
    // 条目没记作用域（不知道冲突属于哪里）：都不读
    asked.length = 0
    expect(await readSuggestionSources({ workspaces: undefined, records: [mem('a'), global] }, readEvent)).toEqual([undefined, undefined])
    expect(asked).toEqual([])
  })

  it('读不到时那一条没有出处，不报错：没有出处锚、手改过、会话不存在、窗口里没有对话文字、宿主没有读事件服务', async () => {
    const { readEvent } = sessions({ 'sess-a': [turnStart(10), toolResult(11, '只有工具输出')], 'sess-h': [userMessage(11, '旧话')] })
    const handWritten = mem('n', { source: undefined })
    const edited = mem('h', { handEdited: true })
    const gone = mem('x')
    expect(await readSuggestionSources({ workspaces: [P, P, P, P], records: [mem('a'), handWritten, edited, gone] }, readEvent)).toEqual([undefined, undefined, undefined, undefined])
    expect(await readSuggestionSources({ workspaces: [P, P], records: [mem('a'), mem('b')] }, null)).toEqual([undefined, undefined])
  })
})
