import { describe, expect, it } from 'vitest'
import {
  checkupResultSchema, CROSS_WORKSPACE_COMMANDS, directoryIssueSchema, encodeMemoryCommand, MEMORY_COMMAND_NAME, memoryCommandResultSchema,
  memoryCommandSchema, OPEN_ITEM_COMMANDS, parseMemoryCommand, type MemoryCommand,
} from '../src/gui/contract.ts'
import { SAMPLE_COMMANDS } from '../client/command/test-commands.ts'

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

describe('契约里界面要用的命令集', () => {
  it('可带跨项目确认的命令：恰好是 schema 收下 allowCrossWorkspace 的那些', () => {
    for (const [cmd, sample] of Object.entries(SAMPLE_COMMANDS)) {
      const parsed = memoryCommandSchema.parse({ ...sample, allowCrossWorkspace: true })
      expect({ cmd, isKept: 'allowCrossWorkspace' in parsed }).toEqual({ cmd, isKept: CROSS_WORKSPACE_COMMANDS.has(cmd as never) })
    }
    expect([...CROSS_WORKSPACE_COMMANDS].sort()).toEqual([
      'confirm', 'edit-memory', 'forget', 'hard-delete', 'keep-local', 'keep-local-memory', 'merge-memories', 'move-memory',
      'promote', 'promote-memory', 'resolve', 'restore', 'undo',
    ])
  })

  it('not-found 算别处已处理的命令：都是 schema 里的命令，不含 undo（快照过期也回 not-found）', () => {
    const known = new Set(memoryCommandSchema.options.map(o => o.shape.cmd.value))
    expect([...OPEN_ITEM_COMMANDS].filter(cmd => !known.has(cmd))).toEqual([])
    expect(OPEN_ITEM_COMMANDS.has('undo')).toBe(false)
  })
})

describe('draft-edit 的放宽', () => {
  const ref = { memoryId: 'm1', layer: { kind: 'global' } } as const

  it('不带建议类型时要求必填（只有空白也算没写）；带建议类型时要求可空', () => {
    const accepts = (args: object) => memoryCommandSchema.safeParse({ cmd: 'draft-edit', memories: [ref], ...args }).success
    expect(accepts({ request: '「每周三」改成每周四' })).toBe(true)
    expect(accepts({})).toBe(false)
    expect(accepts({ request: '  \n' })).toBe(false)
    expect(accepts({ adviceType: 'bloat' })).toBe(true)
  })

  it('此前的要求、计划随命令文本往返', () => {
    const command = {
      cmd: 'draft-edit', memories: [ref], request: '再短一点', priorRequests: ['周三改成周四', '命令保留'],
      planNote: { reason: '和另一条说法矛盾', question: { text: '以哪条为准？', placeholder: '不填就以较新的为准' }, answer: '以周四为准' },
      previous: { content: '每周四发版', summary: '发版日' },
    } as const satisfies MemoryCommand
    const parsed = parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))
    expect(parsed).toEqual({ ok: true, command })
  })

  it('计划只有理由也收；提问缺占位文字不收', () => {
    const accepts = (planNote: object) => memoryCommandSchema.safeParse({ cmd: 'draft-edit', memories: [ref], request: '改', planNote }).success
    expect(accepts({ reason: '过时了' })).toBe(true)
    expect(accepts({ reason: '过时了', question: { text: '换成什么？' } })).toBe(false)
  })
})
