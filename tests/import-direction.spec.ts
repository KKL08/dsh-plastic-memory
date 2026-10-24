import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { posix } from 'node:path'

// 依赖方向守门：叶子 ← storage ← 记忆层 ← governance ← tools 执行器 ← GUI 层（gui/*）← tools 绑定层 ← 接线层（index.ts、domain-spec）。
// 每层只能 import 本层及更低层（GUI 层可 import 执行器、不 import 绑定层，执行器不 import GUI 层）；框架包（@deepseek-ai/*）的运行时 import 只许绑定层与接线层
// （index.ts、domain-spec）碰，type-only 引用任何层都允许。
// 静态读文件 + 正则扫描，不执行源码。

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))
const CLIENT_DIR = fileURLToPath(new URL('../client/', import.meta.url))

const LAYER = { leaf: 0, storage: 1, memory: 2, governance: 3, executor: 4, gui: 5, binding: 6, entry: 7 } as const
type LayerName = keyof typeof LAYER

// 共享契约（record-schema、contract-codes、kv-table、storage/table、storage/paths）归叶子
const LEAF_MODULES = new Set([
  'text', 'secrets', 'record-freshness', 'retention', 'contract-codes', 'index-line', 'errors',
  'kv-table', 'record-schema', 'output', 'storage/paths', 'storage/table', 'types', 'gui/contract',
  'search/tokenizer', 'search/jieba-segmenter',
])
// search/ranking 与 store 同层：只 import 叶子，被执行器用；分词器与 jieba 切分器留在叶子（只碰 Node 内置，词典路径与日志器由调用方注入）
const MEMORY_MODULES = new Set([
  'pipeline', 'store', 'snapshot', 'runtime', 'type-registry', 'evidence-guidance', 'search/ranking',
])
// 接线层：index.ts 与交给 ctx.storageDomain.open 的域定义（只被 index.ts 用）
const ENTRY_MODULES = new Set(['index', 'domain-spec'])

const FRAMEWORK_PREFIX = '@deepseek-ai/'

/** 登记在案的例外边。`to` 是 src 下模块路径（不带 .ts）或包名。条目失效（边已消失）测试会提示删掉。 */
const ALLOWED_EXCEPTIONS: ReadonlyArray<{ from: string; to: string; reason: string }> = [
  { from: 'pipeline', to: 'governance/snapshots', reason: 'update global 前快照先行（2026-09-01 定）' },
]

function layerOf(mod: string): LayerName | undefined {
  if (LEAF_MODULES.has(mod)) return 'leaf'
  if (MEMORY_MODULES.has(mod)) return 'memory'
  if (ENTRY_MODULES.has(mod)) return 'entry'
  if (/^storage\/[^/]+$/.test(mod)) return 'storage'
  if (/^governance\/[^/]+$/.test(mod)) return 'governance'
  if (/^gui\/[^/]+$/.test(mod)) return 'gui'
  if (/^tools\/[^/]+-tool$/.test(mod)) return 'binding'
  if (/^tools\/[^/]+$/.test(mod)) return 'executor'
  return undefined
}

function listSourceModules(dir = SRC_DIR, prefix = '', exts: readonly string[] = ['.ts']): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.isDirectory()) out.push(...listSourceModules(`${dir}${entry.name}/`, `${rel}/`, exts))
    else if (exts.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts')) out.push(rel)
  }
  return out.sort()
}

interface ImportEdge { from: string; spec: string; isTypeOnly: boolean }

// import/export ... from '...'、副作用 import '...'（可跨行）；动态 import('...')；/// <reference types="..." />。
// declare module 增广本身是纯类型，不扫。
const STATIC_RE = /^\s*(import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const REFERENCE_RE = /^\/\/\/\s*<reference\s+types=["']([^"']+)["']/gm

function scanImports(mod: string, file = `${SRC_DIR}${mod}.ts`): ImportEdge[] {
  const source = readFileSync(file, 'utf8')
  const edges: ImportEdge[] = []
  for (const m of source.matchAll(STATIC_RE)) {
    edges.push({ from: mod, spec: m[4]!, isTypeOnly: m[2] !== undefined || isTypeOnlyClause(m[3]) })
  }
  for (const m of source.matchAll(DYNAMIC_RE)) edges.push({ from: mod, spec: m[1]!, isTypeOnly: false })
  for (const m of source.matchAll(REFERENCE_RE)) edges.push({ from: mod, spec: m[1]!, isTypeOnly: true })
  return edges
}

/** `{ type A, type B }` 这种每个具名项都带 type 的子句也是 type-only；副作用 import（无子句）算运行时。 */
function isTypeOnlyClause(clause: string | undefined): boolean {
  const named = clause?.trim().match(/^\{([\s\S]*)\}$/)
  if (!named) return false
  const items = named[1]!.split(',').map(s => s.trim()).filter(s => s !== '')
  return items.length > 0 && items.every(s => s.startsWith('type '))
}

/** 相对路径解析成 src 下模块名；非相对返回 undefined。 */
function resolveRelative(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  return posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.ts$/, '')
}

