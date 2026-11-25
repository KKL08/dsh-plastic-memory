import { describe, expect, it } from 'vitest'
import { anchorTimeMatches } from '../src/session-log.ts'
import {
  MEMORY_QUOTE_BUDGET_TOKENS, MEMORY_QUOTE_LIMIT,
  claimTurn, fillMemoryQuotes, isSameAsMemory, keywordRanker, memoryLabelOf, orderTurnsByRelevance, pickTurnMessages,
  quoteCoverage, quoteTurnKey, renderMemoryQuote, resolveAnchorTurns,
} from '../src/search/memory-quotes.ts'
import type { DialogueSegment } from '../src/search/dialogue-rank.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { DIALOGUE_QUOTE_TAG, foldToLine } from '../src/search/dialogue-format.ts'
import { record } from './helpers/record.ts'

const seg = (seq: number, speaker: string, text: string, segment = 0, turnSeq = 10, at: number | undefined = 1000 + seq): DialogueSegment =>
  ({ sessionId: 's', turnSeq, seq, segment, at, speaker, text })

describe('锚时间对不对得上', () => {
  it('落在起点事件时间和锚区间之后第一条带时间事件之间算对得上，起点没有时间算对不上', () => {
    expect(anchorTimeMatches(5, 5, 9)).toBe(true)
    expect(anchorTimeMatches(9, 5, 9)).toBe(true)
    expect(anchorTimeMatches(10, 5, undefined)).toBe(true)
    expect(anchorTimeMatches(4, 5, 9)).toBe(false)
    expect(anchorTimeMatches(10, 5, 9)).toBe(false)
    expect(anchorTimeMatches(5, undefined, 9)).toBe(false)
  })
})

describe('锚换成轮', () => {
  const turns = [{ turnSeq: 10, at: 1010 }, { turnSeq: 20, at: 1020 }, { turnSeq: 30, at: 1030 }]

  it('前台保存的锚：起点就是一轮的开始', () => {
    expect(resolveAnchorTurns({ eventRange: [20, 25], at: 1020, change: 'create' }, turns, [])).toEqual({ kind: 'turns', turnSeqs: [20], isRelocated: false })
  })

  it('回看补记的锚是消息序号、跨几轮：给覆盖到的每一轮', () => {
    expect(resolveAnchorTurns({ eventRange: [12, 31], at: 1012, change: 'create' }, turns, [{ seq: 12, at: 1012 }]))
      .toEqual({ kind: 'turns', turnSeqs: [10, 20, 30], isRelocated: false })
  })

  it('起点是 0（整会话兜底）、在第一轮之前、没有轮、区间写坏：定位不到轮', () => {
    expect(resolveAnchorTurns({ eventRange: [0, 25], at: 1000 }, turns, [])).toEqual({ kind: 'unlocated' })
    expect(resolveAnchorTurns({ eventRange: [3, 5], at: 1003 }, turns, [])).toEqual({ kind: 'unlocated' })
    expect(resolveAnchorTurns({ eventRange: [20, 25], at: 1020 }, [], [])).toEqual({ kind: 'unlocated' })
    expect(resolveAnchorTurns({ eventRange: [25, 20], at: 1020 }, turns, [])).toEqual({ kind: 'unlocated' })
    expect(resolveAnchorTurns({ eventRange: [Number.NaN, 20], at: 1020 }, turns, [])).toEqual({ kind: 'unlocated' })
    expect(resolveAnchorTurns({ eventRange: [-1, 20], at: 1020 }, turns, [])).toEqual({ kind: 'unlocated' })
  })

  it('带改动性质的锚，时间和序号对不上：按时间找回它那一轮', () => {
    // 会话被改写过：锚里的序号 20 那一轮的时间是 1020，锚时间 1031 落在第三轮
    expect(resolveAnchorTurns({ eventRange: [20, 25], at: 1031, change: 'create' }, turns, [])).toEqual({ kind: 'turns', turnSeqs: [30], isRelocated: true })
  })

  it('带改动性质的锚，时间明确对不上、按时间也找不回：定位不到，不退回旧序号', () => {
    expect(resolveAnchorTurns({ eventRange: [20, 25], at: 900, change: 'create' }, turns, [])).toEqual({ kind: 'unlocated' })
  })

  it('起点在库里拿不到时间：不算对不上，按序号定位，跨轮的锚照样跨轮', () => {
    expect(resolveAnchorTurns({ eventRange: [12, 31], at: 5000, change: 'create' }, turns, [{ seq: 12, at: undefined }]))
      .toEqual({ kind: 'turns', turnSeqs: [10, 20, 30], isRelocated: false })
  })

  it('没有改动性质的旧锚（时间是记录的更新时间）：时间对不上也不重新定位', () => {
    expect(resolveAnchorTurns({ eventRange: [20, 25], at: 1031 }, turns, [])).toEqual({ kind: 'turns', turnSeqs: [20], isRelocated: false })
  })
})

