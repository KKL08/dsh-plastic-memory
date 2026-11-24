import { describe, expect, it } from 'vitest'
import {
  anchorFactsOf, evidenceOf, excludesPluginEvidence, initiatorOf, isOwnEvent, isRealUserMessage, messageText, relocateByTime,
  turnOf, turnOpenerOf, type RawEvent, type SessionLog,
} from '../src/session-log.ts'

// 事件形状对齐宿主落盘的样子：user/message 的 data 就是消息本身（带 source），助手正文在 data.message.content，
// 工具结果在 data.message.content，工具调用的名字和参数在 tool/call 上。

let clock = 1_000
const at = (seq: number, type: string, data: unknown = {}): RawEvent => ({ seq, type, time: clock + seq * 10, data })
const text = (t: string) => [{ type: 'text', text: t }]
const userMsg = (seq: number, t: string, source: Record<string, unknown> = { kind: 'user' }) =>
  at(seq, 'user/message', { id: `m${seq}`, role: 'user', content: text(t), source })
const assistantMsg = (seq: number, blocks: unknown[]) =>
  at(seq, 'assistant/message', { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content: blocks, source: { kind: 'model' } }, stream: [] })
const toolCall = (seq: number, callId: string, name: string, args: unknown) =>
  at(seq, 'tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
const toolResult = (seq: number, callId: string, t: string, isError = false) =>
  at(seq, 'tool/result', { turn: 1, step: 1, message: { id: `t${seq}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: text(t), ...(isError ? { isError } : {}) } })

/** 第三个参数不给是普通会话（前缀长度 0）；显式给 undefined 是宿主给不出边界。 */
const log = (events: RawEvent[], header: SessionLog['header'] = { isSeeded: false }, ...count: [number | undefined] | []): SessionLog =>
  ({ header, inheritedEventCount: count.length === 0 ? 0 : count[0], events })

describe('isOwnEvent：事件是不是这个会话自己的', () => {
  it('普通会话：全是自己的', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '你好')])
    expect(l.events.map(e => isOwnEvent(l, e))).toEqual([true, true])
  })

  it('fork 子会话：继承前缀（含复制过来的父会话 turn/start）判成继承，分界标记和之后的是自己的', () => {
    const parent = [at(0, 'turn/start'), userMsg(1, '父会话的话'), at(2, 'turn/end')]
    const l = log([...parent, at(3, 'session/end-seed', { inherited: true }), at(4, 'turn/start'), userMsg(5, '子会话自己的话')], { isSeeded: true }, 3)
    expect(l.events.map(e => isOwnEvent(l, e))).toEqual([false, false, false, true, true, true])
  })

  it('seeded 会话拿不到边界：分不清，返回 unknown', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '不知道是谁的')], { isSeeded: true }, undefined)
    expect(l.events.map(e => isOwnEvent(l, e))).toEqual(['unknown', 'unknown'])
  })

  it('header 没说是不是 seeded、也没有边界：同样分不清', () => {
    const l = log([userMsg(0, '无从判断')], {}, undefined)
    expect(isOwnEvent(l, l.events[0]!)).toBe('unknown')
  })
})

describe('turnOpenerOf：当轮起点那条消息', () => {
  it('跳过当轮先注入的上下文（插件快照、时间、指令文件），取第一条真正开这一轮的消息', () => {
    const l = log([
      at(0, 'turn/start'), at(1, 'step/start'), at(2, 'system/message'),
      userMsg(3, '记忆快照', { kind: 'plastic-memory', form: 'snapshot', sections: [] }),
      userMsg(4, '现在是周一', { kind: 'time-context' }),
      userMsg(5, '以后测试别 mock 数据库'),
      userMsg(6, '运行环境', { kind: 'runtime-context' }),
    ])
    expect(turnOpenerOf(l, 0)?.seq).toBe(5)
  })

  it('定时任务开的一轮：起点是定时任务那条，之后同一轮里用户插话也不改变起点', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '每日巡检', { kind: 'schedule' }), at(2, 'step/end'), userMsg(3, '用户插话')])
    expect(turnOpenerOf(l, 0)?.seq).toBe(1)
  })

  it('锚起点不是 turn/start（读不到轮边界、退回整会话）：按日志里不晚于保存点的最后一个 turn/start 找', () => {
    const l = log([at(0, 'agent/inbox/spliced'), at(1, 'turn/start'), userMsg(2, '第一轮', { kind: 'schedule' }), at(3, 'turn/end'), at(4, 'turn/start'), userMsg(5, '第二轮')])
    expect(turnOpenerOf(l, 0, 5)?.seq).toBe(5)
  })

  it('日志里一个 turn/start 都没有：找不到起点', () => {
    const l = log([userMsg(0, '直接落进来的用户消息')])
    expect(turnOpenerOf(l, 0)).toBeUndefined()
    expect(turnOpenerOf(l, undefined, 0)).toBeUndefined()
  })

  it('轮起点不知道时按保存点找当轮：首轮用户开、当前轮定时任务开，判定时任务；两轮对调判用户', () => {
    const userFirst = log([at(0, 'turn/start'), userMsg(1, '记一下'), at(2, 'turn/end'), at(3, 'turn/start'), userMsg(4, '巡检', { kind: 'schedule' })])
    expect(turnOpenerOf(userFirst, undefined, 4)?.seq).toBe(4)
    expect(anchorFactsOf(userFirst, { turnStartSeq: undefined, lastSeq: 4 }, () => false).isUserInitiated).toBe(false)
    const scheduleFirst = log([at(0, 'turn/start'), userMsg(1, '巡检', { kind: 'schedule' }), at(2, 'turn/end'), at(3, 'turn/start'), userMsg(4, '记一下')])
    expect(anchorFactsOf(scheduleFirst, { turnStartSeq: undefined, lastSeq: 4 }, () => false).isUserInitiated).toBe(true)
  })

  it('给了轮起点但它不是 turn/start：同样按保存点找当轮', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '巡检', { kind: 'schedule' }), at(2, 'turn/end'), at(3, 'turn/start'), userMsg(4, '记一下')])
    expect(turnOpenerOf(l, 2, 4)?.seq).toBe(4)
  })

  it('这一轮只有注入的上下文：没有起点', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '快照', { kind: 'plastic-memory', form: 'snapshot', sections: [] }), at(2, 'step/end')])
    expect(turnOpenerOf(l, 0)).toBeUndefined()
  })
})

describe('turnOpenerOf：按宿主收件队列认当轮起点', () => {
  // 宿主的顺序：空闲时排进来的通知进 next-step、用户发的消息进 next-turn；开一轮时先写 turn/start，
  // 再取走整个 next-step、从 next-turn 取走一条，取出的这批按这个顺序成为第一步的 user/message。
  const message = (id: string, t: string, kind: string) => ({ id, role: 'user', content: text(t), source: { kind } })
  const queued = (seq: number, m: ReturnType<typeof message>) => at(seq, 'user/message', m)
  type Splice = { target: string; start: number; removedCount?: number; inserted: unknown[]; outcome?: string }
  const spliced = (seq: number, data: Splice) => at(seq, 'agent/inbox/spliced', data)

  const approval = message('n1', '审批模式切换为自动', 'user-approval')
  const cwdChanged = message('n2', '工作目录改成 /proj/b', 'working-directory')
  const scheduleChanged = message('n3', '定时任务已更新', 'schedule')
  const notices = [approval, cwdChanged, scheduleChanged]

  /** 三条通知排在 opener 前面：插入、开轮、取走、第一步按取出顺序落成 user/message。 */
  const turnWithNotices = (opener: ReturnType<typeof message>) => log([
    spliced(0, { target: 'next-step', start: 0, inserted: [approval] }),
    spliced(1, { target: 'next-step', start: 1, inserted: [cwdChanged] }),
    spliced(2, { target: 'next-step', start: 2, inserted: [scheduleChanged] }),
    spliced(3, { target: 'next-turn', start: 0, inserted: [opener] }),
    at(4, 'turn/start', { turn: 1 }),
    spliced(5, { target: 'next-step', start: 0, removedCount: 3, inserted: [] }),
    spliced(6, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    at(7, 'step/start'), at(8, 'system/message'),
    ...notices.map((n, i) => queued(9 + i, n)),
    queued(12, opener),
    userMsg(13, '运行环境', { kind: 'runtime-context' }),
  ])

  it('通知（审批模式、工作目录、定时任务变更）排在用户消息前：起点是用户那条，判成用户发起', () => {
    const l = turnWithNotices(message('u1', '以后部署走 deploy.sh', 'user'))
    expect(turnOpenerOf(l, 4)?.seq).toBe(12)
    expect(anchorFactsOf(l, { turnStartSeq: 4, lastSeq: 13 }, () => false)).toMatchObject({ initiator: 'user', isUserInitiated: true })
  })

  it('定时任务自己开的轮：next-turn 取走的是定时任务那条，仍判非用户', () => {
    const l = turnWithNotices(message('s1', '每日巡检', 'schedule'))
    expect(turnOpenerOf(l, 4)?.seq).toBe(12)
    expect(anchorFactsOf(l, { turnStartSeq: 4, lastSeq: 13 }, () => false)).toMatchObject({ initiator: 'schedule', isUserInitiated: false })
  })

  it('被取消的排队消息不算取走：起点是真正取走的那条', () => {
    const dropped = message('s0', '巡检', 'schedule')
    const user = message('u1', '记一下', 'user')
    const l = log([
      spliced(0, { target: 'next-turn', start: 0, inserted: [dropped, user] }),
      spliced(1, { target: 'next-step', start: 0, inserted: [approval] }),
      at(2, 'turn/start', { turn: 1 }),
      spliced(3, { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
      spliced(4, { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      spliced(5, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      at(6, 'step/start'), queued(7, approval), queued(8, user),
    ])
    expect(turnOpenerOf(l, 2)?.seq).toBe(8)
  })

  it('这一轮是被 next-step 的投递叫醒的（没从 next-turn 取走消息）：起点按第一步里第一条不是上下文的认', () => {
    const l = log([
      spliced(0, { target: 'next-step', start: 0, inserted: [approval] }),
      at(1, 'turn/start', { turn: 1 }),
      spliced(2, { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      at(3, 'step/start'), queued(4, approval),
    ])
    expect(turnOpenerOf(l, 1)?.seq).toBe(4)
    expect(anchorFactsOf(l, { turnStartSeq: 1, lastSeq: 4 }, () => false).isUserInitiated).toBe(false)
  })

  it('日志里没有收件队列记录（旧形状）：起点按第一步里第一条不是上下文的认', () => {
    const l = log([at(0, 'turn/start'), at(1, 'step/start'), ...notices.map((n, i) => queued(2 + i, n)), queued(5, message('u1', '记一下', 'user'))])
    expect(turnOpenerOf(l, 0)?.seq).toBe(2)
  })

  it.each([
    ['取走的位置越界', { target: 'next-turn', start: 5, removedCount: 1, inserted: [] }],
    ['队列名不认识', { target: 'later', start: 0, removedCount: 1, inserted: [] }],
    ['插入的不是数组', { target: 'next-turn', start: 0, inserted: 'u1' }],
  ])('收件队列记录形状不对（%s）：不抛错，起点按旧规则认', (_label, bad) => {
    const user = message('u1', '记一下', 'user')
    const l = log([
      spliced(0, { target: 'next-turn', start: 0, inserted: [user] }),
      spliced(1, { target: 'next-step', start: 0, inserted: [approval] }),
      at(2, 'turn/start', { turn: 1 }),
      at(3, 'agent/inbox/spliced', bad),
      at(4, 'step/start'), queued(5, approval), queued(6, user),
    ])
    expect(turnOpenerOf(l, 2)?.seq).toBe(5)
  })

  it('取走的那条对不回第一步里的消息：起点按旧规则认', () => {
    const l = log([
      spliced(0, { target: 'next-turn', start: 0, inserted: [message('gone', '改写掉了', 'user')] }),
      at(1, 'turn/start', { turn: 1 }),
      spliced(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      at(3, 'step/start'), queued(4, approval), queued(5, message('u2', '记一下', 'user')),
    ])
    expect(turnOpenerOf(l, 1)?.seq).toBe(4)
  })
})

describe('initiatorOf 与 isRealUserMessage：是不是用户本人', () => {
  const plain = (opener: RawEvent) => log([at(0, 'turn/start'), opener])

  it('用户本人发的消息（含界面重试）是 user', () => {
    expect(initiatorOf(plain(userMsg(1, '记一下')), userMsg(1, '记一下'))).toBe('user')
    const retry = userMsg(1, '', { kind: 'retry', rpcId: 'r1' })
    expect(initiatorOf(plain(retry), retry)).toBe('user')
  })

  it.each([
    ['定时任务', { kind: 'schedule' }],
    ['别的 agent', { kind: 'agent-message', senderSessionId: 's2', form: 'relay' }],
    ['团队成员', { kind: 'team-message' }],
    ['目标轮次', { kind: 'goal' }],
    ['插件投递', { kind: 'plastic-memory', form: 'notice', summary: '交给对话处理' }],
  ])('%s开的一轮是 non-user', (_label, source) => {
    const opener = userMsg(1, '任务', source)
    expect(initiatorOf(plain(opener), opener)).toBe('non-user')
  })

  it('给不出发起方（没有起点、来源缺失、不是用户消息）按 non-user', () => {
    const l = plain(at(1, 'step/start'))
    expect(initiatorOf(l, undefined)).toBe('non-user')
    expect(initiatorOf(l, at(1, 'user/message', { role: 'user', content: text('没有来源') }))).toBe('non-user')
    expect(initiatorOf(l, at(1, 'step/start'))).toBe('non-user')
  })

  it('子 agent 会话：委派来的首条任务消息宿主也标成 user，按 non-user 算', () => {
    const task = userMsg(1, '去查一下 CI 为什么挂')
    const l = log([at(0, 'turn/start'), task], { isSeeded: false, delegationDepth: 1, origin: 'subagent' })
    expect(initiatorOf(l, task)).toBe('non-user')
    expect(isRealUserMessage(l, task)).toBe(false)
  })

  it('子 agent fork：委派任务按会话自己的第一条认，继承来的父会话用户消息不占这个位置', () => {
    const inherited = userMsg(1, '父会话里用户说的')
    const task = userMsg(4, '委派的任务')
    const later = userMsg(6, '之后又来一条')
    const l = log([at(0, 'turn/start'), inherited, at(2, 'turn/end'), at(3, 'session/end-seed', { inherited: true }), task, at(5, 'turn/start'), later],
      { isSeeded: true, delegationDepth: 1, origin: 'subagent' }, 3)
    expect(isRealUserMessage(l, task)).toBe(false)
    expect(isRealUserMessage(l, later)).toBe(true)
  })

  it('继承来的消息不是这个会话的用户开的：判成 non-user', () => {
    const inherited = userMsg(1, '父会话里用户说的')
    const l = log([at(0, 'turn/start'), inherited, at(2, 'session/end-seed', { inherited: true })], { isSeeded: true }, 2)
    expect(initiatorOf(l, inherited)).toBe('non-user')
  })

  it.each([
    ['普通 seeded 会话', { isSeeded: true }],
    ['委派的 seeded 会话', { isSeeded: true, delegationDepth: 1, origin: 'subagent' }],
  ])('%s拿不到继承边界：起点归属不明，不算用户本人；锚范围里的消息和工具结果都不算证据', (_label, header) => {
    const msg = userMsg(1, '分不清是谁的')
    const l = log([at(0, 'turn/start'), msg, toolCall(2, 'c1', 'shell', { command: 'pnpm build' }), toolResult(3, 'c1', '构建通过')], header, undefined)
    expect(initiatorOf(l, msg)).toBe('non-user')
    expect(evidenceOf(l, [0, 3], () => false)).toEqual({ user: false, tool: false })
    expect(anchorFactsOf(l, { turnStartSeq: 0, lastSeq: 3 }, () => false)).toMatchObject({ initiator: 'user', isUserInitiated: false })
  })

  it('空内容的用户消息不算用户本人说过话', () => {
    const empty = userMsg(1, '   ')
    expect(isRealUserMessage(plain(empty), empty)).toBe(false)
    const said = userMsg(1, '说了话')
    expect(isRealUserMessage(plain(said), said)).toBe(true)
  })
})

describe('messageText：取消息文本', () => {
  it('用户消息、助手正文（data.message.content）、工具结果都取得出', () => {
    expect(messageText(userMsg(1, '用户原话'))).toEqual({ role: 'user', text: '用户原话' })
    expect(messageText(assistantMsg(2, [{ type: 'reasoning', text: '想一想' }, ...text('助手的回答')]))).toEqual({ role: 'assistant', text: '助手的回答' })
    expect(messageText(toolResult(3, 'c1', '读到 package.json'))).toEqual({ role: 'tool', text: '读到 package.json' })
  })

  it('不是用户本人开的消息，角色写来源', () => {
    expect(messageText(userMsg(1, '每日巡检', { kind: 'schedule' }))).toEqual({ role: 'schedule', text: '每日巡检' })
  })

  it('推理块、宿主注入的上下文、结构事件返回 null', () => {
    expect(messageText(assistantMsg(2, [{ type: 'reasoning', text: '只有推理' }]))).toBeNull()
    expect(messageText(userMsg(1, '现在是周一', { kind: 'time-context' }))).toBeNull()
    expect(messageText(userMsg(1, '运行环境', { kind: 'runtime-context' }))).toBeNull()
    expect(messageText(userMsg(1, '钩子输出', { kind: 'hooks-example' }))).toBeNull()
    expect(messageText(userMsg(1, '快照', { kind: 'plastic-memory', form: 'snapshot', sections: [] }))).toBeNull()
    expect(messageText(userMsg(1, '指令文件', { kind: 'agent-instructions', form: 'instructions' }))).toBeNull()
    expect(messageText(at(1, 'turn/start', { turn: 1 }))).toBeNull()
    expect(messageText(at(1, 'agent/inbox/spliced', { inserted: [{ role: 'user', content: text('排队中的消息') }] }))).toBeNull()
  })
})

describe('turnOf 与 relocateByTime', () => {
  it('turnOf：落在哪一轮（按 turn/start 序号的下标），在第一轮之前或没有轮时定位不到', () => {
    expect(turnOf(5, [0, 4, 9])).toBe(1)
    expect(turnOf(9, [0, 4, 9])).toBe(2)
    expect(turnOf(0, [0, 4, 9])).toBe(0)
    expect(turnOf(2, [3, 7])).toBeNull()
    expect(turnOf(2, [])).toBeNull()
  })

  it('relocateByTime：按锚时间找回那一轮的起点；时间早于所有轮、或日志为空时找不到', () => {
    clock = 1_000
    const events = [at(0, 'turn/start'), userMsg(1, 'a'), at(2, 'turn/end'), at(3, 'turn/start'), userMsg(4, 'b')]
    expect(relocateByTime({ at: events[3]!.time! }, events)).toBe(3)
    expect(relocateByTime({ at: events[4]!.time! + 5 }, events)).toBe(3)
    expect(relocateByTime({ at: events[1]!.time! }, events)).toBe(0)
    expect(relocateByTime({ at: events[0]!.time! - 1 }, events)).toBeNull()
    expect(relocateByTime({ at: 5_000 }, [])).toBeNull()
  })
})

describe('evidenceOf：锚范围里的证据类别', () => {
  const exclude = excludesPluginEvidence({ toolNames: ['memory_save', 'memory_search'], memoryRoot: '/home/u/.dsh/memories', homeDir: '/home/u' })

  it('有用户本人的消息算 user；有别的工具结果算 tool', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '看下 vitest 版本'), toolCall(2, 'c1', 'read_file', { path: '/proj/package.json' }), toolResult(3, 'c1', 'vitest 3.2.7')])
    expect(evidenceOf(l, [0, 3], exclude)).toEqual({ user: true, tool: true })
  })

  it('本插件工具的结果、读记忆根下文件的结果不算工具证据', () => {
    const l = log([
      at(0, 'turn/start'), userMsg(1, '每日巡检', { kind: 'schedule' }),
      toolCall(2, 'c1', 'memory_search', { query: '部署' }), toolResult(3, 'c1', '命中 3 条'),
      toolCall(4, 'c2', 'read_file', { path: '/home/u/.dsh/memories/global/部署.md' }), toolResult(5, 'c2', '部署用 deploy.sh'),
      toolCall(6, 'c3', 'shell', { command: 'cat ~/.dsh/memories/proj/a.md' }), toolResult(7, 'c3', '正文'),
    ])
    expect(evidenceOf(l, [0, 7], exclude)).toEqual({ user: false, tool: false })
  })

  it('记忆根的同名前缀目录照常算；失败的工具调用不算', () => {
    const l = log([
      at(0, 'turn/start'),
      toolCall(1, 'c1', 'read_file', { path: '/home/u/.dsh/memories-backup/x.md' }), toolResult(2, 'c1', '备份'),
      toolCall(3, 'c2', 'shell', { command: 'pnpm test' }), toolResult(4, 'c2', '失败', true),
    ])
    expect(evidenceOf(l, [0, 4], exclude)).toEqual({ user: false, tool: true })
    expect(evidenceOf(l, [3, 4], exclude)).toEqual({ user: false, tool: false })
  })

  it('工具结果配它之前最近的同 id 调用：范围之后同 id 的调用改不了范围内结果的归类', () => {
    const l = log([toolCall(0, 'c', 'memory_search', { query: '部署' }), toolResult(1, 'c', '命中 3 条'), toolCall(2, 'c', 'read', { path: '/proj/a.md' })])
    expect(evidenceOf(l, [0, 1], exclude)).toEqual({ user: false, tool: false })
  })

  it('同一个 id 前后两次调用：各自的结果配各自的调用', () => {
    const l = log([
      toolCall(0, 'c', 'read', { path: '/proj/a.md' }), toolResult(1, 'c', '正文'),
      toolCall(2, 'c', 'memory_search', { query: '部署' }), toolResult(3, 'c', '命中 3 条'),
    ])
    expect(evidenceOf(l, [2, 3], exclude)).toEqual({ user: false, tool: false })
    expect(evidenceOf(l, [0, 3], exclude)).toEqual({ user: false, tool: true })
  })

  it('范围之外的消息和继承来的事件不算', () => {
    const l = log([userMsg(0, '父会话的话'), at(1, 'session/end-seed', { inherited: true }), at(2, 'turn/start'), userMsg(3, '轮外'), at(4, 'turn/start')],
      { isSeeded: true }, 1)
    expect(evidenceOf(l, [0, 2], exclude)).toEqual({ user: false, tool: false })
    expect(evidenceOf(l, [4, 4], exclude)).toEqual({ user: false, tool: false })
  })
})

describe('excludesPluginEvidence：认出记忆根目录的各种写法', () => {
  const isExcluded = excludesPluginEvidence({ toolNames: ['memory_save'], memoryRoot: '/home/u/.dsh/memories', homeDir: '/home/u' })
  /** 参数按宿主落盘的样子：模型给的 JSON 字符串。 */
  const viaArgs = (args: object) => isExcluded({ name: 'tool', arguments: JSON.stringify(args) })
  const viaRaw = (raw: string) => isExcluded({ name: 'tool', arguments: raw })

  it.each([
    ['绝对路径', { path: '/home/u/.dsh/memories/a.md' }],
    ['路径里夹着 /./', { path: '/home/u/.dsh/./memories/./a.md' }],
    ['~ 写法', { command: 'cat ~/.dsh/memories/a.md' }],
    ['$HOME 写法', { command: 'cat $HOME/.dsh/memories/a.md' }],
    ['${HOME} 写法', { command: 'cat ${HOME}/.dsh/memories/a.md' }],
    ['根目录后面紧跟分号', { command: 'ls /home/u/.dsh/memories;echo done' }],
    ['根目录后面紧跟管道', { command: 'ls /home/u/.dsh/memories|head' }],
    ['根目录后面紧跟 &&', { command: 'cd /home/u/.dsh/memories&&ls' }],
    ['根目录后面紧跟右括号', { command: '(ls /home/u/.dsh/memories)' }],
    ['根目录在参数末尾', { path: '/home/u/.dsh/memories' }],
    ['家目录下的相对写法（前面是空白）', { command: 'cd ~ && cat .dsh/memories/a.md' }],
    ['家目录下的相对写法（前面是引号）', { path: '.dsh/memories/a.md' }],
    ['家目录下的相对写法（前面是 =）', { command: 'grep -r 部署 --include=*.md --dir=.dsh/memories' }],
    ['家目录下的相对写法（在命令的第二行行首）', { command: 'cd ~\n.dsh/memories/run.sh' }],
    ['别的目录下同名的 .dsh/memories（不区分，同样排除）', { path: '/other/.dsh/memories/a.md' }],
  ])('%s：排除', (_label, args) => {
    expect(viaArgs(args)).toBe(true)
  })

  it('参数里的斜杠被转义成 \\/：排除', () => {
    expect(viaRaw('{"path":"\\/home\\/u\\/.dsh\\/memories\\/a.md"}')).toBe(true)
  })

  it('参数原文就是根目录、后面没有别的字符：排除', () => {
    expect(viaRaw('/home/u/.dsh/memories')).toBe(true)
  })

  it.each([
    ['同名前缀的备份目录', { path: '/home/u/.dsh/memories-backup/a.md' }],
    ['后缀是点的同名文件', { path: '/home/u/.dsh/memories.old' }],
    ['后缀是下划线的同名目录', { path: '/home/u/.dsh/memories_v2/a.md' }],
    ['相对写法前面连着别的字符', { path: 'my.dsh/memories/a.md' }],
  ])('%s：照常算证据', (_label, args) => {
    expect(viaArgs(args)).toBe(false)
  })
})

describe('anchorFactsOf：保存时记进锚的事实', () => {
  const exclude = excludesPluginEvidence({ toolNames: ['memory_save'], memoryRoot: '/m' })

  it('读得到日志：发起方取当轮起点的来源标记，带证据类别和起点事件时间', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '记一下'), at(2, 'step/start')])
    expect(anchorFactsOf(l, { turnStartSeq: 0, lastSeq: 2 }, exclude)).toEqual({
      initiator: 'user', isUserInitiated: true, evidence: { user: true, tool: false }, startTime: l.events[0]!.time,
    })
    const scheduled = log([at(0, 'turn/start'), userMsg(1, '巡检', { kind: 'schedule' })])
    expect(anchorFactsOf(scheduled, { turnStartSeq: 0, lastSeq: 1 }, exclude)).toMatchObject({ initiator: 'schedule', isUserInitiated: false })
  })

  it('读不到日志：宿主给不出发起方，按非用户发起，不带发起方和证据类别', () => {
    expect(anchorFactsOf(null, { turnStartSeq: 0, lastSeq: 3 }, exclude)).toEqual({ isUserInitiated: false })
  })

  it('子 agent 的委派任务：来源标记照原样记，发起方判成非用户', () => {
    const l = log([at(0, 'turn/start'), userMsg(1, '委派的任务')], { isSeeded: false, delegationDepth: 1 })
    expect(anchorFactsOf(l, { turnStartSeq: 0, lastSeq: 1 }, exclude)).toMatchObject({ initiator: 'user', isUserInitiated: false, evidence: { user: false } })
  })
})
