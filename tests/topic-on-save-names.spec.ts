import { describe, expect, it } from 'vitest'
import { ENTRY_TITLE, NEAREST_TOPICS_LIMIT, TOPIC_NAME_MAX, TOPIC_NAME_PROBLEMS, UNSORTED_PAGE, UNSORTED_TITLE, isTopicName, nearestTopics, orderedPages, resolveTopic, topicNameProblem, topicsNamed, type IndexFiles } from '../src/topic-index.ts'

// 保存时给的主题名能不能用、用不了时列哪几个现有主题：纯函数，不碰磁盘。

/** 入口按给的先后列主题；每页标题是主题名，曾用名一行在标题下面。 */
function index(topics: Array<{ name: string; file: string; aliases?: string[] }>): IndexFiles {
  const entry = `# ${ENTRY_TITLE}\n\n${topics.map(t => `## [${t.name}](topics/${encodeURIComponent(t.file)})\n`).join('\n')}`
  const pages: Record<string, string> = { [UNSORTED_PAGE]: `# ${UNSORTED_TITLE}\n\n` }
  for (const t of topics) pages[t.file] = `# ${t.name}\n\n${t.aliases === undefined ? '' : `曾用名：${t.aliases.join('、')}\n\n`}`
  return { entry, pages }
}

describe('主题名不能用的原因', () => {
  it('能用的名字没有原因', () => {
    for (const name of ['发版', 'Deploy notes', 'a'.repeat(TOPIC_NAME_MAX)]) expect(topicNameProblem(name)).toBeUndefined()
  })

  it('五种原因各对一种名字；同时犯几条给排在前面的那一条', () => {
    expect(topicNameProblem('')).toBe('empty')
    expect(topicNameProblem('长'.repeat(TOPIC_NAME_MAX + 1))).toBe('too-long')
    expect(topicNameProblem(UNSORTED_TITLE)).toBe('reserved')
    expect(topicNameProblem('_unsorted')).toBe('reserved')
    expect(topicNameProblem('发版、上线')).toBe('bad-char')
    expect(topicNameProblem('发版,上线')).toBe('bad-char')
    expect(topicNameProblem('发版，上线')).toBe('bad-char')
    expect(topicNameProblem('发版\n上线')).toBe('bad-char')
    expect(topicNameProblem('# 发版')).toBe('heading')
    expect(topicNameProblem(`#${'长'.repeat(TOPIC_NAME_MAX + 1)}`)).toBe('too-long')
    expect(topicNameProblem('#发版、上线')).toBe('bad-char')
  })

  it('按码点数长度：40 个 emoji 能用，41 个超长', () => {
    expect(topicNameProblem('😀'.repeat(TOPIC_NAME_MAX))).toBeUndefined()
    expect(topicNameProblem('😀'.repeat(TOPIC_NAME_MAX + 1))).toBe('too-long')
  })

  it('和 isTopicName 是同一个判定：每种原因的例子和能用的例子两边结论一致', () => {
    const samples = ['', '发版', '未整理', ' 未整理 '.trim(), 'a、b', '# x', '#x', '长'.repeat(TOPIC_NAME_MAX + 1), 'UNSORTED', '_Unsorted', '正常名字']
    expect(TOPIC_NAME_PROBLEMS).toEqual(['empty', 'too-long', 'reserved', 'bad-char', 'heading'])
    for (const name of samples) expect([name, topicNameProblem(name) === undefined]).toEqual([name, isTopicName(name)])
  })
})

