import { describe, expect, it } from 'vitest'
import { ENTRY_TITLE, UNSORTED_PAGE, UNSORTED_TITLE, memberLine, withCreatedAt, type IndexFiles } from '../src/topic-index.ts'
import {
  SINGLE_MEMBER_CANDIDATE_MS, buildOrganizePrompt, organizeBatches, organizeDirectory, organizeGroups, parseOrganizeOutput, type OrganizeMember,
} from '../src/governance/index-organize.ts'

// 整理索引给模型的输入和对输出的解析：纯函数，只吃文本。

const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const DAY = 86_400_000
const member = (id: string, name: string, updatedAt = NOW - DAY): OrganizeMember => ({ id, name, summary: `${name}的摘要`, updatedAt })
const line = (m: OrganizeMember) => memberLine({ id: m.id, name: m.name, summary: m.summary, fileName: `${m.name}.md` })
const page = (title: string, ...rest: string[]) => [`# ${title}`, '', ...rest, ''].join('\n')

const A = member('mem_a', '发版步骤')
const B = member('mem_b', '打 tag')
const C = member('mem_c', '回复语言')
const D = member('mem_d', '写锁设计')
const ALL = new Map([A, B, C, D].map(m => [m.id, m]))

/** 发版（A、B，建了 40 天）、约定（C，建了 40 天）、「未整理」（D）。 */
const files = (): IndexFiles => ({
  entry: [`# ${ENTRY_TITLE}`, '', '## 发版', '', '怎么发版。', '', '## 约定', '', '协作上的约定。', ''].join('\n'),
  pages: {
    '发版.md': withCreatedAt(page('发版', line(A), line(B)), NOW - 40 * DAY),
    '约定.md': withCreatedAt(page('约定', '曾用名：规矩', '', line(C)), NOW - 40 * DAY),
    [UNSORTED_PAGE]: page(UNSORTED_TITLE, line(D)),
  },
})

describe('主题目录', () => {
  it('按当前顺序列出主题：说明、曾用名、成员数、几条成员名称', () => {
    expect(organizeDirectory(files(), ALL, NOW)).toEqual([
      { name: '发版', about: '怎么发版。', memberCount: 2, sample: ['发版步骤', '打 tag'] },
      { name: '约定', about: '协作上的约定。', aliases: ['规矩'], memberCount: 1, sample: ['回复语言'], isMergeCandidate: true },
    ])
  })

  it('只有一条成员的主题建满 30 天才标成合并候选；页上没记建页时刻的不标', () => {
    const young = files()
    young.pages['约定.md'] = withCreatedAt(page('约定', line(C)), NOW - SINGLE_MEMBER_CANDIDATE_MS + 1)
    expect(organizeDirectory(young, ALL, NOW)[1]).not.toHaveProperty('isMergeCandidate')
    const exact = files()
    exact.pages['约定.md'] = withCreatedAt(page('约定', line(C)), NOW - SINGLE_MEMBER_CANDIDATE_MS)
    expect(organizeDirectory(exact, ALL, NOW)[1]).toMatchObject({ isMergeCandidate: true })
    const unstamped = files()
    unstamped.pages['约定.md'] = page('约定', line(C))
    expect(organizeDirectory(unstamped, ALL, NOW)[1]).not.toHaveProperty('isMergeCandidate')
  })

  it('成员名称里的疑似密钥在给模型之前遮掉', () => {
    const secret = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(5)
    const leaky = new Map(ALL).set('mem_a', { ...A, name: `部署 key ${secret}`, summary: `用 ${secret} 部署` })
    const prompt = buildOrganizePrompt(organizeDirectory(files(), leaky, NOW), organizeGroups(files(), leaky), 30)
    expect(prompt.user).not.toContain(secret)
  })
})

