// 设置页在浏览器半侧手抄的几份服务端常量（客户端只许 import src/gui/contract）：和服务端源头保持一致。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import {
  BUILTIN_TYPE_NAMES, ENTRY_ID, PACKAGE_NAME, PRESET_SCENES as CLIENT_PRESET_SCENES, PRESET_TYPE_NAMES, RETIRED_TYPE_NAMES, SENSITIVITY_NUMBERS,
  buildOps, fieldsOf,
} from '../client/settings/config.ts'
import { applyOps } from '../client/settings/config-form.fake.ts'
import { Config } from '../src/index.ts'
import { SENSITIVITY_PRESETS } from '../src/governance/health-presets.ts'
import { BUILTIN_TYPES, PRESET_SCENES, PRESET_TYPES, RETIRED_TYPES } from '../src/type-registry.ts'

describe('设置页手抄的服务端常量', () => {
  it('内置类型名与 BUILTIN_TYPES 一致', () => {
    expect([...BUILTIN_TYPE_NAMES].sort()).toEqual(BUILTIN_TYPES.map(t => t.name).sort())
  })

  it('预设类型、退役类型名单与 PRESET_TYPES、RETIRED_TYPES 一致', () => {
    expect([...PRESET_TYPE_NAMES]).toEqual(PRESET_TYPES.map(t => t.name))
    expect([...RETIRED_TYPE_NAMES]).toEqual(RETIRED_TYPES.map(t => t.name))
  })

  it('编码、办公的出厂组成与 PRESET_SCENES 一致，也是 Config 里 scenes 的默认值', () => {
    expect(CLIENT_PRESET_SCENES).toEqual(PRESET_SCENES)
    expect(fieldsOf({ scenes: new Config({} as never).scenes.get() }).scenes).toEqual(PRESET_SCENES)
  })

  it('灵敏度说明里的数值与预设一致', () => {
    for (const [level, preset] of Object.entries(SENSITIVITY_PRESETS)) {
      expect(SENSITIVITY_NUMBERS[level as keyof typeof SENSITIVITY_NUMBERS])
        .toEqual({ score: preset.actionScoreThreshold, days: preset.pendingOverdueDays })
    }
  })

  it('configForms 的 entryId 是 cordis.patch.yml 插入的行 id，插槽 key 是包名', () => {
    const patch = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(patch[0]!.insert[0]).toMatchObject({ id: ENTRY_ID, name: PACKAGE_NAME })
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }
    expect(pkg.name).toBe(PACKAGE_NAME)
  })

  it('场景写进 Config：删掉的出厂场景保存后不被默认值补回，新建的场景原样读回', () => {
    const saved = fieldsOf({})
    const draft = { ...saved, template: 'scene-1', scenes: { coding: saved.scenes.coding!, 'scene-1': { label: '写作', types: ['preference'] } } }
    const written = applyOps({ scenes: structuredClone(PRESET_SCENES) }, buildOps(saved, draft)!)
    const config = new Config(written as never)
    expect(config.template.get()).toBe('scene-1')
    expect(Object.keys(config.scenes.get())).toEqual(['coding', 'scene-1'])
  })

  it('设置页不读写用户词典路径：保存别的项时不会把配置文件里的路径写回或清掉', () => {
    const section = { search: { userDictionaryPath: '/opt/dict/domain.txt' } }
    const saved = fieldsOf(section)
    expect(buildOps(saved, { ...saved, budget: '5000' })).toEqual([{ op: 'set', path: ['snapshotTokenBudget'], value: 5000 }])
  })
})
