import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { hostSemanticLlm } from '../src/governance/host-llm.ts'
import {
  ModelSelectionStore, ModelSelectionUnreadable, checkSelection, createBackgroundLlmResolver, listModelChoices, resolveSelection, type HostModelCatalog,
} from '../src/governance/background-llm.ts'
import type { ModelSelection } from '../src/gui/contract.ts'
import { sidecarSchemas } from './helpers/plugin-env.ts'
import { breakModelSelection } from './helpers/model-selection-file.ts'

// 后台模型的选择：真实的选择表（.state 侧表文件），只把宿主 llm 服务（列提供方、列模型、模型详情、调模型）换成假的。

const DEFAULT_ROUTE = { provider: 'provider-x', model: 'model-default' }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-background-llm-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** 宿主 llm 服务的替身：提供方 → 模型 → 推理强度；stream 记下请求，回一段文本。 */
function fakeHostLlm(catalog: Record<string, { name?: string; models: Record<string, { efforts?: string[]; defaultEffort?: string; detailThrows?: true }> | 'throws' | 'no-adapter' }>) {
  const requests: GenerateOptions[] = []
  const service: HostModelCatalog & { stream(req: GenerateOptions): AsyncIterable<StreamChunk> } = {
    listProviders: () => Object.entries(catalog).map(([id, p]) => ({ id, name: p.name ?? id })),
    async listModels(provider) {
      const p = catalog[provider]
      if (p === undefined) throw Object.assign(new Error(`no adapter registered for provider "${provider}"`), { code: 'NO_ADAPTER' })
      if (p.models === 'throws') throw Object.assign(new Error('listing failed'), { code: 'TRANSPORT' })
      // 列提供方之后、列模型之前提供方被删掉
      if (p.models === 'no-adapter') throw Object.assign(new Error(`no adapter registered for provider "${provider}"`), { code: 'NO_ADAPTER' })
      return Object.keys(p.models).map(id => ({ provider, id, name: `${id} 名称` }))
    },
    async resolveModelInfo(provider, model) {
      const p = catalog[provider]
      if (p === undefined) throw Object.assign(new Error('gone'), { code: 'NO_ADAPTER' })
      const m = typeof p.models === 'string' ? undefined : p.models[model]
      if (m === undefined) throw Object.assign(new Error('unknown model'), { code: 'UNKNOWN_MODEL' })
      if (m.detailThrows === true) throw Object.assign(new Error('detail failed'), { code: 'TRANSPORT' })
      return {
        provider, id: model, name: model,
        ...(m.efforts === undefined ? {} : { reasoning: { efforts: m.efforts.map(id => ({ id, name: `强度 ${id}` })), ...(m.defaultEffort === undefined ? {} : { defaultEffort: m.defaultEffort }) } }),
      }
    },
    async *stream(req) {
      requests.push(req)
      yield { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    },
  }
  return { service, requests }
}

const CATALOG = {
  'provider-x': { name: '提供方 X', models: { 'model-default': {}, 'model-a': { efforts: ['low', 'high'], defaultEffort: 'high' } } },
  'provider-y': { models: { 'model-b': { efforts: ['low', 'high'] } } },
}

function setup(catalog: Parameters<typeof fakeHostLlm>[0] = CATALOG) {
  const host = fakeHostLlm(catalog)
  const sidecar = new SidecarStore({ root, schemas: sidecarSchemas })
  const selections = new ModelSelectionStore(sidecar.modelSelections)
  const deps = { selections, catalog: () => host.service, llmFor: (s: ModelSelection) => hostSemanticLlm(host.service, s) }
  const resolve = createBackgroundLlmResolver({ ...deps, defaultLlm: () => hostSemanticLlm(host.service, DEFAULT_ROUTE) })
  /** 解析出来的模型真调一次，看请求带了什么。 */
  const call = async (r: Awaited<ReturnType<typeof resolve>>) => {
    await r.llm!.complete({ system: 's', user: 'u' })
    return host.requests.at(-1)!
  }
  return { host, sidecar, selections, deps, resolve, call }
}

describe('选择的存取：不绑具体键', () => {
  it('任意键各存一份，null 删掉改回跟随；没存过读到 null', async () => {
    const { selections } = setup()
    expect(await selections.read('checkup')).toBeNull()
    await selections.set('checkup', { provider: 'provider-x', model: 'model-a', reasoningEffort: 'low' })
    await selections.set('expansion', { provider: 'provider-y', model: 'model-b' })
    expect(await selections.read('checkup')).toEqual({ provider: 'provider-x', model: 'model-a', reasoningEffort: 'low' })
    expect(await selections.read('expansion')).toEqual({ provider: 'provider-y', model: 'model-b' })
    await selections.set('checkup', null)
    expect(await selections.read('checkup')).toBeNull()
    await selections.set('checkup', null)
    expect(await selections.read('expansion')).toEqual({ provider: 'provider-y', model: 'model-b' })
  })

  it('几个进程读到同一个：一个进程存的选择，另一个进程的选择表（同一个记忆根）现读就是它', async () => {
    const a = new ModelSelectionStore(new SidecarStore({ root, schemas: sidecarSchemas }).modelSelections)
    const b = new ModelSelectionStore(new SidecarStore({ root, schemas: sidecarSchemas }).modelSelections)
    await a.set('checkup', { provider: 'provider-y', model: 'model-b', reasoningEffort: 'high' })
    expect(await b.read('checkup')).toEqual({ provider: 'provider-y', model: 'model-b', reasoningEffort: 'high' })
    await b.set('checkup', null)
    expect(await a.read('checkup')).toBeNull()
  })
})

describe('「还在不在」的校验', () => {
  it('提供方、模型、推理强度都在：没有问题；不带推理强度不查强度', async () => {
    const { host } = setup()
    expect(await checkSelection(host.service, { provider: 'provider-x', model: 'model-a', reasoningEffort: 'low' })).toBeUndefined()
    expect(await checkSelection(host.service, { provider: 'provider-x', model: 'model-default' })).toBeUndefined()
  })

  it('提供方被删、模型下架、推理强度不再支持：各自给出原因', async () => {
    const { host } = setup()
    expect(await checkSelection(host.service, { provider: 'provider-gone', model: 'model-a' })).toBe('provider-gone')
    expect(await checkSelection(host.service, { provider: 'provider-x', model: 'model-gone' })).toBe('model-gone')
    expect(await checkSelection(host.service, { provider: 'provider-x', model: 'model-a', reasoningEffort: 'max' })).toBe('effort-gone')
    expect(await checkSelection(host.service, { provider: 'provider-x', model: 'model-default', reasoningEffort: 'low' })).toBe('effort-gone')
  })

  it('没有宿主 llm 服务：算提供方不在', async () => {
    expect(await checkSelection(undefined, { provider: 'provider-x', model: 'model-a' })).toBe('provider-gone')
  })

  it('列模型出错（不是提供方被删）：确认不了，不算不在', async () => {
    const { host } = setup({ 'provider-x': { models: 'throws' } })
    expect(await checkSelection(host.service, { provider: 'provider-x', model: 'model-a' })).toBeUndefined()
  })

  it('列提供方出错：确认不了，不算不在；宿主报 NO_ADAPTER 时仍算提供方不在', async () => {
    const { host } = setup()
    const failing = (code: string): HostModelCatalog => ({ ...host.service, listProviders: () => { throw Object.assign(new Error('listing providers failed'), { code }) } })
    expect(await checkSelection(failing('TRANSPORT'), { provider: 'provider-x', model: 'model-a' })).toBeUndefined()
    expect(await checkSelection(failing('NO_ADAPTER'), { provider: 'provider-x', model: 'model-a' })).toBe('provider-gone')
  })
})

describe('解析器：自动体检', () => {
  it('没选：用宿主默认模型，不算退回', async () => {
    const s = setup()
    const r = await s.resolve('checkup')
    expect(r).toMatchObject({ isSelected: false, fellBack: false })
    expect(r.reason).toBeUndefined()
    expect(await s.call(r)).toMatchObject(DEFAULT_ROUTE)
  })

  it('选了模型和推理强度：调用带上它们', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-y', model: 'model-b', reasoningEffort: 'high' })
    const r = await s.resolve('checkup')
    expect(r).toMatchObject({ isSelected: true, fellBack: false })
    expect(await s.call(r)).toMatchObject({ provider: 'provider-y', model: 'model-b', reasoningEffort: 'high' })
  })

  it('选了模型、没选推理强度：调用不带推理强度', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    const req = await s.call(await s.resolve('checkup'))
    expect(req).toMatchObject({ provider: 'provider-x', model: 'model-a' })
    expect(req).not.toHaveProperty('reasoningEffort')
  })

  it('选的模型下架了：退回默认模型，fellBack 和原因对应', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-gone' })
    const r = await s.resolve('checkup')
    expect(r).toMatchObject({ isSelected: false, fellBack: true, reason: 'model-gone' })
    expect(await s.call(r)).toMatchObject(DEFAULT_ROUTE)
  })

  it('选的提供方被删了（宿主报 NO_ADAPTER）：同样退回默认模型', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-gone', model: 'model-b' })
    const r = await s.resolve('checkup')
    expect(r).toMatchObject({ fellBack: true, reason: 'provider-gone' })
    expect(await s.call(r)).toMatchObject(DEFAULT_ROUTE)
  })

  it('列提供方出错：确认不了，照常用选的模型，不算退回', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-y', model: 'model-b' })
    const resolve = createBackgroundLlmResolver({
      ...s.deps,
      catalog: () => ({ ...s.host.service, listProviders: () => { throw Object.assign(new Error('listing providers failed'), { code: 'TRANSPORT' }) } }),
      defaultLlm: () => hostSemanticLlm(s.host.service, DEFAULT_ROUTE),
    })
    const r = await resolve('checkup')
    expect(r).toMatchObject({ isSelected: true, fellBack: false })
    expect(await s.call(r)).toMatchObject({ provider: 'provider-y', model: 'model-b' })
  })

  it('退回默认模型时宿主也没有默认模型：llm 为 null，仍说明是退回', async () => {
    const host = fakeHostLlm(CATALOG)
    const selections = new ModelSelectionStore(new SidecarStore({ root, schemas: sidecarSchemas }).modelSelections)
    await selections.set('checkup', { provider: 'provider-x', model: 'model-gone' })
    const resolve = createBackgroundLlmResolver({ selections, catalog: () => host.service, llmFor: s => hostSemanticLlm(host.service, s), defaultLlm: () => null })
    expect(await resolve('checkup')).toEqual({ llm: null, isSelected: false, fellBack: true, reason: 'model-gone' })
  })

  it('解析器只收选择键，不收会话参数', () => {
    expect(setup().resolve.length).toBe(1)
  })
})

