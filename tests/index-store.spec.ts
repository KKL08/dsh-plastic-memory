import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INDEX_DIR, INDEX_ENTRY_FILE, INDEX_TOPICS_DIR, readIndexFiles, writeIndexFiles } from '../src/storage/index-store.ts'

// 主题索引的读与整份替换写：只碰记忆目录下的 _index/。

const dirs: string[] = []
async function memoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-index-store-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

const recorder = () => {
  const paths: string[] = []
  return { paths, write: async (filePath: string, text: string) => { paths.push(filePath); await writeFile(filePath, text, 'utf8') } }
}

describe('主题索引的存取', () => {
  it('索引目录还不存在：读回 undefined', async () => {
    expect(await readIndexFiles(await memoryDir())).toBeUndefined()
  })

  it('写下去再读回来逐字相同；主题页先写、入口最后写', async () => {
    const dir = await memoryDir()
    const files = { entry: '# 记忆索引\n\n## 发版\n', pages: { '发版.md': '# 发版\n', '_unsorted.md': '# 未整理\n' } }
    const w = recorder()
    const written = await writeIndexFiles(dir, undefined, files, w.write)
    expect(await readIndexFiles(dir)).toEqual(files)
    expect(written.at(-1)).toBe(join(INDEX_DIR, INDEX_ENTRY_FILE))
    expect(written).toHaveLength(3)
  })

  it('只写内容变了的文件；都没变一个也不写', async () => {
    const dir = await memoryDir()
    const before = { entry: '# 记忆索引\n', pages: { 'a.md': '# 甲\n', 'b.md': '# 乙\n' } }
    await writeIndexFiles(dir, undefined, before, recorder().write)
    const w = recorder()
    expect(await writeIndexFiles(dir, before, before, w.write)).toEqual([])
    const written = await writeIndexFiles(dir, before, { ...before, pages: { ...before.pages, 'b.md': '# 乙\n\n改过\n' } }, w.write)
    expect(written).toEqual([join(INDEX_DIR, INDEX_TOPICS_DIR, 'b.md')])
    expect(await readFile(join(dir, INDEX_DIR, INDEX_TOPICS_DIR, 'b.md'), 'utf8')).toBe('# 乙\n\n改过\n')
  })

  it('目录在、入口丢了：入口按空读回，主题页照常；不是 .md 的文件和写了一半的临时文件不算', async () => {
    const dir = await memoryDir()
    const topics = join(dir, INDEX_DIR, INDEX_TOPICS_DIR)
    await mkdir(topics, { recursive: true })
    await writeFile(join(topics, 'a.md'), '# 甲\n')
    await writeFile(join(topics, 'a.md.tmp-1-abc123'), '半截')
    await writeFile(join(topics, 'notes.txt'), '别的')
    expect(await readIndexFiles(dir)).toEqual({ entry: '', pages: { 'a.md': '# 甲\n' } })
  })

  it('索引目录在、主题页目录丢了：按没有主题页读回', async () => {
    const dir = await memoryDir()
    await mkdir(join(dir, INDEX_DIR))
    await writeFile(join(dir, INDEX_DIR, INDEX_ENTRY_FILE), '# 记忆索引\n')
    expect(await readIndexFiles(dir)).toEqual({ entry: '# 记忆索引\n', pages: {} })
  })
})
