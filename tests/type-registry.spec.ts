import { describe, expect, it } from 'vitest'
import { assertNoBuiltinCollision, buildTypeRegistry, BUILTIN_TYPES } from '../src/type-registry.ts'
import { TypeRegistryError } from '../src/errors.ts'
import { captureError } from './helpers/errors.ts'

const base = { template: 'coding' as const, customTypes: {} }

describe('buildTypeRegistry', () => {
  it('coding 模板 = 内置五类 + procedure', () => {
    const registry = buildTypeRegistry(base)
    expect(registry.all().map(t => t.name)).toEqual(
      ['profile', 'preference', 'knowledge', 'project', 'reference', 'procedure'])
  })

  it('自定义类型与内置重名时抛错', () => {
    expect(() => buildTypeRegistry({
      ...base,
      customTypes: { profile: { label: 'x', description: 'x', whenToSave: 'x', recall: 'core', decayDays: null, governancePriority: 'low' } },
    })).toThrow(TypeRegistryError)
  })

  it('自定义覆盖模板同名类型', () => {
    const registry = buildTypeRegistry({
      template: 'coding',
      customTypes: { procedure: { label: '改', description: '改', whenToSave: '改', recall: 'passive', decayDays: 1, governancePriority: 'low' } },
    })
    expect(registry.get('procedure').label).toBe('改')
  })

  it('模板类型与内置重名时抛错（assertNoBuiltinCollision 兜底校验）', () => {
    // 现有模板（coding/office）都不与内置五类冲突，无法直接构造真实冲突场景，
    // 因此直接测试 buildTypeRegistry 内部复用的校验函数本身。
    const err = captureError(() => assertNoBuiltinCollision(
      [{ name: 'profile', label: '假冒画像', description: 'x', whenToSave: 'x', recall: 'core', decayDays: null, governancePriority: 'low' }],
      '模板',
    ))
    expect(err).toBeInstanceOf(TypeRegistryError)
    expect(err).toMatchObject({ code: 'builtin-collision' })
    expect((err as Error).message).toContain('profile')

    expect(() => assertNoBuiltinCollision(
      [{ name: 'procedure', label: '可复用流程', description: 'x', whenToSave: 'x', recall: 'search', decayDays: 90, governancePriority: 'medium' }],
      '模板',
    )).not.toThrow()
  })

  it('未知类型返回 fallback 策略', () => {
    const policy = buildTypeRegistry(base).get('ghost')
    expect(policy.recall).toBe('search')
    expect(policy.decayDays).toBe(90)
  })

  it('renderSaveDescription 通用层含守门句/γ/推断低置信/隐私负向 + 全部类型', () => {
    const text = buildTypeRegistry(base).renderSaveDescription()
    expect(text).toContain('各类型何时记')
    for (const t of BUILTIN_TYPES) expect(text).toContain(t.name)
    expect(text).toMatch(/未来的我会不会/)            // 守门句
    expect(text).toMatch(/边做边记|别拖到最后/)        // γ 收尾提示
    expect(text).toMatch(/低置信|0\.5|agent-inferred/) // D3 推断低置信
    expect(text).toMatch(/AGENTS\.md|CLAUDE\.md/)      // 别与基线重复
    expect(text).toMatch(/性别|年龄|没明说/)           // 隐私负向
  })

  it('各类型触发从 whenToSave 生成，补齐 project 弱覆盖与 procedure/office 零覆盖', () => {
    const coding = buildTypeRegistry({ template: 'coding', customTypes: {} }).renderSaveDescription()
    expect(coding).toMatch(/目标/)          // project：目标
    expect(coding).toMatch(/里程碑/)         // project：里程碑
    expect(coding).toMatch(/决策变更|变更/)   // project：决策变更
    expect(coding).toMatch(/procedure（可复用流程）：.*反复验证/) // procedure 零覆盖修复
    const office = buildTypeRegistry({ template: 'office', customTypes: {} }).renderSaveDescription()
    expect(office).toMatch(/commitment（承诺）：.*答应/) // commitment 零覆盖修复
    expect(office).toContain('person（人物）')           // person 零覆盖修复
  })

  it('类型超过 15 个时低优先级类型的 whenToSave 裁剪为仅 label', () => {
    const customTypes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
      `extra${i}`,
      { label: `扩展${i}`, description: `desc${i}`, whenToSave: `这段触发说明不该出现${i}`, recall: 'search' as const, decayDays: null, governancePriority: 'low' as const },
    ]))
    const text = buildTypeRegistry({ template: 'coding', customTypes }).renderSaveDescription()
    expect(text).toContain('extra0（扩展0）')
    expect(text).not.toContain('这段触发说明不该出现0')
  })
})