describe('解析器：记忆梦境（解析链每一步）', () => {
  it('梦境自己选了：用梦境选的，不看自动体检的', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    await s.selections.set('dreams', { provider: 'provider-y', model: 'model-b', reasoningEffort: 'low' })
    const r = await s.resolve('dreams')
    expect(r.fellBack).toBe(false)
    expect(await s.call(r)).toMatchObject({ provider: 'provider-y', model: 'model-b', reasoningEffort: 'low' })
  })

  it('梦境没选：跟随自动体检选的，不算退回', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' })
    const r = await s.resolve('dreams')
    expect(r).toMatchObject({ isSelected: true, fellBack: false })
    expect(await s.call(r)).toMatchObject({ provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' })
  })

  it('梦境和自动体检都没选：用宿主默认模型', async () => {
    const s = setup()
    const r = await s.resolve('dreams')
    expect(r.fellBack).toBe(false)
    expect(await s.call(r)).toMatchObject(DEFAULT_ROUTE)
  })

  it('梦境选的失效、自动体检选的还在：退一步用自动体检的，算退回', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    await s.selections.set('dreams', { provider: 'provider-gone', model: 'model-b' })
    const r = await s.resolve('dreams')
    expect(r).toMatchObject({ fellBack: true, reason: 'provider-gone' })
    expect(await s.call(r)).toMatchObject({ provider: 'provider-x', model: 'model-a' })
  })

  it('两个都失效：退回宿主默认模型，原因取梦境那一步的', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-gone', model: 'model-a' })
    await s.selections.set('dreams', { provider: 'provider-y', model: 'model-gone' })
    const r = await s.resolve('dreams')
    expect(r).toMatchObject({ fellBack: true, reason: 'model-gone' })
    expect(await s.call(r)).toMatchObject(DEFAULT_ROUTE)
  })

  it('梦境没选、自动体检选的失效：退回宿主默认模型，算退回', async () => {
    const s = setup()
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-a', reasoningEffort: 'max' })
    const r = await s.resolve('dreams')
    expect(r).toMatchObject({ fellBack: true, reason: 'effort-gone' })
    expect(await s.call(r)).toMatchObject(DEFAULT_ROUTE)
  })
})

