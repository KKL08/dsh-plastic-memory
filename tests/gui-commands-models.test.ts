import { describe, expect, it } from 'vitest'
import type { HostModelCatalog } from '../src/governance/background-llm.ts'
import { env, ok, err, root } from './helpers/gui-command-env.ts'
import { breakModelSelection } from './helpers/model-selection-file.ts'

// 后台模型的两条命令：list-models 列宿主里能选的模型，set-model-selection 写共享的选择表并重写体检视图。
// 宿主 llm 服务（列提供方、列模型、模型详情）换成假的，选择表与视图文件是真的。

const catalog: HostModelCatalog = {
  listProviders: () => [{ id: 'provider-x', name: '提供方 X' }, { id: 'provider-signed-out', name: '没登录的提供方' }],
  listModels: async provider => (provider === 'provider-x' ? [{ id: 'model-a', name: '模型 A' }] : []),
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
}

describe('list-models', () => {
  it('按提供方分组列出能选的模型和推理强度；列不出模型的提供方不出现', async () => {
    const e = env({ catalog })
    expect(ok(await e.run({ cmd: 'list-models' })).providers).toEqual([
      { id: 'provider-x', name: '提供方 X', models: [{ id: 'model-a', name: '模型 A', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' }] },
    ])
  })

  it('有提供方列模型出错：命令照样成功，那个提供方标成没读到，界面据此说明', async () => {
    const e = env({ catalog: { ...catalog, listModels: async provider => { if (provider === 'provider-x') throw Object.assign(new Error('fetch failed'), { code: 'TRANSPORT' }); return [] } } })
    expect(ok(await e.run({ cmd: 'list-models' })).providers).toEqual([{ id: 'provider-x', name: '提供方 X', models: [], listFailed: true }])
  })

  it('宿主没有可列的模型：空列表，不算失败', async () => {
    expect(ok(await env().run({ cmd: 'list-models' })).providers).toEqual([])
  })

  it('只读：体检关着、借来的是子 agent 会话也能列', async () => {
    expect(ok(await env({ catalog, governanceEnabled: false }).run({ cmd: 'list-models' })).providers).toHaveLength(1)
    expect(ok(await env({ catalog, delegationDepth: 1 }).run({ cmd: 'list-models' })).providers).toHaveLength(1)
  })
})

describe('set-model-selection', () => {
  it('自动体检选了模型：写进选择表，体检视图立刻写出它；改回跟随删掉这一条，视图回到 null', async () => {
    const e = env()
    const selection = { provider: 'provider-x', model: 'model-a', reasoningEffort: 'high' }
    ok(await e.run({ cmd: 'set-model-selection', key: 'checkup', selection }))
    expect(await e.selections.read('checkup')).toEqual(selection)
    expect((await e.readCheckupView()).model).toEqual(selection)
    ok(await e.run({ cmd: 'set-model-selection', key: 'checkup', selection: null }))
    expect(await e.selections.read('checkup')).toBeNull()
    expect((await e.readCheckupView()).model).toBeNull()
  })

  it('梦境的键单独存，不改自动体检的选择', async () => {
    const e = env()
    ok(await e.run({ cmd: 'set-model-selection', key: 'dreams', selection: { provider: 'provider-x', model: 'model-a' } }))
    expect(await e.selections.read('dreams')).toEqual({ provider: 'provider-x', model: 'model-a' })
    expect(await e.selections.read('checkup')).toBeNull()
    expect((await e.readCheckupView()).model).toBeNull()
  })

  it('体检关着时也能改（只是自动体检不跑）', async () => {
    const e = env({ governanceEnabled: false })
    ok(await e.run({ cmd: 'set-model-selection', key: 'checkup', selection: { provider: 'provider-x', model: 'model-a' } }))
    expect(await e.selections.read('checkup')).toEqual({ provider: 'provider-x', model: 'model-a' })
  })

  it.each([
    ['不认识的键', ' set-model-selection {"key":"other","selection":null}'],
    ['模型为空', ' set-model-selection {"key":"checkup","selection":{"provider":"provider-x","model":""}}'],
    ['缺提供方', ' set-model-selection {"key":"checkup","selection":{"model":"model-a"}}'],
  ])('%s → invalid-args，选择表不动', async (_label, raw) => {
    const e = env()
    expect(err(await e.runRaw(raw)).code).toBe('invalid-args')
    expect(await e.selections.read('checkup')).toBeNull()
  })
})

describe('体检视图里给设置页的模型选择', () => {
  it('体检、扩查两个键各写一项：选了为那份选择，没选为 null；扩查的选择不改 model（它只管体检）', async () => {
    const e = env()
    ok(await e.run({ cmd: 'set-model-selection', key: 'expansion', selection: { provider: 'provider-x', model: 'model-a' } }))
    const view = await e.readCheckupView()
    expect(view.selections).toEqual({ checkup: null, expansion: { provider: 'provider-x', model: 'model-a' } })
    expect(view.model).toBeNull()
  })

  it('选择文件在却读不出：那一项写成 unreadable，model 仍写 null（上一个发布版按没选显示）；重新选一次就恢复', async () => {
    const e = env()
    await breakModelSelection(root, 'checkup', 'bad-json')
    await breakModelSelection(root, 'expansion', 'bad-json')
    ok(await e.run({ cmd: 'refresh-views' }))
    const broken = await e.readCheckupView()
    expect(broken.selections).toEqual({ checkup: 'unreadable', expansion: 'unreadable' })
    expect(broken.model).toBeNull()
    ok(await e.run({ cmd: 'set-model-selection', key: 'checkup', selection: { provider: 'provider-x', model: 'model-a' } }))
    ok(await e.run({ cmd: 'set-model-selection', key: 'expansion', selection: null }))
    const fixed = await e.readCheckupView()
    expect(fixed.selections).toEqual({ checkup: { provider: 'provider-x', model: 'model-a' }, expansion: null })
    expect(fixed.model).toEqual({ provider: 'provider-x', model: 'model-a' })
  })
})
