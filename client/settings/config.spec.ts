// 设置页配置模型的纯函数：场景的解析与写入、场景 id、类型迁移的合并、类型表单校验，以及界面用到的那几项配置。
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TYPE_NAMES, EMPTY_TYPE_DRAFT, GENERAL_SCENE, PRESET_SCENES, TYPE_DEFINITIONS, buildOps, customTypeChanges, droppedTypes, fieldsOf,
  forgetMigrations, isPresetEdited, isPresetTypeEdited, keepMigrations, memoryCountOf, nextSceneId, pendingNames, presetSceneTypes, presetTypeChanges,
  removeType, renameMigrations, renameType, restorePresetType, sceneChanges, sceneTypes, typePool, validateSceneDraft, validateTypeDraft,
  OVERFLOW_MODES, PROMOTE_TARGETS, toPluginConfig, type CustomType, type SettingsFields,
  DECAY_DAYS_MAX, decayDaysOf, parseDecayDays, parsePeriodText, withDecayDays,
} from './config.ts'
import { DEFAULT_SECTION } from './config-form.fake.ts'

const term: CustomType = { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' }
const base = (patch: Partial<SettingsFields> = {}): SettingsFields => ({ ...fieldsOf({}), ...patch })

describe('场景字段', () => {
  it('配置里没有 scenes 时用出厂的编码、办公；当前场景默认通用', () => {
    const fields = fieldsOf({})
    expect(fields.template).toBe('custom')
    expect(fields.scenes).toEqual(PRESET_SCENES)
  })

  it('当前场景指向不存在的场景时显示通用；通用不进 scenes，配置里写了也忽略', () => {
    expect(fieldsOf({ template: 'scene-gone', scenes: {} }).template).toBe(GENERAL_SCENE)
    expect(fieldsOf({ template: 'custom', scenes: { custom: { label: 'x', types: ['profile'] } } })).toMatchObject({ template: 'custom', scenes: {} })
  })

  it('组成按类型池顺序取交集、超过 8 类截断；交集为空、通用、不存在都按通用五类', () => {
    const customTypes = { a: term, b: term, c: term }
    const scenes = {
      big: { label: '大', types: ['c', 'b', 'a', 'decision', 'procedure', ...BUILTIN_TYPE_NAMES] },
      retired: { label: '旧', types: ['commitment', 'person'] },
    }
    expect(sceneTypes({ scenes, customTypes }, 'big')).toEqual([...BUILTIN_TYPE_NAMES, 'procedure', 'decision', 'a'])
    expect(sceneTypes({ scenes, customTypes }, 'retired')).toEqual([...BUILTIN_TYPE_NAMES])
    expect(sceneTypes({ scenes, customTypes }, GENERAL_SCENE)).toEqual([...BUILTIN_TYPE_NAMES])
    expect(sceneTypes({ scenes, customTypes }, 'missing')).toEqual([...BUILTIN_TYPE_NAMES])
  })

  it('编码、办公按集合比出厂组成，顺序不同不算改过；自定义场景永远不算', () => {
    expect(isPresetEdited('coding', { label: '编码', types: ['procedure', ...BUILTIN_TYPE_NAMES] })).toBe(false)
    expect(isPresetEdited('coding', { label: '编码', types: ['procedure', 'profile'] })).toBe(true)
    expect(isPresetEdited('scene-1', { label: '写作', types: ['profile'] })).toBe(false)
  })

  it('场景按键 set / unset：新增、修改写整项，删除写 unset，顺序不同不写', () => {
    const saved = base()
    const draft = base({
      template: 'scene-1',
      scenes: {
        coding: { label: '编码', types: ['procedure', ...BUILTIN_TYPE_NAMES] },
        'scene-1': { label: '写作', types: ['preference', 'decision'] },
      },
    })
    expect(buildOps(saved, draft)).toEqual([
      { op: 'set', path: ['template'], value: 'scene-1' },
      { op: 'set', path: ['scenes', 'scene-1'], value: { label: '写作', types: ['preference', 'decision'] } },
      { op: 'unset', path: ['scenes', 'office'] },
    ])
    expect(sceneChanges(saved.scenes, draft.scenes)).toEqual({ added: ['scene-1'], edited: [], removed: ['office'] })
  })

  it('换到类型更少的场景时列出少掉的类型；改名跟着迁过去的不算少掉', () => {
    const saved = base({ template: 'office', customTypes: { term }, scenes: { office: { label: '办公', types: [...BUILTIN_TYPE_NAMES, 'decision', 'term'] } } })
    expect(droppedTypes(saved, { ...saved, template: GENERAL_SCENE })).toEqual(['decision', 'term'])
    const renamed = { ...saved, ...renameType(saved, 'term', 'glossary', term) }
    expect(droppedTypes(saved, renamed)).toEqual(['term'])
    expect(droppedTypes(saved, renamed, { term: { action: 'retype', to: 'glossary' } })).toEqual([])
  })
})

describe('新建场景的 id', () => {
  it('scene- 加毫秒数的 36 进制，撞上已有 id 时顺延一毫秒', () => {
    const now = 1_790_000_000_000
    expect(nextSceneId([], now)).toBe(`scene-${now.toString(36)}`)
    expect(nextSceneId([`scene-${now.toString(36)}`], now)).toBe(`scene-${(now + 1).toString(36)}`)
  })
})

describe('场景草稿校验', () => {
  it('名字必填、去掉首尾空白后不和其他场景重名；至少勾一类', () => {
    expect(validateSceneDraft({ label: '  ', types: [] }, [])).toEqual({ ok: false, errors: { label: 'required', types: 'types-empty' } })
    expect(validateSceneDraft({ label: ' 编码 ', types: ['profile'] }, ['通用', '编码'])).toEqual({ ok: false, errors: { label: 'label-taken' } })
    expect(validateSceneDraft({ label: ' 写作 ', types: ['profile'] }, ['通用'])).toEqual({ ok: true, scene: { label: '写作', types: ['profile'] } })
  })
})

describe('类型改名、删除与迁移', () => {
  const counts = new Map([['term', 12], ['client', 3]])

  it('改名时场景组成一并换成新名字，列表位置不变；删除时从场景里去掉', () => {
    const pool = { customTypes: { term, client: { ...term, label: '客户名' } }, scenes: { office: { label: '办公', types: ['decision', 'term'] } }, removedPresets: [] }
    const renamed = renameType(pool, 'term', 'glossary', term)
    expect(Object.keys(renamed.customTypes)).toEqual(['glossary', 'client'])
    expect(renamed.scenes.office!.types).toEqual(['decision', 'glossary'])
    expect(removeType(pool, 'term')).toEqual({ customTypes: { client: { ...term, label: '客户名' } }, scenes: { office: { label: '办公', types: ['decision'] } }, removedPresets: [] })
  })

  it('跟着改名：条数归到新名字；改回原名时迁移去掉', () => {
    const once = renameMigrations({}, 'term', 'glossary', 'retype', counts)
    expect(once).toEqual({ term: { action: 'retype', to: 'glossary' } })
    expect(memoryCountOf('glossary', once, counts)).toBe(12)
    expect(memoryCountOf('term', once, counts)).toBe(0)
    const twice = renameMigrations(once, 'glossary', 'words', 'retype', counts)
    expect(twice).toEqual({ term: { action: 'retype', to: 'words' } })
    expect(renameMigrations(twice, 'words', 'term', 'retype', counts)).toEqual({})
  })

  it('改名后又删掉、选移到最近删除：合并成删原名', () => {
    const renamed = renameMigrations({}, 'term', 'glossary', 'retype', counts)
    expect(forgetMigrations(renamed, 'glossary', counts)).toEqual({ term: { action: 'forget' } })
    expect(renameMigrations({}, 'term', 'glossary', 'forget', counts)).toEqual({ term: { action: 'forget' } })
  })

  it('改名后又删掉、选保留记忆：改名迁移去掉，记忆留在原名下；条数读不到时按都有记忆记迁移', () => {
    const renamed = renameMigrations({}, 'term', 'glossary', 'retype', counts)
    expect(keepMigrations(renamed, 'glossary')).toEqual({})
    expect(renameMigrations({}, 'glossary', 'words', 'retype', undefined)).toEqual({ glossary: { action: 'retype', to: 'words' } })
  })

  it('迁移中的原名别的类型不能占用，自己改回原名可以', () => {
    const migrations = renameMigrations({}, 'term', 'glossary', 'retype', counts)
    expect(pendingNames(migrations)).toEqual(['term'])
    expect(pendingNames(migrations, 'glossary')).toEqual([])
  })
})

describe('类型表单校验', () => {
  const filled = { ...EMPTY_TYPE_DRAFT, name: 'glossary', label: '术语', description: 'd', whenToSave: 'w' }

  it('中文名不和类型池里其他类型重复（去掉首尾空白）', () => {
    const result = validateTypeDraft({ ...filled, label: ' 决定 ' }, { names: [], labels: ['决定'] })
    expect(result).toEqual({ ok: false, errors: { label: 'label-taken' } })
  })

  it('英文名不和预设、其他自建类型重名，不占迁移中的原名；退役类型名可以用', () => {
    expect(validateTypeDraft({ ...filled, name: 'decision' }, { names: ['procedure', 'decision'], labels: [] })).toEqual({ ok: false, errors: { name: 'name-taken' } })
    expect(validateTypeDraft({ ...filled, name: 'term' }, { names: [], labels: [], pending: ['term'] })).toEqual({ ok: false, errors: { name: 'name-pending' } })
    expect(validateTypeDraft({ ...filled, name: 'commitment' }, { names: ['procedure', 'decision'], labels: [] })).toMatchObject({ ok: true, name: 'commitment' })
  })

  it('「怎么用」选填：空着不写进类型，填了去掉首尾空白写进去', () => {
    expect(EMPTY_TYPE_DRAFT.howToUse).toBe('')
    const blank = validateTypeDraft({ ...filled, howToUse: '  ' }, { names: [], labels: [] })
    expect(blank.ok && blank.type).toEqual({ label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' })
    const used = validateTypeDraft({ ...filled, howToUse: ' 遇到这个词时按记下的含义理解 ' }, { names: [], labels: [] })
    expect(used.ok && used.type.howToUse).toBe('遇到这个词时按记下的含义理解')
  })
})

describe('确认周期', () => {
  it('没改过时各类型的确认周期取出厂值；fieldsOf 只认通用类型名和数字', () => {
    const fields = fieldsOf({})
    expect(fields.builtinDecayDays).toEqual({})
    expect(Object.fromEntries(['profile', 'knowledge', 'project', 'procedure', 'decision'].map(name => [name, decayDaysOf(fields, name)])))
      .toEqual({ profile: null, knowledge: 90, project: 7, procedure: 90, decision: 30 })
    expect(fieldsOf({ builtinDecayDays: { project: 30, decision: 3, ghost: 3, knowledge: 'x' } }).builtinDecayDays).toEqual({ project: 30 })
  })

  it('fieldsOf 和类型表认同一批周期：不是 1 到上限的整数的忽略；写的就是出厂周期的算没改过', () => {
    const fields = fieldsOf({ builtinDecayDays: { project: 0, knowledge: 1.5, procedure: 5, reference: DECAY_DAYS_MAX + 1, preference: -5, profile: 30 } })
    expect(fields.builtinDecayDays).toEqual({ profile: 30 })
    expect(fieldsOf({ builtinDecayDays: { project: 7, knowledge: 90, profile: DECAY_DAYS_MAX } }).builtinDecayDays).toEqual({ profile: DECAY_DAYS_MAX })
    const odd = fieldsOf({ builtinDecayDays: { project: 7, knowledge: 0, reference: 1.5 } })
    expect(buildOps(odd, odd)).toEqual([])
  })

  it('配置里手写了出厂周期：改成别的再改回来，不产生改动', () => {
    const saved = fieldsOf({ builtinDecayDays: { project: 7 } })
    const changed = { ...saved, ...withDecayDays(saved, 'project', 30) }
    const back = { ...changed, ...withDecayDays(changed, 'project', 7) }
    expect(buildOps(saved, back)).toEqual([])
  })

  it('只返回改到的那一项：通用类型只给 builtinDecayDays，预设和我加的只给 customTypes', () => {
    const saved = base({ customTypes: { term } })
    expect(Object.keys(withDecayDays(saved, 'project', 30))).toEqual(['builtinDecayDays'])
    expect(Object.keys(withDecayDays(saved, 'project', null))).toEqual(['builtinDecayDays'])
    expect(Object.keys(withDecayDays(saved, 'decision', 60))).toEqual(['customTypes'])
    expect(Object.keys(withDecayDays(saved, 'term', 20))).toEqual(['customTypes'])
    expect(withDecayDays(saved, 'ghost', 20)).toEqual({})
  })

  it('改成不用定期确认：通用类型是回到出厂周期，我加的类型写 null', () => {
    const saved = base({ builtinDecayDays: { profile: 30, project: 30 }, customTypes: { term: { ...term, decayDays: 10 } } })
    expect(withDecayDays(saved, 'profile', null).builtinDecayDays).toEqual({ project: 30 })
    expect(withDecayDays(saved, 'project', null).builtinDecayDays).toEqual({ profile: 30 })
    expect(withDecayDays(saved, 'term', null).customTypes).toEqual({ term: { ...term, decayDays: null } })
  })

  it('改通用类型：写进 builtinDecayDays、按键 set；改回出厂值或恢复默认就去掉这一项（unset）', () => {
    const saved = base()
    const draft = { ...saved, ...withDecayDays(saved, 'project', 30) }
    expect(draft.builtinDecayDays).toEqual({ project: 30 })
    expect(draft.customTypes).toEqual({})
    expect(decayDaysOf(draft, 'project')).toBe(30)
    expect(buildOps(saved, draft)).toEqual([{ op: 'set', path: ['builtinDecayDays', 'project'], value: 30 }])

    const stored = base({ builtinDecayDays: { project: 30, knowledge: 5 } })
    const reset = { ...stored, ...withDecayDays(stored, 'project', 7) }
    expect(reset.builtinDecayDays).toEqual({ knowledge: 5 })
    expect(buildOps(stored, reset)).toEqual([{ op: 'unset', path: ['builtinDecayDays', 'project'] }])
  })

  it('改预设：存成 customTypes 里的同名一项（算改过）；改回出厂值就去掉，还有别的改动时只恢复周期', () => {
    const saved = base()
    const draft = { ...saved, ...withDecayDays(saved, 'decision', 60) }
    expect(draft.customTypes).toEqual({ decision: { ...TYPE_DEFINITIONS.decision, decayDays: 60 } })
    expect(draft.builtinDecayDays).toEqual({})
    expect(isPresetTypeEdited('decision', draft.customTypes)).toBe(true)
    expect(withDecayDays(draft, 'decision', 30).customTypes).toEqual({})

    const relabeled = base({ customTypes: { decision: { ...TYPE_DEFINITIONS.decision, label: '约定', decayDays: 60 } } })
    expect(withDecayDays(relabeled, 'decision', 30).customTypes).toEqual({ decision: { ...TYPE_DEFINITIONS.decision, label: '约定' } })
  })

  it('改我加的类型：改它定义里的 decayDays', () => {
    const saved = base({ customTypes: { term: { ...term, decayDays: 10 } } })
    expect(decayDaysOf(saved, 'term')).toBe(10)
    const draft = { ...saved, ...withDecayDays(saved, 'term', 20) }
    expect(draft.customTypes).toEqual({ term: { ...term, decayDays: 20 } })
    expect(buildOps(saved, draft)).toEqual([{ op: 'set', path: ['customTypes', 'term'], value: { ...term, decayDays: 20 } }])
  })

  it(`天数只收 1 到 ${DECAY_DAYS_MAX} 的整数；类型表单里的确认周期同一个范围，可以留空`, () => {
    expect(['1', ' 30 ', String(DECAY_DAYS_MAX)].map(parseDecayDays)).toEqual([1, 30, DECAY_DAYS_MAX])
    expect(['', '0', '-3', '1.5', '30天', String(DECAY_DAYS_MAX + 1)].map(parseDecayDays)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
    const filled = { ...EMPTY_TYPE_DRAFT, name: 'glossary', label: '术语', description: 'd', whenToSave: 'w' }
    expect(validateTypeDraft({ ...filled, decayDays: String(DECAY_DAYS_MAX + 1) }, { names: [], labels: [] })).toEqual({ ok: false, errors: { decayDays: 'decay-invalid' } })
    expect(validateTypeDraft({ ...filled, decayDays: String(DECAY_DAYS_MAX) }, { names: [], labels: [] })).toMatchObject({ ok: true, type: { decayDays: DECAY_DAYS_MAX } })
  })

  it('输入框原文：能留空的类型留空是不用定期确认，不能留空的留空和填错一样不收', () => {
    expect([parsePeriodText(' ', true), parsePeriodText('', false)]).toEqual([null, undefined])
    expect([parsePeriodText('30', true), parsePeriodText('30', false), parsePeriodText('0', true)]).toEqual([30, 30, undefined])
  })
})

describe('预设类型：改、删、恢复', () => {
  const edited: CustomType = { ...TYPE_DEFINITIONS.procedure, label: '我的流程' }

  it('removedPresetTypes 只认预设名、去重；删掉的预设不进类型池，场景里列了也不生效', () => {
    const fields = fieldsOf({ removedPresetTypes: ['decision', 'profile', 'decision', 'ghost'] })
    expect(fields.removedPresets).toEqual(['decision'])
    expect(fieldsOf({}).removedPresets).toEqual([])
    expect(typePool({ decision: term, term }, ['decision'])).toEqual([...BUILTIN_TYPE_NAMES, 'procedure', 'term'])
    const scenes = { office: PRESET_SCENES.office }
    expect(sceneTypes({ scenes, customTypes: {}, removedPresets: ['decision'] }, 'office')).toEqual([...BUILTIN_TYPE_NAMES])
  })

  it('同名 customTypes 和出厂定义不同才算改过', () => {
    expect(isPresetTypeEdited('procedure', {})).toBe(false)
    expect(isPresetTypeEdited('procedure', { procedure: { ...TYPE_DEFINITIONS.procedure } })).toBe(false)
    expect(isPresetTypeEdited('procedure', { procedure: edited })).toBe(true)
    const { howToUse: _cleared, ...withoutUsage } = TYPE_DEFINITIONS.procedure
    expect(isPresetTypeEdited('procedure', { procedure: withoutUsage })).toBe(true)
    expect(isPresetTypeEdited('term', { term })).toBe(false)
  })

  it('删预设：从场景里去掉、改动丢掉、名字记进 removedPresets；写配置是整段 set', () => {
    const saved = base({ customTypes: { procedure: edited } })
    const removed = { ...saved, ...removeType(saved, 'procedure') }
    expect(removed.removedPresets).toEqual(['procedure'])
    expect(removed.customTypes).toEqual({})
    expect(removed.scenes.coding!.types).not.toContain('procedure')
    expect(buildOps(saved, removed)).toEqual(expect.arrayContaining([
      { op: 'unset', path: ['customTypes', 'procedure'] },
      { op: 'set', path: ['removedPresetTypes'], value: ['procedure'] },
    ]))
    // 删自建类型不碰 removedPresets
    expect(removeType(base({ customTypes: { term } }), 'term').removedPresets).toEqual([])
  })

  it('恢复预设：从 removedPresets 去掉，删除时选的移到最近删除一并撤销，场景不自动勾回', () => {
    const saved = base({ removedPresets: ['decision', 'procedure'] })
    const { pool, migrations } = restorePresetType(saved, { decision: { action: 'forget' }, term: { action: 'forget' } }, 'decision')
    expect(pool.removedPresets).toEqual(['procedure'])
    expect(migrations).toEqual({ term: { action: 'forget' } })
    // 配置文件里只写了 removedPresetTypes、场景走默认值时，办公还列着 decision：恢复后不能因此自动勾回
    expect(pool.scenes.office!.types).toEqual([...BUILTIN_TYPE_NAMES])
    expect(pool.scenes.coding).toBe(saved.scenes.coding)
  })

  it('恢复预设：配置里残留的同名定义一并去掉，回到出厂定义', () => {
    const saved = base({ removedPresets: ['procedure'], customTypes: { procedure: { ...TYPE_DEFINITIONS.procedure, label: '旧流程' }, term } })
    const { pool } = restorePresetType(saved, {}, 'procedure')
    expect(pool.customTypes).toEqual({ term })
    expect(buildOps(saved, { ...saved, ...pool })).toEqual(expect.arrayContaining([{ op: 'unset', path: ['customTypes', 'procedure'] }]))
  })

  it('配置文件里手写删掉预设、场景还列着它：编码、办公不算改过', () => {
    const fields = fieldsOf({ removedPresetTypes: ['procedure'] })
    expect(isPresetEdited('coding', fields.scenes.coding!, fields.removedPresets)).toBe(false)
    expect(isPresetEdited('coding', { label: '编码', types: ['procedure', 'profile'] }, ['procedure'])).toBe(true)
  })

  it('编码、办公的出厂组成先去掉已删的预设再比、再恢复默认', () => {
    expect(presetSceneTypes('coding', ['procedure'])).toEqual([...BUILTIN_TYPE_NAMES])
    expect(isPresetEdited('coding', { label: '编码', types: [...BUILTIN_TYPE_NAMES] }, ['procedure'])).toBe(false)
    expect(isPresetEdited('coding', { label: '编码', types: [...BUILTIN_TYPE_NAMES] }, [])).toBe(true)
  })

  it('保存确认的汇总：预设单独一组（改过、恢复默认、删除、恢复），我加的不含预设', () => {
    const saved = base({ customTypes: { procedure: edited, term }, removedPresets: ['decision'] })
    const draft = base({ customTypes: { term, glossary: term }, removedPresets: [] })
    expect(presetTypeChanges(saved, draft)).toEqual({ edited: [], reset: ['procedure'], removed: [], restored: ['decision'] })
    expect(presetTypeChanges(base(), { ...base(), customTypes: { decision: { ...TYPE_DEFINITIONS.decision, decayDays: 60 } } }))
      .toEqual({ edited: ['decision'], reset: [], removed: [], restored: [] })
    const deleted = { ...saved, ...removeType(saved, 'procedure') }
    expect(presetTypeChanges(saved, deleted)).toEqual({ edited: [], reset: [], removed: ['procedure'], restored: [] })
    expect(customTypeChanges(saved.customTypes, draft.customTypes)).toEqual({ added: ['术语'], edited: [], removed: [] })
  })

  it('新建类型用了已删的预设名：单独提示（不是重名）', () => {
    const draft = { ...EMPTY_TYPE_DRAFT, name: 'decision', label: '决策', description: 'd', whenToSave: 'w' }
    const result = validateTypeDraft(draft, { names: ['procedure', 'decision'], labels: [], removedPresets: ['decision'] })
    expect(result).toMatchObject({ ok: false, errors: { name: 'name-removed-preset' } })
  })
})

describe('toPluginConfig：配置段 → 界面用到的几项', () => {
  it('PA-53：设置里超限处理、提升去处的每个取值都能转成插件配置', () => {
    for (const overflow of OVERFLOW_MODES) {
      for (const target of PROMOTE_TARGETS) {
        const section = { ...DEFAULT_SECTION, snapshotOverflow: overflow, governance: { ...DEFAULT_SECTION.governance, globalPromoteTarget: target } }
        expect(toPluginConfig(section)).toMatchObject({ snapshotOverflow: overflow, globalPromoteTarget: target })
      }
    }
  })

  it('结构不对、取值不认识时不认整份', () => {
    expect(toPluginConfig({ snapshotTokenBudget: '4000' })).toBeUndefined()
    expect(toPluginConfig({ ...DEFAULT_SECTION, snapshotOverflow: 'cut' })).toBeUndefined()
    expect(toPluginConfig({ ...DEFAULT_SECTION, governance: { ...DEFAULT_SECTION.governance, globalPromoteTarget: 'readme' } })).toBeUndefined()
  })

  it('主题色取不到或不认识时按艾拉主题色，不连累其余几项', () => {
    const base = { snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governance: { enabled: true, globalPromoteTarget: 'plugin-global' } }
    expect(toPluginConfig(base)?.accent).toBe('ella')
    expect(toPluginConfig({ ...base, accent: 'neon' })?.accent).toBe('ella')
  })

  it('customTypes 只取显示名；没名字或结构不对的条目按没改名处理，不连累其余几项', () => {
    const base = { snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governance: { enabled: true, globalPromoteTarget: 'plugin-global' } }
    const customTypes = { procedure: { label: '发版手册', description: 'd' }, term: { label: '' }, broken: null, odd: { label: 3 } }
    expect(toPluginConfig({ ...base, customTypes })?.customTypes).toEqual({ procedure: { label: '发版手册' } })
    expect(toPluginConfig({ ...base, customTypes: 'x' })?.customTypes).toEqual({})
    expect(toPluginConfig(base)?.customTypes).toEqual({})
  })
})

describe('类型表单里的说明跟着注入的样子写', () => {
  it('治理优先级：讲语义体检先查哪类、索引读不出时按它排，不再说带入时排在前面；中英文一致', async () => {
    const { settingsZh, settingsEn } = await import('../locales/settings.ts')
    expect(settingsZh['settings.type.priorityHint']).toMatch(/语义体检.*先查.*主题索引读不出/)
    expect(settingsZh['settings.type.priorityHint']).not.toContain('带入时排在前面')
    expect(settingsEn['settings.type.priorityHint']).toMatch(/semantic checkup.*first.*topic index cannot be read/)
    expect(settingsEn['settings.type.priorityHint']).not.toMatch(/brought in first/)
  })

  it('确认周期：成员行不逐条标陈旧，说明不写「带入时」', async () => {
    const { settingsZh } = await import('../locales/settings.ts')
    expect(settingsZh['settings.type.decayDaysHint']).not.toContain('带入时')
    expect(settingsZh['settings.type.decayDaysHintRequired']).not.toContain('带入时')
  })
})
