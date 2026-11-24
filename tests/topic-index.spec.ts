import { describe, expect, it } from 'vitest'
import {
  ENTRY_TITLE, UNSORTED_PAGE, UNSORTED_TITLE, maskIndexText, memberLine, withoutMember, readIndex, reconcileIndex, renderProjection, resolveTopic, stampOf, withStamp,
  type IndexFiles, type IndexedMemory,
} from '../src/topic-index.ts'

// 主题索引的纯函数：解析、整份核对、主题名解析、MEMORY.md 投影。只吃文本和记忆清单，不碰磁盘。

const mem = (id: string, name: string, summary = `${name}的摘要`, fileName = `${name}.md`): IndexedMemory => ({ id, name, summary, fileName })
const A = mem('mem_a', '发版步骤')
const B = mem('mem_b', '回复语言')
const C = mem('mem_c', '写锁设计')

const page = (title: string, ...rest: string[]) => [`# ${title}`, '', ...rest, ''].join('\n')
const files = (entry: string, pages: Record<string, string>): IndexFiles => ({ entry, pages })

describe('成员行', () => {
  it('链接指向记忆文件，标题属性里是记忆 id，后面接摘要', () => {
    expect(memberLine(A)).toBe('- [发版步骤](../../%E5%8F%91%E7%89%88%E6%AD%A5%E9%AA%A4.md "mem_a") — 发版步骤的摘要')
  })

  it('名称里的方括号转义，名称和摘要里的换行压成空格，文件名里的括号和空格编码', () => {
    const line = memberLine(mem('mem_x', '用 [x] 标记\n完成', '第一行\n第二行', 'a (b) c.md'))
    expect(line).toBe('- [用 \\[x\\] 标记 完成](../../a%20%28b%29%20c.md "mem_x") — 第一行 第二行')
    const { files: out } = reconcileIndex(files('', { [UNSORTED_PAGE]: page(UNSORTED_TITLE, line) }), [mem('mem_x', '用 [x] 标记\n完成', '第一行\n第二行', 'a (b) c.md')])
    expect(out.pages[UNSORTED_PAGE]).toContain(line)
  })
})

