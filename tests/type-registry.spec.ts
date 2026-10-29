import { describe, expect, it } from 'vitest'
import { assertNoBuiltinCollision, buildTypeRegistry, BUILTIN_TYPES, PRESET_SCENES } from '../src/type-registry.ts'
import { GENERAL_SCENE, SCENE_MAX_TYPES } from '../src/contract-codes.ts'
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

  it('切场景后读时认得类型池里的类型（label、decayDays 不退化），写时仍只认当前场景', () => {
    const office = buildTypeRegistry({ template: 'office', customTypes: {} })
    expect(office.get('procedure')).toMatchObject({ label: '可复用流程', decayDays: 90, recall: 'search', governancePriority: 'medium' })
    expect(office.has('procedure')).toBe(false)
    expect(office.all().map(t => t.name)).not.toContain('procedure')
    const coding = buildTypeRegistry(base)
    expect(coding.get('decision')).toMatchObject({ label: '决定', decayDays: 30, recall: 'search' })
    expect(coding.has('decision')).toBe(false)
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
    expect(office).toMatch(/decision（决定）：.*依据.*答应/) // 承诺并进决定
  })

})

const term = { label: '术语', description: '领域术语', whenToSave: '出现新术语', recall: 'search' as const, decayDays: null, governancePriority: 'medium' as const }

describe('场景', () => {
  it('不写 scenes 时编码、办公按出厂组成：通用五类 + 各一类预设', () => {
    expect(buildTypeRegistry(base).all().map(t => t.name)).toEqual([...BUILTIN_TYPES.map(t => t.name), 'procedure'])
    expect(buildTypeRegistry({ template: 'office', customTypes: {} }).all().map(t => t.name))
      .toEqual([...BUILTIN_TYPES.map(t => t.name), 'decision'])
    expect(PRESET_SCENES.coding.types).toEqual([...BUILTIN_TYPES.map(t => t.name), 'procedure'])
  })

  it('通用场景（custom）只有内置五类，scenes 里写了 custom 也忽略', () => {
    const registry = buildTypeRegistry({ template: GENERAL_SCENE, customTypes: {}, scenes: { custom: { label: '假', types: ['procedure'] } } })
    expect(registry.all().map(t => t.name)).toEqual(BUILTIN_TYPES.map(t => t.name))
    expect(registry.warnings).toEqual([])
  })

  it('自定义场景：按类型池顺序挑类型，可去掉通用类型；去掉的仍能读、不能写', () => {
    const registry = buildTypeRegistry({
      template: 'scene-1',
      customTypes: { 'domain-term': term },
      scenes: { 'scene-1': { label: '写作', types: ['domain-term', 'decision', 'reference', 'preference'] } },
    })
    expect(registry.all().map(t => t.name)).toEqual(['preference', 'reference', 'decision', 'domain-term'])
    expect(registry.has('profile')).toBe(false)
    expect(registry.get('profile').label).toBe('用户画像')
    expect(registry.warnings).toEqual([])
  })

  it('自建类型不在当前场景时不能写，但读时认得原定义（不走兜底）', () => {
    const registry = buildTypeRegistry({ template: 'coding', customTypes: { 'domain-term': term } })
    expect(registry.has('domain-term')).toBe(false)
    expect(registry.get('domain-term')).toMatchObject({ label: '术语', decayDays: null, recall: 'search' })
  })

  it('template 指向不存在的场景时按通用运行，并给出警告', () => {
    const registry = buildTypeRegistry({ template: 'scene-9', customTypes: {} })
    expect(registry.all().map(t => t.name)).toEqual(BUILTIN_TYPES.map(t => t.name))
    expect(registry.warnings).toHaveLength(1)
    expect(registry.warnings[0]).toContain('scene-9')
  })

  it(`场景超过 ${SCENE_MAX_TYPES} 类时按类型池顺序取前 ${SCENE_MAX_TYPES} 类，并给出警告`, () => {
    const extra = Object.fromEntries(['a-one', 'a-two', 'a-three'].map(n => [n, { ...term, label: n }]))
    const registry = buildTypeRegistry({
      template: 'scene-1', customTypes: extra,
      scenes: { 'scene-1': { label: '满', types: ['a-three', 'a-two', 'a-one', 'decision', 'procedure', ...BUILTIN_TYPES.map(t => t.name)] } },
    })
    expect(registry.all().map(t => t.name)).toEqual([...BUILTIN_TYPES.map(t => t.name), 'procedure', 'decision', 'a-one'])
    expect(registry.warnings).toHaveLength(1)
  })

  it('场景里的退役类型和未知类型跳过并警告；跳过后一类不剩按通用运行', () => {
    const partial = buildTypeRegistry({
      template: 'scene-1', customTypes: {},
      scenes: { 'scene-1': { label: '旧办公', types: ['profile', 'commitment', 'person', 'ghost'] } },
    })
    expect(partial.all().map(t => t.name)).toEqual(['profile'])
    expect(partial.has('commitment')).toBe(false)
    expect(partial.warnings.join('\n')).toMatch(/commitment[\s\S]*ghost|ghost[\s\S]*commitment/)

    const empty = buildTypeRegistry({
      template: 'scene-1', customTypes: {},
      scenes: { 'scene-1': { label: '空', types: ['person', 'ghost'] } },
    })
    expect(empty.all().map(t => t.name)).toEqual(BUILTIN_TYPES.map(t => t.name))
    expect(empty.warnings.length).toBeGreaterThan(0)
  })

  it('退役的承诺、人物读时按原定义，任何场景都不能新增', () => {
    const registry = buildTypeRegistry({ template: 'office', customTypes: {} })
    expect(registry.get('commitment')).toMatchObject({ label: '承诺', recall: 'core', decayDays: 14, governancePriority: 'high' })
    expect(registry.get('person')).toMatchObject({ label: '人物', recall: 'search', decayDays: null })
    expect(registry.has('commitment')).toBe(false)
    expect(registry.has('person')).toBe(false)
    expect(registry.renderSaveDescription()).not.toContain('commitment')
  })

  it('自建类型和退役类型同名就是新类型：可勾进场景、可写，旧记忆按新定义读；删掉后回落到退役定义', () => {
    const mine = { ...term, label: '我的承诺', recall: 'search' as const, decayDays: 60 }
    const withCustom = buildTypeRegistry({
      template: 'scene-1', customTypes: { commitment: mine },
      scenes: { 'scene-1': { label: '跟进', types: ['preference', 'commitment'] } },
    })
    expect(withCustom.has('commitment')).toBe(true)
    expect(withCustom.get('commitment')).toMatchObject({ label: '我的承诺', decayDays: 60 })
    expect(withCustom.warnings).toEqual([])
    const removed = buildTypeRegistry({ template: 'custom', customTypes: {} })
    expect(removed.get('commitment')).toMatchObject({ label: '承诺', decayDays: 14 })
  })

  it('删掉预设场景后指向它的 template 按通用运行', () => {
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {}, scenes: { office: PRESET_SCENES.office } })
    expect(registry.all().map(t => t.name)).toEqual(BUILTIN_TYPES.map(t => t.name))
    expect(registry.warnings).toHaveLength(1)
  })
})
