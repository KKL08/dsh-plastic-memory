// 设置页在浏览器侧重复声明的几份服务端常量（客户端只许 import src/gui/contract）：和服务端源头保持一致。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { BUILTIN_TYPE_NAMES, ENTRY_ID, PACKAGE_NAME, SENSITIVITY_NUMBERS } from '../client/settings/config.ts'
import { SENSITIVITY_PRESETS } from '../src/governance/health-presets.ts'
import { BUILTIN_TYPES } from '../src/type-registry.ts'

describe('设置页重复声明的服务端常量', () => {
  it('内置类型名与 BUILTIN_TYPES 一致', () => {
    expect([...BUILTIN_TYPE_NAMES].sort()).toEqual(BUILTIN_TYPES.map(t => t.name).sort())
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
})
