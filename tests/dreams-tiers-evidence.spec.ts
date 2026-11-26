import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_TOOL_NAMES } from '../src/contract-codes.ts'
import { evidenceKindOf, type EvidenceKindOptions } from '../src/tools/dreams-tiers.ts'
import type { RawEvent, SessionLog } from '../src/session-log.ts'
import { messageFrom } from './helpers/session-log.ts'

// 依据类别在执行器这一层按真实路径判：读记忆文件的、本插件工具的、判不了的都不算依据。真目录、真符号链接。

let base: string
let memoryRoot: string
let project: string
let home: string
let opts: EvidenceKindOptions

beforeAll(async () => {
  // 取真实路径：macOS 的临时目录在 /var 下、真实路径在 /private/var 下，不存在的记忆根只能按解析后的路径比
  base = await realpath(await mkdtemp(join(tmpdir(), 'pm-tier-evidence-')))
  home = join(base, 'home')
  memoryRoot = join(home, '.dsh', 'memories')
  project = join(base, 'proj')
  await mkdir(join(memoryRoot, 'global'), { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(join(memoryRoot, 'global', 'a.md'), '记忆正文')
  await writeFile(join(project, 'package.json'), '{"packageManager":"pnpm@9"}')
  await symlink(join(memoryRoot, 'global', 'a.md'), join(project, 'notes.md'))
  // 和记忆根同前缀的兄弟目录：不在记忆根里
  await mkdir(`${memoryRoot}-backup`, { recursive: true })
  await writeFile(join(`${memoryRoot}-backup`, 'a.md'), '备份的正文')
  opts = { pluginTools: MEMORY_TOOL_NAMES, memoryRoot, homeDir: home }
})
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

const call = (seq: number, name: string, args: unknown): RawEvent => ({ type: 'tool/call', seq, data: { callId: `c${seq}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
const result = (seq: number, callSeq: number, isError = false): RawEvent => ({ type: 'tool/result', seq, data: { message: { toolCallId: `c${callSeq}`, isError, content: [{ type: 'text', text: '结果' }] } } })
const assistant = (seq: number): RawEvent => ({ type: 'assistant/message', seq, data: { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text: '助手的话' }] } } })
/** 第三个参数显式传 undefined 表示拿不到继承边界；不传按 0。 */
const log = (events: RawEvent[], header: SessionLog['header'] = { isSeeded: false, cwd: project }, ...boundary: [inheritedEventCount?: number | undefined]): SessionLog =>
  ({ header, inheritedEventCount: boundary.length > 0 ? boundary[0] : 0, events: [{ type: 'turn/start', seq: 0, time: 1 }, messageFrom('user', 1, '看看包管理器'), ...events] })
/** 一次调用加它的结果（结果在 seq+1）。 */
const toolRun = (name: string, args: unknown, header?: SessionLog['header']) => evidenceKindOf(log([call(2, name, args), result(3, 2)], header), 3, opts)

describe('依据类别', () => {
  it('用户本人的消息算用户', async () => {
    expect(await evidenceKindOf(log([]), 1, opts)).toBe('user')
  })

  it('助手的话、别的来源开的消息、继承来的事件不算依据', async () => {
    expect(await evidenceKindOf(log([assistant(2)]), 2, opts)).toBe('other')
    expect(await evidenceKindOf(log([messageFrom('schedule', 2, '定时任务')]), 2, opts)).toBe('other')
    expect(await evidenceKindOf(log([], { isSeeded: true, cwd: project }, 5), 1, opts)).toBe('other')
    expect(await evidenceKindOf(log([]), 42, opts)).toBe('other')
  })

  it('记忆之外的文件、不带路径的工具结果算工具', async () => {
    expect(await toolRun('read', { path: join(project, 'package.json') })).toBe('tool')
    expect(await toolRun('read', { file_path: 'package.json' })).toBe('tool')
    expect(await toolRun('web_search', { query: 'pnpm 9 发布' })).toBe('tool')
  })

  it('失败的工具结果不算依据', async () => {
    expect(await evidenceKindOf(log([call(2, 'read', { path: join(project, 'package.json') }), result(3, 2, true)]), 3, opts)).toBe('other')
  })

  it('本插件工具的结果算插件', async () => {
    expect(await toolRun('read', { path: join(project, 'package.json') })).toBe('tool')
    expect(await toolRun('memory_search', { query: '包管理器' })).toBe('plugin')
  })

  it('绝对路径、家目录写法读记忆文件的算记忆', async () => {
    expect(await toolRun('read', { path: join(memoryRoot, 'global', 'a.md') })).toBe('memory')
    expect(await toolRun('read', { path: '~/.dsh/memories/global/a.md' })).toBe('memory')
  })

  it('经符号链接读到记忆文件的算记忆', async () => {
    expect(await toolRun('read', { path: join(project, 'package.json') })).toBe('tool')
    expect(await toolRun('read', { path: join(project, 'notes.md') })).toBe('memory')
    expect(await toolRun('read', { path: 'notes.md' })).toBe('memory')
  })

  it('会话的工作目录在记忆根里时，相对路径和不带路径的结果都算记忆', async () => {
    const inside = { isSeeded: false, cwd: join(memoryRoot, 'global') }
    expect(await toolRun('read', { path: 'a.md' }, inside)).toBe('memory')
    expect(await toolRun('grep', { pattern: 'pnpm' }, inside)).toBe('memory')
  })

  it('shell 类调用判不了', async () => {
    expect(await toolRun('read', { path: join(project, 'package.json') })).toBe('tool')
    expect(await toolRun('bash', { command: 'cat package.json' })).toBe('unknown')
    expect(await toolRun('run_tests', { cmd: 'pnpm test' })).toBe('unknown')
  })

  it('路径已不存在、相对路径没有工作目录、参数不是 JSON 对象：判不了', async () => {
    expect(await toolRun('read', { path: join(project, 'package.json') })).toBe('tool')
    expect(await toolRun('read', { path: join(project, 'gone.md') })).toBe('unknown')
    expect(await toolRun('read', { path: 'package.json' }, { isSeeded: false })).toBe('unknown')
    expect(await toolRun('read', '不是 JSON')).toBe('unknown')
  })

  it('路径数组里有一个落在记忆根里就算记忆', async () => {
    expect(await toolRun('read_many', { paths: [join(project, 'package.json'), join(memoryRoot, 'global', 'a.md')] })).toBe('memory')
  })

  it('归属分不清的事件（seeded 会话拿不到继承边界）不算依据', async () => {
    expect(await evidenceKindOf(log([]), 1, opts)).toBe('user')
    expect(await evidenceKindOf(log([], { isSeeded: true, cwd: project }, undefined), 1, opts)).toBe('other')
    expect(await evidenceKindOf(log([call(2, 'read', { path: join(project, 'package.json') }), result(3, 2)], { isSeeded: true, cwd: project }, undefined), 3, opts)).toBe('other')
  })

  it('$HOME、${HOME} 和 ~ 一样按家目录展开', async () => {
    expect(await toolRun('read', { path: '$HOME/.dsh/memories/global/a.md' })).toBe('memory')
    expect(await toolRun('read', { path: '${HOME}/.dsh/memories/global/a.md' })).toBe('memory')
  })

  it('记忆根的祖先目录：当路径参数给、或当工作目录且调用不带路径，都判不了', async () => {
    expect(await toolRun('grep', { pattern: 'pnpm', path: join(project, 'package.json') })).toBe('tool')
    expect(await toolRun('grep', { pattern: 'pnpm', path: home })).toBe('unknown')
    expect(await toolRun('grep', { pattern: 'pnpm', path: '~' })).toBe('unknown')
    expect(await toolRun('grep', { pattern: 'pnpm' }, { isSeeded: false, cwd: home })).toBe('unknown')
    expect(await toolRun('grep', { pattern: 'pnpm' }, { isSeeded: false, cwd: base })).toBe('unknown')
  })

  it('和记忆根同前缀的兄弟目录不在记忆根里', async () => {
    expect(await toolRun('read', { path: join(`${memoryRoot}-backup`, 'a.md') })).toBe('tool')
    expect(await toolRun('read', { path: join(memoryRoot, 'global', 'a.md') })).toBe('memory')
  })

  it('工具名、路径键、命令键不分大小写；路径键在任意层级的对象和数组里找', async () => {
    const memoryFile = join(memoryRoot, 'global', 'a.md')
    expect(await toolRun('Bash', { command: 'ls' })).toBe('unknown')
    expect(await toolRun('Memory_Search', { query: '包管理器' })).toBe('plugin')
    expect(await toolRun('read', { Path: memoryFile })).toBe('memory')
    expect(await toolRun('custom', { options: { Command: 'cat a.md' } })).toBe('unknown')
    expect(await toolRun('read', { options: { source: { FILE_PATH: memoryFile } } })).toBe('memory')
    expect(await toolRun('multi_edit', { edits: [{ file_path: join(project, 'package.json') }, { file_path: memoryFile }] })).toBe('memory')
    expect(await toolRun('multi_edit', { edits: [{ file_path: join(project, 'package.json') }] })).toBe('tool')
  })

  it('代码执行类工具、参数里带代码的调用照 shell 处理，判不了', async () => {
    expect(await toolRun('read', { path: join(project, 'package.json') })).toBe('tool')
    expect(await toolRun('python', { source: 'print(1)' })).toBe('unknown')
    expect(await toolRun('code_interpreter', { input: 'open("a.md")' })).toBe('unknown')
    expect(await toolRun('custom_exec', { code: 'require("fs").readFileSync("a.md")' })).toBe('unknown')
  })

  it('路径参数里有非字符串、空串：判不了', async () => {
    expect(await toolRun('read_many', { paths: [join(project, 'package.json')] })).toBe('tool')
    expect(await toolRun('read_many', { paths: [join(project, 'package.json'), 42] })).toBe('unknown')
    expect(await toolRun('read_many', { paths: [join(project, 'package.json'), ''] })).toBe('unknown')
    expect(await toolRun('read', { path: '' })).toBe('unknown')
    expect(await toolRun('read', { path: { nested: true } })).toBe('unknown')
    expect(await toolRun('read_many', { paths: [42, join(memoryRoot, 'global', 'a.md')] })).toBe('memory')
  })

  it('几个路径里有记忆就判记忆，其次判不了', async () => {
    expect(await toolRun('read_many', { paths: [join(project, 'gone.md'), join(memoryRoot, 'global', 'a.md')] })).toBe('memory')
    expect(await toolRun('read_many', { paths: [join(project, 'gone.md'), join(project, 'package.json')] })).toBe('unknown')
  })

  it('参数是合法 JSON 但不是对象：判不了', async () => {
    expect(await toolRun('read', JSON.stringify([join(project, 'package.json')]))).toBe('unknown')
    expect(await toolRun('read', JSON.stringify(join(project, 'package.json')))).toBe('unknown')
    expect(await toolRun('read', '42')).toBe('unknown')
    expect(await toolRun('read', 'null')).toBe('unknown')
  })

  it('工作目录取不到真实路径：不带路径和相对路径的判不了，绝对路径照常判，不抛错', async () => {
    const broken = { isSeeded: false, cwd: join(base, 'no-such-dir') }
    expect(await toolRun('web_search', { query: 'pnpm' }, broken)).toBe('unknown')
    expect(await toolRun('read', { path: 'package.json' }, broken)).toBe('unknown')
    expect(await toolRun('read', { path: join(project, 'package.json') }, broken)).toBe('tool')
    expect(await toolRun('read', { path: join(memoryRoot, 'global', 'a.md') }, broken)).toBe('memory')
  })

  it('记忆根取不到真实路径：按解析后的路径比，不抛错', async () => {
    const missingRoot = { ...opts, memoryRoot: join(base, 'no-such-root') }
    const run = (args: unknown) => evidenceKindOf(log([call(2, 'read', args), result(3, 2)]), 3, missingRoot)
    expect(await run({ path: join(project, 'package.json') })).toBe('tool')
    expect(await run({ path: base })).toBe('unknown')
  })

  it('找不到对应调用的工具结果判不了', async () => {
    expect(await evidenceKindOf(log([result(3, 99)]), 3, opts)).toBe('unknown')
  })
})
