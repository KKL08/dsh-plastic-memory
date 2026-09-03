import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMemoryRoot, slugifyName, workspaceDirName } from '../src/storage/paths.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

describe('resolveMemoryRoot', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('配置优先；DSH_HOME 次之；homedir 兜底', () => {
    expect(resolveMemoryRoot('/tmp/custom')).toBe('/tmp/custom')
    vi.stubEnv('DSH_HOME', '/tmp/dshhome')
    expect(resolveMemoryRoot('')).toBe(join('/tmp/dshhome', 'memories'))
    vi.stubEnv('DSH_HOME', undefined)
    expect(resolveMemoryRoot('')).toBe(join(homedir(), '.dsh', 'memories'))
  })
})

describe('workspaceDirName', () => {
  it('确定性且含 hash 后缀；带连字符的路径不会互撞（Critical #1 回归钉）', () => {
    const a = workspaceDirName('/home/dev/example-project')
    const b = workspaceDirName('/home/dev/example/project') // slug 反推会混淆的两个路径
    expect(a).toBe(workspaceDirName('/home/dev/example-project'))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^example-project-[0-9a-f]{8}$/)
  })

  it('slugifyName 保留中文、替换不安全字符、截断', () => {
    expect(slugifyName('包管理用 pnpm')).toBe('包管理用-pnpm')
    expect(slugifyName('a/b\\c:d*e')).toBe('a-b-c-d-e')
    expect(slugifyName('')).toBe('memory')
    expect(slugifyName('x'.repeat(80)).length).toBe(40)
  })
})

// slugifyName 在 40 字符截断边界的边缘案例（属性测试先揪出：去尾连字符曾发生在 slice 之前，
// 截断落在分隔符位会重新露出尾部 '-'，导致 slug 不幂等、文件名以 '-' 结尾）。
describe('slugifyName 截断边界', () => {
  it('第 40 位恰是分隔符：结果不以 - 结尾且幂等', () => {
    const name = 'a'.repeat(39) + ' 0'
    const once = slugifyName(name)
    expect(once.endsWith('-')).toBe(false)
    expect(slugifyName(once)).toBe(once)
  })

  it('全是分隔符的名字回落为 memory', () => {
    expect(slugifyName('/ \\ : *')).toBe('memory')
  })

  it('只有连字符的名字（去边后为空）回落为 memory', () => {
    expect(slugifyName('-'.repeat(50))).toBe('memory')
  })

  it('已是合法 slug 的输入原样返回', () => {
    expect(slugifyName('abc-def_中文.v2')).toBe('abc-def_中文.v2')
  })

  it('前导分隔符加超长输入：去掉前导后截到 40 位', () => {
    expect(slugifyName('/' + 'b'.repeat(60))).toBe('b'.repeat(40))
  })
})
