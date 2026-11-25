/**
 * 带 key 的真机检查用哪个模型：默认是官方 key（DEEPSEEK_API_KEY），也可以改走宿主多提供方适配器里的另一条路由。
 * 三个环境变量一起给才算数，给一半直接报错，不悄悄退回官方：
 *
 *   TEST_LLM_PROVIDER   路由名（宿主已装模型目录里的提供方 id，小写字母、数字和连字符）
 *   TEST_LLM_MODEL      该路由下的模型 id
 *   TEST_LLM_API_KEY    这条路由的 key。只经环境变量交给宿主（路由配置里写的是变量名），不落盘、不进日志
 *
 * 替代路由和官方 key 同时给时以替代路由为准，官方 key 不交给宿主，只对官方路由有意义的检查标跳过。
 * 「有可用模型」的判定：替代路由的 key 能列出模型（GET {baseUrl}/models 带 bearer 返回 2xx）。
 * 浏览器套件也用这里的同一组函数。
 *
 * 命令行（run.sh 调用）：
 *   node scripts/host-contract/test-model.ts check
 *   node scripts/host-contract/test-model.ts prepare <宿主目录> <状态文件> <补丁文件>
 * prepare 只在替代路由时写补丁文件；配置不对（给一半、宿主没带这个模型、接口不兼容）退出码 2。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const TEST_MODEL_VARS = { provider: 'TEST_LLM_PROVIDER', model: 'TEST_LLM_MODEL', apiKey: 'TEST_LLM_API_KEY' } as const
const OFFICIAL_KEY_VAR = 'DEEPSEEK_API_KEY'
/** 宿主多提供方适配器的路由键文法：小写字母、数字和连字符，首字符不是连字符。 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/

export type TestModelChoice =
  | { kind: 'none' }
  | { kind: 'official' }
  | { kind: 'alternate'; provider: string; model: string; officialKeyIgnored: boolean }

/** 交给验证插件的状态：用哪条路，替代路由不可用时写明原因（不含 key）。 */
export type TestModelState =
  | { kind: 'none' | 'official' }
  | { kind: 'alternate'; provider: string; model: string; unavailable?: string }

export class TestModelConfigError extends Error {}

const present = (value: string | undefined): value is string => value !== undefined && value !== ''

/** 从环境变量定这次用哪个模型。空字符串当作没给。替代路由的三个变量给了一部分时抛 TestModelConfigError。 */
export function resolveTestModel(env: Readonly<Record<string, string | undefined>>): TestModelChoice {
  const provider = env[TEST_MODEL_VARS.provider]
  const model = env[TEST_MODEL_VARS.model]
  const apiKey = env[TEST_MODEL_VARS.apiKey]
  const given = [provider, model, apiKey].filter(present).length
  if (given === 0) return present(env[OFFICIAL_KEY_VAR]) ? { kind: 'official' } : { kind: 'none' }
  if (!present(provider) || !present(model) || !present(apiKey)) {
    const missing = Object.values(TEST_MODEL_VARS).filter(name => !present(env[name]))
    throw new TestModelConfigError(`alternate test model needs all of ${Object.values(TEST_MODEL_VARS).join(', ')}; missing: ${missing.join(', ')}`)
  }
  if (!PROVIDER_ID.test(provider)) {
    throw new TestModelConfigError(`${TEST_MODEL_VARS.provider} must be lowercase letters, digits and hyphens, got ${JSON.stringify(provider)}`)
  }
  return { kind: 'alternate', provider, model, officialKeyIgnored: present(env[OFFICIAL_KEY_VAR]) }
}

/**
 * 替代路由的宿主补丁（patch-list 叠加层）：给多提供方适配器加一条路由，key 按变量名现取；把默认模型指到这条路由。
 * 值一律按 JSON 字符串写进 YAML，不拼原文。
 */