describe('选择文件在、却读不出', () => {
  /** 解析时宿主侧被碰过几次：建模型调用（选的、默认的、退回目标）、列提供方。 */
  function counted() {
    const s = setup()
    const calls = { llmFor: 0, defaultLlm: 0, fallback: 0, catalog: 0 }
    const deps = {
      selections: s.selections,
      catalog: () => { calls.catalog++; return s.host.service },
      llmFor: (selection: ModelSelection) => { calls.llmFor++; return hostSemanticLlm(s.host.service, selection) },
    }
    const resolve = createBackgroundLlmResolver({ ...deps, defaultLlm: () => { calls.defaultLlm++; return hostSemanticLlm(s.host.service, DEFAULT_ROUTE) } })
    const fallback = () => { calls.fallback++; return hostSemanticLlm(s.host.service, DEFAULT_ROUTE) }
    return { ...s, calls, deps, resolve, fallback }
  }

  /** 选择文件读不出时的这一条（how 是读不出的造法）。 */
  const checkupUnreadable = async (how: 'bad-json' | 'no-permission') => {
    const s = counted()
    const broken = await breakModelSelection(root, 'checkup', how)
    await expect(s.resolve('checkup')).rejects.toBeInstanceOf(ModelSelectionUnreadable)
    expect(s.calls).toEqual({ llmFor: 0, defaultLlm: 0, fallback: 0, catalog: 0 })
    expect(s.host.requests).toEqual([])
    if (how === 'bad-json') expect(await readFile(broken.path, 'utf8')).toBe(broken.text)
  }
  it('自动体检的选择读不出（bad-json）：抛读不出，不退回默认模型、不建任何模型调用；选择文件原样留着', () => checkupUnreadable('bad-json'))
  // root 读得了没有读权限的文件
  it.skipIf(process.getuid?.() === 0)('自动体检的选择读不出（no-permission）：抛读不出，不退回默认模型、不建任何模型调用；选择文件原样留着', () => checkupUnreadable('no-permission'))

  it('梦境自己的选择读不出：不跟随自动体检选的，也不退回默认模型', async () => {
    const s = counted()
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    await breakModelSelection(root, 'dreams', 'bad-json')
    await expect(s.resolve('dreams')).rejects.toBeInstanceOf(ModelSelectionUnreadable)
    expect(s.calls).toEqual({ llmFor: 0, defaultLlm: 0, fallback: 0, catalog: 0 })
  })

  it('梦境没选、自动体检的选择读不出：不退回默认模型', async () => {
    const s = counted()
    await breakModelSelection(root, 'checkup', 'bad-json')
    await expect(s.resolve('dreams')).rejects.toBeInstanceOf(ModelSelectionUnreadable)
    expect(s.calls).toEqual({ llmFor: 0, defaultLlm: 0, fallback: 0, catalog: 0 })
  })

  // root 读得了没有读权限的文件
  it.skipIf(process.getuid?.() === 0)('第三个键（检索扩查）读不出：不退到调用方给的退回目标', async () => {
    const s = counted()
    await breakModelSelection(root, 'expansion', 'no-permission')
    await expect(resolveSelection(['expansion'], s.deps, s.fallback)).rejects.toBeInstanceOf(ModelSelectionUnreadable)
    expect(s.calls).toEqual({ llmFor: 0, defaultLlm: 0, fallback: 0, catalog: 0 })
  })

  it.each([
    ['checkup', '设置里为体检选的模型读不出来，这次没有调用模型。可以在设置里重新选一次'],
    ['dreams', '设置里为记忆梦境选的模型读不出来，这次没有调用模型'],
    ['expansion', '设置里为补搜选的模型读不出来，这次没有调用模型'],
  ] as const)('%s 读不出时的说明用界面上的功能名，不露出选择键', async (key, message) => {
    const s = counted()
    await breakModelSelection(root, key, 'bad-json')
    await expect(resolveSelection([key], s.deps, s.fallback)).rejects.toThrow(new ModelSelectionUnreadable(key).message)
    expect(new ModelSelectionUnreadable(key).message).toBe(message)
  })

  it('读不出不当成没选：给显示用的读取方读到 unreadable，之后重新选一次就恢复', async () => {
    const s = counted()
    await breakModelSelection(root, 'checkup', 'bad-json')
    expect(await s.selections.read('checkup')).toBe('unreadable')
    await s.selections.set('checkup', { provider: 'provider-x', model: 'model-a' })
    const r = await s.resolve('checkup')
    expect(r).toMatchObject({ isSelected: true, fellBack: false })
    expect(await s.call(r)).toMatchObject({ provider: 'provider-x', model: 'model-a' })
  })
})

