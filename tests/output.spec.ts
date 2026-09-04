import { describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { toToolOutput } from '../src/tools/output.ts'

// toToolOutput 的契约：语义 =「宿主 snapshotJsonValue 会接受的值」，只做一件宽容：深度剔除
// undefined。其余非 JSON 值（NaN/±Infinity/-0、Date/Map/Set/类实例/函数/bigint/symbol、循环）
// 一律抛 TypeError，让契约测试而非宿主报错。

/** 递归深冻一个对象，供不可变测试：实现若尝试原地改动会在严格模式抛错。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

describe('toToolOutput — 深度剔除 undefined', () => {
  it('删除顶层对象里值为 undefined 的键', () => {
    expect(toToolOutput({ a: 1, b: undefined })).toEqual({ a: 1 })
  })

  it('任意深度删除嵌套对象里值为 undefined 的键', () => {
    expect(toToolOutput({ a: { b: { c: undefined, d: 2 } } })).toEqual({ a: { b: { d: 2 } } })
  })

  it('保留 null，不当作 undefined 删除', () => {
    expect(toToolOutput({ a: null })).toEqual({ a: null })
  })

  it('保留空对象', () => {
    expect(toToolOutput({ a: {} })).toEqual({ a: {} })
  })

  it('保留空数组', () => {
    expect(toToolOutput({ a: [] })).toEqual({ a: [] })
  })

  it('数组内 undefined 元素转 null，保持长度与下标', () => {
    const out = toToolOutput([1, undefined, 3])
    expect(out).toEqual([1, null, 3])
    expect(Array.isArray(out) ? out.length : -1).toBe(3)
  })
})

describe('toToolOutput — 拒绝非 JSON 数字（抛 TypeError，不静默转换）', () => {
  // 关键区分点：JSON.parse(JSON.stringify(v)) 会把 NaN/Infinity 静默转成 null、
  // 把 -0 转成 0；契约要求这些一律抛错，所以断言错误类型必须是 TypeError。
  it('NaN 抛 TypeError', () => {
    expect(() => toToolOutput(NaN)).toThrow(TypeError)
  })

  it('Infinity 抛 TypeError', () => {
    expect(() => toToolOutput(Infinity)).toThrow(TypeError)
  })

  it('-Infinity 抛 TypeError', () => {
    expect(() => toToolOutput(-Infinity)).toThrow(TypeError)
  })

  it('-0 抛 TypeError', () => {
    expect(() => toToolOutput(-0)).toThrow(TypeError)
  })
})

describe('toToolOutput — 拒绝非纯对象/函数/bigint/symbol（抛 TypeError）', () => {
  it('Date 抛 TypeError（不序列化成 ISO 字符串）', () => {
    expect(() => toToolOutput(new Date('2026-01-01T00:00:00.000Z'))).toThrow(TypeError)
  })

  it('Map 抛 TypeError（不静默变成空对象）', () => {
    expect(() => toToolOutput(new Map([['k', 'v']]))).toThrow(TypeError)
  })

  it('Set 抛 TypeError', () => {
    expect(() => toToolOutput(new Set([1, 2]))).toThrow(TypeError)
  })

  it('类实例（原型非 Object.prototype）抛 TypeError', () => {
    class Point {
      x = 1
      y = 2
    }
    expect(() => toToolOutput(new Point())).toThrow(TypeError)
  })

  it('函数抛 TypeError', () => {
    expect(() => toToolOutput({ fn: () => 1 })).toThrow(TypeError)
  })

  it('bigint 抛 TypeError', () => {
    expect(() => toToolOutput({ n: 10n })).toThrow(TypeError)
  })

  it('symbol 抛 TypeError', () => {
    expect(() => toToolOutput({ s: Symbol('x') })).toThrow(TypeError)
  })

  it('symbol 键抛 TypeError（不静默丢弃）', () => {
    expect(() => toToolOutput({ ok: 1, [Symbol('hidden')]: 2 })).toThrow(TypeError)
  })

  it('非枚举键抛 TypeError（不静默丢弃）', () => {
    const obj: Record<string, unknown> = { ok: 1 }
    Object.defineProperty(obj, 'hidden', { value: 2, enumerable: false })
    expect(() => toToolOutput(obj)).toThrow(TypeError)
  })

  it('带 toJSON 方法的对象抛 TypeError（不调用 toJSON，函数值属性即非 JSON）', () => {
    // JSON.parse(JSON.stringify(v)) 会调用 toJSON 得到字符串；契约不接管 toJSON，
    // toJSON 是一个可枚举的函数值属性，因此按函数规则抛错。
    expect(() => toToolOutput({ id: 1, toJSON: () => 'serialized' })).toThrow(TypeError)
  })

  it('嵌套非纯对象：抛 TypeError 且错误信息含路径 entries[2].current', () => {
    const input = { entries: [{}, {}, { current: new Date('2026-01-01T00:00:00.000Z') }] }
    let err: unknown
    try {
      toToolOutput(input)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TypeError)
    if (!(err instanceof Error)) throw new Error('期望抛出一个 Error')
    expect(err.message).toContain('entries[2].current')
  })
})

describe('toToolOutput — 循环引用', () => {
  it('循环引用抛 TypeError', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => toToolOutput(cyclic)).toThrow(TypeError)
  })
})

describe('toToolOutput — 顶层 undefined', () => {
  it('顶层 undefined 抛 TypeError（无容器可剔除，且非 JsonValue）', () => {
    expect(() => toToolOutput(undefined)).toThrow(TypeError)
  })
})

describe('toToolOutput — 返回新对象且不改输入', () => {
  it('返回一个全新对象，引用与输入不同', () => {
    const input = { a: 1 }
    expect(toToolOutput(input)).not.toBe(input)
  })

  it('不改输入：深冻输入后仍能剔除，且输入结构逐字不变', () => {
    const input = { a: 1, b: undefined, nested: { c: undefined, d: [2, undefined] } }
    const before = structuredClone(input) // structuredClone 保留对象/数组里的 undefined
    deepFreeze(input)
    // 若实现原地 delete/改写，深冻会在此抛错；不抛才说明是纯函数式复制。
    const out = toToolOutput(input)
    expect(out).toEqual({ a: 1, nested: { d: [2, null] } })
    expect(input).toStrictEqual(before) // toStrictEqual 区分 undefined 键，输入必须原样
  })
})

describe('toToolOutput ↔ 宿主 snapshotJsonValue 交叉验证', () => {
  // 正向：凡 toToolOutput 接受的值，snapshotJsonValue 必须不返回 undefined（宿主也接受），
  // 且快照结构等于剔除后的形状。
  const accepted: Array<{ label: string; input: unknown; expected: unknown }> = [
    { label: '对象含 undefined 键', input: { a: 1, b: undefined }, expected: { a: 1 } },
    { label: '数组含 undefined 元素', input: [1, undefined, 3], expected: [1, null, 3] },
    { label: '深层嵌套剔除', input: { a: { b: { c: undefined } } }, expected: { a: { b: {} } } },
    { label: 'null 保留', input: { a: null }, expected: { a: null } },
    { label: '空对象', input: {}, expected: {} },
    { label: '空数组', input: [], expected: [] },
    { label: '顶层数字', input: 42, expected: 42 },
    { label: '顶层字符串', input: 's', expected: 's' },
    { label: '顶层布尔', input: true, expected: true },
    { label: '顶层 null', input: null, expected: null },
  ]

  it.each(accepted)('接受 $label：宿主不拒绝且快照结构正确', ({ input, expected }) => {
    const snap = snapshotJsonValue(toToolOutput(input))
    expect(snap).not.toBeUndefined()
    expect(snap).toEqual(expected)
  })

  // 反向：至少一类被拒绝的原值，宿主对原值同样返回 undefined，
  // 说明 toToolOutput 抛错与宿主拒绝对齐（并解释为什么需要它先做剔除）。
  const hostRejects: Array<{ label: string; input: unknown }> = [
    { label: '带 undefined 键的对象', input: { a: undefined } },
    { label: 'NaN', input: NaN },
    { label: 'Date', input: new Date('2026-01-01T00:00:00.000Z') },
  ]

  it.each(hostRejects)('宿主对原值 $label 同样返回 undefined', ({ input }) => {
    expect(snapshotJsonValue(input)).toBeUndefined()
  })
})
