import { describe, expect, it } from 'vitest'
import {
  ENTRY_TITLE, UNSORTED_PAGE, UNSORTED_TITLE, createdAtOf, memberLine, readIndex, reconcileIndex, resolveTopic, stampOf, withStamp,
  type IndexFiles, type IndexedMemory,
} from '../src/topic-index.ts'
import { applyPlan, planIndexOp, targetOf, undoPlan, type IndexOp, type IndexPlan, type PlanContext } from '../src/topic-ops.ts'

// 索引操作的纯函数：定计划、套计划（可重复）、撤销（按效果判）。只吃文本，不碰磁盘。

const mem = (id: string, name: string): IndexedMemory => ({ id, name, summary: `${name}的摘要`, fileName: `${name}.md` })
const A = mem('mem_a', '发版步骤')
const B = mem('mem_b', '回复语言')
const C = mem('mem_c', '写锁设计')
const D = mem('mem_d', '打 tag 的时机')
const ALL = [A, B, C, D]

const page = (title: string, ...rest: string[]) => [`# ${title}`, '', ...rest, ''].join('\n')
const NOW = Date.parse('2026-01-02T03:04:05.000Z')
const ctx = (extra: Partial<PlanContext> = {}): PlanContext => ({ maxTopics: 30, activeIds: new Set(ALL.map(m => m.id)), now: NOW, ...extra })

/** 两个主题加「未整理」：发版（A、D）、约定（B），C 还没归。入口里发版是纯名字标题，约定是链接标题。 */
const base = (): IndexFiles => ({
  entry: [`# ${ENTRY_TITLE}`, '', '手写的开场白。', '', '## 发版', '', '怎么发版。', '', '发版一节里手写的备注。', '', '## [约定](topics/约定.md)', '', '协作上的约定。', ''].join('\n'),
  pages: {
    '发版.md': page('发版', '页里手写的一句话。', '', memberLine(A), memberLine(D)),
    '约定.md': page('约定', memberLine(B)),
    [UNSORTED_PAGE]: page(UNSORTED_TITLE, memberLine(C)),
  },
})

const planned = (files: IndexFiles, op: IndexOp, c = ctx()): IndexPlan => {
  const r = planIndexOp(files, op, c)
  if (r.kind !== 'planned') throw new Error(`预期能定出计划，实际跳过：${r.reason}`)
  return r.plan
}
const skippedReason = (files: IndexFiles, op: IndexOp, c = ctx()) => {
  const r = planIndexOp(files, op, c)
  return r.kind === 'skipped' ? r.reason : undefined
}
const members = (files: IndexFiles) => Object.fromEntries([...readIndex(files).topics.map(t => [t.name, t.memberIds] as const), [UNSORTED_TITLE, readIndex(files).unsorted]])
const undone = (files: IndexFiles, plan: IndexPlan) => {
  const r = undoPlan(files, plan)
  if (r.kind !== 'undone') throw new Error(`预期能撤，实际：${r.reason}`)
  return r
}
/** 套完之后整份核对一遍不该再有改动：操作留下的索引本身就是对的。 */
const expectSettled = (files: IndexFiles) => expect(reconcileIndex(files, ALL).files).toEqual(files)

