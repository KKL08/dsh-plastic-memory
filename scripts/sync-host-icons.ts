/**
 * 从宿主图标集生成 client/ui/host-icons.ts。插件不在运行时 require 宿主的 ui-primitives
 * （见 build-client.ts），用到的图标按宿主同一版本渲染一次，存成图形数据随插件打包。
 *
 * 做法：npm pack 宿主钉版对应的 @deepseek-ai/dsh-client-ui-primitives，用 esbuild 只打包要的图标导出
 * （其余裸导入换成空模块），用本仓的 React 渲染成 SVG，拆成 viewBox + 子元素属性写进数据文件。
 * 只收 path / circle / rect / line：带 mask、clipPath 的图标要按 id 去重，这里不支持，遇到直接报错。
 *
 * 用法：
 *   node scripts/sync-host-icons.ts            按 devDependencies 里宿主钉版的版本
 *   node scripts/sync-host-icons.ts <版本>
 * 升宿主钉版时跑一次，有 diff 就随升钉版一起提交。
 */
import { build, type Plugin } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const PKG = '@deepseek-ai/dsh-client-ui-primitives'
const OUT = `${REPO}client/ui/host-icons.ts`

/** 本插件用到的宿主图标：数据里的名字 → 宿主导出名。 */
export const HOST_ICONS = {
  user: 'IconUserOutlineRegular',
  sparkle: 'IconSparkleRegular',
  code: 'IconInspectOutlineRegular',
  folder: 'IconFolderCloseRegular',
  globe: 'IconGlobeOutlineRegular',
  clock: 'IconClockOutlineRegular',
  search: 'IconSearchOutlineRegular',
  check: 'IconCheckOutlineMedium',
  chevronDown: 'IconChevronDownOutlineRegular',
  chevronDownMedium: 'IconChevronDownOutlineMedium',
  chevronUp: 'IconChevronUpOutlineRegular',
  chevronRight: 'IconChevronRightOutlineRegular',
  chevronsUpDown: 'IconChevronsUpDownOutlineRegular',
  trash: 'IconTrashOutlineRegular',
} as const

const ATTRS = ['d', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'x1', 'y1', 'x2', 'y2', 'fill', 'stroke', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'clip-rule'] as const

/** 根上的绘制属性（有的图标只在根上写 stroke），Icon 照着画到 `<svg>` 上；fill="none" 是 Icon 的缺省，不记。 */
const ROOT_PAINT = ['stroke', 'stroke-linecap', 'stroke-linejoin'] as const
const ROOT_OTHER = ['xmlns', 'aria-hidden', 'width', 'height', 'viewBox', 'fill', 'stroke-width'] as const

interface Shape { tag: string; attrs: Record<string, string> }
interface IconData { viewBox: string; strokeWidth: string; root: Record<string, string>; shapes: Shape[] }

/** 渲染出的 `<svg>…</svg>` 拆成数据；遇到不认识的元素或属性就报错，免得悄悄丢图形。 */
export function parseSvg(name: string, markup: string): IconData {
  const root = /^<svg([^>]*)>(.*)<\/svg>$/s.exec(markup)
  if (root === null) throw new Error(`${name}: 不是单个 <svg>`)
  const rootAttr = (key: string) => new RegExp(`\\s${key}="([^"]*)"`).exec(root[1]!)?.[1]
  const viewBox = rootAttr('viewBox')
  if (viewBox === undefined) throw new Error(`${name}: 缺 viewBox`)
  const rootPaint: Record<string, string> = {}
  for (const [, key, value] of root[1]!.matchAll(/\s([a-zA-Z-]+)="([^"]*)"/g)) {
    if ((ROOT_PAINT as readonly string[]).includes(key!)) rootPaint[key!] = value!
    else if (key === 'fill' ? value !== 'none' : !(ROOT_OTHER as readonly string[]).includes(key!)) throw new Error(`${name}: <svg> 不支持属性 ${key}`)
  }
  const shapes: Shape[] = []
  const body = root[2]!.replace(/<(path|circle|rect|line)((?:\s[a-z-]+="[^"]*")*)\s*(?:\/>|><\/\1>)/g, (_, tag: string, raw: string) => {
    const attrs: Record<string, string> = {}
    for (const [, key, value] of raw.matchAll(/\s([a-z-]+)="([^"]*)"/g)) {
      if (!(ATTRS as readonly string[]).includes(key!)) throw new Error(`${name}: <${tag}> 不支持属性 ${key}`)
      attrs[key!] = value!
    }
    shapes.push({ tag, attrs })
    return ''
  })
  if (body.trim() !== '') throw new Error(`${name}: 有不支持的元素 ${body.slice(0, 60)}`)
  return { viewBox, strokeWidth: rootAttr('stroke-width') ?? '1', root: rootPaint, shapes }
}

