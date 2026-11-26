import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'

/** 每趟宿主的合成输入；URL 保持官方路由，使真实的模型列表加载路径仍会执行。 */
export interface HttpFixtureConfig {
  provider: string
  model: string
  baseUrl: string
  modelsUrl: string
  messagesUrl: string
  credential: string
  sentinel: string
}

/** 两种 550 正文分别验证状态码分类和认证类型的优先级。 */
export type HttpFixtureMode = 'auth' | 'server' | 'auth-type'

/** HTTP 实收值；provider 是 URL 对应的官方路由，GET 没有模型字段。 */
export interface HttpRequestRecord {
  url: string
  method: string
  credential: string | null
  authorization: string | null
  provider: string | null
  model: string | null
  matched: boolean
  status: number | null
}

/** 只允许返回预设响应的 fetch；未匹配请求也留证，再直接抛错。 */
export interface HttpFixture {
  config: HttpFixtureConfig
  mode: HttpFixtureMode
  requests: HttpRequestRecord[]
  fetch: typeof fetch
}

/** 生成测试输入，不读取环境或凭据文件；模型取宿主官方适配器的内置目录项。 */
export function createHttpFixtureConfig(): HttpFixtureConfig {
  const baseUrl = 'https://api.deepseek.com/anthropic'
  return {
    provider: 'deepseek-official', model: 'deepseek-flash', baseUrl,
    modelsUrl: 'https://api.deepseek.com/models', messagesUrl: `${baseUrl}/v1/messages`,
    credential: `host-contract-synthetic-${randomUUID()}`, sentinel: `http-response-sentinel-${randomUUID()}`,
  }
}

/** 不保存原 fetch，因此未匹配的 URL 或方法没有放行外网的路径。 */
export function createHttpFixture(config: HttpFixtureConfig): HttpFixture {
  const fixture: HttpFixture = {
    config, mode: 'auth', requests: [],
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const { url, method } = request
      const isModels = url === config.modelsUrl && method === 'GET'
      const isMessages = url === config.messagesUrl && method === 'POST'
      const matched = isModels || isMessages
      const status = matched ? (isModels || fixture.mode === 'auth' ? 401 : 550) : null
      const body = await request.text()
      const model = isMessages && body !== '' ? (JSON.parse(body) as { model?: string }).model ?? null : null
      fixture.requests.push({
        url, method, credential: request.headers.get('x-api-key'), authorization: request.headers.get('authorization'),
        provider: matched ? config.provider : null, model, matched, status,
      })
      if (status === null) throw new Error(`未匹配的 HTTP 请求：${method} ${url}`)
      const type = isModels || fixture.mode !== 'server' ? 'authentication_error' : 'api_error'
      return Response.json({ error: { type, message: config.sentinel } }, { status })
    },
  }
  return fixture
}

// NODE_OPTIONS 只在测试那趟设置；验证插件导入同一个模块，读取同一份请求记录。
const fixturePath = process.env.HOST_CONTRACT_HTTP_FIXTURE
/** 仅预加载进程持有实例；常规测试和其他宿主启动不安装拦截。 */
export const httpFixture = fixturePath === undefined ? undefined : createHttpFixture(JSON.parse(readFileSync(fixturePath, 'utf8')) as HttpFixtureConfig)
if (httpFixture !== undefined) globalThis.fetch = httpFixture.fetch

if (import.meta.main) {
  const [home, schemaVersion, statePath, patchPath, configPath] = process.argv.slice(2)
  const config = createHttpFixtureConfig()
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
  writeFileSync(statePath, JSON.stringify({ kind: 'official' }))
  const credentialsPath = join(home, '.credentials.yaml')
  writeFileSync(credentialsPath, stringify({ version: Number(schemaVersion), refs: { HOST_CONTRACT_HTTP_KEY: config.credential }, records: {} }), { mode: 0o600 })
  chmodSync(credentialsPath, 0o600)
  writeFileSync(patchPath, stringify([
    { id: 'llm-deepseek', config: { apiKeyEnv: 'HOST_CONTRACT_HTTP_KEY', baseURL: config.baseUrl } },
    { id: 'agent-default-model', config: { provider: config.provider, model: config.model } },
  ]))
}
