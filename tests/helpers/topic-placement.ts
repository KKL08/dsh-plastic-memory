import { basename } from 'node:path'
import { expect } from 'vitest'
import { readIndexFiles } from '../../src/storage/index-store.ts'
import { UNSORTED_TITLE, entryTopics, memberLines, memberLine, readIndex } from '../../src/topic-index.ts'
import { maskSecrets } from '../../src/secrets.ts'
import type { LocateTarget } from '../../src/storage/table.ts'
import type { FileTable } from '../../src/storage/file-table.ts'
import type { IndexOp } from '../../src/topic-ops.ts'

/**
 * 保存时归主题的测试共用：看一条记忆在一个目录的主题索引里落在哪几页、是第几行、行里写的是什么。
 * 不做维护，读的是写入之后磁盘上的原样。
 */

/** 每条记忆在哪几页（主题名，「未整理」写作 UNSORTED_TITLE），按页的先后。还没有索引时为空对象。 */
export async function placement(dir: string): Promise<Record<string, string[]>> {
  const files = await readIndexFiles(dir)
  if (files === undefined) return {}
  const { topics, unsorted } = readIndex(files)
  const where: Record<string, string[]> = {}
  for (const t of topics) for (const id of t.memberIds) (where[id] ??= []).push(t.name)
  for (const id of unsorted) (where[id] ??= []).push(UNSORTED_TITLE)
  return where
}

/** 一页（主题名或 UNSORTED_TITLE）里的成员 id，按行的先后；没有这一页为 undefined。 */
export async function membersOf(dir: string, page: string): Promise<string[] | undefined> {
  const files = await readIndexFiles(dir)
  if (files === undefined) return undefined
  const { topics, unsorted } = readIndex(files)
  if (page === UNSORTED_TITLE) return files.pages['_unsorted.md'] === undefined ? undefined : unsorted
  return topics.find(t => t.name === page)?.memberIds
}

/** 入口里列的主题：名字和说明，按先后。 */
export async function entryOf(dir: string): Promise<Array<{ name: string; about: string }>> {
  const files = await readIndexFiles(dir)
  return files === undefined ? [] : entryTopics(files.entry).map(t => ({ name: t.name, about: t.about }))
}

/** 这条记忆在索引里的那一行（原样）；不在为 undefined。 */
export async function rowOf(dir: string, id: string): Promise<string | undefined> {
  const files = await readIndexFiles(dir)
  return files === undefined ? undefined : memberLines(files).get(id)
}

/** 按磁盘上这条记忆现在的文件算出的那一行（名称、摘要遮过密钥，文件名取文件的实际名字）。 */
export async function expectedRow(table: Pick<FileTable, 'locate'>, id: string, at: LocateTarget): Promise<string> {
  const found = await table.locate(id, at)
  expect(found, `${id} 应在磁盘上`).toBeDefined()
  return memberLine({ id, name: maskSecrets(found!.record.name), summary: maskSecrets(found!.record.summary), fileName: basename(found!.filePath) })
}

/** 做一个索引操作，必须做成。 */
export async function applied(table: Pick<FileTable, 'applyIndexOp'>, dir: string, op: IndexOp, maxTopics = 30): Promise<void> {
  const r = await table.applyIndexOp(dir, op, { maxTopics })
  if (r.kind !== 'applied') throw new Error(`索引操作没做成：${r.reason}`)
}