describe('一轮里挑哪几段', () => {
  it('没切的用户消息整条给；一轮多条助手正文时，在全部助手段里给最相关的一段', async () => {
    const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
    const picked = pickTurnMessages([
      seg(11, 'user', '数据库用哪个'),
      seg(12, 'assistant', '我先查一下现有配置'),
      seg(13, 'tool', 'PostgreSQL 15 已安装'),
      seg(14, 'assistant', '建议用 PostgreSQL，已经装好了'),
      seg(15, 'assistant', '还有别的要调整吗'),
    ], [keywordRanker('PostgreSQL', tokenizer)])
    expect(picked.map(m => [m.seq, m.speaker, m.text, m.segmentCount > 1])).toEqual([
      [11, 'user', '数据库用哪个', false],
      [14, 'assistant', '建议用 PostgreSQL，已经装好了', false],
    ])
  })

  it('切过的用户消息给最相关的一段，标成节选并带总段数', async () => {
    const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
    const picked = pickTurnMessages([seg(11, 'user', '第一段说背景', 0), seg(11, 'user', '第二段说写锁', 1), seg(11, 'user', '第三段收尾', 2)], [keywordRanker('写锁', tokenizer)])
    expect(picked).toEqual([{ seq: 11, segment: 1, speaker: 'user', at: 1011, text: '第二段说写锁', segmentCount: 3 }])
  })

  it('助手段一段都对不上：给最后一条助手正文的第一段', async () => {
    const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
    const picked = pickTurnMessages([
      seg(11, 'user', '好'), seg(12, 'assistant', '甲'), seg(14, 'assistant', '乙一', 0), seg(14, 'assistant', '乙二', 1),
    ], [keywordRanker('写锁', tokenizer)])
    expect(picked.at(-1)).toMatchObject({ seq: 14, text: '乙一', segmentCount: 2 })
  })

  it('打分来源可以有几个：前一个对不上时用后一个', () => {
    const none = (segments: readonly DialogueSegment[]) => segments.map(segment => ({ segment, isMatched: false }))
    const last = (segments: readonly DialogueSegment[]) => [...segments].reverse().map(segment => ({ segment, isMatched: true }))
    const picked = pickTurnMessages([seg(11, 'user', '问'), seg(12, 'assistant', '甲'), seg(13, 'assistant', '乙'), seg(14, 'assistant', '丙')], [none, last])
    expect(picked.at(-1)?.text).toBe('丙')
  })

  it('这一轮没有用户消息也没有助手正文：什么都不给', () => {
    expect(pickTurnMessages([seg(13, 'tool', 'exit 0')], [])).toEqual([])
    expect(pickTurnMessages([], [])).toEqual([])
  })

  it('跨几轮的锚：从和记忆最相关的一轮开始，对不上的按先后排在后面', async () => {
    const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
    const ordered = orderTurnsByRelevance([
      { turnSeq: 10, segments: [seg(11, 'user', '天气不错', 0, 10)] },
      { turnSeq: 20, segments: [seg(21, 'user', '随便聊聊', 0, 20)] },
      { turnSeq: 30, segments: [seg(31, 'user', '写锁要提前', 0, 30)] },
    ], [keywordRanker('写锁', tokenizer)])
    expect(ordered.map(t => t.turnSeq)).toEqual([30, 10, 20])
  })

  it('跨几轮的锚：只有工具段对上关键词的那一轮不排到前面', async () => {
    const tokenizer = await dialogueTokenizer({ log: { warn() {} } })
    const ordered = orderTurnsByRelevance([
      { turnSeq: 10, segments: [seg(11, 'user', '先看看日志', 0, 10), seg(13, 'tool', '写锁 写锁 写锁', 0, 10)] },
      { turnSeq: 20, segments: [seg(21, 'user', '写锁放在提交前', 0, 20), seg(22, 'assistant', '好', 0, 20)] },
    ], [keywordRanker('写锁', tokenizer)])
    expect(ordered.map(t => t.turnSeq)).toEqual([20, 10])
  })
})

