/**
 * 发布包的浏览器半侧检查（host:smoke 与 host:contract 共用，无需 key，CI 常规档就跑）。
 * 对象是 `dsh plugin add` 装进隔离 DSH_HOME 的那份包，也就是用户实际拿到的形状：
 *   - package.json 声明 `dsh.client.platform = "web"`，`exports['./client']` 指向的文件存在；
 *   - 该文件在假的 `window.__ModuleLoader__` 下按工厂格式加载：只登记一次、id 等于包名，
 *     factory 返回 `apply` 函数和 `inject` 数组，require 只问宿主共享模块表里的名字；
 *   - apply 交给记录型假宿主后登记的插槽名集合等于写死的预期，每个预期插槽名都还在宿主客户端包的插槽声明里；
 *   - 仓库 locale/ 下的每个 *.json 都随包发出且能解析。
 * 宿主自己的扫描器只挂在 web profile 上，这里不起浏览器、不连宿主，只验包本身能被工厂加载。
 *
 *   用法：node scripts/host-contract/verify-client.ts <已安装包目录> <宿主安装目录>
 *
 * 只用可擦除的 TypeScript 语法（Node 22.19+/24 原生 strip-types 直接加载）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { HOST_MODULES } from '../build-client.ts'

interface Handoff { id: string; factory: (require: (spec: string) => unknown) => unknown }

/** 插件挂的全部插槽（对着钉版与 peer 下界宿主客户端包的 SlotMap 声明逐个核过）。插件新挂或撤掉一处时同步改这里。 */
const EXPECTED_SLOTS = [
  'conversation.chat.turnTail', 'conversation.composer.dock', 'main', 'plugins.bundle.config',
  'sidebar.panellist', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'tool.call.toolview',
]

const [pkgDir, hostDir] = process.argv.slice(2)
if (pkgDir === undefined || hostDir === undefined) {
  console.error('usage: verify-client.ts <installed package dir> <host install dir>')
  process.exit(2)
}
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const failures: string[] = []

/** 宿主客户端包（@deepseek-ai/dsh-client-ui-*）类型声明里带 SlotMap 的文件全文。 */
function hostSlotDeclarations(): string {
  const scope = join(hostDir!, 'node_modules', '@deepseek-ai')
  const texts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.d.ts')) {
        const text = readFileSync(path, 'utf8')
        if (text.includes('interface SlotMap')) texts.push(text)
      }
    }
  }
  for (const name of readdirSync(scope).filter(n => n.startsWith('dsh-client-ui-'))) {
    const types = join(scope, name, 'lib', 'types')
    if (existsSync(types)) walk(types)
  }
  return texts.join('\n')
}

/** 记录型假宿主：插槽登记记名字，inject 的回调立刻执行（可选服务都当有），其余服务是什么都接的空桩。 */
function recordSlots(apply: (ctx: unknown) => void): string[] {
  const names: string[] = []
  const stub = (): unknown => new Proxy(() => {}, {
    get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : stub()),
    apply: () => stub(),
  })
  const host: unknown = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'slots') return { inject: (_name: string, fn: () => void) => { fn(); return () => {} }, register: (options: { name: string }) => { names.push(options.name); return () => {} } }
      if (key === 'inject') return (_deps: unknown, callback: (scope: unknown) => void) => { callback(host); return () => {} }
      if (key === 'effect') return (execute: () => unknown) => { execute(); return () => {} }
      return key === 'then' || typeof key === 'symbol' ? undefined : stub()
    },
  })
  apply(host)
  return [...new Set(names)].sort()
}
const check = (ok: boolean, label: string, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures.push(label)
}

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  name: string
  dsh?: { client?: { platform?: unknown } }
  exports?: Record<string, unknown>
}
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform is "web"', JSON.stringify(pkg.dsh?.client))
const clientRel = pkg.exports?.['./client']
check(typeof clientRel === 'string', "exports['./client'] is declared", JSON.stringify(clientRel))
const clientPath = typeof clientRel === 'string' ? join(pkgDir, clientRel) : undefined
const hasBundle = clientPath !== undefined && existsSync(clientPath)
check(hasBundle, "exports['./client'] file ships", String(clientRel))

if (hasBundle) {
  const handoffs: Handoff[] = []
  runInNewContext(readFileSync(clientPath, 'utf8'), {
    window: { __ModuleLoader__: { load: (h: Handoff) => { handoffs.push(h) } } },
  })
  check(handoffs.length === 1, 'bundle registers exactly once via __ModuleLoader__.load', `${handoffs.length} registration(s)`)
  const handoff = handoffs[0]
  check(handoff?.id === pkg.name, 'registered id equals the package name', String(handoff?.id))
  if (handoff !== undefined && typeof handoff.factory === 'function') {
    // 加载期会建 zod schema、React context：这几个给真模块（宿主运行时同样提供），其余给空桩
    const realRequire = createRequire(import.meta.url)
    const real = new Set(['react', 'react/jsx-runtime', 'zod'])
    const asked: string[] = []
    const plugin = handoff.factory((spec) => {
      asked.push(spec)
      return real.has(spec) ? realRequire(spec) : {}
    }) as { apply?: unknown; inject?: unknown }
    check(typeof plugin.apply === 'function', 'factory exports apply()')
    check(Array.isArray(plugin.inject), 'factory exports an inject array')
    const allowed = new Set<string>(HOST_MODULES)
    const stray = [...new Set(asked)].filter(spec => !allowed.has(spec))
    check(stray.length === 0, 'factory requires only host-shared modules', stray.join(', '))
    if (typeof plugin.apply === 'function') {
      const slots = recordSlots(plugin.apply as (ctx: unknown) => void)
      const expected = [...EXPECTED_SLOTS].sort()
      check(JSON.stringify(slots) === JSON.stringify(expected), 'PA-50 apply registers exactly the expected slots',
        `missing: ${expected.filter(s => !slots.includes(s)).join(', ') || '-'}; unexpected: ${slots.filter(s => !expected.includes(s)).join(', ') || '-'}`)
    }
  } else {
    check(false, 'registration carries a factory function')
  }
}

const declarations = hostSlotDeclarations()
const undeclared = EXPECTED_SLOTS.filter(name => !new RegExp(`['"]${name.replaceAll('.', '\\.')}['"]\\??:`).test(declarations))
check(undeclared.length === 0, 'PA-50 every expected slot is declared by the host client packages', undeclared.join(', '))

const locales = readdirSync(join(REPO, 'locale')).filter(f => f.endsWith('.json'))
check(locales.length > 0, 'repository has locale/*.json to ship', locales.join(', '))
for (const file of locales) {
  const shipped = join(pkgDir, 'locale', file)
  let parses = false
  try { JSON.parse(readFileSync(shipped, 'utf8')); parses = true } catch { /* reported below */ }
  check(parses, `locale/${file} ships and parses`)
}

if (failures.length > 0) {
  console.error(`verify-client: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('verify-client: all checks passed')
