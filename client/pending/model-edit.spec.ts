// 写要求区底栏的提示和置灰原因。
import { describe, expect, it } from 'vitest'
import type { ModelState } from '../gateway.ts'
import type { Translate } from '../i18n.tsx'
import { requestFootOf } from './model-edit.tsx'

const t: Translate = key => key
const READY: ModelState = { status: 'ready', model: 'm' }
const NONE: ModelState = { status: 'unavailable' }

describe('写要求区底栏', () => {
  it('拿不到模型最先：提示和置灰原因都写它，盖过调用方的原因和空要求', () => {
    expect(requestFootOf(NONE, true, t, 'other')).toEqual({ hint: 'pending.model.unavailable', blocked: 'pending.model.unavailable' })
  })

  it('调用方的原因排在空要求之前；提示照旧提醒写要求', () => {
    expect(requestFootOf(READY, true, t, 'other')).toEqual({ hint: 'library.model.empty', blocked: 'other' })
    expect(requestFootOf(READY, false, t)).toEqual({ hint: 'pending.model.hint', blocked: undefined })
  })
})
