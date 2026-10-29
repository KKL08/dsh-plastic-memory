import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/use-host.cjs：CI 下界档与试新宿主时把开发依赖改写到另一个宿主版本。脚本问 npm 要该版本宿主的依赖，
// 这里在 PATH 前面放一个假的 npm（进程边界），不联网；在临时目录里跑，不动仓库的 package.json。

const SCRIPT = fileURLToPath(new URL('../scripts/use-host.cjs', import.meta.url))
const REPO_PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url))
const HOST_DEPS = { '@deepseek-ai/cordis': '~4.9.1', '@deepseek-ai/schemastery': '^3.99.2', 'yaml': '^2.0.0' }

interface PackageJson { devDependencies: Record<string, string>; peerDependencies: Record<string, string> }

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-use-host-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function run(...args: string[]) {
  const bin = join(dir, 'bin')
  await mkdir(bin)
  // 假 npm：记下参数，回宿主的依赖表
  await writeFile(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, 'npm-args.txt')}"\nprintf '%s' '${JSON.stringify(HOST_DEPS)}'\n`)
  await chmod(join(bin, 'npm'), 0o755)
  await writeFile(join(dir, 'package.json'), await readFile(REPO_PACKAGE, 'utf8'))
  const out = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
  expect(out.status, out.stderr).toBe(0)
  return {
    pkg: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJson,
    npmArgs: (await readFile(join(dir, 'npm-args.txt'), 'utf8')).trim(),
  }
}

describe.skipIf(process.platform === 'win32')('use-host.cjs 改写宿主开发依赖', () => {
  it('所有 @deepseek-ai/dsh-* 开发依赖（不论运行时还是只取类型）都换成目标版本；cordis、schemastery 取该版本宿主的依赖并去掉范围前缀；其余依赖与 peer 不动', async () => {
    const before = JSON.parse(await readFile(REPO_PACKAGE, 'utf8')) as PackageJson
    const { pkg, npmArgs } = await run('9.9.9-rc.1')

    expect(npmArgs).toBe('view @deepseek-ai/dsh@9.9.9-rc.1 dependencies --json')
    const dshDeps = Object.keys(before.devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshDeps.length).toBeGreaterThan(3)
    for (const name of dshDeps) expect(pkg.devDependencies[name], name).toBe('9.9.9-rc.1')
    expect(pkg.devDependencies['@deepseek-ai/cordis']).toBe('4.9.1')
    expect(pkg.devDependencies['@deepseek-ai/schemastery']).toBe('3.99.2')
    const untouched = (deps: Record<string, string>) =>
      Object.fromEntries(Object.entries(deps).filter(([name]) => !name.startsWith('@deepseek-ai/')))
    expect(untouched(pkg.devDependencies)).toEqual(untouched(before.devDependencies))
    expect(pkg.peerDependencies).toEqual(before.peerDependencies)
  })

  it('不给版本时取 peer 下界（dsh-tools 的 >= 去掉）', async () => {
    const before = JSON.parse(await readFile(REPO_PACKAGE, 'utf8')) as PackageJson
    const floor = before.peerDependencies['@deepseek-ai/dsh-tools']!.replace(/^>=/, '')
    const { pkg, npmArgs } = await run()
    expect(npmArgs).toBe(`view @deepseek-ai/dsh@${floor} dependencies --json`)
    expect(pkg.devDependencies['@deepseek-ai/dsh-tools']).toBe(floor)
  })
})