describe('通用解析：别的键、别的退回目标', () => {
  it('第三个键用自己的退回目标（如主对话的模型）：没选用它、不算退回；选的失效也退到它', async () => {
    const s = setup()
    const main = () => hostSemanticLlm(s.host.service, { provider: 'provider-y', model: 'model-b' })
    const unset = await resolveSelection(['expansion'], s.deps, main)
    expect(unset.fellBack).toBe(false)
    expect(await s.call(unset)).toMatchObject({ provider: 'provider-y', model: 'model-b' })
    await s.selections.set('expansion', { provider: 'provider-x', model: 'model-gone' })
    const gone = await resolveSelection(['expansion'], s.deps, main)
    expect(gone).toMatchObject({ fellBack: true, reason: 'model-gone' })
    expect(await s.call(gone)).toMatchObject({ provider: 'provider-y', model: 'model-b' })
  })
})

describe('列出能选的模型', () => {
  it('按提供方分组，顺序同宿主；带推理强度和默认强度；列出来是空的提供方不出现', async () => {
    const { host } = setup({
      ...CATALOG,
      'provider-empty': { models: {} },
    })
    expect(await listModelChoices(host.service)).toEqual([
      {
        id: 'provider-x', name: '提供方 X', models: [
          { id: 'model-default', name: 'model-default 名称', efforts: [] },
          { id: 'model-a', name: 'model-a 名称', efforts: [{ id: 'low', name: '强度 low' }, { id: 'high', name: '强度 high' }], defaultEffort: 'high' },
        ],
      },
      { id: 'provider-y', name: 'provider-y', models: [{ id: 'model-b', name: 'model-b 名称', efforts: [{ id: 'low', name: '强度 low' }, { id: 'high', name: '强度 high' }] }] },
    ])
  })

  it('某个提供方列模型出错：照样列出读到的，读不到的那个标成没读到（不当成没有模型）', async () => {
    const { host } = setup({
      'provider-broken': { name: '出错的提供方', models: 'throws' },
      'provider-y': { models: { 'model-b': {} } },
    })
    expect(await listModelChoices(host.service)).toEqual([
      { id: 'provider-broken', name: '出错的提供方', models: [], listFailed: true },
      { id: 'provider-y', name: 'provider-y', models: [{ id: 'model-b', name: 'model-b 名称', efforts: [] }] },
    ])
  })

  it('读模型详情出错：推理强度确认不了，这个提供方同样标成没读到', async () => {
    const { host } = setup({
      'provider-x': { name: '提供方 X', models: { 'model-a': { efforts: ['low'] }, 'model-flaky': { detailThrows: true } } },
    })
    expect(await listModelChoices(host.service)).toEqual([{ id: 'provider-x', name: '提供方 X', models: [], listFailed: true }])
  })

  it('列模型时宿主报提供方已删（NO_ADAPTER）：不出现，不算没读到', async () => {
    const { host } = setup({ ...CATALOG, 'provider-removed': { models: 'no-adapter' } })
    const choices = await listModelChoices(host.service)
    expect(choices.map(p => p.id)).toEqual(['provider-x', 'provider-y'])
    expect(choices.some(p => p.listFailed === true)).toBe(false)
  })

  it('没有宿主 llm 服务、一个模型都列不出：空列表', async () => {
    expect(await listModelChoices(undefined)).toEqual([])
    const { host } = setup({ 'provider-x': { models: {} } })
    expect(await listModelChoices(host.service)).toEqual([])
  })
})