describe('归主题', () => {
  it('从「未整理」归到现有主题：行原样搬到目标页最前，源页不留', () => {
    const plan = planned(base(), { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定' })
    expect(plan).toMatchObject({ kind: 'assign', page: '约定.md', isNew: false, moved: [{ id: 'mem_c', from: UNSORTED_PAGE, at: 0 }] })
    expect(targetOf(plan)).toBe('约定.md')
    const { files, deleted } = applyPlan(base(), plan)
    expect(deleted).toEqual([])
    expect(files.pages['约定.md']).toBe(page('约定', memberLine(C), memberLine(B)))
    expect(files.pages[UNSORTED_PAGE]).toBe(page(UNSORTED_TITLE))
    expect(files.entry).toBe(base().entry)
    expectSettled(files)
  })

  it('归到还没有的主题：建页（页头记下建页时刻）、入口末尾加一节带说明；这就是拆分的做法', () => {
    const plan = planned(base(), { kind: 'assign', memoryIds: ['mem_d'], from: '发版', to: '打 tag', about: '什么时候打 tag。' })
    expect(plan).toMatchObject({ page: '打-tag.md', isNew: true, about: '什么时候打 tag。', createdAt: NOW })
    const { files } = applyPlan(base(), plan)
    expect(createdAtOf(files.pages['打-tag.md']!)).toBe(NOW)
    expect(members(files)).toEqual({ 发版: ['mem_a'], 约定: ['mem_b'], '打 tag': ['mem_d'], [UNSORTED_TITLE]: ['mem_c'] })
    expect(files.entry.endsWith('协作上的约定。\n\n## [打 tag](topics/%E6%89%93-tag.md)\n\n什么时候打 tag。\n')).toBe(true)
    expect(readIndex(files).topics.at(-1)).toMatchObject({ name: '打 tag', about: '什么时候打 tag。' })
    expect(files.pages['发版.md']).toBe(page('发版', '页里手写的一句话。', '', memberLine(A)))
    expectSettled(files)
  })

  it('按曾用名也找得到主题；记忆已经不在说的那个主题里、已经不在用、主题不在了、名字不能用、到上限都跳过', () => {
    const files = base()
    files.pages['约定.md'] = page('约定', '曾用名：规矩', memberLine(B))
    expect(planned(files, { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '规矩' })).toMatchObject({ page: '约定.md', name: '约定' })
    expect(skippedReason(base(), { kind: 'assign', memoryIds: ['mem_c'], from: '发版', to: '约定' })).toContain('已经不在')
    expect(skippedReason(base(), { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定' }, ctx({ activeIds: new Set() }))).toContain('已经不在')
    expect(skippedReason(base(), { kind: 'assign', memoryIds: ['mem_a'], from: '没有的主题', to: '约定' })).toContain('不在了')
    expect(skippedReason(base(), { kind: 'assign', memoryIds: ['mem_a'], from: '发版', to: '甲、乙' })).toContain('不能当主题名')
    expect(skippedReason(base(), { kind: 'assign', memoryIds: ['mem_a'], from: '发版', to: '新主题' }, ctx({ maxTopics: 2 }))).toContain('上限')
    expect(skippedReason(base(), { kind: 'assign', memoryIds: ['mem_a'], from: '发版', to: '发版' })).toBeDefined()
  })

  it('只搬了一部分：定计划之后有一条被别处挪走了，套的时候只搬还在的', () => {
    const plan = planned(base(), { kind: 'assign', memoryIds: ['mem_a', 'mem_d'], from: '发版', to: '约定' })
    const later = base()
    later.pages['发版.md'] = page('发版', memberLine(A))
    later.pages[UNSORTED_PAGE] = page(UNSORTED_TITLE, memberLine(C), memberLine(D))
    const { files } = applyPlan(later, plan)
    // D 现在在「未整理」里：计划认的是「把它归到约定」，照样搬过去
    expect(members(files)).toEqual({ 发版: [], 约定: ['mem_a', 'mem_d', 'mem_b'], [UNSORTED_TITLE]: ['mem_c'] })
  })

  it('撤销：还在目标页的搬回原页原位置；新建的主题搬空了连页带入口那一节一起去掉', () => {
    const toExisting = planned(base(), { kind: 'assign', memoryIds: ['mem_a'], from: '发版', to: '约定' })
    expect(undone(applyPlan(base(), toExisting).files, toExisting).files).toEqual(base())
    const toNew = planned(base(), { kind: 'assign', memoryIds: ['mem_d'], from: '发版', to: '打 tag', about: '什么时候打 tag。' })
    const back = undone(applyPlan(base(), toNew).files, toNew)
    expect(back.deleted).toEqual(['打-tag.md'])
    expect(back.files.pages).toEqual(base().pages)
    expect(readIndex(back.files).topics.map(t => t.name)).toEqual(['发版', '约定'])
  })

  it('撤销时期间进来的行留着；搬过去的记忆后来都不在目标页了就撤不了', () => {
    const plan = planned(base(), { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定' })
    const applied = applyPlan(base(), plan).files
    const withNew = { ...applied, pages: { ...applied.pages, '约定.md': page('约定', memberLine(mem('mem_n', '新来的')), memberLine(C), memberLine(B)) } }
    expect(readIndex(undone(withNew, plan).files).topics.find(t => t.name === '约定')!.memberIds).toEqual(['mem_n', 'mem_b'])
    const movedAway = { ...applied, pages: { ...applied.pages, '约定.md': page('约定', memberLine(B)), '发版.md': page('发版', memberLine(A), memberLine(D), memberLine(C)) } }
    expect(undoPlan(movedAway, plan)).toMatchObject({ kind: 'stale' })
  })

  it('新主题的说明以标题记号或代码围栏开头：主题照建，说明空着，入口里后面的主题不受影响', () => {
    for (const about of ['```js 里面', '## [别的](topics/x.md)', '~~~']) {
      const plan = planned(base(), { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '锁', about })
      expect(plan).toMatchObject({ isNew: true, about: '' })
      const { files } = applyPlan(base(), plan)
      expect(readIndex(files).topics.map(t => [t.name, t.about])).toEqual([['发版', '怎么发版。'], ['约定', '协作上的约定。'], ['锁', '']])
      expectSettled(files)
    }
  })

  it('目标页里只有一个没收尾的代码块：行放进去不算成员，这个操作不做；代码块之前有成员的页照常做', () => {
    const files = base()
    files.pages['约定.md'] = page('约定', memberLine(B), '```', '没收尾的代码块')
    expect(members(applyPlan(files, planned(files, { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定' })).files)['约定']).toEqual(['mem_c', 'mem_b'])
    files.pages['约定.md'] = page('约定', '```', '没收尾的代码块')
    expect(skippedReason(files, { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定' }, ctx({ activeIds: new Set(['mem_a', 'mem_c', 'mem_d']) }))).toContain('代码块')
    expect(skippedReason(files, { kind: 'merge', from: ['发版'], into: '约定' }, ctx({ activeIds: new Set(['mem_a', 'mem_c', 'mem_d']) }))).toContain('代码块')
  })

  it('撤销新建的主题时，页里或入口那一节后来多了手写的文字：成员搬回去，页和那一节留着', () => {
    const plan = planned(base(), { kind: 'assign', memoryIds: ['mem_d'], from: '发版', to: '打 tag', about: '什么时候打 tag。' })
    const applied = applyPlan(base(), plan).files
    const noted = { ...applied, pages: { ...applied.pages, '打-tag.md': applied.pages['打-tag.md']!.replace(memberLine(D), `后来手写的笔记。\n${memberLine(D)}`) } }
    const kept = undone(noted, plan)
    expect(kept.deleted).toEqual([])
    expect(kept.files.pages['打-tag.md']).toContain('后来手写的笔记。')
    expect(members(kept.files)).toMatchObject({ 发版: ['mem_a', 'mem_d'], '打 tag': [] })
    const described = { ...applied, entry: applied.entry.replace('什么时候打 tag。', '手改过的说明。') }
    const keptSection = undone(described, plan)
    expect(keptSection.deleted).toEqual([])
    expect(readIndex(keptSection.files).topics.at(-1)).toMatchObject({ name: '打 tag', about: '手改过的说明。', memberIds: [] })
  })
})

describe('改名', () => {
  it('页标题换成新名，旧名进曾用名和主题说明，入口标题改成链到页的写法；文件名不变', () => {
    const plan = planned(base(), { kind: 'rename', topic: '发版', name: '发布流程' })
    expect(targetOf(plan)).toBe('发版.md')
    const { files } = applyPlan(base(), plan)
    expect(files.pages['发版.md']).toBe(['# 发布流程', '', '曾用名：发版', '', '页里手写的一句话。', '', memberLine(A), memberLine(D), ''].join('\n'))
    expect(files.entry).toContain('## [发布流程](topics/%E5%8F%91%E7%89%88.md)\n\n怎么发版。（曾用名：发版）\n\n发版一节里手写的备注。\n')
    expect(readIndex(files).topics[0]).toMatchObject({ fileName: '发版.md', name: '发布流程', aliases: ['发版'], about: '怎么发版。（曾用名：发版）' })
    // 开头冻结着旧主题名的会话：用旧名照样解析到这个主题
    expect(resolveTopic(files, '发版', 30)).toEqual({ kind: 'existing', fileName: '发版.md', name: '发布流程' })
    expectSettled(files)
  })

  it('撞上别的主题的名字或曾用名、名字不能用、没变都跳过；改回自己的曾用名可以', () => {
    expect(skippedReason(base(), { kind: 'rename', topic: '发版', name: '约定' })).toContain('已经有主题')
    expect(skippedReason(base(), { kind: 'rename', topic: '发版', name: '# 发版' })).toContain('不能当主题名')
    expect(skippedReason(base(), { kind: 'rename', topic: '发版', name: ' 发版 ' })).toBeDefined()
    const renamed = applyPlan(base(), planned(base(), { kind: 'rename', topic: '发版', name: '发布流程' })).files
    const back = applyPlan(renamed, planned(renamed, { kind: 'rename', topic: '发布流程', name: '发版' })).files
    expect(readIndex(back).topics[0]).toMatchObject({ name: '发版', aliases: ['发布流程'] })
  })

  it('撤销：名字、曾用名、说明改回去；后来又改过名就撤不了，后来改过的说明留着', () => {
    const plan = planned(base(), { kind: 'rename', topic: '发版', name: '发布流程' })
    const applied = applyPlan(base(), plan).files
    const back = undone(applied, plan).files
    expect(back.pages).toEqual(base().pages)
    expect(readIndex(back).topics[0]).toMatchObject({ name: '发版', about: '怎么发版。', aliases: [] })
    const again = applyPlan(applied, planned(applied, { kind: 'rename', topic: '发布流程', name: '上线' })).files
    expect(undoPlan(again, plan)).toMatchObject({ kind: 'stale' })
    const edited = { ...applied, entry: applied.entry.replace('怎么发版。（曾用名：发版）', '手改过的说明。') }
    expect(readIndex(undone(edited, plan).files).topics[0]).toMatchObject({ name: '发版', about: '手改过的说明。' })
  })

  it('改回自己的曾用名再撤销：那个曾用名回来', () => {
    const renamed = applyPlan(base(), planned(base(), { kind: 'rename', topic: '发版', name: '发布流程' })).files
    const plan = planned(renamed, { kind: 'rename', topic: '发布流程', name: '发版' })
    const back = undone(applyPlan(renamed, plan).files, plan).files
    expect(readIndex(back).topics[0]).toMatchObject({ name: '发布流程', aliases: ['发版'] })
    expect(back.pages).toEqual(renamed.pages)
  })

  it('旧名自己带全角括号：说明末尾那句曾用名照样认得出，再改名接着往里记', () => {
    const files = base()
    files.pages['发版.md'] = page('发版（旧）', memberLine(A), memberLine(D))
    files.entry = files.entry.replace('## 发版', '## [发版（旧）](topics/%E5%8F%91%E7%89%88.md)')
    const once = applyPlan(files, planned(files, { kind: 'rename', topic: '发版（旧）', name: '发布' })).files
    expect(readIndex(once).topics[0]!.about).toBe('怎么发版。（曾用名：发版（旧））')
    const twice = applyPlan(once, planned(once, { kind: 'rename', topic: '发布', name: '上线' })).files
    expect(readIndex(twice).topics[0]!.about).toBe('怎么发版。（曾用名：发版（旧）、发布）')
  })
})

describe('合并', () => {
  const merge: IndexOp = { kind: 'merge', from: ['约定'], into: '发版', about: '发版和协作约定。' }

  it('成员接到存活主题后面，被并的页和它在入口里的一节删掉，旧名进曾用名和说明', () => {
    const plan = planned(base(), merge)
    expect(targetOf(plan)).toBe('发版.md')
    const { files, deleted } = applyPlan(base(), plan)
    expect(deleted).toEqual(['约定.md'])
    expect(Object.keys(files.pages).sort()).toEqual([UNSORTED_PAGE, '发版.md'].sort())
    expect(readIndex(files).topics).toEqual([{ fileName: '发版.md', name: '发版', about: '发版和协作约定。（曾用名：约定）', aliases: ['约定'], memberIds: ['mem_a', 'mem_d', 'mem_b'] }])
    expect(files.entry).not.toContain('协作上的约定')
    expect(resolveTopic(files, '约定', 30)).toMatchObject({ kind: 'existing', fileName: '发版.md' })
    expectSettled(files)
  })

  it('被并的主题自己的曾用名也带过来；没给新说明就在原说明后面记旧名', () => {
    const files = base()
    files.pages['约定.md'] = page('约定', '曾用名：规矩', memberLine(B))
    const applied = applyPlan(files, planned(files, { kind: 'merge', from: ['约定'], into: '发版' })).files
    expect(readIndex(applied).topics[0]).toMatchObject({ aliases: ['约定', '规矩'], about: '怎么发版。（曾用名：约定）' })
  })

  it('被并的页里期间又归进来一条：那一条留在原处，页不删', () => {
    const plan = planned(base(), merge)
    const later = base()
    later.pages['约定.md'] = page('约定', memberLine(B), memberLine(C))
    later.pages[UNSORTED_PAGE] = page(UNSORTED_TITLE)
    const { files, deleted } = applyPlan(later, plan)
    expect(deleted).toEqual([])
    expect(members(files)).toMatchObject({ 发版: ['mem_a', 'mem_d', 'mem_b'], 约定: ['mem_c'] })
  })

  it('要并的主题都不在了、并进自己：跳过', () => {
    expect(skippedReason(base(), { kind: 'merge', from: ['没有的'], into: '发版' })).toBeDefined()
    expect(skippedReason(base(), { kind: 'merge', from: ['发版'], into: '发版' })).toBeDefined()
    expect(skippedReason(base(), { kind: 'merge', from: ['约定'], into: '没有的' })).toContain('不在了')
  })

  it('撤销：被并的页连手写的文字一起回来，入口那一节回到原位置，成员、曾用名、说明都回去', () => {
    const plan = planned(base(), merge)
    const back = undone(applyPlan(base(), plan).files, plan)
    expect(back.files.pages).toEqual(base().pages)
    expect(readIndex(back.files)).toEqual(readIndex(base()))
    expect(back.files.entry).toContain('## [约定](topics/约定.md)\n\n协作上的约定。\n')
  })

  it('撤销时合并后新归进来的记忆留在存活主题；并过来的记忆后来挪走了的不跟着回去', () => {
    const plan = planned(base(), merge)
    const applied = applyPlan(base(), plan).files
    const later = { ...applied, pages: { ...applied.pages, '发版.md': page('发版', '曾用名：约定', memberLine(C), memberLine(A), memberLine(D)), [UNSORTED_PAGE]: page(UNSORTED_TITLE, memberLine(B)) } }
    const back = undone(later, plan).files
    expect(members(back)).toEqual({ 发版: ['mem_c', 'mem_a', 'mem_d'], 约定: [], [UNSORTED_TITLE]: ['mem_b'] })
  })

  it('计划里说到记忆只有 id：被并的页存的是占位，撤销时成员行用现在的', () => {
    const plan = planned(base(), merge)
    const stored = JSON.stringify(plan)
    for (const m of ALL) {
      expect(stored).not.toContain(m.name)
      expect(stored).not.toContain(m.summary)
    }
    // 合并之后那条记忆改了名：撤回去的页里是新的那一行
    const applied = applyPlan(base(), plan).files
    const renamedB = memberLine({ ...B, name: '回复用中文' })
    const later = { ...applied, pages: { ...applied.pages, '发版.md': applied.pages['发版.md']!.replace(memberLine(B), renamedB) } }
    expect(undone(later, plan).files.pages['约定.md']).toBe(page('约定', renamedB))
  })

  it('被并的页在定计划之后多了手写的文字：成员照搬，页留着不删', () => {
    const plan = planned(base(), merge)
    const later = base()
    later.pages['约定.md'] = page('约定', '刚写的备注。', memberLine(B))
    const { files, deleted } = applyPlan(later, plan)
    expect(deleted).toEqual([])
    expect(files.pages['约定.md']).toBe(page('约定', '刚写的备注。'))
    expect(members(files)).toMatchObject({ 发版: ['mem_a', 'mem_d', 'mem_b'] })
  })

  it('被并的页里有等着清理的成员行（记忆已经不在用）：先不并', () => {
    expect(skippedReason(base(), merge, ctx({ activeIds: new Set(['mem_a', 'mem_c', 'mem_d']) }))).toContain('等着清理')
  })

  it('合并后的说明以标题记号或代码围栏开头：照并，说明用原来的', () => {
    const plan = planned(base(), { ...merge, about: '``` 开头' })
    expect(readIndex(applyPlan(base(), plan).files).topics[0]!.about).toBe('怎么发版。（曾用名：约定）')
  })

  it('补做时目标页已经被改成放不进成员（成员前面多了没收尾的代码块）：要搬的记忆留在原处，被并的页不删', () => {
    const plan = planned(base(), merge)
    const later = base()
    later.pages['发版.md'] = page('发版', '```', memberLine(A), memberLine(D))
    const { files, deleted } = applyPlan(later, plan)
    expect(deleted).toEqual([])
    expect(members(files)['约定']).toEqual(['mem_b'])
    expect(files.pages['发版.md']).not.toContain('mem_b')
  })
})

describe('调顺序和改说明', () => {
  it('调主题顺序：入口里整节跟着走（节里手写的文字一起），没点到的保持原来的先后', () => {
    const plan = planned(base(), { kind: 'order-topics', order: ['约定', '发版'] })
    expect(targetOf(plan)).toBe('entry')
    const { files } = applyPlan(base(), plan)
    expect(readIndex(files).topics.map(t => t.name)).toEqual(['约定', '发版'])
    expect(files.entry.indexOf('协作上的约定。')).toBeLessThan(files.entry.indexOf('发版一节里手写的备注。'))
    expect(files.entry.startsWith(`# ${ENTRY_TITLE}\n\n手写的开场白。\n\n## [约定]`)).toBe(true)
    expect(undone(files, plan).files).toEqual(base())
    expect(skippedReason(base(), { kind: 'order-topics', order: ['发版', '约定'] })).toBeDefined()
  })

  it('调成员顺序：只挪成员行，页里别的文字原位；漏写的成员按原来的先后接在后面，多写的不认', () => {
    const files = base()
    files.pages['发版.md'] = page('发版', memberLine(A), '夹在中间的备注', memberLine(D), memberLine(C))
    const plan = planned(files, { kind: 'order-members', topic: '发版', order: ['mem_c', 'mem_x', 'mem_a'] })
    expect(plan).toMatchObject({ order: ['mem_c', 'mem_a', 'mem_d'], before: ['mem_a', 'mem_d', 'mem_c'] })
    const applied = applyPlan(files, plan).files
    expect(applied.pages['发版.md']).toBe(page('发版', memberLine(C), '夹在中间的备注', memberLine(A), memberLine(D)))
    expect(undone(applied, plan).files).toEqual(files)
    const reshuffled = { ...applied, pages: { ...applied.pages, '发版.md': page('发版', memberLine(D), memberLine(C), memberLine(A)) } }
    expect(undoPlan(reshuffled, plan)).toMatchObject({ kind: 'stale' })
  })

  it('改说明：换掉入口里标题下第一段，别的文字不动；原来没有说明就加一段', () => {
    const plan = planned(base(), { kind: 'describe', topic: '发版', about: '发版的步骤\n和注意事项。' })
    const applied = applyPlan(base(), plan).files
    expect(applied.entry).toContain('## 发版\n\n发版的步骤 和注意事项。\n\n发版一节里手写的备注。\n')
    expect(undone(applied, plan).files).toEqual(base())
    const bareEntry = { ...base(), entry: `# ${ENTRY_TITLE}\n\n## 发版\n` }
    const added = applyPlan(bareEntry, planned(bareEntry, { kind: 'describe', topic: '发版', about: '新写的说明。' })).files
    expect(readIndex(added).topics[0]!.about).toBe('新写的说明。')
    const later = { ...applied, entry: applied.entry.replace('发版的步骤 和注意事项。', '又改了。') }
    expect(undoPlan(later, plan)).toMatchObject({ kind: 'stale' })
  })

  it('说明以标题记号或代码围栏开头的不收；改说明时末尾那句曾用名留着', () => {
    for (const about of ['```js', '# 标题', '## [X](topics/../../x.md)', '~~~ 围栏']) expect(skippedReason(base(), { kind: 'describe', topic: '发版', about })).toContain('开头')
    const renamed = applyPlan(base(), planned(base(), { kind: 'rename', topic: '发版', name: '发布流程' })).files
    const plan = planned(renamed, { kind: 'describe', topic: '发布流程', about: '发布的步骤。' })
    expect(readIndex(applyPlan(renamed, plan).files).topics[0]!.about).toBe('发布的步骤。（曾用名：发版）')
    expect(skippedReason(renamed, { kind: 'describe', topic: '发布流程', about: '怎么发版。' })).toContain('没变')
    // 「曾用名」几个字只是出现在说明中间：整句照收
    const middle = '部署（曾用名：发布）请看附录（第二章）'
    expect(readIndex(applyPlan(base(), planned(base(), { kind: 'describe', topic: '发版', about: middle })).files).topics[0]!.about).toBe(middle)
  })
})

describe('套计划可以重复做', () => {
  const cases: Array<[string, IndexOp]> = [
    ['归到现有主题', { kind: 'assign', memoryIds: ['mem_a', 'mem_c'], from: '发版', to: '约定' }],
    ['归到新主题', { kind: 'assign', memoryIds: ['mem_d'], from: '发版', to: '打 tag', about: '什么时候打 tag。' }],
    ['改名', { kind: 'rename', topic: '发版', name: '发布流程' }],
    ['合并', { kind: 'merge', from: ['约定'], into: '发版', about: '发版和协作约定。' }],
    ['调主题顺序', { kind: 'order-topics', order: ['约定', '发版'] }],
    ['调成员顺序', { kind: 'order-members', topic: '发版', order: ['mem_d', 'mem_a'] }],
    ['改说明', { kind: 'describe', topic: '约定', about: '新的说明。' }],
  ]
  for (const [what, op] of cases) {
    it(`${what}：只写了第一个文件就断了，再套一次得到套完的索引；套完再套不变`, () => {
      const plan = planned(base(), op)
      const done = applyPlan(base(), plan)
      // 只有第一个要写的文件落了盘（带着提交标记），别的文件还是原样
      const target = targetOf(plan)
      const half: IndexFiles = target === 'entry'
        ? { entry: withStamp(done.files.entry, 'op_1'), pages: base().pages }
        : { entry: base().entry, pages: { ...base().pages, [target]: withStamp(done.files.pages[target]!, 'op_1') } }
      const resumed = applyPlan(half, plan)
      const stamped = (files: IndexFiles): IndexFiles => (target === 'entry'
        ? { ...files, entry: withStamp(files.entry, 'op_1') }
        : { ...files, pages: { ...files.pages, [target]: withStamp(files.pages[target]!, 'op_1') } })
      expect(resumed.files).toEqual(stamped(done.files))
      expect(resumed.deleted).toEqual(done.deleted)
      expect(stampOf(target === 'entry' ? resumed.files.entry : resumed.files.pages[target]!)).toBe('op_1')
      expect(applyPlan(done.files, plan)).toEqual({ files: done.files, deleted: [] })
    })
  }

  it('归主题只写了目标页就断了：补做之后成员只在目标主题', () => {
    const plan = planned(base(), { kind: 'assign', memoryIds: ['mem_a'], from: '发版', to: '约定' })
    const done = applyPlan(base(), plan).files
    const half = { entry: base().entry, pages: { ...base().pages, '约定.md': done.pages['约定.md']! } }
    expect(members(half).发版).toContain('mem_a')
    expect(members(applyPlan(half, plan).files)).toEqual({ 发版: ['mem_d'], 约定: ['mem_a', 'mem_b'], [UNSORTED_TITLE]: ['mem_c'] })
  })
})

describe('主题页带页头和回车换行', () => {
  it('页头原样留着，行尾的回车跟着原文', () => {
    const files = base()
    files.pages['约定.md'] = withStamp(page('约定', memberLine(B)).replace(/\n/g, '\r\n'), 'op_0')
    const applied = applyPlan(files, planned(files, { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定' })).files
    expect(stampOf(applied.pages['约定.md']!)).toBe('op_0')
    expect(applied.pages['约定.md']).toBe(withStamp(page('约定', memberLine(C), memberLine(B)).replace(/\n/g, '\r\n'), 'op_0'))
  })
})
