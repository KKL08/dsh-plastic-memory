import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { INDEX_DIR, INDEX_ENTRY_FILE, INDEX_TOPICS_DIR } from '../../src/storage/index-store.ts'
import { memberLine, UNSORTED_PAGE, UNSORTED_TITLE } from '../../src/topic-index.ts'

/** 手写索引里的一个主题：成员按 id、按主题页里的先后。 */
export interface IndexTopicFixture {
  name: string
  about?: string
  aliases?: readonly string[]
  members: readonly string[]
}

/** 只认 id 的成员行：解析索引只看标题属性里的 id，名称、摘要、文件名都用 id 占位。 */
const rowOf = (id: string) => memberLine({ id, name: id, summary: id, fileName: `${id}.md` })

/**
 * 像用户手改那样写一个记忆目录的主题索引（整个 _index/ 先清掉再写）：入口按 topics 的先后列出链到主题页的标题和说明，
 * 每个主题一页（标题、曾用名一行、成员行），unsorted 写进「未整理」那一页。
 */
export async function writeTopicIndex(dir: string, topics: readonly IndexTopicFixture[], unsorted: readonly string[] = []): Promise<void> {
  await rm(join(dir, INDEX_DIR), { recursive: true, force: true })
  await mkdir(join(dir, INDEX_DIR, INDEX_TOPICS_DIR), { recursive: true })
  let entry = '# 记忆索引\n'
  for (const [i, t] of topics.entries()) {
    const file = `t${i}.md`
    entry += `\n## [${t.name}](topics/${file})\n${t.about === undefined || t.about === '' ? '' : `${t.about}\n`}`
    const aliases = t.aliases !== undefined && t.aliases.length > 0 ? `曾用名：${t.aliases.join('、')}\n\n` : ''
    await writeFile(join(dir, INDEX_DIR, INDEX_TOPICS_DIR, file), `# ${t.name}\n\n${aliases}${t.members.map(rowOf).join('\n')}\n`)
  }
  await writeFile(join(dir, INDEX_DIR, INDEX_ENTRY_FILE), entry)
  await writeFile(join(dir, INDEX_DIR, INDEX_TOPICS_DIR, UNSORTED_PAGE), `# ${UNSORTED_TITLE}\n\n${unsorted.map(rowOf).join('\n')}\n`)
}

/** 让这个目录的主题索引读不出：主题页目录的位置换成一个普通文件（列目录报 ENOTDIR）。 */
export async function breakTopicIndex(dir: string): Promise<void> {
  await rm(join(dir, INDEX_DIR), { recursive: true, force: true })
  await mkdir(join(dir, INDEX_DIR), { recursive: true })
  await writeFile(join(dir, INDEX_DIR, INDEX_TOPICS_DIR), '不是目录')
}

/** 去掉这个目录的主题索引，回到还没有索引的样子。 */
export async function removeTopicIndex(dir: string): Promise<void> {
  await rm(join(dir, INDEX_DIR), { recursive: true, force: true })
}