export function alternatePatch(choice: { provider: string; model: string }): string {
  const q = (s: string) => JSON.stringify(s)
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${q(choice.provider)}:`,
    `        apiKeyEnv: ${q(TEST_MODEL_VARS.apiKey)}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${q(choice.provider)}`,
    `    model: ${q(choice.model)}`,
    '',
  ].join('\n')
}

export interface CatalogRoute { api: string; baseUrl: string }

/** 目录查找的结果：找到；宿主里没有这个提供方的目录文件（相对宿主目录的路径）；文件在但没有这个模型。 */
export type CatalogLookup =
  | { kind: 'found'; route: CatalogRoute }
  | { kind: 'no-catalog-file'; file: string }
  | { kind: 'no-model' }

/**
 * 在宿主自带的模型目录里找这条路由的这个模型，返回接口类型和地址。目录文件按接口类型分组：{ [api]: { [modelId]: { baseUrl } } }。
 * 路由名不合文法时按没有目录文件算（不拼进路径，file 是目录本身）。
 */
export function findCatalogRoute(hostDir: string, provider: string, model: string): CatalogLookup {
  const dataDir = join(hostDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
  if (!PROVIDER_ID.test(provider)) return { kind: 'no-catalog-file', file: relative(hostDir, dataDir) }
  const file = join(dataDir, `${provider}.json`)
  const missing = { kind: 'no-catalog-file', file: relative(hostDir, file) } as const
  let catalog: unknown
  try {
    catalog = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return missing
    throw e
  }
  if (typeof catalog !== 'object' || catalog === null) return { kind: 'no-model' }
  for (const [api, models] of Object.entries(catalog as Record<string, unknown>)) {
    if (typeof models !== 'object' || models === null) continue
    const list = Array.isArray(models) ? models as unknown[] : Object.values(models)
    for (const entry of list) {
      const m = entry as { id?: unknown; baseUrl?: unknown }
      if (m.id === model && typeof m.baseUrl === 'string') return { kind: 'found', route: { api, baseUrl: m.baseUrl } }
    }
  }
  return { kind: 'no-model' }
}

/** 只用 OpenAI 兼容接口判断 key：列模型的地址和鉴权方式各家一致。 */
export const isOpenAiCompatible = (api: string) => api === 'openai-completions' || api === 'openai-responses'

export type ModelsCheck = { ok: true } | { ok: false; reason: string }

/** 「有可用模型」：带 bearer 列一次模型，2xx 即可用。原因里只有状态码或错误名，不带 key 和服务端原话。 */
export async function checkModelsEndpoint(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<ModelsCheck> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? { ok: true } : { ok: false, reason: `GET ${url} returned ${res.status}` }
  } catch (e) {
    return { ok: false, reason: `GET ${url} failed (${e instanceof Error ? e.name : 'error'})` }
  }
}

/** 替代路由在这个宿主上的地址：没有目录文件、目录里没有这个模型、接口不是 OpenAI 兼容时抛 TestModelConfigError。host:contract 和浏览器套件共用。 */
export function resolveAlternateRoute(hostDir: string, choice: { provider: string; model: string }): CatalogRoute {
  const want = `${choice.provider}/${choice.model}`
  const lookup = findCatalogRoute(hostDir, choice.provider, choice.model)
  if (lookup.kind === 'no-catalog-file') {
    throw new TestModelConfigError(`this host has no model catalog file ${lookup.file}; the alternate route ${want} only works on a host that ships that provider`)
  }
  if (lookup.kind === 'no-model') {
    throw new TestModelConfigError(`this host's model catalog has no model ${JSON.stringify(choice.model)} under provider ${JSON.stringify(choice.provider)}; the alternate route only works on a host that ships it`)
  }
  if (!isOpenAiCompatible(lookup.route.api)) {
    throw new TestModelConfigError(`model ${want} uses the ${lookup.route.api} API; the key check only supports OpenAI-compatible routes`)
  }
  return lookup.route
}

function describe(choice: TestModelChoice): string {
  if (choice.kind === 'none') return 'none (model-backed checks are skipped)'
  if (choice.kind === 'official') return `official key from ${OFFICIAL_KEY_VAR}`
  return `alternate route ${choice.provider}/${choice.model}, key from ${TEST_MODEL_VARS.apiKey}`
    + (choice.officialKeyIgnored ? ` (${OFFICIAL_KEY_VAR} is ignored)` : '')
}

export interface PrepareOptions {
  env: Readonly<Record<string, string | undefined>>
  hostDir: string
  stateFile: string
  patchFile: string
  fetchImpl?: typeof fetch
}

/**
 * prepare：定路由，写状态文件；替代路由时再查目录、判断 key、写补丁文件（其余情况不写补丁）。返回一行说明。
 * 配置不对抛 TestModelConfigError。两个文件里都只有路由名、模型 id 和变量名，没有 key。
 */
export async function prepareTestModel({ env, hostDir, stateFile, patchFile, fetchImpl = fetch }: PrepareOptions): Promise<string> {
  const choice = resolveTestModel(env)
  if (choice.kind !== 'alternate') {
    writeFileSync(stateFile, JSON.stringify({ kind: choice.kind } satisfies TestModelState))
    return describe(choice)
  }
  const route = resolveAlternateRoute(hostDir, choice)
  const check = await checkModelsEndpoint(route.baseUrl, env[TEST_MODEL_VARS.apiKey] ?? '', fetchImpl)
  const state: TestModelState = { kind: 'alternate', provider: choice.provider, model: choice.model, ...(check.ok ? {} : { unavailable: check.reason }) }
  writeFileSync(stateFile, JSON.stringify(state))
  writeFileSync(patchFile, alternatePatch(choice))
  return `${describe(choice)}: ${check.ok ? 'models endpoint reachable' : `unavailable, model-backed checks are skipped (${check.reason})`}`
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (command === 'check') {
      console.log(`test model = ${describe(resolveTestModel(process.env))}`)
    } else if (command === 'prepare' && args.length === 3) {
      console.log(`test model = ${await prepareTestModel({ env: process.env, hostDir: args[0], stateFile: args[1], patchFile: args[2] })}`)
    } else {
      console.error('usage: test-model.ts check | prepare <host dir> <state file> <patch file>')
      process.exit(64)
    }
  } catch (e) {
    if (!(e instanceof TestModelConfigError)) throw e
    console.error(`test model: ${e.message}`)
    process.exit(2)
  }
}
