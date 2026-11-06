import { describe, expect, it } from 'vitest'
import { createTranslator } from './i18n.tsx'
import { zh } from './locales.ts'
import { typeLabel } from './type-label.ts'

const t = createTranslator(zh)

describe('typeLabel', () => {
  it('类型 id 恰好是对象原型上的名字（constructor、toString）：照样显示 id，不取到原型上的函数', () => {
    expect(typeLabel(t, 'constructor', { viewLabels: {}, customTypes: {} })).toBe('constructor')
    expect(typeLabel(t, 'toString', {})).toBe('toString')
  })
})