describe('整份核对', () => {
  it('还没有索引：全部在用记忆进「未整理」，按名称排（按字符编码比，不随系统语言变）', () => {
    const { files: out, report } = reconcileIndex(undefined, [C, A, B])
    expect(out.entry).toBe(`# ${ENTRY_TITLE}\n`)
    expect(out.pages).toEqual({ [UNSORTED_PAGE]: page(UNSORTED_TITLE, memberLine(C), memberLine(A), memberLine(B)) })
    expect(report.added).toEqual(['mem_c', 'mem_a', 'mem_b'])
  })

  it('索引里漏掉的在用记忆补进「未整理」末尾；没有「未整理」页就建', () => {
    const before = files(`# ${ENTRY_TITLE}\n\n## 发版\n怎么发版。\n`, { '发版.md': page('发版', memberLine(A)) })
    const { files: out, report } = reconcileIndex(before, [A, B])
    expect(out.pages['发版.md']).toBe(before.pages['发版.md'])
    expect(out.pages[UNSORTED_PAGE]).toBe(page(UNSORTED_TITLE, memberLine(B)))
    expect(out.entry).toBe(before.entry)
    expect(report).toMatchObject({ added: ['mem_b'], removed: [], deduped: [] })
  })

  it('指向已不存在的记忆的行去掉；标题、说明和别的文字原样保留', () => {
    const text = ['---', 'lastWriteOp: op_1', '---', '# 发版', '', '曾用名：上线', '', '手写的一段说明。', '', memberLine(A), '中间一句话', memberLine(C), ''].join('\n')
    const { files: out, report } = reconcileIndex(files(`# ${ENTRY_TITLE}\n\n## 发版\n`, { '发版.md': text, [UNSORTED_PAGE]: page(UNSORTED_TITLE) }), [A])
    expect(out.pages['发版.md']).toBe(['---', 'lastWriteOp: op_1', '---', '# 发版', '', '曾用名：上线', '', '手写的一段说明。', '', memberLine(A), '中间一句话', ''].join('\n'))
    expect(report.removed).toEqual(['mem_c'])
  })

  it('同一条记忆出现在两个主题里：留入口里排在前面的主题那一行；同一页里重复的留第一行', () => {
    const entry = `# ${ENTRY_TITLE}\n\n## 乙\n\n## 甲\n`
    const before = files(entry, {
      '甲.md': page('甲', memberLine(A), memberLine(B), memberLine(B)),
      '乙.md': page('乙', memberLine(A)),
      [UNSORTED_PAGE]: page(UNSORTED_TITLE, memberLine(B)),
    })
    const { files: out, report } = reconcileIndex(before, [A, B])
    expect(out.pages['乙.md']).toBe(page('乙', memberLine(A)))
    expect(out.pages['甲.md']).toBe(page('甲', memberLine(B)))
    expect(out.pages[UNSORTED_PAGE]).toBe(page(UNSORTED_TITLE))
    expect(report.deduped.sort()).toEqual(['mem_a', 'mem_b', 'mem_b'])
  })

  it('记忆改了名称、摘要、文件名：行按 id 认，内容同步过来，位置和列表符号不动', () => {
    const stale = memberLine(mem('mem_a', '旧名字', '旧摘要', '旧文件.md')).replace(/^- /, '  * ')
    const { files: out, report } = reconcileIndex(files('', { '发版.md': page('发版', memberLine(B), stale) }), [A, B])
    expect(out.pages['发版.md']).toBe(page('发版', memberLine(B), memberLine(A).replace(/^- /, '  * ')))
    expect(report.synced).toEqual(['mem_a'])
  })

  it('用户手改过的顺序和主题说明留得住：没有要改的地方时逐字不变', () => {
    const entry = `# ${ENTRY_TITLE}\n\n随手写的导语。\n\n## 发版\n我改过的说明。\n\n另一段。\n`
    const before = files(entry, {
      '发版.md': page('发版', '> 备注', memberLine(C), memberLine(A)),
      [UNSORTED_PAGE]: page(UNSORTED_TITLE, memberLine(B)),
    })
    const { files: out, report } = reconcileIndex(before, [A, B, C])
    expect(out).toEqual(before)
    expect(report).toEqual({ added: [], removed: [], deduped: [], synced: [], entryAdded: [] })
  })

  it('入口缺了某个主题索引页：以页存在为准，把主题补到入口末尾；入口里没有页的标题不动', () => {
    const entry = `# ${ENTRY_TITLE}\n\n## 只在入口里\n手写的。\n`
    const { files: out, report } = reconcileIndex(files(entry, { '发版.md': page('发版', memberLine(A)) }), [A])
    expect(out.entry).toBe(`${entry}\n## [发版](topics/%E5%8F%91%E7%89%88.md)\n`)
    expect(report.entryAdded).toEqual(['发版'])
  })

  it('入口整个丢了：按现有的主题索引页补出来', () => {
    const { files: out } = reconcileIndex(files('', { 'b.md': page('乙', memberLine(B)), 'a.md': page('甲', memberLine(A)) }), [A, B])
    expect(out.entry).toBe(`# ${ENTRY_TITLE}\n\n## [甲](topics/a.md)\n\n## [乙](topics/b.md)\n`)
  })

  it('主题索引页没有标题：拿文件名当主题名', () => {
    const { files: out } = reconcileIndex(files('', { '发版.md': `${memberLine(A)}\n` }), [A])
    expect(readIndex(out).topics.map(t => t.name)).toEqual(['发版'])
    expect(out.entry).toContain('## [发版](topics/')
  })

  it('核对两遍结果相同', () => {
    const before = files('', { '发版.md': page('发版', memberLine(C), memberLine(A), memberLine(A)) })
    const once = reconcileIndex(before, [A, B]).files
    expect(reconcileIndex(once, [A, B]).files).toEqual(once)
  })
})

