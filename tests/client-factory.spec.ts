import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { buildClient } from '../scripts/build-client.ts'

// 浏览器半侧的工厂格式（spec「Testing Decisions」第 2 层）：构建产物在 vm 里用假的
// window.__ModuleLoader__ 加载，断言 id 等于包名、factory 返回 {inject, apply}、
// require 只问过宿主共享模块表里的名字。
// 白名单抄自宿主 packages/client/web/src/platform.ts 的 PLATFORM_MODULES（0.2.1-rc.2），
// 故意不从构建脚本导入：构建脚本的 externals 写错时这里要能拦住。
const HOST_PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
// 技能（cordis-plugin-development practices.md）禁止外部插件 require ui-primitives
const FORBIDDEN = new Set(['@deepseek-ai/dsh-client-ui-primitives'])

interface Handoff { id: string; factory: (require: (spec: string) => unknown) => unknown }
interface ClientPlugin { inject: unknown; apply: (ctx: unknown) => unknown }

let dir: string
let bundle: string
const pkgName = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plastic-memory-client-'))
  const outfile = join(dir, 'client.js')
  await buildClient({ outfile })
  bundle = await readFile(outfile, 'utf8')
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

/** 在独立 vm 上下文里执行产物，收集它交给模块加载器的登记。 */
function evaluate(): Handoff[] {
  const handoffs: Handoff[] = []
  runInNewContext(bundle, { window: { __ModuleLoader__: { load: (h: Handoff) => { handoffs.push(h) } } } })
  return handoffs
}

// 产物在加载期就会建 zod schema、React context，这几个给真模块（宿主运行时同样提供），其余给空桩。
const realRequire = createRequire(import.meta.url)
const REAL_MODULES = new Set(['react', 'react/jsx-runtime', 'zod'])

/** 假 require：记下被问到的模块名，给出够 factory 求值用的模块。 */
function fakeRequire(asked: string[]) {
  return (spec: string): unknown => {
    asked.push(spec)
    return REAL_MODULES.has(spec) ? realRequire(spec) : {}
  }
}

describe('lib/client.js 工厂格式', () => {
  it('只登记一次，id 等于包名', () => {
    const handoffs = evaluate()
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]!.id).toBe(pkgName)
  })

  it('factory 返回 {inject, apply}，require 只问过宿主共享模块', () => {
    const asked: string[] = []
    const plugin = evaluate()[0]!.factory(fakeRequire(asked)) as ClientPlugin
    expect(Array.isArray(plugin.inject)).toBe(true)
    expect(typeof plugin.apply).toBe('function')
    expect(asked.filter(spec => !HOST_PLATFORM_MODULES.has(spec))).toEqual([])
    expect(asked.filter(spec => FORBIDDEN.has(spec))).toEqual([])
  })

  it('apply 注册左栏图标与同 id 的主面板', () => {
    const plugin = evaluate()[0]!.factory(fakeRequire([])) as ClientPlugin
    const registered: Array<{ name: string; id?: string; key?: string }> = []
    const ctx = {
      slots: {
        inject: (_name: string, fn: () => unknown) => { fn(); return () => {} },
        register: (opts: { name: string; id?: string; key?: string }) => { registered.push(opts); return () => {} },
      },
      locale: { register: () => () => {}, bind: () => (key: string) => key, getSnapshot: () => 0, subscribe: () => () => {} },
      layout: { selectPanel: () => {} },
    }
    plugin.apply(ctx)
    const icon = registered.find(r => r.name === 'sidebar.panellist')
    const page = registered.find(r => r.name === 'main')
    expect(icon?.id).toBeTruthy()
    expect(page?.key).toBe(icon?.id)
  })
})
