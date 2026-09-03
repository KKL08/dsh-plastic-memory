import type { JsonValue } from '@deepseek-ai/dsh-session'

/**
 * 工具执行结果 → 宿主可无损序列化的 JsonValue。
 *
 * 宿主（dsh-session 的 snapshotJsonValue）对每个工具结果做深度无损 JSON 校验：含
 * undefined / 非纯对象 / 函数 / NaN / ±Infinity / -0 / 循环的值一律被判为不可无损序列化。
 * 执行器返回的领域对象（PipelineResult、SnapshotToolResult 等接口）常带可选字段——不填时
 * 键值为 undefined，宿主据此拒收。本函数只做一件宽容：深度剔除 undefined（对象删键、
 * 数组元素转 null，与 JSON.stringify 一致）；其余宿主会拒的值一律抛 TypeError（在本插件里
 * 报出、带路径，而非等宿主静默拒绝），并返回全新的 JsonValue，绝不改动输入。
 *
 * 绑定层唯一允许的双重 cast 由此成立：execute 返回本函数的产物（静态类型 JsonValue），
 * defineTool 的输出 schema 是 { type: 'json' }，故 render 收到的 value 静态类型也是 JsonValue；
 * 但宿主传给 render 的是它对 execute 产物做 snapshotJsonValue 后的结构等价克隆——形状即
 * 执行器结果类型 X 去掉 undefined 键。因此 render 里写 `value as unknown as X` 是安全的；
 * 绑定层只允许这一处双重 cast（pipeline 里 pruneUndefined 的那处由本函数固定返回
 * JsonValue 的签名所迫，另有注释）。
 */
export function toToolOutput<T>(value: T): JsonValue {
  return walk(value, '', new Set())
}

/** 递归走一遍：深剔 undefined，拒非 JSON 值（错误信息带路径），检测循环。 */
function walk(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean') return value as string | boolean
  if (type === 'number') {
    const n = value as number
    // 宿主拒 NaN/±Infinity/-0，不静默转 null/0——我们同样拒并给清晰错误
    if (!Number.isFinite(n) || Object.is(n, -0)) {
      throw new TypeError(`toToolOutput: 非 JSON 数字（${String(n)}）位于 ${loc(path)}`)
    }
    return n
  }
  // 顶层 undefined 落这里（容器内的 undefined 由下面的容器分支就地处理，不会走到这）；
  // 函数/bigint/symbol 是可枚举属性值时也在这里被拒（含对象上的 toJSON 函数值键）
  if (type === 'undefined' || type === 'bigint' || type === 'symbol' || type === 'function') {
    throw new TypeError(`toToolOutput: 非 JSON 值（${type}）位于 ${loc(path)}`)
  }

  const obj = value as object
  if (ancestors.has(obj)) {
    throw new TypeError(`toToolOutput: 检测到循环引用，位于 ${loc(path)}`)
  }
  ancestors.add(obj)
  try {
    if (Array.isArray(obj)) {
      const out: JsonValue[] = []
      for (let i = 0; i < obj.length; i++) {
        const el = (obj as unknown[])[i]
        // 数组元素 undefined → null，保持长度与下标（与 JSON.stringify 一致）
        out[i] = el === undefined ? null : walk(el, `${path}[${i}]`, ancestors)
      }
      return out
    }

    // 非纯对象（Date/Map/Set/类实例/原型非 Object.prototype）宿主拒收。
    // 有意的简化：只认本 realm 的 Object.prototype（宿主还接受跨 realm 的纯对象）；插件的
    // 领域逻辑不产生跨 realm 值，收严无害。
    const proto = Object.getPrototypeOf(obj)
    if (proto !== null && proto !== Object.prototype) {
      throw new TypeError(`toToolOutput: 非纯对象位于 ${loc(path)}`)
    }
    // 只认 own enumerable string 键；symbol 键 / 非枚举键宿主同样拒（与其 enumerableStringKeys 对齐）
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(obj, key)) {
        throw new TypeError(`toToolOutput: 对象含非 JSON 键（${String(key)}）位于 ${loc(path)}`)
      }
    }
    const out: { [key: string]: JsonValue } = {}
    for (const key of Object.keys(obj)) {
      const child = (obj as Record<string, unknown>)[key]
      if (child === undefined) continue // 对象值为 undefined 的键：删除
      out[key] = walk(child, path === '' ? key : `${path}.${key}`, ancestors)
    }
    return out
  } finally {
    ancestors.delete(obj)
  }
}

function loc(path: string): string {
  return path === '' ? '<root>' : path
}
