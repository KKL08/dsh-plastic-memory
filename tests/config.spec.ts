import { describe, expect, it } from 'vitest'

import { Config } from '../src/index.ts'

describe('Config schema', () => {
  it('空对象得到全部默认值', () => {
    // 传原始输入（模拟 loader 从 YAML 读入的未校验数据），验证默认值填充
    const value = new Config({} as unknown as Config)
    expect(value.writeMode).toBe('proactive')
    expect(value.evidenceLookup).toBe('strict')
    expect(value.snapshotTokenBudget).toBe(4000)
    expect(value.template).toBe('coding')
    expect(value.governance.enabled).toBe(true)
  })

  it('非法 writeMode 抛错', () => {
    // 非法 writeMode 应在运行时被 Schemastery 拒绝
    expect(() => new Config({ writeMode: 'magic' } as unknown as Config)).toThrow()
  })

  it('governance.health.sensitivity 默认 normal，接受三档，拒绝非法', () => {
    expect(new Config({} as unknown as Config).governance.health.sensitivity).toBe('normal')
    expect(new Config({ governance: { health: { sensitivity: 'proactive' } } } as unknown as Config).governance.health.sensitivity).toBe('proactive')
    expect(() => new Config({ governance: { health: { sensitivity: 'aggressive' } } } as unknown as Config)).toThrow()
  })

  it('自定义类型可以配 decayDays: null（不衰减），不被当成缺失字段拒绝', () => {
    const value = new Config({
      template: 'custom',
      customTypes: {
        regulation: { label: '合规要求', description: '行业法规', whenToSave: '出现合规要求时', recall: 'core', decayDays: null, governancePriority: 'low' },
      },
    } as unknown as Config)
    expect(value.customTypes.regulation.decayDays).toBeNull()
  })
})
