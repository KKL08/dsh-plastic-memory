import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { DerivedIndex } from '../src/storage/derived-index.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, INDEX_FILE, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { INDEX_DIR, INDEX_ENTRY_FILE, INDEX_TOPICS_DIR } from '../src/storage/index-store.ts'
import { ENTRY_TITLE, PROJECTION_NOTE, UNSORTED_PAGE, UNSORTED_TITLE, memberLine } from '../src/topic-index.ts'
import { maskSecrets } from '../src/secrets.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { indexedIds } from './helpers/topic-index.ts'

// 主题索引在真实目录上的整份核对：第一次建立、手改留得住、和旧版本共用目录、落盘前遮盖、派生库的成员表。
// 纯函数的各种情形在 topic-index.spec.ts；这里只看维护点接起来之后磁盘上的结果。

const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  type: 'preference', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_000_000, ...partial,
})

let root: string
let derived: DerivedIndex
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-topic-index-'))
  derived = new DerivedIndex({ path: join(root, 'local', 'derived-index.sqlite'), log: { info: () => {}, warn: () => {}, error: () => {} } })
})
afterEach(async () => {
  derived.close()
  await rm(root, { recursive: true, force: true })
})

const dir = () => join(root, GLOBAL_DIR)
const entryPath = () => join(dir(), INDEX_DIR, INDEX_ENTRY_FILE)
const pagePath = (name: string) => join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, name)
const read = (path: string) => readFile(path, 'utf8')
const open = () => new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), index: derived })
async function writeMem(fileName: string, r: MemoryRecord) {
  await mkdir(dir(), { recursive: true })
  await writeFile(join(dir(), fileName), encodeRecord(r, {}))
}
const line = (id: string, name: string, fileName: string, summary = '摘要') => memberLine({ id, name, summary, fileName })

describe('第一次在一个目录运行', () => {
  it('只有记忆文件和旧版本的平铺 MEMORY.md：建出索引，在用记忆全进「未整理」，MEMORY.md 换成按主题的投影', async () => {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    await writeMem('b.md', record({ id: 'mem_b', name: 'beta' }))
    await writeFile(join(dir(), INDEX_FILE), '# Memory Index\n\n- [alpha] summary · a.md\n- [beta] summary · b.md\n')
    await open().maintain([dir()])
    expect(await read(entryPath())).toBe(`# ${ENTRY_TITLE}\n`)
    expect(await read(pagePath(UNSORTED_PAGE))).toBe(`# ${UNSORTED_TITLE}\n\n${line('mem_a', 'alpha', 'a.md')}\n${line('mem_b', 'beta', 'b.md')}\n`)
    const projection = await read(join(dir(), INDEX_FILE))
    expect(projection.startsWith(PROJECTION_NOTE)).toBe(true)
    expect(projection).toContain(`## [${UNSORTED_TITLE}](${INDEX_DIR}/${INDEX_TOPICS_DIR}/${UNSORTED_PAGE})`)
    expect(projection).toContain('2 条')
    expect(projection).not.toContain('· a.md')
  })

  it('子 agent 存下、主会话还没接受的记录不进索引；接受之后下次维护补进来', async () => {
    const delegation = { sessionId: 'child', depth: 1, parentSessionId: 'main' }
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    await writeMem('p.md', record({ id: 'mem_p', name: 'pending', delegation }))
    const table = open()
    await table.maintain([dir()])
    expect(await indexedIds(dir())).toEqual(['mem_a'])
    await writeMem('p.md', record({ id: 'mem_p', name: 'pending', delegation: { ...delegation, reviewed: { by: 'main', at: 1_700_000_100_000 } } }))
    await table.maintain([dir()])
    expect(await indexedIds(dir())).toEqual(['mem_a', 'mem_p'])
  })
})