describe('和记忆正文相同', () => {
  it('只差空白和换行算相同', () => {
    expect(isSameAsMemory('数据库统一用 PostgreSQL 15\n不用 MySQL', '数据库统一用PostgreSQL 15 不用MySQL')).toBe(true)
    expect(isSameAsMemory('ＡＢＣ', 'abc')).toBe(true)
  })

  it('差一个小数点、比较符号、「不」字或标点都不算相同；空的不算', () => {
    expect(isSameAsMemory('金额为1.5万元', '金额为15万元')).toBe(false)
    expect(isSameAsMemory('temperature < 100', 'temperature > 100')).toBe(false)
    expect(isSameAsMemory('这个接口要加缓存', '这个接口不要加缓存')).toBe(false)
    expect(isSameAsMemory('数据库用 PostgreSQL。', '数据库用 PostgreSQL')).toBe(false)
    expect(isSameAsMemory('', '')).toBe(false)
  })
})

describe('库里有没有这一轮', () => {
  it('收过且水位过了锚终点：有；水位没到、库里没有这个会话的行：还在整理', () => {
    expect(quoteCoverage({ watermark: 30, revision: 1, isRemoved: false }, { isRebuilding: false }, 25)).toBe('covered')
    expect(quoteCoverage({ watermark: 20, revision: 1, isRemoved: false }, { isRebuilding: false }, 25)).toBe('pending')
    expect(quoteCoverage(undefined, { isRebuilding: false }, 25)).toBe('pending')
    expect(quoteCoverage(undefined, { isRebuilding: true }, 25)).toBe('pending')
  })

  it('会话的行标了移出库：没有收录；库在重建时不下这个结论', () => {
    expect(quoteCoverage({ watermark: -1, revision: 2, isRemoved: true }, { isRebuilding: false }, 25)).toBe('not-collected')
    expect(quoteCoverage({ watermark: -1, revision: 2, isRemoved: true }, { isRebuilding: true }, 25)).toBe('pending')
  })
})

describe('去重与预算装填', () => {
  it('同一轮第一次出现时认领，之后指回认领它的那条记忆', () => {
    const claims = new Map<string, number>()
    expect(claimTurn(claims, quoteTurnKey('s', 10), 0)).toEqual({ kind: 'new' })
    expect(claimTurn(claims, quoteTurnKey('s', 10), 2)).toEqual({ kind: 'same', owner: 0 })
    expect(quoteTurnKey('s', 10)).not.toBe(quoteTurnKey('s1', 0))
  })

  it('暂定只给排名前 3 条带，合计 1000 token', () => {
    expect(MEMORY_QUOTE_LIMIT).toBe(3)
    expect(MEMORY_QUOTE_BUDGET_TOKENS).toBe(1000)
  })

  it('超出预算时从排名靠后的记忆开始不带', () => {
    const plan = (key: string, cost: number) => ({ turns: [{ key, cost }] })
    expect(fillMemoryQuotes([plan('a', 400), plan('b', 400), plan('c', 400)], 1000)).toEqual([
      [{ kind: 'quote', turn: 0 }], [{ kind: 'quote', turn: 0 }], [],
    ])
    // 排第二的放不下：排在它后面的就算更短也不带
    expect(fillMemoryQuotes([plan('a', 400), plan('b', 700), plan('c', 10)], 1000)).toEqual([[{ kind: 'quote', turn: 0 }], [], []])
  })

  it('一条记忆有几个锚：最新的先带，预算有余再按新到旧加，放不下的跳过', () => {
    const items = fillMemoryQuotes([
      { turns: [{ key: 'new', cost: 300 }, { key: 'mid', cost: 800 }, { key: 'old', cost: 200 }] },
      { turns: [{ key: 'b', cost: 300 }] },
    ], 1000)
    expect(items).toEqual([[{ kind: 'quote', turn: 0 }, { kind: 'quote', turn: 2 }], [{ kind: 'quote', turn: 0 }]])
  })

  it('几条记忆锚着同一轮：原话附在排名最靠前的那条下面，其余指过去、不占预算', () => {
    const items = fillMemoryQuotes([{ turns: [{ key: 'x', cost: 900 }] }, { turns: [{ key: 'x', cost: 900 }] }, { turns: [{ key: 'y', cost: 100 }] }], 1000)
    expect(items).toEqual([[{ kind: 'quote', turn: 0 }], [{ kind: 'same-source', owner: 0 }], [{ kind: 'quote', turn: 0 }]])
  })

  it('已经带上原话的记忆：其余锚的那一轮被别的记忆附过就跳过，不写出处同', () => {
    expect(fillMemoryQuotes([{ turns: [{ key: 'A', cost: 100 }, { key: 'B', cost: 100 }] }, { turns: [{ key: 'B', cost: 100 }] }], 1000))
      .toEqual([[{ kind: 'quote', turn: 0 }], [{ kind: 'quote', turn: 0 }]])
    expect(fillMemoryQuotes([{ turns: [{ key: 'A', cost: 100 }] }, { turns: [{ key: 'A', cost: 100 }, { key: 'B', cost: 100 }] }], 1000))
      .toEqual([[{ kind: 'quote', turn: 0 }], [{ kind: 'quote', turn: 1 }]])
  })

  it('一条原话都没带上的记忆才写出处同，只指向排在它前面的记忆', () => {
    expect(fillMemoryQuotes([
      { turns: [{ key: 'A', cost: 100 }, { key: 'B', cost: 100 }] },
      { turns: [{ key: 'B', cost: 100 }, { key: 'A', cost: 100 }] },
    ], 1000)).toEqual([[{ kind: 'quote', turn: 0 }], [{ kind: 'quote', turn: 0 }]])
    expect(fillMemoryQuotes([
      { turns: [{ key: 'A', cost: 100 }] },
      { turns: [{ key: 'B', cost: 100 }] },
      { turns: [{ key: 'A', cost: 100 }, { key: 'B', cost: 100 }] },
    ], 1000)).toEqual([[{ kind: 'quote', turn: 0 }], [{ kind: 'quote', turn: 0 }], [{ kind: 'same-source', owner: 0 }, { kind: 'same-source', owner: 1 }]])
  })
})

