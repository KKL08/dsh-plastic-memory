import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readIndexFiles } from '../src/storage/index-store.ts'
import { UNSORTED_PAGE, UNSORTED_TITLE, type IndexFiles } from '../src/topic-index.ts'
import { groupTopics, usableMembers, topicDisplayAbout, topicDisplayName, SAME_NAME_TOPIC_MARK } from '../src/topic-members.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { writeTopicIndex, type IndexTopicFixture } from './helpers/topic-fixture.ts'

// 注入和检索共用的分组与计数（src/topic-members.ts）：分组规则、可用成员的口径、主题名和说明进结果前的写法；
// 以及注入、检索两侧都从这里取分组和计数（静态读源码，不执行）。

const T0 = 1_700_000_000_000
const DAY = 86_400_000
const mem = (id: string, partial: Partial<MemoryRecord> = {}) => record({ id, name: `${id} 名称`, ...partial })
const memberIds = (groups: ReturnType<typeof groupTopics>) => groups.map(g => [g.name, g.members.map(r => r.id)])

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-topic-members-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** 像用户手改那样写索引，再用存储层的读法读回来：分组吃的是真实解析出的索引文件。 */
async function indexFiles(topics: readonly IndexTopicFixture[], unsorted: readonly string[] = []): Promise<IndexFiles> {
  await writeTopicIndex(dir, topics, unsorted)
  return (await readIndexFiles(dir))!
}

describe('groupTopics', () => {
  it('各主题按索引的先后，同一条在索引里出现两次取先出现的；「未整理」在最后，先是页里的，再接哪组都没放进去的（名称序，再按 id）', async () => {
    const files = await indexFiles([
      { name: '甲 <b>', about: `说明 ${FAKE_SECRET.github}`, aliases: ['旧甲'], members: ['r1', 'r2'] },
      { name: '乙', members: ['r2', 'r3', 'gone'] },
    ], ['r4', 'r1'])
    const records = [mem('r1'), mem('r2'), mem('r3'), mem('r4'), mem('r6', { name: '丙' }), mem('r5', { name: '乙' }), mem('r7', { name: '乙' })]
    const groups = groupTopics(files, records)
    expect(memberIds(groups)).toEqual([['甲 <b>', ['r1', 'r2']], ['乙', ['r3']], [UNSORTED_TITLE, ['r4', 'r6', 'r5', 'r7']]])
    // 名称、说明、曾用名是索引文件原样，不遮盖、不折行
    expect(groups[0]).toMatchObject({ fileName: 't0.md', name: '甲 <b>', about: `说明 ${FAKE_SECRET.github}`, aliases: ['旧甲'], isUnsorted: false })
    expect(groups[1]).toMatchObject({ fileName: 't1.md', about: '', aliases: [], isUnsorted: false })
    expect(groups[2]).toEqual({ fileName: UNSORTED_PAGE, name: UNSORTED_TITLE, about: '', aliases: [], isUnsorted: true, members: groups[2]!.members })
  })

  it('成员里含已过期、还没生效的（计不计数由 usableMembers 判）', async () => {
    const files = await indexFiles([{ name: '甲', members: ['old', 'future', 'ok'] }])
    const groups = groupTopics(files, [mem('old', { validTo: T0 - DAY }), mem('future', { validFrom: T0 + DAY }), mem('ok')])
    expect(memberIds(groups)).toEqual([['甲', ['old', 'future', 'ok']], [UNSORTED_TITLE, []]])
  })

  it('没有索引文件（空索引）：全部在「未整理」，按名称再按 id；没有记录时「未整理」照样有，成员为空', () => {
    const empty = { entry: '', pages: {} }
    expect(memberIds(groupTopics(empty, [mem('b', { name: '乙' }), mem('a', { name: '甲' }), mem('c', { name: '甲' })]))).toEqual([[UNSORTED_TITLE, ['b', 'a', 'c']]])
    expect(groupTopics(empty, [])).toEqual([{ fileName: UNSORTED_PAGE, name: UNSORTED_TITLE, about: '', aliases: [], isUnsorted: true, members: [] }])
  })
})

describe('usableMembers', () => {
  it('只留已生效且没过期的，含设成不列入的、必读全文档的；先后不变', () => {
    const members = [
      mem('a'), mem('expired', { validTo: T0 - DAY }), mem('unlisted', { recall: 'unlisted' }), mem('future', { validFrom: T0 + DAY }),
      mem('core', { recall: 'core' }), mem('edge_to', { validTo: T0 }), mem('edge_from', { validFrom: T0 }),
    ]
    expect(usableMembers(members, T0).map(r => r.id)).toEqual(['a', 'unlisted', 'core', 'edge_from'])
  })
})

describe('主题名和说明进结果前的写法', () => {
  it('topicDisplayName：遮盖密钥、折成一行、尖括号换全角；不是「未整理」的组显示成「未整理」时加区分', () => {
    expect(topicDisplayName({ name: `令牌\n<b> ${FAKE_SECRET.github}`, isUnsorted: false })).toBe(`令牌 ＜b＞ ${SECRET_MASK}`)
    expect(topicDisplayName({ name: UNSORTED_TITLE, isUnsorted: true })).toBe(UNSORTED_TITLE)
    expect(topicDisplayName({ name: UNSORTED_TITLE, isUnsorted: false })).toBe(`${UNSORTED_TITLE}${SAME_NAME_TOPIC_MARK}`)
    expect(topicDisplayName({ name: ` ${UNSORTED_TITLE}\n`, isUnsorted: false })).toBe(`${UNSORTED_TITLE}${SAME_NAME_TOPIC_MARK}`)
  })

  it('topicDisplayAbout：遮盖密钥、折成一行、尖括号换全角', () => {
    expect(topicDisplayAbout(`存着 ${FAKE_SECRET.github}\n的 <i>说明</i>`)).toBe(`存着 ${SECRET_MASK} 的 ＜i＞说明＜/i＞`)
    expect(topicDisplayAbout('')).toBe('')
  })
})

// —— 结构：注入和检索的分组、计数都从 topic-members 来；执行器经 search/topic-context 取候选 ——
// 写法同 import-direction.spec.ts：静态读源码、正则扫 import，不执行源码。

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))
const IMPORT_RE = /^\s*import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm

/** 一个模块从 spec 运行时 import 的具名项（整句 type-only、带 type 前缀的具名项都不算）。 */
function runtimeNames(mod: string, spec: string): string[] {
  const source = readFileSync(`${SRC_DIR}${mod}.ts`, 'utf8')
  return [...source.matchAll(IMPORT_RE)]
    .filter(m => m[1] === undefined && m[3] === spec)
    .flatMap(m => m[2]!.split(',').map(s => s.trim()).filter(s => s !== '' && !s.startsWith('type ')))
    .map(s => s.split(/\s+as\s+/)[0]!)
}

describe('结构', () => {
  it('注入（snapshot）和检索（search/topic-context）都从 topic-members 取 groupTopics、usableMembers', () => {
    expect(runtimeNames('snapshot', './topic-members.ts')).toEqual(expect.arrayContaining(['groupTopics', 'usableMembers']))
    expect(runtimeNames('search/topic-context', '../topic-members.ts')).toEqual(expect.arrayContaining(['groupTopics', 'usableMembers']))
  })

  it('执行器经 search/topic-context 取候选，不直接调 findMemoryCandidates', () => {
    expect(runtimeNames('tools/search', '../search/topic-context.ts')).toContain('findTopicCandidates')
    expect(runtimeNames('tools/search', '../search/memory-candidates.ts')).not.toContain('findMemoryCandidates')
  })
})
