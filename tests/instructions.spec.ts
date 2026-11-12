import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheInstructions, createInstructionReader, INSTRUCTION_MAX_BYTES, instructionTexts, type ReadInstructions } from '../src/governance/instructions.ts'
import type { Scope } from '../src/scope.ts'

// 用宿主自己的指令文件包，在真实临时目录里读：全局层由 DSH_HOME、DSH_AGENTS_HOME 决定，都指到临时目录，不碰真实家目录
const loadHost = () => import('@deepseek-ai/dsh-agent-instructions')

let root: string
let dshHome: string
let agentsHome: string
const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-instructions-'))
  dshHome = join(root, 'dsh-home')
  agentsHome = join(root, 'agents-home')
  await mkdir(dshHome)
  await mkdir(agentsHome)
  process.env.DSH_HOME = dshHome
  process.env.DSH_AGENTS_HOME = agentsHome
})

afterEach(async () => {
  for (const [key, value] of [['DSH_HOME', saved.dsh], ['DSH_AGENTS_HOME', saved.agents]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

const project = async (name: string, files: Record<string, string>, opts: { isRepo?: boolean } = {}) => {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  if (opts.isRepo !== false) await mkdir(join(dir, '.git'))
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), text)
  }
  return dir
}
const ws = (workspacePath: string): Scope => ({ kind: 'workspace', workspacePath })
const GLOBAL: Scope = { kind: 'global' }

describe('取指令文件：按项目取全局层加项目层，全局只取全局层', () => {
  it('项目：全局 AGENTS.md 和项目根的 AGENTS.md 都在，渲染成一段文本，和宿主函数直接取到的逐字相同', async () => {
    await writeFile(join(dshHome, 'AGENTS.md'), '全局：注释用英文')
    const dir = await project('app', { 'AGENTS.md': '项目：包管理统一用 pnpm' })
    const read = createInstructionReader(loadHost)
    const files = await read(ws(dir))
    const { loadBaselineInstructions } = await loadHost()
    const direct = await loadBaselineInstructions({ cwd: dir, maxBytes: INSTRUCTION_MAX_BYTES })
    expect(files).toEqual({ kind: 'found', texts: [direct!.text], isTruncated: false })
    expect(files.kind === 'found' && files.texts[0]).toContain('注释用英文')
    expect(files.kind === 'found' && files.texts[0]).toContain('包管理统一用 pnpm')
  })

  it('全局：只有全局层，项目文件不进来', async () => {
    await writeFile(join(dshHome, 'AGENTS.md'), '全局：注释用英文')
    await writeFile(join(agentsHome, 'AGENTS.md'), '共享：提交前跑测试')
    await project('app', { 'AGENTS.md': '项目：包管理统一用 pnpm' })
    const files = await createInstructionReader(loadHost)(GLOBAL)
    expect(files.kind).toBe('found')
    const text = instructionTexts(files)!.join('\n')
    expect(text).toContain('注释用英文')
    expect(text).toContain('提交前跑测试')
    expect(text).not.toContain('pnpm')
  })

  it('子目录里的指令文件不算项目的：只取项目根往上的', async () => {
    const dir = await project('app', { 'AGENTS.md': '根：用 pnpm', 'packages/web/AGENTS.md': '子目录：用 yarn' })
    const text = instructionTexts(await createInstructionReader(loadHost)(ws(dir)))!.join('\n')
    expect(text).toContain('用 pnpm')
    expect(text).not.toContain('用 yarn')
  })

  it('没有 .git：项目根就是这个目录本身', async () => {
    const dir = await project('loose', { 'CLAUDE.md': '散目录：用 bun' }, { isRepo: false })
    expect(instructionTexts(await createInstructionReader(loadHost)(ws(dir)))!.join('\n')).toContain('用 bun')
  })

  it('一个指令文件都没有：没有内容（不是取不到）；项目目录不存在也一样', async () => {
    const dir = await project('empty', {})
    const read = createInstructionReader(loadHost)
    expect(await read(ws(dir))).toEqual({ kind: 'none' })
    expect(await read(ws(join(root, 'missing')))).toEqual({ kind: 'none' })
    expect(await read(GLOBAL)).toEqual({ kind: 'none' })
    expect(instructionTexts({ kind: 'none' })).toBeNull()
  })

  it('总量超过上限：只留宿主截下的部分，标出被截断', async () => {
    await writeFile(join(dshHome, 'AGENTS.md'), `全局开头\n${'g'.repeat(INSTRUCTION_MAX_BYTES)}`)
    const dir = await project('big', { 'AGENTS.md': `项目开头\n${'p'.repeat(INSTRUCTION_MAX_BYTES)}` })
    const files = await createInstructionReader(loadHost)(ws(dir))
    const { loadBaselineInstructions } = await loadHost()
    const direct = await loadBaselineInstructions({ cwd: dir, maxBytes: INSTRUCTION_MAX_BYTES })
    expect(files).toEqual({ kind: 'found', texts: [direct!.text], isTruncated: true })
  })

  it('宿主包加载不了、函数抛错：取不到，带原因', async () => {
    const missing = createInstructionReader(() => Promise.reject(new Error('Cannot find package')))
    expect(await missing(GLOBAL)).toEqual({ kind: 'unavailable', reason: 'Cannot find package' })
    const throwing = createInstructionReader(async () => ({ loadBaselineInstructions: () => Promise.reject(new Error('EACCES')) }))
    expect(await throwing(ws(root))).toEqual({ kind: 'unavailable', reason: 'EACCES' })
  })
})

describe('一次体检内按作用域只读一次', () => {
  it('同一作用域第二次取用第一次的结果；不同作用域各读各的', async () => {
    const calls: string[] = []
    const read: ReadInstructions = async scope => {
      calls.push(scope.kind === 'global' ? 'global' : scope.workspacePath)
      return { kind: 'none' }
    }
    const cached = cacheInstructions(read)
    await Promise.all([cached(ws('/a')), cached(ws('/a')), cached(GLOBAL)])
    await cached(GLOBAL)
    await cached(ws('/b'))
    expect(calls).toEqual(['/a', 'global', '/b'])
  })
})