describe('记忆名称和渲染', () => {
  it('名称折成一行；名称里有密钥只写 id', () => {
    expect(foldToLine('# 标题\n```\n代码\n```')).toBe('# 标题 ``` 代码 ```')
    expect(memoryLabelOf(record({ id: 'mem_a', name: '数据库\n## 选型' }))).toBe('数据库 ## 选型')
    expect(memoryLabelOf(record({ id: 'mem_k', name: 'key sk-abcdefghijklmnopqrstuvwx1234' }))).toBe('mem_k')
  })

  it('本项目会话：整条给的带引用，节选带节选说明；别的项目会话：不带引用，节选说明指向传记忆 id 回查', () => {
    const messages = [
      { seq: 11, segment: 0, speaker: 'user' as const, at: undefined, text: '问', segmentCount: 1, isSameAsMemory: false },
      { seq: 12, segment: 1, speaker: 'assistant' as const, at: undefined, text: '答二', segmentCount: 3, isSameAsMemory: false },
    ]
    const local = renderMemoryQuote({ memoryId: 'mem_a', turns: [{ sessionId: 's', isInProject: true, messages }], sameSource: [] })!
    expect(local).toContain(`<${DIALOGUE_QUOTE_TAG}>`)
    expect(local).toContain('用户：问〔引用 s#11〕')
    expect(local).toContain('助手：答二（节选，这条消息共 3 段，可用 memory_source 带上引用 s#12 看更多内容）')
    const foreign = renderMemoryQuote({ memoryId: 'mem_a', turns: [{ sessionId: 's', isInProject: false, messages }], sameSource: [] })!
    expect(foreign).toContain('用户：问\n')
    expect(foreign).not.toContain('s#')
    expect(foreign).toContain('助手：答二（节选，这条消息共 3 段，可用 memory_source 传记忆 id mem_a 回查）')
  })

  it('原话和记忆正文相同：只给日期和位置', () => {
    const text = renderMemoryQuote({ memoryId: 'mem_a', sameSource: [], turns: [{ sessionId: 's', isInProject: true, messages: [
      { seq: 11, segment: 0, speaker: 'user', at: new Date(2026, 10, 24, 9, 5).getTime(), text: '记住数据库用 PostgreSQL', segmentCount: 1, isSameAsMemory: true },
    ] }] })!
    expect(text).toContain('[2026-11-24 09:05] 用户：（和记忆正文相同，从略）〔引用 s#11〕')
    expect(text).not.toContain('记住数据库用 PostgreSQL')
  })

  it('只有说明、没有原话时不出标签；什么都没有时不出东西', () => {
    expect(renderMemoryQuote({ memoryId: 'mem_a', turns: [], sameSource: ['数据库'], status: undefined })).toBe('出处同「数据库」')
    expect(renderMemoryQuote({ memoryId: 'mem_a', turns: [], sameSource: [], status: '出处的会话已不在' })).toBe('出处原话：出处的会话已不在')
    expect(renderMemoryQuote({ memoryId: 'mem_a', turns: [], sameSource: [] })).toBeUndefined()
  })
})
