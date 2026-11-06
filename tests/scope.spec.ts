import { describe, expect, it } from 'vitest'
import { isInScope, ledgerLabel, sameScope, scopeAt, scopeCacheKey, scopeKey, scopeOfLedger, scopeOfMemory, type Scope } from '../src/scope.ts'
import { checkupKey } from '../src/gui/contract.ts'

// 作用域的身份：判等、从记录推作用域、归属、标准键、组合键、账本标签。

const GLOBAL: Scope = { kind: 'global' }
const APP: Scope = { kind: 'workspace', workspacePath: '/w/app' }
const BLOG: Scope = { kind: 'workspace', workspacePath: '/w/blog' }
const ws = (workspacePath: string): Scope => ({ kind: 'workspace', workspacePath })

describe('sameScope', () => {
  it.each([
    [GLOBAL, { kind: 'global' } as Scope, true],
    [APP, ws('/w/app'), true],
    [APP, BLOG, false],
    [APP, GLOBAL, false],
    [GLOBAL, APP, false],
  ])('%o 与 %o → %s', (a, b, expected) => {
    expect(sameScope(a, b)).toBe(expected)
  })

  it.each([
    ['/w/app/', '/w/app'],
    ['/w/app//', '/w/app'],
    ['C:\\w\\app\\', 'C:\\w\\app'],
    ['/', '/'],
  ])('项目路径末尾带不带分隔符都是同一个：%s 与 %s', (a, b) => {
    expect(sameScope(ws(a), ws(b))).toBe(true)
    expect(sameScope(ws(b), ws(a))).toBe(true)
  })

  it('只去掉末尾的分隔符，前缀相同的项目不算同一个', () => {
    expect(sameScope(ws('/w/app'), ws('/w/app2'))).toBe(false)
    expect(sameScope(ws('/w/app/'), ws('/w'))).toBe(false)
  })
})

describe('scopeOfMemory：从记录推作用域', () => {
  it.each([
    [{ scope: 'global' as const }, GLOBAL],
    [{ scope: 'global' as const, workspacePath: '/w/app' }, GLOBAL],
    [{ scope: 'workspace' as const, workspacePath: '/w/app' }, APP],
    [{ scope: 'workspace' as const }, undefined],
  ])('%o → %o', (memory, expected) => {
    expect(scopeOfMemory(memory)).toEqual(expected)
  })
})

describe('scopeAt：只带 workspacePath 的写法', () => {
  it('缺省即全局，有路径即那个项目', () => {
    expect(scopeAt(undefined)).toEqual({ kind: 'global' })
    expect(scopeAt('/w/app')).toEqual({ kind: 'workspace', workspacePath: '/w/app' })
  })
})

describe('isInScope：归属', () => {
  it.each([
    [{ scope: 'global' as const }, GLOBAL, true],
    [{ scope: 'global' as const }, APP, false],
    [{ scope: 'workspace' as const, workspacePath: '/w/app' }, APP, true],
    [{ scope: 'workspace' as const, workspacePath: '/w/app/' }, APP, false],
    [{ scope: 'workspace' as const, workspacePath: '/w/app' }, BLOG, false],
    [{ scope: 'workspace' as const, workspacePath: '/w/app' }, GLOBAL, false],
    [{ scope: 'workspace' as const }, APP, false],
  ])('%o 属于 %o → %s', (memory, scope, expected) => {
    expect(isInScope(memory, scope)).toBe(expected)
  })
})

describe('键', () => {
  it('标准键：全局为 global，项目取原路径（不规范化末尾分隔符）', () => {
    expect(scopeKey(GLOBAL)).toBe('global')
    expect(scopeKey(APP)).toBe('/w/app')
    expect(scopeKey(ws('/w/app/'))).toBe('/w/app/')
  })

  // 三种组合键已经落盘：改了就读不到旧的缓存、体检记录与待决账本。
  it.each([
    [GLOBAL, 'cache_global', 'global', 'global'],
    [APP, 'cache_/w/app', '/w/app', '/w/app'],
    [ws('/w/app/'), 'cache_/w/app/', '/w/app/', '/w/app/'],
  ])('PA-23 组合键逐字节不变：%o', (scope, cache, checkup, ledger) => {
    expect(scopeCacheKey(scope)).toBe(cache)
    expect(checkupKey(scope)).toBe(checkup)
    expect(ledgerLabel(scope)).toBe(ledger)
  })

  it('PA-23 体检键的「全部」取 all', () => {
    expect(checkupKey({ kind: 'all' })).toBe('all')
  })

  it.each([GLOBAL, APP, ws('/w/app/')])('账本标签往返：%o', (scope) => {
    expect(scopeOfLedger(ledgerLabel(scope))).toEqual(scope)
  })

  it('账本标签 global 还原成全局，其余还原成项目', () => {
    expect(scopeOfLedger('global')).toEqual(GLOBAL)
    expect(scopeOfLedger('/w/app')).toEqual(APP)
  })
})