describe('成员分组和分批', () => {
  it('「未整理」在前，再按主题顺序；每条带 id、名称、摘要、最近更新的日期', () => {
    const groups = organizeGroups(files(), ALL)
    expect(groups.map(g => [g.topic, g.members.map(m => m.id)])).toEqual([[UNSORTED_TITLE, ['mem_d']], ['发版', ['mem_a', 'mem_b']], ['约定', ['mem_c']]])
    expect(groups[1]!.members[0]).toEqual({ id: 'mem_a', name: '发版步骤', summary: '发版步骤的摘要', updatedAt: '2026-05-31' })
  })

  it('只留指定的成员；一条都不剩的组不出现；成员表里没有的（不在用了）不算', () => {
    expect(organizeGroups(files(), ALL, new Set(['mem_b'])).map(g => [g.topic, g.members.map(m => m.id)])).toEqual([['发版', ['mem_b']]])
    const gone = new Map(ALL)
    gone.delete('mem_d')
    expect(organizeGroups(files(), gone).map(g => g.topic)).toEqual(['发版', '约定'])
  })

  it('一批装到文字量上限为止，装不下另起一批；每条记忆恰好在一批里', () => {
    expect(organizeBatches(files(), ALL)).toEqual([['mem_d', 'mem_a', 'mem_b', 'mem_c']])
    const small = organizeBatches(files(), ALL, 1)
    expect(small).toEqual([['mem_d'], ['mem_a'], ['mem_b'], ['mem_c']])
  })
})

describe('提示词', () => {
  it('主题数上限写进提示词；用户消息是主题目录和这一批的成员两段', () => {
    const prompt = buildOrganizePrompt(organizeDirectory(files(), ALL, NOW), [], 12)
    expect(prompt.system).toContain('保持在 12 个以内')
    expect(prompt.system).not.toContain('{maxTopics}')
    expect(prompt.user).toMatch(/^## 主题目录\n\[.*\]\n\n## 这一批的成员\n\[\]$/s)
  })
})

describe('解析模型的输出', () => {
  const known = new Set(ALL.keys())
  const out = (operations: unknown[]) => JSON.stringify({ operations })

  it('六种操作都认；说明留空的当没给', () => {
    expect(parseOrganizeOutput(out([
      { op: 'assign', memoryIds: ['mem_d'], from: UNSORTED_TITLE, to: '并发', about: '写锁和并发写入。' },
      { op: 'assign', memoryIds: ['mem_b'], from: '发版', to: '约定', about: ' ' },
      { op: 'rename', topic: '发版', name: '发布流程' },
      { op: 'merge', from: ['约定'], into: '发版', about: null },
      { op: 'describe', topic: '发版', about: '发版、打 tag。' },
      { op: 'order-topics', order: ['约定', '发版'] },
      { op: 'order-members', topic: '发版', order: ['mem_b', 'mem_a'] },
    ]), known)).toEqual({
      dropped: 0,
      ops: [
        { kind: 'assign', memoryIds: ['mem_d'], from: UNSORTED_TITLE, to: '并发', about: '写锁和并发写入。' },
        { kind: 'assign', memoryIds: ['mem_b'], from: '发版', to: '约定' },
        { kind: 'rename', topic: '发版', name: '发布流程' },
        { kind: 'merge', from: ['约定'], into: '发版' },
        { kind: 'describe', topic: '发版', about: '发版、打 tag。' },
        { kind: 'order-topics', order: ['约定', '发版'] },
        { kind: 'order-members', topic: '发版', order: ['mem_b', 'mem_a'] },
      ],
    })
  })

  it('不合格式的操作只丢那一个，其余照收；不认识的记忆 id 去掉，一条都不剩的操作丢掉', () => {
    const r = parseOrganizeOutput(out([
      { op: 'delete', memoryIds: ['mem_a'] },
      { op: 'rename', topic: '', name: '新名' },
      { op: 'assign', memoryIds: ['mem_x', 'mem_d', 'mem_d'], from: UNSORTED_TITLE, to: '约定' },
      { op: 'assign', memoryIds: ['mem_x'], from: UNSORTED_TITLE, to: '约定' },
      { op: 'order-members', topic: '发版', order: ['mem_x'] },
      '不是对象',
    ]), known)
    expect(r).toEqual({ dropped: 5, ops: [{ kind: 'assign', memoryIds: ['mem_d'], from: UNSORTED_TITLE, to: '约定' }] })
  })

  it('JSON 外面包了代码围栏和说明文字也读得出；空的操作表是合格的输出', () => {
    expect(parseOrganizeOutput('好的，结果如下：\n```json\n{"operations":[]}\n```', known)).toEqual({ ops: [], dropped: 0 })
  })

  it('整体不是要求的 JSON：返回空，由调用方重试', () => {
    for (const raw of ['', '没有要改的', '{"operations": "none"}', '{"ops":[]}', '{"operations":[']) expect(parseOrganizeOutput(raw, known)).toBeUndefined()
  })
})