describe('名字最相近的现有主题', () => {
  it('缺省取两个，按相似度降序；「未整理」不算', () => {
    const files = index([{ name: '回复语言', file: 'reply.md' }, { name: '发版流程', file: 'release.md' }, { name: '发版', file: 'r2.md' }])
    expect(NEAREST_TOPICS_LIMIT).toBe(2)
    expect(nearestTopics(files, '发版步骤')).toEqual(['发版流程', '发版'])
    expect(nearestTopics(files, UNSORTED_TITLE, 5)).not.toContain(UNSORTED_TITLE)
    expect(nearestTopics(files, UNSORTED_TITLE, 5)).toHaveLength(3)
  })

  it('曾用名也比，取主题名和各曾用名里最高的那个分', () => {
    const files = index([{ name: '上线', file: 'up.md', aliases: ['发版步骤'] }, { name: '发版流程', file: 'release.md' }, { name: '写锁', file: 'lock.md' }])
    // 「上线」靠曾用名「发版步骤」和查询完全一样，排第一
    expect(nearestTopics(files, '发版步骤')).toEqual(['上线', '发版流程'])
  })

  it('比之前去首尾空白、不分大小写', () => {
    const files = index([{ name: 'Deploy Notes', file: 'deploy.md' }, { name: 'zzzz', file: 'z.md' }, { name: 'Lock', file: 'lock.md' }])
    expect(nearestTopics(files, '  deploy notes  ', 1)).toEqual(['Deploy Notes'])
  })

  it('同分按入口里的先后', () => {
    const files = index([{ name: '乙', file: 'b.md' }, { name: '甲', file: 'a.md' }, { name: '丙', file: 'c.md' }])
    // 三个单字主题和查询都不同，分数都是 0
    expect(nearestTopics(files, '丁', 2)).toEqual(['乙', '甲'])
    expect(nearestTopics(files, '丁', 3)).toEqual(['乙', '甲', '丙'])
  })

  it('现有主题不足 limit 个就全列；一个都没有为空', () => {
    expect(nearestTopics(index([{ name: '发版', file: 'r.md' }]), '发版流程')).toEqual(['发版'])
    expect(nearestTopics(index([]), '发版')).toEqual([])
  })
})

describe('按名字认主题', () => {
  // 「发布」先是「部署」的曾用名，后来又有一个主题就叫「发布」；入口里曾用名那个排在前面
  const conflicted = () => index([{ name: '部署', file: 'deploy.md', aliases: ['发布'] }, { name: '发布', file: 'release.md' }, { name: '排查', file: 'debug.md', aliases: ['定位'] }])

  it('名字优先：一个主题的曾用名等于另一个主题的名字时，认名字那个，不管入口里谁在前', () => {
    expect(topicsNamed(orderedPages(conflicted()), '发布').map(t => t.fileName)).toEqual(['release.md'])
    expect(resolveTopic(conflicted(), '发布', 50)).toEqual({ kind: 'existing', fileName: 'release.md', name: '发布' })
  })

  it('没有名字对上的才认曾用名；都没有为空；去首尾空白、不分大小写', () => {
    const files = index([{ name: 'Deploy', file: 'deploy.md', aliases: ['Ship'] }, { name: '排查', file: 'debug.md', aliases: ['定位'] }])
    expect(topicsNamed(orderedPages(files), ' ship ').map(t => t.fileName)).toEqual(['deploy.md'])
    expect(topicsNamed(orderedPages(files), 'DEPLOY').map(t => t.fileName)).toEqual(['deploy.md'])
    expect(topicsNamed(orderedPages(files), '定位').map(t => t.fileName)).toEqual(['debug.md'])
    expect(topicsNamed(orderedPages(files), '发布')).toEqual([])
  })

  it('同一档里对上几个就按先后全回；namesOf 给的写法都算名字，压过别的主题的曾用名', () => {
    const topics = [
      { name: 'A', aliases: ['x'], label: 'a' },
      { name: 'B', aliases: [], label: 'b' },
      { name: 'x', aliases: [], label: 'c' },
      { name: 'x', aliases: [], label: 'd' },
    ]
    expect(topicsNamed(topics, 'X').map(t => t.label)).toEqual(['c', 'd'])
    expect(topicsNamed(topics, 'b-shown', t => [t.name, `${t.name.toLowerCase()}-shown`]).map(t => t.label)).toEqual(['b'])
    expect(topicsNamed(topics.slice(0, 2), 'x').map(t => t.label)).toEqual(['a'])
    expect(topicsNamed(topics.slice(0, 2), 'x', t => [t.name, 'X']).map(t => t.label)).toEqual(['a', 'b'])
  })
})
