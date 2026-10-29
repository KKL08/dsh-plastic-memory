/**
 * 浏览器半侧构建：client/index.tsx → lib/client.js，格式是宿主模块加载器要的闭包工厂
 *   window.__ModuleLoader__.load({ id: <包名>, factory(require) { …; return module.exports } })
 * esbuild 以 CJS 产出，宿主共享的运行时（react、cordis 等）留作 external，产物里变成 require('react')，
 * 正好接 factory 的 require；再用固定头尾包起来。不复刻宿主未发布的 tsdown clientBundle 预设。
 *
 * 用法：
 *   pnpm build:client                 一次性构建到 lib/client.js
 *   pnpm build:client --watch         监听 client/ 改动重建
 *   node scripts/build-client.ts --outfile <路径>
 */
import { build, context, type BuildOptions } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/**
 * 宿主浏览器模块表（0.2.1-rc.2 packages/client/web/src/platform.ts 的 PLATFORM_MODULES）。
 * 去掉 ui-primitives：技能（cordis-plugin-development practices.md）禁止外部插件 require 它。
 */
export const HOST_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const pkgName = (JSON.parse(readFileSync(`${REPO}package.json`, 'utf8')) as { name: string }).name

// CJS 产物引用自由变量 module / exports / require，由头部在 factory 作用域里提供。
const banner = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(pkgName)},\n  factory(require) {\n    var module = { exports: {} };\n    var exports = module.exports;`
const footer = '    return module.exports;\n  }\n});'

function options(outfile: string): BuildOptions {
  return {
    entryPoints: [`${REPO}client/index.tsx`],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: [...HOST_MODULES],
    banner: { js: banner },
    footer: { js: footer },
    legalComments: 'none',
    logLevel: 'warning',
  }
}

/** 构建一次（测试与 CLI 共用）。 */
export async function buildClient({ outfile = `${REPO}lib/client.js` }: { outfile?: string } = {}): Promise<void> {
  await build(options(outfile))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--outfile')
  const outfile = at >= 0 ? args[at + 1] : undefined
  if (args.includes('--watch')) {
    const ctx = await context(options(outfile ?? `${REPO}lib/client.js`))
    await ctx.watch()
    console.log('build-client: watching client/ …')
  } else {
    await buildClient(outfile === undefined ? {} : { outfile })
  }
}
