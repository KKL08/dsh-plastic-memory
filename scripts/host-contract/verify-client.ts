/**
 * 发布包的浏览器半侧检查（host:smoke 与 host:contract 共用，无需 key，CI 常规档就跑）。
 * 对象是 `dsh plugin add` 装进隔离 DSH_HOME 的那份包，也就是用户实际拿到的形状：
 *   - package.json 声明 `dsh.client.platform = "web"`，`exports['./client']` 指向的文件存在；
 *   - 该文件在假的 `window.__ModuleLoader__` 下按工厂格式加载：只登记一次、id 等于包名，
 *     factory 返回 `apply` 函数和 `inject` 数组，require 只问宿主共享模块表里的名字；
 *   - 仓库 locale/ 下的每个 *.json 都随包发出且能解析。
 * 宿主自己的扫描器只挂在 web profile 上，这里不起浏览器、不连宿主，只验包本身能被工厂加载。
 *
 *   用法：node scripts/host-contract/verify-client.ts <已安装包目录>
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

const pkgDir = process.argv[2]
if (pkgDir === undefined) {
  console.error('usage: verify-client.ts <installed package dir>')
  process.exit(2)
}
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const failures: string[] = []
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
    // 旧宿主：共享模块表缺 zod 时 require 同步抛错，工厂要返回空插件而不是把错误抛给加载器
    let degraded: { apply?: unknown; inject?: unknown } | undefined
    let threw: string | undefined
    try {
      degraded = handoff.factory((spec) => {
        if (spec === 'zod') throw new Error(`client-modules: require("${spec}") missed the module table`)
        return real.has(spec) ? realRequire(spec) : {}
      }) as { apply?: unknown; inject?: unknown }
    } catch (error) { threw = error instanceof Error ? error.message : String(error) }
    check(threw === undefined && typeof degraded?.apply === 'function' && Array.isArray(degraded?.inject) && degraded.inject.length === 0,
      'factory degrades to an empty plugin when a host module is missing', threw ?? JSON.stringify(degraded))
  } else {
    check(false, 'registration carries a factory function')
  }
}

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
