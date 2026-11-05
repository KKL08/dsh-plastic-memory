import { describe, expect, it } from 'vitest'
import { checkupResultSchema, directoryIssueSchema, memoryCommandResultSchema } from '../src/gui/contract.ts'

describe('契约的枚举字段', () => {
  it('PA-18 目录问题码、体检结果说明码、scan 命令说明码：认识的取值通过，不认识的拒绝', () => {
    const issue = (code: string) => directoryIssueSchema.safeParse({ code, path: '/m/a.md' }).success
    expect([issue('duplicate-id'), issue('dir-gone')]).toEqual([true, false])

    const result = (code: string) => checkupResultSchema.safeParse({
      checkupId: 'c1', by: 'manual', completedAt: 1, added: { keys: [], pending: 0, advice: 0 }, notes: [{ code }],
    }).success
    expect([result('semantic-batched'), result('semantic-timeout')]).toEqual([true, false])

    const scan = (code: string) => memoryCommandResultSchema.safeParse({ ok: true, cmd: 'scan', notes: [code] }).success
    expect([scan('baseline-missing'), scan('baseline-gone')]).toEqual([true, false])
  })
})
