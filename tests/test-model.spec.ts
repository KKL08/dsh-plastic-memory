import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  TEST_MODEL_VARS, TestModelConfigError, alternatePatch, checkModelsEndpoint, findCatalogRoute, isOpenAiCompatible, prepareTestModel,
  resolveAlternateRoute, resolveTestModel,
} from '../scripts/host-contract/test-model.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/host-contract/test-model.ts', import.meta.url))
const CATALOG_DIR = ['node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data']

/** 假宿主目录：只有一份 route-x 的模型目录文件，一个 OpenAI 兼容模型、一个不兼容的。 */
async function fakeHost(): Promise<string> {
  const host = await mkdtemp(join(tmpdir(), 'pm-test-model-'))
  const dir = join(host, ...CATALOG_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'route-x.json'), JSON.stringify({
    'anthropic-messages': { 'model-a': { id: 'model-a', baseUrl: 'https://example.test/a' } },
    'openai-completions': { 'model-y': { id: 'model-y', baseUrl: 'https://example.test/v1' } },
  }))
  return host
}

// scripts/host-contract/test-model.ts：带 key 的真机检查用官方 key 还是另一条路由。
// 解析是纯函数；列模型那一步只在进程边界换掉 fetch，目录查找用临时目录里的假目录文件。

const ALT = { [TEST_MODEL_VARS.provider]: 'route-x', [TEST_MODEL_VARS.model]: 'model-y', [TEST_MODEL_VARS.apiKey]: 'k-test' }

describe('resolveTestModel：四种组合', () => {
  it('都不给：none', () => {
    expect(resolveTestModel({})).toEqual({ kind: 'none' })
  })
  it('只给官方 key：official', () => {
    expect(resolveTestModel({ DEEPSEEK_API_KEY: 'k-official' })).toEqual({ kind: 'official' })
  })
  it('只给替代路由三个变量：alternate，官方 key 没被忽略', () => {
    expect(resolveTestModel(ALT)).toEqual({ kind: 'alternate', provider: 'route-x', model: 'model-y', officialKeyIgnored: false })
  })
  it('两样都给：以替代路由为准，记下官方 key 被忽略', () => {
    expect(resolveTestModel({ ...ALT, DEEPSEEK_API_KEY: 'k-official' })).toEqual({ kind: 'alternate', provider: 'route-x', model: 'model-y', officialKeyIgnored: true })
  })
  it('空字符串当作没给', () => {
    expect(resolveTestModel({ DEEPSEEK_API_KEY: '', [TEST_MODEL_VARS.provider]: '', [TEST_MODEL_VARS.model]: '', [TEST_MODEL_VARS.apiKey]: '' })).toEqual({ kind: 'none' })
  })
})

describe('resolveTestModel：给一半直接报错，不退回官方', () => {
  for (const name of Object.values(TEST_MODEL_VARS)) {
    it(`缺 ${name} 时报错并点名缺的变量，即使官方 key 在`, () => {
      const env: Record<string, string | undefined> = { ...ALT, DEEPSEEK_API_KEY: 'k-official', [name]: undefined }
      expect(() => resolveTestModel(env)).toThrow(TestModelConfigError)
      expect(() => resolveTestModel(env)).toThrow(`missing: ${name}`)
    })
  }
  it('只给路由名：报两个缺的变量', () => {
    expect(() => resolveTestModel({ [TEST_MODEL_VARS.provider]: 'route-x' })).toThrow(`missing: ${TEST_MODEL_VARS.model}, ${TEST_MODEL_VARS.apiKey}`)
  })
  it('路由名不合文法（大写、路径分隔符）报错', () => {
    expect(() => resolveTestModel({ ...ALT, [TEST_MODEL_VARS.provider]: 'Route' })).toThrow(TestModelConfigError)
    expect(() => resolveTestModel({ ...ALT, [TEST_MODEL_VARS.provider]: '../x' })).toThrow(TestModelConfigError)
  })
  it('报错信息里没有 key', () => {
    expect.assertions(1)
    try {
      resolveTestModel({ ...ALT, [TEST_MODEL_VARS.model]: undefined })
    } catch (e) {
      expect(String(e)).not.toContain('k-test')
    }
  })
})