describe('不规整的输入', () => {
  it('记忆 id 不是 mem_ 开头、带引号和反斜杠：照样认得出，核对两遍结果相同，记忆没了行也去得掉', () => {
    const odd = mem('custom-"1"\\x', '自己起的 id')
    const first = reconcileIndex(undefined, [odd]).files
    expect(readIndex(first).unsorted).toEqual([odd.id])
    expect(reconcileIndex(first, [odd]).files).toEqual(first)
    expect(reconcileIndex(first, []).files.pages[UNSORTED_PAGE]).not.toContain('自己起的 id')
  })

  it('围栏代码块里的示例不当成员行、标题、曾用名：块外的真实行留着，块里的一字不动', () => {
    const sample = ['```md', '# 示例标题', '曾用名：假名', memberLine(A), memberLine(C), '```'].join('\n')
    const text = page('发版', sample, memberLine(A))
    const before = files(`# ${ENTRY_TITLE}\n\n\`\`\`\n## 不是主题\n\`\`\`\n\n## 发版\n`, { '发版.md': text, [UNSORTED_PAGE]: page(UNSORTED_TITLE) })
    const { files: out, report } = reconcileIndex(before, [A])
    expect(out).toEqual(before)
    expect(report).toMatchObject({ removed: [], deduped: [] })
    expect(readIndex(out).topics).toMatchObject([{ name: '发版', aliases: [], memberIds: ['mem_a'] }])
  })

  it('回车换行的页：没变的行原样留着，同步过的行保持回车换行', () => {
    const text = ['# 发版', '', memberLine(A), memberLine(mem('mem_b', '旧名')), ''].join('\r\n')
    const { files: out } = reconcileIndex(files(`# ${ENTRY_TITLE}\n\n## 发版\n`, { '发版.md': text }), [A, B])
    expect(out.pages['发版.md']).toBe(['# 发版', '', memberLine(A), memberLine(B), ''].join('\r\n'))
  })

  it('这一层有读不出来的记忆时不去掉清单里没有的行，只补和同步；重复的行照样只留一处', () => {
    const before = files(`# ${ENTRY_TITLE}\n\n## 发版\n`, { '发版.md': page('发版', memberLine(A), memberLine(C), memberLine(C)) })
    const { files: out, report } = reconcileIndex(before, [A, B], false)
    expect(out.pages['发版.md']).toBe(page('发版', memberLine(A), memberLine(C)))
    expect(report).toMatchObject({ removed: [], deduped: ['mem_c'], added: ['mem_b'] })
  })

  it('文件名里的 # 和 ? 编进链接，不被读成片段和查询', () => {
    expect(memberLine(mem('mem_x', 'n', 's', 'release#1?.md'))).toBe('- [n](../../release%231%3F.md "mem_x") — s')
  })

  it('入口标题链到主题页时按文件对页：页里的主题改了名，说明和顺序还跟着这一页', () => {
    const entry = `# ${ENTRY_TITLE}\n\n## [乙](topics/b.md)\n乙的说明。\n\n## 甲\n甲的说明。\n`
    const before = files(entry, { 'a.md': page('甲', memberLine(A)), 'b.md': page('乙改名', memberLine(B)) })
    expect(readIndex(before).topics.map(t => [t.fileName, t.name, t.about])).toEqual([['b.md', '乙改名', '乙的说明。'], ['a.md', '甲', '甲的说明。']])
    expect(reconcileIndex(before, [A, B]).files.entry).toBe(entry)
  })

  it('把一条记忆的行从各页去掉：别的行和文字不动，代码块里的示例不动', () => {
    const before = files('', { 'a.md': page('甲', '```', memberLine(A), '```', memberLine(A), memberLine(B)), 'b.md': page('乙', memberLine(C)) })
    const out = withoutMember(before, 'mem_a')
    expect(out.pages['a.md']).toBe(page('甲', '```', memberLine(A), '```', memberLine(B)))
    expect(out.pages['b.md']).toBe(before.pages['b.md'])
  })

  it('遮盖只跳过主题页里的成员行，代码块里长得像成员行的照样遮', () => {
    const mask = (text: string) => text.replaceAll('SECRET', '***')
    const text = page('SECRET 主题', '```', memberLine(mem('mem_x', 'SECRET')), '```', memberLine(mem('mem_y', 'SECRET')))
    expect(maskIndexText(text, mask)).toBe(page('*** 主题', '```', memberLine(mem('mem_x', '***', 'SECRET的摘要', 'SECRET.md')).replaceAll('SECRET', '***'), '```', memberLine(mem('mem_y', 'SECRET'))))
  })
})

