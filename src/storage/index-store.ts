import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IndexFiles } from '../topic-index.ts'

/** 主题索引在记忆目录下的子目录。旧版本只读写目录顶层的 .md，不进子目录：索引放这里不会被它当成记忆，也不会被它覆盖。 */
export const INDEX_DIR = '_index'
/** 入口文件（在 INDEX_DIR 下）。 */
export const INDEX_ENTRY_FILE = 'index.md'
/** 主题页所在的子目录（在 INDEX_DIR 下）。 */
export const INDEX_TOPICS_DIR = 'topics'

/** 写回之前发现索引文件已经不是读到的那份（用户或别的进程刚改过）：这一轮不写，调用方重读重算。 */
export class IndexChangedError extends Error {
  constructor(filePath: string) {
    super(`索引文件在核对期间被改过：${filePath}`)
    this.name = 'IndexChangedError'
  }
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

/**
 * 读一个记忆目录的主题索引。索引目录还不存在返回 undefined（第一次在这个目录运行）；
 * 目录在而入口或主题页缺了，缺的按空处理，由整份核对补齐。
 */
export async function readIndexFiles(dir: string): Promise<IndexFiles | undefined> {
  const root = join(dir, INDEX_DIR)
  let names: string[]
  try {
    names = await readdir(join(root, INDEX_TOPICS_DIR))
  } catch (err) {
    if (!isMissing(err)) throw err
    try {
      await readdir(root)
    } catch (inner) {
      if (isMissing(inner)) return undefined
      throw inner
    }
    names = []
  }
  const entry = await readFile(join(root, INDEX_ENTRY_FILE), 'utf8').catch(err => { if (isMissing(err)) return ''; throw err })
  const pages: Record<string, string> = {}
  // 只认 .md；原子写留下的临时文件以 .tmp-<pid>-<rand> 结尾，天然排除
  for (const name of names.filter(n => n.endsWith('.md')).sort()) {
    try {
      pages[name] = await readFile(join(root, INDEX_TOPICS_DIR, name), 'utf8')
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }
  return { entry, pages }
}

/**
 * 把索引写回去：只写内容变了的文件，每个文件整份替换（write 由调用方给，是先写临时文件再改名的那种，读的人读不到写了一半的）。
 * 先写主题页、再写入口、最后删 deleted 里的主题页：中途断了，入口里只会少主题，不会指向还没有的页。
 * 这些文件用户可以随手改，改它们不经过插件的锁：每个文件写之前再读一次，和 before 里读到的不一样就抛 IndexChangedError，
 * 不拿按旧内容算出来的结果盖掉刚改的。返回写了哪些文件（相对记忆目录的路径）。
 */
export async function writeIndexFiles(
  dir: string, before: IndexFiles | undefined, next: IndexFiles, write: (filePath: string, text: string) => Promise<void>,
  deleted: readonly string[] = [],
): Promise<string[]> {
  const root = join(dir, INDEX_DIR)
  const written: string[] = []
  const changed = Object.keys(next.pages).filter(name => before?.pages[name] !== next.pages[name])
  const isEntryChanged = before === undefined || before.entry !== next.entry
  if (changed.length === 0 && !isEntryChanged && deleted.length === 0) return written
  await mkdir(join(root, INDEX_TOPICS_DIR), { recursive: true })
  const replace = async (filePath: string, was: string | undefined, text: string) => {
    const current = await readFile(filePath, 'utf8').catch(err => { if (isMissing(err)) return undefined; throw err })
    // 入口缺了读的时候按空串算，这里同样对待
    if ((current ?? '') !== (was ?? '')) throw new IndexChangedError(filePath)
    await write(filePath, text)
  }
  for (const name of changed) {
    await replace(join(root, INDEX_TOPICS_DIR, name), before?.pages[name], next.pages[name]!)
    written.push(join(INDEX_DIR, INDEX_TOPICS_DIR, name))
  }
  if (isEntryChanged) {
    await replace(join(root, INDEX_ENTRY_FILE), before?.entry, next.entry)
    written.push(join(INDEX_DIR, INDEX_ENTRY_FILE))
  }
  for (const name of deleted) {
    const filePath = join(root, INDEX_TOPICS_DIR, name)
    const current = await readFile(filePath, 'utf8').catch(err => { if (isMissing(err)) return undefined; throw err })
    if (current === undefined) continue
    if (current !== before?.pages[name]) throw new IndexChangedError(filePath)
    await rm(filePath, { force: true })
    written.push(join(INDEX_DIR, INDEX_TOPICS_DIR, name))
  }
  return written
}

/** 索引里的一个文件：'entry' 是入口，其余是主题页的文件名。 */
export function indexFilePath(dir: string, file: string): string {
  return file === 'entry' ? join(dir, INDEX_DIR, INDEX_ENTRY_FILE) : join(dir, INDEX_DIR, INDEX_TOPICS_DIR, file)
}

/** 读索引里的一个文件；不存在返回 undefined。 */
export async function readIndexFile(dir: string, file: string): Promise<string | undefined> {
  return readFile(indexFilePath(dir, file), 'utf8').catch(err => { if (isMissing(err)) return undefined; throw err })
}

/**
 * 整份替换索引里的一个文件（索引操作先写的那一个）。写之前再读一次：和 was 不一样就抛 IndexChangedError。
 * 入口缺了按空串算，主题页缺了是 undefined。
 */
export async function replaceIndexFile(
  dir: string, file: string, was: string | undefined, text: string, write: (filePath: string, text: string) => Promise<void>,
): Promise<void> {
  const filePath = indexFilePath(dir, file)
  await mkdir(join(dir, INDEX_DIR, INDEX_TOPICS_DIR), { recursive: true })
  const current = await readIndexFile(dir, file)
  if (file === 'entry' ? (current ?? '') !== (was ?? '') : current !== was) throw new IndexChangedError(filePath)
  await write(filePath, text)
}