/** 宿主包顶层会调用它的依赖（建主题、建高亮器）：桩子任意取属性、调用、new 都返回自己。 */
const ANY = 'const any = new Proxy(function () {}, { get: (_, k) => k === Symbol.toPrimitive ? () => "" : any, apply: () => any, construct: () => any })'

/**
 * react 指向本仓那份（产物在临时目录里，按名字找不到）；其余裸导入和 CSS 换成桩子：只取图标，用不到它们。
 * 桩子按 lib/index.js 里实际 import 的名字逐个导出，esbuild 才认得这些具名导入。
 */
function stubOthers(lib: string): Plugin {
  const names = new Map<string, Set<string>>()
  for (const [, clause, spec] of lib.matchAll(/^import\s+(.+?)\s+from\s+"([^"]+)";$/gm)) {
    const set = names.get(spec!) ?? new Set<string>()
    for (const [, inner] of clause!.matchAll(/\{([^}]*)\}/g)) {
      for (const part of inner!.split(',')) if (part.trim() !== '') set.add(part.trim().split(/\s+as\s+/)[0]!)
    }
    names.set(spec!, set)
  }
  return {
    name: 'stub-others',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, args => args.path === 'react' || args.path.startsWith('react/') || args.path.startsWith('react-dom')
        ? { path: require.resolve(args.path), external: true }
        : { path: args.path, namespace: 'stub' })
      b.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
        contents: `${ANY}\nexport default any\n${[...names.get(args.path) ?? []].map(n => `export const ${n} = any`).join('\n')}`,
        loader: 'js',
      }))
    },
  }
}

async function render(version: string): Promise<Record<string, IconData>> {
  const dir = mkdtempSync(join(tmpdir(), 'host-icons-'))
  try {
    const tgz = execFileSync('npm', ['pack', `${PKG}@${version}`, '--pack-destination', dir, '--silent'], { encoding: 'utf8' }).trim().split('\n').pop()!
    execFileSync('tar', ['xzf', join(dir, tgz), '-C', dir])
    const entry = join(dir, 'entry.js')
    writeFileSync(entry, `export { ${[...new Set(Object.values(HOST_ICONS))].join(', ')} } from './package/lib/index.js'\n`)
    const out = join(dir, 'icons.cjs')
    await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'cjs', platform: 'node', plugins: [stubOthers(readFileSync(join(dir, 'package/lib/index.js'), 'utf8'))], logLevel: 'error' })
    const mod = require(out) as Record<string, ComponentType<{ size?: number }>>
    const icons: Record<string, IconData> = {}
    for (const [name, exported] of Object.entries(HOST_ICONS)) {
      const component = mod[exported]
      if (component === undefined) throw new Error(`${PKG}@${version} 没有导出 ${exported}`)
      icons[name] = parseSvg(exported, renderToStaticMarkup(createElement(component, { size: 16 })))
    }
    return icons
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8')) as { devDependencies: Record<string, string> }
  // 缺省取宿主钉版：宿主各包同号发版，图标包和 dsh-agent 版本号一致；对不上时 npm pack 直接报错
  const version = process.argv[2] ?? pkg.devDependencies['@deepseek-ai/dsh-agent']!
  const icons = await render(version)
  const header = `/**\n * 宿主图标集（${PKG}@${version}，MIT，见 THIRD_PARTY_NOTICES.md）里本插件用到的图标。\n * 由 scripts/sync-host-icons.ts 生成，不要手改；组件见 Icon.tsx。\n */\n`
  writeFileSync(OUT, `${header}export const HOST_ICON_DATA = ${JSON.stringify(icons, null, 2)} as const\n`)
  console.log(`sync-host-icons: ${Object.keys(icons).length} 个图标 → client/ui/host-icons.ts（${version}）`)
}
