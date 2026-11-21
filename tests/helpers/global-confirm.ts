import type { PipelineResult } from '../../src/pipeline.ts'

/** 像模型一样从全局改写引导里抄出确认码；不是引导就抛错，测试当场失败。 */
export function confirmCodeOf(result: PipelineResult): string {
  const code = result.kind === 'rejected' && result.code === 'global-update-unconfirmed'
    ? /confirmGlobal: "(\d+)"/.exec(result.reason)?.[1]
    : undefined
  if (code === undefined) throw new Error(`不是全局改写引导：${JSON.stringify(result)}`)
  return code
}
