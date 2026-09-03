/** 把「必须抛错」的调用收成可断言的错误对象：先断类型（instanceof），再断 code 等结构字段。 */
export function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw')
}

export async function captureRejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected the promise to reject')
}
