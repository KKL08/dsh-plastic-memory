import { describe, expect, it } from 'vitest'
import { commandLine } from '../client/chat/command-summary.ts'
import { zh } from '../client/locales.ts'
import type { MemoryCommandResult } from '../src/gui/contract.ts'

// 对话里那一行命令摘要：换作用域去掉了够不着的关联和前提时，句子里说出去掉了几个。

const done = (result: MemoryCommandResult) => ({ kind: 'success' as const, text: JSON.stringify(result) })
const dropped = [{ id: 'mem_m', related: ['mem_p', 'mem_q'], premises: ['mem_p'] }]

describe('换作用域去掉了关联的命令摘要', () => {
  it('提升为全局、移到项目、撤销：结果带去掉的关联和前提时，那一句接上去掉了几个', () => {
    const cases: Array<[string, string, Record<string, string | number>]> = [
      [' promote-memory {"memoryId":"mem_m","layer":{"kind":"workspace","workspacePath":"/w/app"}}', 'chat.command.promote.global.droppedLinks', { n: 3 }],
      [' move-memory {"memoryId":"mem_m","workspacePath":"/w/app"}', 'chat.command.move.droppedLinks', { name: 'app', n: 3 }],
      [' undo {"decisionId":"pd_1"}', 'chat.command.undo.droppedLinks', { n: 3 }],
    ]
    for (const [args, key, params] of cases) {
      const line = commandLine(args, done({ ok: true, cmd: args.trim().split(' ')[0]!, droppedLinks: dropped }))
      expect(line).toEqual({ state: 'ok', action: { key, params } })
      expect(zh[key as keyof typeof zh]).toContain('{n}')
    }
  })

  it('没去掉的时候句子不变', () => {
    const line = commandLine(' undo {"decisionId":"pd_1"}', done({ ok: true, cmd: 'undo' }))
    expect(line).toEqual({ state: 'ok', action: { key: 'chat.command.undo' } })
  })
})