describe('alternatePatch', () => {
  it('加一条路由、key 只写变量名，默认模型指过去；值按字符串写，特殊字符不改变结构', () => {
    const patch = parse(alternatePatch({ provider: 'route-x', model: 'model: y #1' })) as unknown
    expect(patch).toEqual([
      { id: 'llm-pi-ai', config: { providers: { 'route-x': { apiKeyEnv: TEST_MODEL_VARS.apiKey } } } },
      { id: 'agent-default-model', config: { provider: 'route-x', model: 'model: y #1' } },
    ])
  })
})

describe('findCatalogRoute / resolveAlternateRoute', () => {
  let host: string
  beforeEach(async () => { host = await fakeHost() })
  afterEach(async () => { await rm(host, { recursive: true, force: true }) })

  it('找到模型所在的接口类型和地址', () => {
    expect(findCatalogRoute(host, 'route-x', 'model-y')).toEqual({ kind: 'found', route: { api: 'openai-completions', baseUrl: 'https://example.test/v1' } })
    expect(findCatalogRoute(host, 'route-x', 'model-a')).toEqual({ kind: 'found', route: { api: 'anthropic-messages', baseUrl: 'https://example.test/a' } })
  })
  it('没有目录文件和目录里没有这个模型分开报；路由名不合文法按没有目录文件算', () => {
    expect(findCatalogRoute(host, 'route-z', 'model-y')).toEqual({ kind: 'no-catalog-file', file: join(...CATALOG_DIR, 'route-z.json') })
    expect(findCatalogRoute(host, 'route-x', 'model-q')).toEqual({ kind: 'no-model' })
    expect(findCatalogRoute(host, '../route-x', 'model-y')).toEqual({ kind: 'no-catalog-file', file: join(...CATALOG_DIR) })
  })
  it('只认 OpenAI 兼容接口', () => {
    expect(isOpenAiCompatible('openai-completions')).toBe(true)
    expect(isOpenAiCompatible('openai-responses')).toBe(true)
    expect(isOpenAiCompatible('anthropic-messages')).toBe(false)
  })
  it('resolveAlternateRoute：三种不能用的情况各报各的', () => {
    expect(resolveAlternateRoute(host, { provider: 'route-x', model: 'model-y' })).toEqual({ api: 'openai-completions', baseUrl: 'https://example.test/v1' })
    expect(() => resolveAlternateRoute(host, { provider: 'route-z', model: 'model-y' })).toThrow(`no model catalog file ${join(...CATALOG_DIR, 'route-z.json')}`)
    expect(() => resolveAlternateRoute(host, { provider: 'route-x', model: 'model-q' })).toThrow('has no model "model-q"')
    expect(() => resolveAlternateRoute(host, { provider: 'route-x', model: 'model-a' })).toThrow('uses the anthropic-messages API')
  })
})

describe('checkModelsEndpoint：有可用模型 = 带 bearer 能列出模型', () => {
  const fakeFetch = (status: number) => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      return new Response('{}', { status })
    }) as typeof fetch
    return { impl, calls }
  }

  it('2xx 可用；地址末尾的斜杠去掉再接 /models', async () => {
    const { impl, calls } = fakeFetch(200)
    expect(await checkModelsEndpoint('https://example.test/v1/', 'k-test', impl)).toEqual({ ok: true })
    expect(calls).toEqual([{ url: 'https://example.test/v1/models', auth: 'Bearer k-test' }])
  })
  it('401 不可用，原因写状态码、不带 key', async () => {
    const r = await checkModelsEndpoint('https://example.test/v1', 'k-test', fakeFetch(401).impl)
    expect(r).toEqual({ ok: false, reason: 'GET https://example.test/v1/models returned 401' })
  })
  it('服务不可达不可用，原因写错误名', async () => {
    const impl = (async () => { throw new TypeError('fetch failed: k-test') }) as typeof fetch
    const r = await checkModelsEndpoint('https://example.test/v1', 'k-test', impl)
    expect(r).toEqual({ ok: false, reason: 'GET https://example.test/v1/models failed (TypeError)' })
  })
})