describe('整份核对接在维护点上', () => {
  async function seedTopic() {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    await writeMem('b.md', record({ id: 'mem_b', name: 'beta' }))
    const table = open()
    await table.maintain([dir()])
    // 用户手改：建一个主题、写说明、把 beta 挪过去，页里加一句自己的话
    await writeFile(entryPath(), `# ${ENTRY_TITLE}\n\n开头自己写的一段。\n\n## 发版\n\n和发版有关的约定。\n`)
    await writeFile(pagePath('发版.md'), `# 发版\n\n曾用名：上线\n\n先看这条：\n${line('mem_b', 'beta', 'b.md')}\n`)
    await writeFile(pagePath(UNSORTED_PAGE), `# ${UNSORTED_TITLE}\n\n${line('mem_a', 'alpha', 'a.md')}\n`)
    return table
  }

  it('手改的主题、说明、顺序和页里的文字留得住；MEMORY.md 跟着列出这个主题', async () => {
    const table = await seedTopic()
    const before = [await read(entryPath()), await read(pagePath('发版.md')), await read(pagePath(UNSORTED_PAGE))]
    await table.maintain([dir()])
    expect([await read(entryPath()), await read(pagePath('发版.md')), await read(pagePath(UNSORTED_PAGE))]).toEqual(before)
    const projection = await read(join(dir(), INDEX_FILE))
    expect(projection).toContain(`## [发版](${INDEX_DIR}/${INDEX_TOPICS_DIR}/${encodeURIComponent('发版')}.md)`)
    expect(projection).toContain('和发版有关的约定。')
  })

  it('漏掉的在用记忆补进「未整理」，指向已不在的记忆的行去掉，改过的名称和摘要同步到行里，其余文字不动', async () => {
    const table = await seedTopic()
    await writeMem('c.md', record({ id: 'mem_c', name: 'gamma' }))
    await writeMem('b.md', record({ id: 'mem_b', name: 'beta 改名', summary: '新摘要' }))
    await rm(join(dir(), 'a.md'))
    await table.maintain([dir()])
    expect(await read(pagePath('发版.md'))).toBe(`# 发版\n\n曾用名：上线\n\n先看这条：\n${line('mem_b', 'beta 改名', 'b.md', '新摘要')}\n`)
    expect(await read(pagePath(UNSORTED_PAGE))).toBe(`# ${UNSORTED_TITLE}\n\n${line('mem_c', 'gamma', 'c.md')}\n`)
    expect(await read(entryPath())).toContain('开头自己写的一段。')
  })

  it('旧版本把 MEMORY.md 重新写成平铺列表：下次维护按索引生成回来，索引本身不受影响', async () => {
    const table = await seedTopic()
    await table.maintain([dir()])
    const projection = await read(join(dir(), INDEX_FILE))
    const pages = [await read(entryPath()), await read(pagePath('发版.md'))]
    await writeFile(join(dir(), INDEX_FILE), '# Memory Index\n\n- [alpha] summary · a.md\n- [beta] summary · b.md\n')
    await table.maintain([dir()])
    expect(await read(join(dir(), INDEX_FILE))).toBe(projection)
    expect([await read(entryPath()), await read(pagePath('发版.md'))]).toEqual(pages)
  })

  it('主题名和主题说明里的密钥落盘前遮住，MEMORY.md 里也没有', async () => {
    const secret = `sk-ant-api03-${'S'.repeat(40)}`
    expect(maskSecrets(secret)).not.toContain(secret)
    const table = await seedTopic()
    await writeFile(entryPath(), `# ${ENTRY_TITLE}\n\n## 发版\n\n部署用的是 ${secret}。\n`)
    await writeFile(pagePath('发版.md'), `# 发版\n\n曾用名：${secret}\n\n${line('mem_b', 'beta', 'b.md')}\n`)
    await table.maintain([dir()])
    for (const path of [entryPath(), pagePath('发版.md'), join(dir(), INDEX_FILE)]) expect(await read(path)).not.toContain(secret)
    expect(derived.topicPages(dir()).flatMap(p => [p.title, ...p.aliases]).join('\n')).not.toContain(secret)
  })
})

