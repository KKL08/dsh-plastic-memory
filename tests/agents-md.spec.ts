import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { agentsMdPath, createAgentsMdWriter } from '../src/storage/agents-md.ts'

describe('agentsMdPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('独立解析 $DSH_HOME/AGENTS.md，不随自定义 memoryRoot 反推到别处', () => {
    vi.stubEnv('DSH_HOME', '/custom/dshhome')
    expect(agentsMdPath()).toBe('/custom/dshhome/AGENTS.md')
  })

  it('未设 DSH_HOME 时回落 ~/.dsh/AGENTS.md', () => {
    vi.stubEnv('DSH_HOME', undefined)
    expect(agentsMdPath()).toBe(join(homedir(), '.dsh', 'AGENTS.md'))
  })
})

describe('createAgentsMdWriter.append', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = join(tmpdir(), `dsh-agents-md-${process.pid}-${Math.floor(performance.now() * 1000)}`)
    await mkdir(dir, { recursive: true })
    file = join(dir, 'AGENTS.md')
  })

  it('文件不存在时建区块并含该行', async () => {
    await createAgentsMdWriter(file).append('用户偏好 pnpm')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('<!-- dsh-memory:start -->')
    expect(text).toContain('- 用户偏好 pnpm')
    expect(text).toContain('<!-- dsh-memory:end -->')
  })

  it('已有用户手写内容：只在区块内加，区块外不变', async () => {
    await writeFile(file, '# 我的全局指令\n\n手写规则一条\n', 'utf8')
    await createAgentsMdWriter(file).append('测试不 mock 数据库')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('# 我的全局指令')
    expect(text).toContain('手写规则一条')
    const inner = text.slice(text.indexOf('<!-- dsh-memory:start -->'), text.indexOf('<!-- dsh-memory:end -->'))
    expect(inner).toContain('- 测试不 mock 数据库')
  })

  it('同内容再 append 不重复（幂等）', async () => {
    const w = createAgentsMdWriter(file)
    await w.append('一条记忆')
    await w.append('一条记忆')
    const text = await readFile(file, 'utf8')
    expect(text.match(/- 一条记忆/g)?.length).toBe(1)
  })

  it('区块内追加第二条，两条都在', async () => {
    const w = createAgentsMdWriter(file)
    await w.append('第一条')
    await w.append('第二条')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('- 第一条')
    expect(text).toContain('- 第二条')
  })

  it('同一 writer 并发 append 两条不同内容：两条都落到文件（读改写不能互相覆盖）', async () => {
    const w = createAgentsMdWriter(file)
    await Promise.all([w.append('并发甲'), w.append('并发乙')])
    const text = await readFile(file, 'utf8')
    expect(text).toContain('- 并发甲')
    expect(text).toContain('- 并发乙')
  })

  it('判重按整行相等：前缀相同但更短的条目不算重复，两条都写入', async () => {
    const w = createAgentsMdWriter(file)
    await w.append('包管理 — 使用 pnpm 安装依赖并运行测试')
    await w.append('包管理 — 使用 pnpm 安装依赖')
    const text = await readFile(file, 'utf8')
    const inner = text.slice(text.indexOf('<!-- dsh-memory:start -->'), text.indexOf('<!-- dsh-memory:end -->'))
    const entries = inner.split('\n').filter(l => l.startsWith('- '))
    expect(entries).toEqual(['- 包管理 — 使用 pnpm 安装依赖并运行测试', '- 包管理 — 使用 pnpm 安装依赖'])
  })

  it('原子写：写入成功后目录不留 .tmp- 残留', async () => {
    await createAgentsMdWriter(file).append('一条记忆')
    const names = await readdir(dir)
    expect(names.some(n => n.includes('.tmp-'))).toBe(false)
  })

  it('多行内容折叠成单行条目（区块格式是一行一条）', async () => {
    await createAgentsMdWriter(file).append('部署流程：\n先跑测试\n再打 tag')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('- 部署流程： 先跑测试 再打 tag')
    const inner = text.slice(text.indexOf('<!-- dsh-memory:start -->'), text.indexOf('<!-- dsh-memory:end -->'))
    expect(inner.trim().split('\n').filter(l => l.startsWith('- ')).length).toBe(1)
  })

  it('内容含区块标记字面量：剔除后写入，后续 append 仍落真区块内', async () => {
    await writeFile(file, '# 用户手写区\n', 'utf8')
    const w = createAgentsMdWriter(file)
    await w.append('托管区块以 <!-- dsh-memory:end --> 结尾')
    await w.append('后来的一条')
    const text = await readFile(file, 'utf8')
    // 假标记不得存在：文件里 end 标记只出现一次（真界碑）
    expect(text.match(/<!-- dsh-memory:end -->/g)?.length).toBe(1)
    // 两条都在真区块内，用户手写区不被污染
    const inner = text.slice(text.indexOf('<!-- dsh-memory:start -->'), text.indexOf('<!-- dsh-memory:end -->'))
    expect(inner).toContain('托管区块以')
    expect(inner).toContain('- 后来的一条')
    expect(text.indexOf('# 用户手写区')).toBeLessThan(text.indexOf('<!-- dsh-memory:start -->'))
  })
})
