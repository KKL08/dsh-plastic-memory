import { describe, expect, it } from 'vitest'

import { Config } from '../src/index.ts'

describe('Config schema', () => {
  it('空对象得到全部默认值', () => {
    // 传原始输入（模拟 loader 从 YAML 读入的未校验数据），验证默认值填充
    const value = new Config({} as never)
    expect(value.writeMode).toBe('proactive')
    expect(value.evidenceLookup.get()).toBe('strict')
    expect(value.snapshotTokenBudget.get()).toBe(4000)
    expect(value.template.get()).toBe('coding')
    expect(value.governance.enabled.get()).toBe(true)
  })

  it('进 GUI 的字段是 volatile 引用（用时 .get()），writeMode 与 memoryRoot 不是', () => {
    const value = new Config({} as never)
    const refs = [
      value.template, value.customTypes, value.snapshotTokenBudget, value.snapshotOverflow, value.evidenceLookup,
      value.governance.enabled, value.governance.health.sensitivity, value.governance.globalPromoteTarget,
    ]
    for (const ref of refs) expect(typeof ref.get).toBe('function')
    expect(value.governance.globalPromoteTarget.get()).toBe('plugin-global')
    expect(value.customTypes.get()).toEqual({})
    expect(value.writeMode).toBe('proactive')
    expect(value.memoryRoot).toBe('')
  })

  it('非法 writeMode 抛错', () => {
    // 非法 writeMode 应在运行时被 Schemastery 拒绝
    expect(() => new Config({ writeMode: 'magic' } as never)).toThrow()
  })

  it('governance.health.sensitivity 默认 normal，接受三档，拒绝非法', () => {
    expect(new Config({} as never).governance.health.sensitivity.get()).toBe('normal')
    expect(new Config({ governance: { health: { sensitivity: 'proactive' } } } as never).governance.health.sensitivity.get()).toBe('proactive')
    expect(() => new Config({ governance: { health: { sensitivity: 'aggressive' } } } as never)).toThrow()
  })

  it('snapshotOverflow 默认 relax（自动放宽），接受 strict（严格按上限），拒绝非法', () => {
    expect(new Config({} as never).snapshotOverflow.get()).toBe('relax')
    expect(new Config({ snapshotOverflow: 'strict' } as never).snapshotOverflow.get()).toBe('strict')
    expect(() => new Config({ snapshotOverflow: 'truncate' } as never)).toThrow()
  })

  it('自定义类型可以配 decayDays: null（不衰减），不被当成缺失字段拒绝', () => {
    const value = new Config({
      template: 'custom',
      customTypes: {
        regulation: { label: '合规要求', description: '行业法规', whenToSave: '出现合规要求时', recall: 'core', decayDays: null, governancePriority: 'low' },
      },
    } as never)
    expect(value.customTypes.get().regulation!.decayDays).toBeNull()
  })
})
