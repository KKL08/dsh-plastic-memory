import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createCordisHostSession } from '../src/cordis-host-session.ts'
import { readPrunerThreshold } from '../src/tools/search-budget.ts'

// 宿主会话适配器取工具结果裁剪服务：宿主的 agent 预设登记表和根上的服务是替身（宿主边界），适配器本身用真的。
// 裁剪服务挂在 agent 预设的隔离分组里，插件根上的查找看不到它，要经预设登记表按 agent 取。

function boot(services: Record<string, unknown> = {}) {
  return createCordisHostSession({
    lookup: name => {
      const v = services[name]
      return typeof v === 'function' ? (v as () => unknown)() : v
    },
    logger: { warn: () => {} },
    resolveCwd: async cwd => cwd,
  })
}
const execOf = (agent: unknown) => ({ agent } as unknown as ToolRunContext)
const scoped = { config: { thresholdChars: 6000 } }
const root = { config: { thresholdChars: 8192 } }

describe('取裁剪服务', () => {
  it('按这次调用所在的 agent 经预设登记表取隔离分组里的那个', () => {
    const agent = { ctx: {} }
    const asked: unknown[] = []
    const host = boot({
      agentPresets: { serviceFor: (a: unknown, name: string) => { asked.push([a, name]); return a === agent ? scoped : undefined } },
      toolResultPruner: () => root,
    })
    expect(host.toolResultPrunerOf(execOf(agent))).toBe(scoped)
    expect(asked).toEqual([[agent, 'toolResultPruner']])
  })

  it('agent 的预设里没有：退回插件根上的服务；根上也没有为 undefined', () => {
    const agent = { ctx: {} }
    const presets = { serviceFor: () => undefined }
    expect(boot({ agentPresets: presets, toolResultPruner: () => root }).toolResultPrunerOf(execOf(agent))).toBe(root)
    expect(boot({ agentPresets: presets }).toolResultPrunerOf(execOf(agent))).toBeUndefined()
  })

  it('没有预设登记表、或调用不带 agent：取根上的服务', () => {
    expect(boot({ toolResultPruner: () => root }).toolResultPrunerOf(execOf({ ctx: {} }))).toBe(root)
    const presets = { serviceFor: () => scoped }
    expect(boot({ agentPresets: presets, toolResultPruner: () => root }).toolResultPrunerOf(execOf(undefined))).toBe(root)
  })

  it.each([['agentPresets'], ['toolResultPruner']])('查找 %s 时抛错：错误照常抛给调用方，按读不出处理，不当成没有裁剪服务', name => {
    const host = boot({
      agentPresets: name === 'agentPresets' ? () => { throw new Error('查找失败') } : { serviceFor: () => undefined },
      toolResultPruner: name === 'toolResultPruner' ? () => { throw new Error('查找失败') } : undefined,
    })
    expect(() => host.toolResultPrunerOf(execOf({ ctx: {} }))).toThrow('查找失败')
    expect(readPrunerThreshold(() => host.toolResultPrunerOf(execOf({ ctx: {} })))).toEqual({ kind: 'unknown' })
  })

  it('预设登记表取服务抛错：错误照常抛给调用方，由它按读不出处理', () => {
    const presets = { serviceFor: () => { throw new Error('预设正在重载') } }
    expect(() => boot({ agentPresets: presets }).toolResultPrunerOf(execOf({ ctx: {} }))).toThrow('预设正在重载')
  })
})