describe('读索引', () => {
  it('入口里的二级标题是主题，标题下第一段是主题说明；主题页给出曾用名和成员', () => {
    const entry = `# ${ENTRY_TITLE}\n\n## 发版\n怎么发版，\n分两步。\n\n别的话。\n\n## 约定\n`
    const index = readIndex(files(entry, {
      '约定.md': page('约定', memberLine(B)),
      '发版.md': page('发版', '曾用名：上线、 Release ', memberLine(A), memberLine(C)),
      [UNSORTED_PAGE]: page(UNSORTED_TITLE),
    }))
    expect(index.topics).toEqual([
      { fileName: '发版.md', name: '发版', about: '怎么发版， 分两步。', aliases: ['上线', 'Release'], memberIds: ['mem_a', 'mem_c'] },
      { fileName: '约定.md', name: '约定', about: '', aliases: [], memberIds: ['mem_b'] },
    ])
    expect(index.unsorted).toEqual([])
  })
})

describe('主题名解析', () => {
  const index = files(`# ${ENTRY_TITLE}\n\n## 发版\n\n## 约定\n`, {
    '发版.md': page('发版', '曾用名：上线、Release'),
    '约定.md': page('约定'),
    [UNSORTED_PAGE]: page(UNSORTED_TITLE),
  })

  it('同名按去首尾空白、不分大小写判；曾用名也算', () => {
    expect(resolveTopic(index, '  发版 ', 30)).toEqual({ kind: 'existing', fileName: '发版.md', name: '发版' })
    expect(resolveTopic(index, 'release', 30)).toEqual({ kind: 'existing', fileName: '发版.md', name: '发版' })
  })

  it('两个页同名：归到文件名排在前面的那个；名字对得上的排在曾用名对得上的前面', () => {
    const twin = files(`# ${ENTRY_TITLE}\n\n## 约定\n`, { 'b.md': page('约定'), 'a.md': page('约定') })
    expect(resolveTopic(twin, '约定', 30)).toMatchObject({ kind: 'existing', fileName: 'a.md' })
    const renamed = files(`# ${ENTRY_TITLE}\n\n## 规矩\n\n## 约定\n`, { 'a.md': page('规矩', '曾用名：约定'), 'b.md': page('约定') })
    expect(resolveTopic(renamed, '约定', 30)).toMatchObject({ kind: 'existing', fileName: 'b.md' })
  })

  it('新主题：文件名取主题名的 slug', () => {
    expect(resolveTopic(index, '写锁 设计', 30)).toEqual({ kind: 'new', fileName: '写锁-设计.md', name: '写锁 设计' })
  })

  it('slug 和现有的页撞名（含只差大小写）：后建的追加主题名的哈希片段', () => {
    const taken = files('', { 'A-B.md': page('a/b') })
    const r = resolveTopic(taken, 'a b', 30)
    expect(r).toMatchObject({ kind: 'new', name: 'a b' })
    expect(r.kind === 'new' && r.fileName).toMatch(/^a-b-[0-9a-f]{6}\.md$/)
  })

  it('到主题数上限：不建，现有主题照常能归；「未整理」不占名额', () => {
    expect(resolveTopic(index, '新主题', 2)).toEqual({ kind: 'full' })
    expect(resolveTopic(index, '约定', 2)).toMatchObject({ kind: 'existing' })
    expect(resolveTopic(index, '新主题', 3)).toMatchObject({ kind: 'new' })
  })

  it('空名字、超过 40 个字符、取「未整理」的名字：不算主题', () => {
    expect(resolveTopic(index, '   ', 30)).toEqual({ kind: 'invalid' })
    expect(resolveTopic(index, '题'.repeat(41), 30)).toEqual({ kind: 'invalid' })
    expect(resolveTopic(index, '题'.repeat(40), 30)).toMatchObject({ kind: 'new' })
    expect(resolveTopic(index, UNSORTED_TITLE, 30)).toEqual({ kind: 'invalid' })
    expect(resolveTopic(index, '发版\n## 别的', 30)).toEqual({ kind: 'invalid' })
    expect(resolveTopic(index, '# 发版', 30)).toEqual({ kind: 'invalid' })
    expect(resolveTopic(index, '_unsorted', 30)).toEqual({ kind: 'invalid' })
  })
})