describe('索引文件是用户的东西', () => {
  /** 维护写这个文件之前插一脚：模拟用户正好在这时改了它。只插一次。 */
  class Interrupted extends FileTable {
    before: { path: string; act: () => Promise<void> } | undefined
    protected override async atomicWrite(filePath: string, text: string): Promise<void> {
      const hook = this.before
      if (hook !== undefined && filePath === hook.path) {
        this.before = undefined
        await hook.act()
      }
      return super.atomicWrite(filePath, text)
    }
  }

  it('核对期间用户改了一个主题页（写它之前读到的已经不是原来那份）：不盖，同一次维护里按新内容重算', async () => {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    await writeMem('b.md', record({ id: 'mem_b', name: 'beta' }))
    const table = new Interrupted({ root, stats: new InMemoryKvTable<RecallStats>(), index: derived })
    await table.maintain([dir()])
    await writeFile(entryPath(), `# ${ENTRY_TITLE}\n\n## 发版\n`)
    await writeFile(pagePath('发版.md'), `# 发版\n\n${line('mem_b', 'beta', 'b.md')}\n`)
    await writeFile(pagePath(UNSORTED_PAGE), `# ${UNSORTED_TITLE}\n\n${line('mem_a', 'alpha', 'a.md')}\n`)
    await table.maintain([dir()])
    // 两页都要重写（两条记忆的摘要都变了）。写第一页之前，用户在第二页加了一句话
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha', summary: '甲的新摘要' }))
    await writeMem('b.md', record({ id: 'mem_b', name: 'beta', summary: '乙的新摘要' }))
    let isHit = false
    table.before = { path: pagePath('发版.md'), act: async () => { isHit = true; await appendFile(pagePath(UNSORTED_PAGE), '\n用户刚加的一句。\n') } }
    await table.maintain([dir()])
    expect(isHit).toBe(true)
    const text = await read(pagePath(UNSORTED_PAGE))
    expect(text).toContain('用户刚加的一句。')
    expect(text).toContain(line('mem_a', 'alpha', 'a.md', '甲的新摘要'))
    expect(await read(pagePath('发版.md'))).toContain(line('mem_b', 'beta', 'b.md', '乙的新摘要'))
  })

  it('记忆文件一时读不出来：它归在哪个主题不丢，修好之后还在原来那一页', async () => {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    await writeMem('b.md', record({ id: 'mem_b', name: 'beta' }))
    const table = open()
    await table.maintain([dir()])
    await writeFile(entryPath(), `# ${ENTRY_TITLE}\n\n## 发版\n`)
    await writeFile(pagePath('发版.md'), `# 发版\n\n${line('mem_a', 'alpha', 'a.md')}\n`)
    await writeFile(pagePath(UNSORTED_PAGE), `# ${UNSORTED_TITLE}\n\n${line('mem_b', 'beta', 'b.md')}\n`)
    const good = await read(join(dir(), 'a.md'))
    await writeFile(join(dir(), 'a.md'), '---\nname: [没写完\n---\n\n正文\n')
    await table.maintain([dir()])
    expect(await read(pagePath('发版.md'))).toContain('"mem_a"')
    await writeFile(join(dir(), 'a.md'), good)
    await table.maintain([dir()])
    expect(await read(pagePath('发版.md'))).toBe(`# 发版\n\n${line('mem_a', 'alpha', 'a.md')}\n`)
    expect(await read(pagePath(UNSORTED_PAGE))).not.toContain('"mem_a"')
  })

  it('手建的记忆名称、摘要里带密钥：进主题页的那一行是遮过的，核对两遍不漂', async () => {
    const secret = `sk-ant-api03-${'S'.repeat(40)}`
    await writeMem('a.md', record({ id: 'mem_a', name: `key ${secret}`, summary: `用 ${secret} 部署` }))
    const table = open()
    await table.maintain([dir()])
    const text = await read(pagePath(UNSORTED_PAGE))
    expect(text).not.toContain(secret)
    expect(text).toContain('"mem_a"')
    await table.maintain([dir()])
    expect(await read(pagePath(UNSORTED_PAGE))).toBe(text)
  })

  it('索引目录里写到一半留下的临时文件：自己进程的和放久了的清掉，别的进程刚写的不动', async () => {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    const table = open()
    await table.maintain([dir()])
    const topics = join(dir(), INDEX_DIR, INDEX_TOPICS_DIR)
    const own = join(topics, `${UNSORTED_PAGE}.tmp-${process.pid}-abc123`)
    const stale = join(dir(), INDEX_DIR, `${INDEX_ENTRY_FILE}.tmp-1-abc123`)
    const fresh = join(topics, `${UNSORTED_PAGE}.tmp-1-def456`)
    for (const path of [own, stale, fresh]) await writeFile(path, 'alpha 的旧内容')
    await utimes(stale, 1, 1)
    await table.maintain([dir()])
    expect((await readdir(topics)).sort()).toEqual([UNSORTED_PAGE, `${UNSORTED_PAGE}.tmp-1-def456`])
    expect(await readdir(join(dir(), INDEX_DIR))).not.toContain(`${INDEX_ENTRY_FILE}.tmp-1-abc123`)
  })

  it('记忆换了作用域再彻底删除：原来那个目录的索引和派生库里都不留它', async () => {
    const WS = '/home/dev/proj-t'
    const wsDir = join(root, workspaceDirName(WS))
    await writeMem('s.md', record({ id: 'mem_s', name: '机密的名字', summary: '机密的摘要' }))
    const table = open()
    await table.maintain([dir()])
    expect(derived.pagesOf(dir(), 'mem_s')).toEqual([UNSORTED_PAGE])
    await table.update('mem_s', {}, r => ({ ...r, scope: 'workspace', workspacePath: WS }))
    expect(await read(pagePath(UNSORTED_PAGE))).not.toContain('机密')
    expect(derived.pagesOf(dir(), 'mem_s')).toEqual([])
    await table.maintain([wsDir])
    await table.delete('mem_s', { workspacePath: WS })
    for (const d of [dir(), wsDir]) {
      const pages = await readdir(join(d, INDEX_DIR, INDEX_TOPICS_DIR))
      for (const name of pages) expect(await read(join(d, INDEX_DIR, INDEX_TOPICS_DIR, name))).not.toContain('机密')
    }
    expect(await read(join(wsDir, WORKSPACE_MARKER))).toContain(WS)
  })
})