function isException(from: string, to: string): boolean {
  return ALLOWED_EXCEPTIONS.some(e => e.from === from && e.to === to)
}

const modules = listSourceModules().map(f => f.slice(0, -'.ts'.length))
const edges = modules.flatMap(m => scanImports(m))

// 浏览器半侧 client/*：独立编译，只许 import 本目录、src/gui/contract（视图与命令的契约），以及宿主
// 浏览器模块表提供的运行时（react、cordis 等，构建时 external）；src/ 任何模块不许 import client/。
const CLIENT_FILES = listSourceModules(CLIENT_DIR, '', ['.ts', '.tsx'])
const clientEdges = CLIENT_FILES.flatMap(f => scanImports(`client/${f}`, `${CLIENT_DIR}${f}`))
const CLIENT_ALLOWED_SRC = new Set(['src/gui/contract'])

describe('import 方向', () => {
  it('src 下每个模块都归入某一层', () => {
    expect(modules.length).toBeGreaterThan(0)
    expect(modules.filter(m => layerOf(m) === undefined)).toEqual([])
  })

  it('相对 import 都解析到 src 内已知模块', () => {
    const known = new Set(modules)
    const unresolved = edges
      .map(e => ({ ...e, to: resolveRelative(e.from, e.spec) }))
      .filter(e => e.to !== undefined && !known.has(e.to))
      .map(e => `${e.from} → ${e.spec}`)
    expect(unresolved).toEqual([])
  })

  it('每层只 import 本层及更低层（登记例外除外）', () => {
    const violations: string[] = []
    for (const e of edges) {
      const to = resolveRelative(e.from, e.spec)
      if (to === undefined) continue
      const fromLayer = layerOf(e.from)!
      const toLayer = layerOf(to)
      if (toLayer === undefined) continue // 上一条用例负责报未解析
      if (LAYER[toLayer] > LAYER[fromLayer] && !isException(e.from, to)) {
        violations.push(`${e.from}（${fromLayer}）→ ${to}（${toLayer}）`)
      }
    }
    expect(violations).toEqual([])
  })

  it('框架包的运行时 import 只在绑定层与接线层出现；type-only 不限层', () => {
    const violations: string[] = []
    for (const e of edges) {
      if (!e.spec.startsWith(FRAMEWORK_PREFIX) || e.isTypeOnly) continue
      const fromLayer = layerOf(e.from)
      if (fromLayer === 'binding' || fromLayer === 'entry') continue
      violations.push(`${e.from} → ${e.spec}`)
    }
    expect(violations).toEqual([])
  })

  it('例外表没有失效条目', () => {
    const present = new Set(edges.map(e => `${e.from} → ${resolveRelative(e.from, e.spec) ?? e.spec}`))
    const stale = ALLOWED_EXCEPTIONS
      .map(e => `${e.from} → ${e.to}`)
      .filter(key => !present.has(key))
    expect(stale).toEqual([])
  })
})

describe('import 方向：GUI 两条边', () => {
  it('执行器不 import GUI 层；GUI 层不 import 绑定层', () => {
    const violations = edges
      .map(e => ({ from: e.from, to: resolveRelative(e.from, e.spec) }))
      .filter((e): e is { from: string; to: string } => e.to !== undefined)
      .filter(e => (layerOf(e.from) === 'executor' && layerOf(e.to) === 'gui')
        || (layerOf(e.from) === 'gui' && layerOf(e.to) === 'binding'))
      .map(e => `${e.from} → ${e.to}`)
    expect(violations).toEqual([])
  })

  it('src/ 不 import client/', () => {
    const violations = edges
      .filter(e => resolveRelative(e.from, e.spec)?.startsWith('../client/') === true)
      .map(e => `${e.from} → ${e.spec}`)
    expect(violations).toEqual([])
  })

  it('client/ 只 import 本目录与 src/gui/contract', () => {
    const violations: string[] = []
    for (const e of clientEdges) {
      const to = resolveRelative(e.from, e.spec)?.replace(/\.tsx?$/, '')
      if (to === undefined) continue // 裸包名由构建的 external 白名单与工厂格式测试把关
      if (to.startsWith('client/') || CLIENT_ALLOWED_SRC.has(to)) continue
      violations.push(`${e.from} → ${e.spec}`)
    }
    expect(violations).toEqual([])
  })
})
