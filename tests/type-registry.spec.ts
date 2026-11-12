import { describe, expect, it } from 'vitest'
import { assertNoBuiltinCollision, buildTypeRegistry, BUILTIN_TYPES, PRESET_SCENES, PRESET_TYPES, RETIRED_TYPES } from '../src/type-registry.ts'
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

  it('预设「决定」的治理优先级为高', () => {
    expect(buildTypeRegistry({ template: 'office', customTypes: {} }).get('decision').governancePriority).toBe('high')
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
    expect(text).toContain('各类型记什么、什么时候记')
    for (const t of BUILTIN_TYPES) expect(text).toContain(t.name)
    expect(text).toMatch(/未来的我会不会/)            // 守门句
    expect(text).toMatch(/边做边记|别拖到最后/)        // γ 收尾提示
    expect(text).toMatch(/低置信|0\.5|agent-inferred/) // D3 推断标 agent-inferred
    expect(text).toMatch(/AGENTS\.md|CLAUDE\.md/)      // 别与基线重复
    expect(text).toMatch(/性别|年龄|没明说/)           // 隐私负向
  })

  it('各类型触发从 whenToSave 生成，补齐 project 弱覆盖与 procedure/office 零覆盖', () => {
    const coding = buildTypeRegistry({ template: 'coding', customTypes: {} }).renderSaveDescription()
    expect(coding).toMatch(/目标/)          // project：目标
    expect(coding).toMatch(/里程碑/)         // project：里程碑
    expect(coding).toMatch(/变化/)           // project：计划、范围变化
    expect(coding).toMatch(/procedure（可复用流程）：[^\n]*\n  什么时候记：[^\n]*多次/) // procedure 零覆盖修复
    const office = buildTypeRegistry({ template: 'office', customTypes: {} }).renderSaveDescription()
    expect(office).toMatch(/decision（决定）：[^\n]*\n  什么时候记：[^\n]*决定[^\n]*承诺/) // 承诺并进决定
  })

  it('memory_save 说明逐类写「是什么」（说明）和「什么时候记」，自建类型写的说明也带上', () => {
    const term = { label: '术语', description: '领域术语', whenToSave: '出现新术语', recall: 'search' as const, decayDays: null, governancePriority: 'medium' as const }
    const text = buildTypeRegistry({ template: 'research', customTypes: { term }, scenes: { research: { label: '调研', types: ['profile', 'term'] } } }).renderSaveDescription()
    const profile = BUILTIN_TYPES[0]!
    expect(text).toContain(`- profile（用户画像）：${profile.description}\n  什么时候记：${profile.whenToSave}`)
    expect(text).toContain('- term（术语）：领域术语\n  什么时候记：出现新术语')
  })
})

describe('出厂类型的定义', () => {
  it('通用五类、预设两类、退役两类都写了「怎么用」', () => {
    for (const t of [...BUILTIN_TYPES, ...PRESET_TYPES, ...RETIRED_TYPES]) expect(t.howToUse?.trim(), t.name).toBeTruthy()
  })

  it('说明按「定义 → 正文：写法 → 例：用户原话 → 记下的内容」排；开头的定义正面写清范围，不靠否定句划界', () => {
    for (const t of [...BUILTIN_TYPES, ...PRESET_TYPES]) {
      expect(t.description, t.name).toMatch(/^[^。]+。正文：.+例：用户说「.+」→ 记(两条：)?「.+」$/)
      expect(t.description.split('。')[0], t.name).not.toMatch(/不要|不是|而非|不算/)
    }
  })

  it('例子记下的内容守通用写法：相对时间已换成具体日期', () => {
    for (const t of [...BUILTIN_TYPES, ...PRESET_TYPES]) {
      expect(t.description.split('→')[1], t.name).not.toMatch(/今天|明天|昨天|这周|下周|上周|月底|今年|明年|去年|最近/)
    }
  })

  it('事实与经验：没找到、行不通的结论限定在试过的范围，推测写明是推测', () => {
    const knowledge = BUILTIN_TYPES.find(t => t.name === 'knowledge')!
    expect(knowledge.description).toContain('没找到、行不通这类结论写明在什么范围试过')
    expect(knowledge.description).toContain('推测的写明是推测')
  })

  it('「记住」不挂在某一类的触发上：通用说明让模型按最贴合的类型记', () => {
    for (const t of [...BUILTIN_TYPES, ...PRESET_TYPES]) expect(t.whenToSave, t.name).not.toContain('记住')
    expect(buildTypeRegistry(base).renderSaveDescription()).toContain('用户明确要你记住某件事时，按最贴合的类型马上记下')
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

  it('通用场景（custom）配了非空 customTypes 也只有内置五类', () => {
    const registry = buildTypeRegistry({ template: GENERAL_SCENE, customTypes: { 'domain-term': term } })
    expect(registry.all().map(t => t.name)).toEqual(BUILTIN_TYPES.map(t => t.name))
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

describe('删掉的预设类型', () => {
  it('不进类型池，场景里列了也跳过并警告；读时按出厂定义（和退役类型一样）', () => {
    const registry = buildTypeRegistry({ template: 'coding', customTypes: {}, removedPresetTypes: ['procedure'] })
    expect(registry.all().map(t => t.name)).toEqual(BUILTIN_TYPES.map(t => t.name))
    expect(registry.has('procedure')).toBe(false)
    expect(registry.get('procedure')).toMatchObject({ label: '可复用流程', recall: 'search', decayDays: 90 })
    expect(registry.warnings.join('\n')).toContain('procedure')
    expect(registry.renderSaveDescription()).not.toContain('procedure')
  })

  it('同名的 customTypes 不生效（按删掉处理）并警告', () => {
    const mine = { ...term, label: '我的决定', decayDays: 60 }
    const registry = buildTypeRegistry({
      template: 'scene-1', customTypes: { decision: mine }, removedPresetTypes: ['decision'],
      scenes: { 'scene-1': { label: '跟进', types: ['preference', 'decision'] } },
    })
    expect(registry.has('decision')).toBe(false)
    expect(registry.get('decision')).toMatchObject({ label: '决定', decayDays: 30 })
    expect(registry.warnings.join('\n')).toMatch(/decision/)
  })

  it('不是预设类型的名字忽略并警告，内置、自建照常', () => {
    const registry = buildTypeRegistry({
      template: 'scene-1', customTypes: { term }, removedPresetTypes: ['profile', 'term', 'ghost'],
      scenes: { 'scene-1': { label: '写作', types: ['profile', 'term'] } },
    })
    expect(registry.all().map(t => t.name)).toEqual(['profile', 'term'])
    expect(registry.warnings.join('\n')).toMatch(/profile[\s\S]*term[\s\S]*ghost/)
  })

  it('没删的预设照常：改过的（同名 customTypes）按改过的定义', () => {
    const mine = { ...term, label: '我的流程' }
    const registry = buildTypeRegistry({ template: 'coding', customTypes: { procedure: mine }, removedPresetTypes: ['decision'] })
    expect(registry.has('procedure')).toBe(true)
    expect(registry.get('procedure')).toMatchObject({ label: '我的流程' })
    expect(registry.warnings).toEqual([])
  })
})