describe('派生库的成员表跟着维护走', () => {
  it('记下的签名和内容出自同一份文件：记的时候页已经被改成别的内容，签名记空', async () => {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    class Late extends FileTable {
      isArmed = false
      protected override async atomicWrite(filePath: string, text: string): Promise<void> {
        await super.atomicWrite(filePath, text)
        // MEMORY.md 是最后写的：它落盘之后、记派生库之前，页被改了
        if (this.isArmed && filePath.endsWith(INDEX_FILE)) await appendFile(pagePath(UNSORTED_PAGE), '\n后来加的。\n')
      }
    }
    const table = new Late({ root, stats: new InMemoryKvTable<RecallStats>(), index: derived })
    table.isArmed = true
    await table.maintain([dir()])
    expect(derived.topicPages(dir()).map(p => [p.page, p.sig])).toEqual([[UNSORTED_PAGE, '']])
  })

  it('维护后查得到各页的主题名、曾用名和成员；页在别处改过，下次维护换成新的成员和签名', async () => {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    await writeMem('b.md', record({ id: 'mem_b', name: 'beta' }))
    const table = open()
    await table.maintain([dir()])
    expect(derived.topicPages(dir()).map(p => [p.page, p.title, p.memberIds])).toEqual([[UNSORTED_PAGE, UNSORTED_TITLE, ['mem_a', 'mem_b']]])
    const sig = derived.topicPages(dir())[0]!.sig
    expect(sig).not.toBe('')
    await writeFile(entryPath(), `# ${ENTRY_TITLE}\n\n## 发版\n`)
    await writeFile(pagePath('发版.md'), `# 发版\n\n曾用名：上线、发布\n\n${line('mem_b', 'beta', 'b.md')}\n`)
    await writeFile(pagePath(UNSORTED_PAGE), `# ${UNSORTED_TITLE}\n\n${line('mem_a', 'alpha', 'a.md')}\n`)
    await table.maintain([dir()])
    expect(derived.topicPages(dir()).map(p => [p.page, p.title, p.aliases, p.memberIds])).toEqual([
      [UNSORTED_PAGE, UNSORTED_TITLE, [], ['mem_a']],
      ['发版.md', '发版', ['上线', '发布'], ['mem_b']],
    ])
    expect(derived.pagesOf(dir(), 'mem_b')).toEqual(['发版.md'])
    expect(derived.topicPages(dir())[0]!.sig).not.toBe(sig)
  })

  it('没接派生库时照常核对索引', async () => {
    await writeMem('a.md', record({ id: 'mem_a', name: 'alpha' }))
    await new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() }).maintain([dir()])
    expect(await indexedIds(dir())).toEqual(['mem_a'])
  })
})
