import { readFile, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { readIndex } from '../../src/topic-index.ts'
import { INDEX_DIR, readIndexFiles } from '../../src/storage/index-store.ts'
import { INDEX_FILE } from '../../src/storage/paths.ts'
import type { FileTable } from '../../src/storage/file-table.ts'
import { isPendingDelegated } from '../../src/record-schema.ts'

/**
 * 测试里看一个记忆目录的主题索引：成员 id、各文件全文、MEMORY.md 里的条数。
 * 索引只在维护点（快照冻结、彻底删除、显式 maintain）核对，断言前先维护。
 */

/** 索引里全部成员 id：各主题页按先后、「未整理」最后。还没有索引时为空。 */
export async function indexedIds(dir: string): Promise<string[]> {
  const files = await readIndexFiles(dir)
  if (files === undefined) return []
  const { topics, unsorted } = readIndex(files)
  return [...topics.flatMap(t => t.memberIds), ...unsorted]
}

/** 索引各文件（入口、主题页）和 MEMORY.md 的全文连在一起，查某段文字在不在；缺的文件按空算。 */
export async function indexText(dir: string): Promise<string> {
  const files = await readIndexFiles(dir)
  const projection = await readFile(join(dir, INDEX_FILE), 'utf8').catch(() => '')
  return [files?.entry ?? '', ...Object.values(files?.pages ?? {}), projection].join('\n')
}

/** MEMORY.md 里各段的条数加起来；没有 MEMORY.md 为 0。 */
export async function projectedCount(dir: string): Promise<number> {
  const text = await readFile(join(dir, INDEX_FILE), 'utf8').catch(() => '')
  return [...text.matchAll(/^(\d+) 条/gm)].reduce((sum, m) => sum + Number(m[1]), 0)
}

/** 索引目录下全部文件和子目录（相对 _index/）；目录还不存在为 undefined。比较前后是否原样用。 */
export async function indexTree(dir: string): Promise<Record<string, string> | undefined> {
  const root = join(dir, INDEX_DIR)
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return undefined
  const tree: Record<string, string> = {}
  for (const e of entries) {
    const rel = join(e.parentPath, e.name).slice(root.length + 1)
    tree[rel] = e.isDirectory() ? '<dir>' : await readFile(join(root, rel), 'utf8')
  }
  return tree
}

/** 路径落在主题索引目录里，或是 MEMORY.md：写调用、读调用的记录里按它挑出碰了索引的。 */
export function isIndexPath(path: string): boolean {
  return path.includes(`${sep}${INDEX_DIR}${sep}`) || path.endsWith(`${sep}${INDEX_DIR}`) || path.endsWith(`${sep}${INDEX_FILE}`)
    || path.includes(`${sep}${INDEX_FILE}.tmp-`)
}

/**
 * 维护之后的收敛核对：索引成员 id 的集合等于磁盘上这个目录顶层在用、已进主档的记忆 id 集合（子 agent 存下还没接受的不算），
 * 返回排好序的这组 id。
 * 不等就抛错，把两边都列出来。调用前先 maintain 这个目录。
 */
export async function indexedIdsMatchDisk(table: Pick<FileTable, 'readScope'>, dir: string): Promise<string[]> {
  const onDisk = [...new Set((await table.readScope([dir])).records.filter(l => l.record.status === 'active' && !isPendingDelegated(l.record)).map(l => l.record.id))].sort()
  const indexed = [...(await indexedIds(dir))].sort()
  if (JSON.stringify(indexed) !== JSON.stringify(onDisk)) {
    throw new Error(`索引与磁盘不一致：索引里 ${JSON.stringify(indexed)}，磁盘上 ${JSON.stringify(onDisk)}`)
  }
  return indexed
}
