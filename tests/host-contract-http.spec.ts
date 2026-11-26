import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { createHash } from 'node:crypto'
import { CheckupDiagnostics } from '../scripts/host-contract/checkup-diagnostics.ts'
import { parseSemanticFindings } from '../src/governance/semantic-scan.ts'
import { createHttpFixture, createHttpFixtureConfig } from '../scripts/host-contract/http-fixture.ts'

describe('宿主契约的 HTTP 替身', () => {
  it('每次生成独立的合成凭据和原文哨兵', () => {
    const first = createHttpFixtureConfig()
    const second = createHttpFixtureConfig()
    expect(first.credential).not.toBe(second.credential)
    expect(first.sentinel).not.toBe(second.sentinel)
  })

  it('模型列表和对话固定回带哨兵的 401，记录实际请求', async () => {
    const config = createHttpFixtureConfig()
    const fixture = createHttpFixture(config)
    const headers = { 'x-api-key': config.credential }
    const models = await fixture.fetch(config.modelsUrl, { headers })
    const messages = await fixture.fetch(new Request(config.messagesUrl, {
      method: 'POST', headers, body: JSON.stringify({ model: config.model }),
    }))
    expect(models.status).toBe(401)
    expect(messages.status).toBe(401)
    expect(await models.text()).toContain(config.sentinel)
    expect(await messages.text()).toContain(config.sentinel)
    expect(fixture.requests).toEqual([
      { url: config.modelsUrl, method: 'GET', credential: config.credential, authorization: null, provider: config.provider, model: null, matched: true, status: 401 },
      { url: config.messagesUrl, method: 'POST', credential: config.credential, authorization: null, provider: config.provider, model: config.model, matched: true, status: 401 },
    ])
  })

  it('550 的两种正文只按当前分组返回，模型列表仍回 401', async () => {
    const config = createHttpFixtureConfig()
    const fixture = createHttpFixture(config)
    for (const [mode, type] of [['server', 'api_error'], ['auth-type', 'authentication_error']] as const) {
      fixture.mode = mode
      const response = await fixture.fetch(config.messagesUrl, { method: 'POST', body: JSON.stringify({ model: config.model }) })
      expect(response.status).toBe(550)
      expect(await response.json()).toEqual({ error: { type, message: config.sentinel } })
      expect((await fixture.fetch(config.modelsUrl)).status).toBe(401)
    }
  })

  it('目标 URL 或方法未匹配就拒绝，同时留下未匹配记录', async () => {
    const config = createHttpFixtureConfig()
    const fixture = createHttpFixture(config)
    for (const [url, method] of [
      ['https://unmatched.invalid/models', 'GET'],
      [config.modelsUrl + '?extra=1', 'GET'],
      [config.modelsUrl, 'POST'],
      [config.messagesUrl, 'GET'],
    ]) {
      await expect(fixture.fetch(url, { method })).rejects.toThrow('未匹配的 HTTP 请求')
    }
    expect(fixture.requests).toHaveLength(4)
    expect(fixture.requests.every(r => !r.matched && r.status === null)).toBe(true)
  })

  it('凭据和模型照收到的值记录，不用夹具期望覆盖错误请求', async () => {
    const config = createHttpFixtureConfig()
    const fixture = createHttpFixture(config)
    await fixture.fetch(new URL(config.messagesUrl), {
      method: 'POST', headers: { 'x-api-key': 'synthetic-wrong', Authorization: 'Bearer synthetic-other' },
      body: JSON.stringify({ model: 'wrong-model' }),
    })
    expect(fixture.requests[0]).toMatchObject({ credential: 'synthetic-wrong', authorization: 'Bearer synthetic-other', model: 'wrong-model' })
  })

  it('无凭据环境生成官方配置，预加载后和普通导入共享请求记录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-http-fixture-'))
    const moduleUrl = new URL('../scripts/host-contract/http-fixture.ts', import.meta.url).href
    try {
      const state = join(dir, 'state.json')
      const patch = join(dir, 'patch.yml')
      const configPath = join(dir, 'fixture.json')
      const prepared = spawnSync(process.execPath, [fileURLToPath(moduleUrl), dir, '1', state, patch, configPath], { env: {}, encoding: 'utf8' })
      expect(prepared.status, prepared.stderr).toBe(0)
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      expect(parse(readFileSync(join(dir, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { HOST_CONTRACT_HTTP_KEY: config.credential }, records: {} })
      expect(statSync(join(dir, '.credentials.yaml')).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ kind: 'official' })
      expect(parse(readFileSync(patch, 'utf8'))).toEqual([
        { id: 'llm-deepseek', config: { apiKeyEnv: 'HOST_CONTRACT_HTTP_KEY', baseURL: config.baseUrl } },
        { id: 'agent-default-model', config: { provider: config.provider, model: config.model } },
      ])
      const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const preloadedFetch = fetch;
        const { httpFixture } = await import(${JSON.stringify(moduleUrl)});
        if (preloadedFetch !== httpFixture.fetch) throw new Error('预加载没有生效');
        const response = await fetch(httpFixture.config.modelsUrl);
        console.log(JSON.stringify({ status: response.status, count: httpFixture.requests.length }));
      `], { env: { HOST_CONTRACT_HTTP_FIXTURE: configPath, NODE_OPTIONS: `--import=${moduleUrl}` }, encoding: 'utf8' })
      expect(loaded.status, loaded.stderr).toBe(0)
      expect(JSON.parse(loaded.stdout)).toEqual({ status: 401, count: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('宿主契约自动体检用例的成功响应和诊断', () => {
  it('成功流包含可解析的真实记忆发现、用量和结束事件', async () => {
    const config = createHttpFixtureConfig()
    const fixture = createHttpFixture(config)
    fixture.mode = 'success'
    const response = await fixture.fetch(config.messagesUrl, {
      method: 'POST', body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: [{ type: 'text', text: '## 记忆列表（共 1 条）\n- id=mem_fixture type=knowledge scope=workspace\n  name: 流程约定' }] }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const events = (await response.text()).split('\n\n').filter(Boolean).map(event => JSON.parse(event.split('\ndata: ')[1]!))
    expect(events.map(event => event.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    const findings = parseSemanticFindings(events[2].delta.text, new Set(['mem_fixture']))
    expect(findings?.length).toBe(1)
    expect(findings?.[0]?.type).toBe('unclear')
    expect(findings?.[0]?.memoryIds).toEqual(['mem_fixture'])
    expect(events[4].delta.stop_reason).toBe('end_turn')
    expect(events[0].message.usage.input_tokens + events[4].usage.output_tokens).toBe(30)
    expect((await fixture.fetch(config.modelsUrl)).status).toBe(401)
    await expect(fixture.fetch(`${config.messagesUrl}/unexpected`, { method: 'POST' })).rejects.toThrow(/未匹配/)
  })

  it('诊断保留读取和解析错误，完成记录不冒充结果或视图写入', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-checkup-diagnostics-'))
    const workspace = join(root, 'workspace')
    const key = createHash('sha1').update(workspace).digest('hex')
    const recordDir = join(root, '.state', 'checkups')
    const viewDir = join(root, '.state', 'gui')
    try {
      mkdirSync(recordDir, { recursive: true })
      mkdirSync(viewDir, { recursive: true })
      const diagnostics = new CheckupDiagnostics(root, workspace)
      expect(diagnostics.sample()).toBeUndefined()
      writeFileSync(join(viewDir, 'checkups.json'), '{')
      writeFileSync(join(recordDir, `${key}.claim`), JSON.stringify({ pid: process.pid, at: 1, id: 'claim' }))
      writeFileSync(join(recordDir, `${key}.json`), JSON.stringify({ id: workspace, completed: { startedAt: 1, completedAt: 2, by: 'auto' } }))
      expect(diagnostics.sample()).toBeUndefined()
      expect(diagnostics.stages.claimed).toBe(true)
      expect(diagnostics.stages.completed).toBe(true)
      expect(diagnostics.stages.resultWritten).toBe(false)
      expect(diagnostics.stages.viewResultWritten).toBe(false)
      expect(diagnostics.detail()).toMatch(/ENOENT/)
      expect(diagnostics.detail()).toMatch(/JSON/)
      expect(diagnostics.detail()).toMatch(/"completedAt":2/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
