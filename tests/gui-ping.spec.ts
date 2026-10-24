import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryCommand, writePing } from '../src/gui/ping.ts'

// walking skeleton 的服务端半侧：/memory ping 命令写 <memoryRoot>/.state/gui/ping.json，
// 返回 JSON 文本；浏览器半侧订阅这个文件看版本变化。

const tmpDirs: string[] = []
async function makeTmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plastic-memory-gui-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

const invoke = (rawInput: string) => ({ rawInput })

describe('/memory ping', () => {
  it('writePing 在 .state/gui/ 下写带时间戳的 ping.json', async () => {
    const root = await makeTmpRoot()
    const rec = await writePing(root, 'startup', 1_700_000_000_000)
    const onDisk = JSON.parse(await readFile(join(root, '.state', 'gui', 'ping.json'), 'utf8')) as unknown
    expect(onDisk).toEqual({ at: new Date(1_700_000_000_000).toISOString(), source: 'startup' })
    expect(rec.path).toBe(join(root, '.state', 'gui', 'ping.json'))
  })

  it('命令名为 memory，ping 子命令重写文件并以 JSON 文本返回路径与时间戳', async () => {
    const root = await makeTmpRoot()
    const command = createMemoryCommand(root)
    expect(command.name).toBe('memory')
    const result = await command.handler(invoke(' ping'))
    expect(result.kind).toBe('success')
    const body = JSON.parse(result.text) as { path: string; at: string; source: string }
    expect(body.path).toBe(join(root, '.state', 'gui', 'ping.json'))
    expect(body.source).toBe('command')
    const onDisk = JSON.parse(await readFile(body.path, 'utf8')) as { at: string }
    expect(onDisk.at).toBe(body.at)
  })

  it('未知子命令返回 error，不写文件', async () => {
    const root = await makeTmpRoot()
    const result = await createMemoryCommand(root).handler(invoke(' nope'))
    expect(result.kind).toBe('error')
    await expect(readFile(join(root, '.state', 'gui', 'ping.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
