import { describe, expect, it } from 'vitest'
import { createCordisHostSession } from '../src/cordis-host-session.ts'

// 宿主会话适配器读存档状态：宿主的工作区登记表是替身（宿主边界），适配器本身用真的

/** services：按名字给的宿主服务；值是函数时每次查找调用它（可以抛错）。 */
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

describe('已存档的会话', () => {
  it('工作区登记表给出存档的会话 id', async () => {
    const host = boot({ workspaceRegistry: { archivedSessionIds: ['s_old', 's_older'] } })
    expect(await host.archivedSessionIds()).toEqual(new Set(['s_old', 's_older']))
  })

  it('每次现读：登记表变了，下次读到的跟着变', async () => {
    const registry = { archivedSessionIds: ['s_old'] }
    const host = boot({ workspaceRegistry: registry })
    expect(await host.archivedSessionIds()).toEqual(new Set(['s_old']))
    registry.archivedSessionIds = []
    expect(await host.archivedSessionIds()).toEqual(new Set())
  })

  it('读不出为 null，不当成没有存档的会话：服务缺席、查找抛错、字段不是字符串数组、取字段抛错', async () => {
    expect(await boot().archivedSessionIds()).toBeNull()
    expect(await boot({ workspaceRegistry: () => { throw new Error('服务查不到') } }).archivedSessionIds()).toBeNull()
    for (const bad of [undefined, null, 's_old', ['s_old', 3], { 0: 's_old' }]) {
      expect(await boot({ workspaceRegistry: { archivedSessionIds: bad } }).archivedSessionIds()).toBeNull()
    }
    const throwing = { get archivedSessionIds(): string[] { throw new Error('读不出') } }
    expect(await boot({ workspaceRegistry: throwing }).archivedSessionIds()).toBeNull()
  })
})
