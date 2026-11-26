import type { MemoryRecord } from './record-schema.ts'
import { readIndex, UNSORTED_PAGE, UNSORTED_TITLE, type IndexFiles } from './topic-index.ts'
import { withinValidity } from './record-freshness.ts'
import { injectionText } from './index-line.ts'
import { maskSecrets } from './secrets.ts'

/**
 * 一个作用域的记忆按主题索引分组，以及「这一组算几条」的口径。注入（主题目录、成员行）和检索（按主题列出、
 * 「同主题还有 N 条」、匹配的主题、主题目录）都从这里分组、计数，两边的条数因此一致。纯函数，不碰磁盘。
 */

/** 一组：索引里的一个主题，或这个作用域的「未整理」。名称、说明、曾用名是索引文件原样，没遮盖密钥、没折行。 */
export interface TopicGroup {
  /** 主题页的文件名；「未整理」是 UNSORTED_PAGE。 */
  fileName: string
  /** 主题名；「未整理」是 UNSORTED_TITLE。 */
  name: string
  /** 入口里这个主题标题下的第一段；入口里没有它、以及「未整理」，为空串。 */
  about: string
  aliases: readonly string[]
  isUnsorted: boolean
  /**
   * 索引行按 id 对上 records 的记录，按主题页里的先后；同一条在索引里出现两次取先出现的（各主题按先后，「未整理」最后）。
   * 「未整理」末尾再接索引里还没有行的记录（名称序，再按 id）。含已过期、还没生效的：要不要数它们由 usableMembers 判。
   */
  members: readonly MemoryRecord[]
}

/**
 * 把一个作用域的记录按主题索引分组：各主题按 readIndex 的先后，「未整理」固定在最后。
 * records 是调用方按自己的视角取舍过的、这个作用域的在用记录；索引行对不上其中任何一条的（别的作用域里同 id 的那份、这次没读到的）跳过。
 */
export function groupTopics(files: IndexFiles, records: readonly MemoryRecord[]): TopicGroup[] {
  const { topics, unsorted } = readIndex(files)
  const byId = new Map(records.map(r => [r.id, r]))
  const placed = new Set<string>()
  const take = (ids: readonly string[]) => ids.flatMap(id => {
    const r = byId.get(id)
    if (r === undefined || placed.has(id)) return []
    placed.add(id)
    return [r]
  })
  const groups = topics.map(t => ({ fileName: t.fileName, name: t.name, about: t.about, aliases: t.aliases, isUnsorted: false, members: take(t.memberIds) }))
  const listed = take(unsorted)
  const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  const missing = records.filter(r => !placed.has(r.id)).sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id))
  return [...groups, { fileName: UNSORTED_PAGE, name: UNSORTED_TITLE, about: '', aliases: [], isUnsorted: true, members: [...listed, ...missing] }]
}

/** 一组里算条数的成员：已生效且没过期（含单条设成不列入的、必读全文里已经给过全文的）。注入和检索的条数都只数它们。 */
export function usableMembers(members: readonly MemoryRecord[], now: number): MemoryRecord[] {
  return members.filter(r => withinValidity(r, now))
}

/** 手改的主题页名字和固定在最后的「未整理」撞上时，加在主题名后面的区分。 */
export const SAME_NAME_TOPIC_MARK = '（同名主题）'

/**
 * 主题名进注入或检索结果前的写法：遮盖密钥，再折成一行、尖括号换成全角（保留结构不改变外层结构）；
 * 不是「未整理」的组显示成「未整理」时加 SAME_NAME_TOPIC_MARK。
 */
export function topicDisplayName(group: Pick<TopicGroup, 'name' | 'isUnsorted'>): string {
  const name = injectionText(maskSecrets(group.name))
  return name === UNSORTED_TITLE && !group.isUnsorted ? `${name}${SAME_NAME_TOPIC_MARK}` : name
}

/** 主题说明进注入或检索结果前的写法：遮盖密钥，再折成一行、尖括号换成全角。 */
export function topicDisplayAbout(about: string): string {
  return injectionText(maskSecrets(about))
}
