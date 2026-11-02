// 设置页配置模型的纯函数：场景的解析与写入、场景 id、类型迁移的合并、类型表单校验。
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TYPE_NAMES, EMPTY_TYPE_DRAFT, GENERAL_SCENE, PRESET_SCENES, TYPE_DEFINITIONS, buildOps, customTypeChanges, droppedTypes, fieldsOf,
  forgetMigrations, isPresetEdited, isPresetTypeEdited, keepMigrations, memoryCountOf, nextSceneId, pendingNames, presetSceneTypes, presetTypeChanges,
  removeType, renameMigrations, renameType, restorePresetType, sceneChanges, sceneTypes, typePool, validateSceneDraft, validateTypeDraft,
  type CustomType, type SettingsFields,
} from './config.ts'

const term: CustomType = { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' }
const base = (patch: Partial<SettingsFields> = {}): SettingsFields => ({ ...fieldsOf({}), ...patch })

describe('场景字段', () => {
  it('配置里没有 scenes 时用出厂的编码、办公；当前场景默认编码', () => {
    const fields = fieldsOf({})
    expect(fields.template).toBe('coding')
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