describe('prepareTestModel / 命令行 prepare', () => {
  let host: string
  let out: string
  beforeEach(async () => {
    host = await fakeHost()
    out = await mkdtemp(join(tmpdir(), 'pm-test-model-out-'))
  })
  afterEach(async () => {
    await rm(host, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  })
  const files = () => ({ stateFile: join(out, 'model.json'), patchFile: join(out, 'model.patch.yml') })
  const okFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch

  it('替代路由：状态文件和补丁文件里都没有 key', async () => {
    const { stateFile, patchFile } = files()
    const line = await prepareTestModel({ env: ALT, hostDir: host, stateFile, patchFile, fetchImpl: okFetch })
    const state = await readFile(stateFile, 'utf8')
    const patch = await readFile(patchFile, 'utf8')
    expect(JSON.parse(state)).toEqual({ kind: 'alternate', provider: 'route-x', model: 'model-y' })
    expect(parse(patch)).toEqual(parse(alternatePatch({ provider: 'route-x', model: 'model-y' })))
    for (const text of [state, patch, line]) expect(text).not.toContain('k-test')
  })
  it('替代路由的 key 列不出模型：状态里写明原因，仍写补丁', async () => {
    const { stateFile, patchFile } = files()
    await prepareTestModel({ env: ALT, hostDir: host, stateFile, patchFile, fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch })
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ kind: 'alternate', provider: 'route-x', model: 'model-y', unavailable: 'GET https://example.test/v1/models returned 401' })
    await access(patchFile)
  })
  for (const [label, env, kind] of [['都不给', {}, 'none'], ['只给官方 key', { DEEPSEEK_API_KEY: 'k-official' }, 'official']] as const) {
    it(`${label}：只写状态文件，不生成补丁`, async () => {
      const { stateFile, patchFile } = files()
      await prepareTestModel({ env, hostDir: host, stateFile, patchFile, fetchImpl: okFetch })
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ kind })
      await expect(access(patchFile)).rejects.toThrow()
    })
  }

  // 命令行：配置不对时退出码 2、不写文件；这几种都在列模型之前就停下，不联网
  const runCli = (env: Record<string, string>) => {
    const { stateFile, patchFile } = files()
    const base = { ...process.env }
    for (const name of [...Object.values(TEST_MODEL_VARS), 'DEEPSEEK_API_KEY']) delete base[name]
    return spawnSync(process.execPath, [SCRIPT, 'prepare', host, stateFile, patchFile], { encoding: 'utf8', env: { ...base, ...env } })
  }
  for (const [label, env, message] of [
    ['只给一半', { [TEST_MODEL_VARS.provider]: 'route-x' }, 'missing:'],
    ['宿主里没有这个提供方的目录文件', { ...ALT, [TEST_MODEL_VARS.provider]: 'route-z' }, 'no model catalog file'],
    ['目录里没有这个模型', { ...ALT, [TEST_MODEL_VARS.model]: 'model-q' }, 'has no model'],
    ['接口不是 OpenAI 兼容', { ...ALT, [TEST_MODEL_VARS.model]: 'model-a' }, 'anthropic-messages API'],
  ] as const) {
    it(`${label}：退出码 2，报错写明原因、不带 key，不写补丁`, async () => {
      const r = runCli(env)
      expect(r.status, r.stderr).toBe(2)
      expect(r.stderr).toContain(message)
      expect(r.stderr + r.stdout).not.toContain('k-test')
      await expect(access(files().patchFile)).rejects.toThrow()
    }, 15_000)
  }
})