describe('主题页文件名', () => {
  it('追加哈希后还撞名就接着换，直到空闲', () => {
    const first = resolveTopic(files('', { 'a-b.md': page('别的') }), 'a b', 30)
    if (first.kind !== 'new') throw new Error('应当给出新页')
    expect(first.fileName).not.toBe('a-b.md')
    const second = resolveTopic(files('', { 'a-b.md': page('别的'), [first.fileName]: page('又一个') }), 'a b', 30)
    expect(second).toMatchObject({ kind: 'new' })
    expect(['a-b.md', first.fileName]).not.toContain((second as { fileName: string }).fileName)
  })

  it('写法不同的同一个字算同名文件', () => {
    const out = resolveTopic(files('', { 'caf\u00e9.md': page('别的') }), 'cafe\u0301', 30)
    expect(out).toMatchObject({ kind: 'new' })
    expect((out as { fileName: string }).fileName.normalize('NFC')).not.toBe('caf\u00e9.md')
  })

  it('到长度上限、末尾是表情的主题名：文件名编得进链接', () => {
    const out = resolveTopic(files('', {}), `${'a'.repeat(39)}😀`, 30)
    if (out.kind !== 'new') throw new Error('应当给出新页')
    expect(() => encodeURIComponent(out.fileName)).not.toThrow()
  })
})

describe('提交标记', () => {
  it('回车换行的页头认得出，换标记不叠出两个页头', () => {
    const text = '---\r\nlastWriteOp: op_1\r\n---\r\n# 发版\r\n'
    expect(stampOf(text)).toBe('op_1')
    expect(withStamp(text, 'op_2')).toBe('---\r\nlastWriteOp: op_2\r\n---\r\n# 发版\r\n')
  })

  it('写在页头，读得回来；再写是替换，正文不动', () => {
    const body = page('发版', memberLine(A))
    const once = withStamp(body, 'op_1')
    expect(stampOf(body)).toBeUndefined()
    expect(stampOf(once)).toBe('op_1')
    expect(once.endsWith(body)).toBe(true)
    const twice = withStamp(once, 'op_2')
    expect(stampOf(twice)).toBe('op_2')
    expect(twice.endsWith(body)).toBe(true)
    expect(twice.length).toBe(once.length)
  })

  it('带着页头的页照常解析和核对，页头留着', () => {
    const stamped = withStamp(page('发版', memberLine(A), memberLine(C)), 'op_9')
    const { files: out } = reconcileIndex(files('', { '发版.md': stamped }), [A])
    expect(stampOf(out.pages['发版.md']!)).toBe('op_9')
    expect(readIndex(out).topics[0]).toMatchObject({ name: '发版', memberIds: ['mem_a'] })
  })
})

describe('MEMORY.md 投影', () => {
  it('每个主题一段：主题名、说明、条数（其中久未确认几条）、链到主题索引页；「未整理」放最后；开头注明是生成的', () => {
    const index = files(`# ${ENTRY_TITLE}\n\n## 发版\n怎么发版。\n\n## 空主题\n`, {
      '发版.md': page('发版', memberLine(A), memberLine(C)),
      '空主题.md': page('空主题'),
      [UNSORTED_PAGE]: page(UNSORTED_TITLE, memberLine(B)),
    })
    const text = renderProjection(index, new Set(['mem_c']))
    expect(text).toBe([
      '<!-- 自动生成：要调整请改 _index/ 下的文件，直接改这里会被覆盖。 -->',
      '# 记忆索引',
      '',
      '## [发版](_index/topics/%E5%8F%91%E7%89%88.md)',
      '怎么发版。',
      '',
      '2 条（其中久未确认 1 条）',
      '',
      '## [空主题](_index/topics/%E7%A9%BA%E4%B8%BB%E9%A2%98.md)',
      '',
      '0 条',
      '',
      `## [${UNSORTED_TITLE}](_index/topics/_unsorted.md)`,
      '',
      '1 条',
      '',
    ].join('\n'))
  })
})
