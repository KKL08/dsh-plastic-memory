import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { STATE_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { MemoryStore } from '../src/store.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { GUI_VIEW_DIR, GUI_VIEW_FILES, checkupKey, healthViewSchema, pendingViewSchema, type MemoryCommand } from '../src/gui/contract.ts'
import { executeScan } from '../src/tools/scan.ts'
import { scopeCacheKey } from '../src/scope.ts'
import { fakeExec } from './helpers/exec.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { noInstructions } from './helpers/instructions.ts'
import { NOW, SESSION_WS, OTHER_WS, registry, root, env, ok, err, seedPair, ledgerItems } from './helpers/gui-command-env.ts'

/** 建一个临时文件夹给用例用，用例结束删掉；fn 拿到它的路径。 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-cmd-fs-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}


describe('scan', () => {
  const conflictLlm: SemanticLlm = {
    complete: async () => JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', suggestedAction: '裁决' }] }),
  }

  it('拿不到模型：llm-unavailable，不扫描、不写缓存', async () => {
    const e = env({ llm: null })
    await seedPair(e)
    expect(err(await e.run({ cmd: 'scan' })).code).toBe('llm-unavailable')
    expect(await e.cache.list()).toEqual([])
  })

  it('全库体检：冲突进账本、视图重写', async () => {
    const e = env({ llm: conflictLlm })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm' }))
    ok(await e.run({ cmd: 'scan' }))
    const [entry] = await e.decisions.list()
    expect(entry!.memoryIds).toEqual(['mem_a', 'mem_b'])
    const pending = pendingViewSchema.parse(await e.readView('pending'))
    expect(ledgerItems(pending).map(i => i.kind)).toEqual(['conflict-horizontal'])
    await expect(stat(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.health))).resolves.toBeTruthy()
  })

  it('手动体检的结果先回，冲突卡带「正在生成」；建议随后补上，用量补记进这次体检的结果', async () => {
    let open: (() => void) | undefined
    const gate = new Promise<void>(resolve => { open = resolve })
    let suggestCalls = 0
    const llm: SemanticLlm = {
      model: 'm-test',
      complete: async (input, _signal, onUsage) => {
        if (!input.system.includes('两条互相矛盾的记忆')) {
          onUsage?.(100)
          return JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', suggestedAction: '裁决' }] })
        }
        suggestCalls++
        await gate
        onUsage?.(30)
        return JSON.stringify({ action: 'keep-a', reason: 'A 更新' })
      },
    }
    const e = env({ llm, withSuggestions: true })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm' }))
    const body = ok(await e.run({ cmd: 'scan' }))
    expect(body.usageTokens).toBe(100)
    // 命令已经回了，建议还在生成
    await vi.waitFor(() => { expect(suggestCalls).toBe(1) })
    const during = ledgerItems(pendingViewSchema.parse(await e.readView('pending')))
    expect(during).toEqual([expect.objectContaining({ kind: 'conflict-horizontal', isGeneratingSuggestion: true })])
    open?.()
    await e.suggestions!.whenIdle()
    const after = ledgerItems(pendingViewSchema.parse(await e.readView('pending')))
    expect(after).toEqual([expect.objectContaining({ suggestion: expect.objectContaining({ action: 'keep-a' }) })])
    expect(after[0]).not.toHaveProperty('isGeneratingSuggestion')
    expect((await e.readCheckupView()).allResult?.usageTokens).toBe(130)
  })

  it('手动体检之后给垂直冲突生成建议：用记忆所在项目的指令文件（会话在别的项目也一样），依据记下那个项目', async () => {
    let verticalPrompt = ''
    const llm: SemanticLlm = {
      model: 'm-test',
      complete: async (input) => {
        if (input.system.includes('长期记忆和项目指令文件')) {
          verticalPrompt = input.user
          return JSON.stringify({ action: 'delete', reason: '指令文件已经写清楚了' })
        }
        return JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '和基线矛盾', suggestedAction: '裁决' }] })
      },
    }
    const e = env({ llm, instructions: { [SESSION_WS]: '# AGENTS.md\n会话项目用 yarn', [OTHER_WS]: '# AGENTS.md\n包管理统一用 pnpm' }, withSuggestions: true })
    await e.store.create(record({ id: 'mem_v', name: '包管理', content: '用 npm', scope: 'workspace', workspacePath: OTHER_WS }))
    const body = ok(await e.run({ cmd: 'scan', workspacePath: OTHER_WS }))
    expect(body.notes ?? []).toEqual([])
    await e.suggestions!.whenIdle()
    expect(verticalPrompt).toContain('包管理统一用 pnpm')
    expect(verticalPrompt).not.toContain('会话项目用 yarn')
    const [entry] = await e.decisions.list()
    expect(entry?.suggestion).toMatchObject({ action: 'delete', basis: { baseline: { workspace: OTHER_WS } } })
    const items = ledgerItems(pendingViewSchema.parse(await e.readView('pending')))
    expect(items).toEqual([expect.objectContaining({ kind: 'conflict-vertical', suggestion: expect.objectContaining({ action: 'delete', baselineWorkspace: OTHER_WS }) })])
  })

  it('指令文件太长、只留了前面一部分：结果带回 baseline-truncated', async () => {
    const e = env({ llm: { complete: async () => '{"findings":[]}' }, instructions: { [OTHER_WS]: { kind: 'found', texts: ['用 pnpm'], isTruncated: true } } })
    await e.store.create(record({ id: 'mem_w', scope: 'workspace', workspacePath: OTHER_WS }))
    const body = ok(await e.run({ cmd: 'scan', workspacePath: OTHER_WS }))
    expect(body.notes).toContain('baseline-truncated')
  })

  it('手动体检读不到指令文件：baseline-missing 说明和原因透传到命令响应，体检视图里这个项目的最近一次结果也记下它', async () => {
    const e = env({ llm: { complete: async () => '{"findings":[]}' }, instructions: { [SESSION_WS]: { kind: 'unavailable', reason: 'EACCES: permission denied' } } })
    await e.store.create(record({ id: 'mem_s', scope: 'workspace', workspacePath: SESSION_WS }))
    const body = ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect(body.notes).toContain('baseline-missing')
    const entry = (await e.readCheckupView()).scopes.find(s => s.scope.kind === 'workspace' && s.scope.workspacePath === SESSION_WS)
    expect(entry?.lastResult?.notes).toEqual([{ code: 'baseline-missing', cause: { kind: 'error', message: 'EACCES: permission denied' } }])
  })

  it('分了批：带回 semantic-batched 与批数；用量是宿主报的合计，每次体检各算各的', async () => {
    let calls = 0
    const metered: SemanticLlm = { complete: async (_input, _signal, onUsage) => { calls++; onUsage?.(1000); return '{"findings":[]}' } }
    const e = env({ llm: metered })
    for (let i = 0; i < 6; i++) await e.store.create(record({ id: `mem_big${i}`, name: `大${i}`, content: '记'.repeat(10_000), scope: 'workspace', workspacePath: SESSION_WS }))
    const body = ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect(body.notes).toContain('semantic-batched')
    expect(body.semanticBatches).toBe(calls)
    expect(body.usageTokens).toBe(calls * 1000)
    const again = ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect(again.usageTokens).toBe(body.usageTokens)
  })

  it('宿主没报用量、没有分批：结果不带用量与批数', async () => {
    const e = env({ llm: { complete: async () => '{"findings":[]}' } })
    await seedPair(e, SESSION_WS)
    const body = ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect(body).not.toHaveProperty('usageTokens')
    expect(body).not.toHaveProperty('semanticBatches')
    expect(body.notes).not.toContain('semantic-batched')
  })

  describe('结果：新增条数与分数', () => {
    /** 模型这次要报的发现；测试里随时换。 */
    const answering = (findings: () => object[]): SemanticLlm => ({ complete: async () => JSON.stringify({ findings: findings() }) })
    const conflict = { type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', suggestedAction: '裁决' }
    const redundancy = { type: 'redundancy', memoryIds: ['mem_c', 'mem_d'], summary: '说的是一件事' }
    async function seedFour(e: ReturnType<typeof env>, ws = SESSION_WS) {
      const scoped = { scope: 'workspace' as const, workspacePath: ws }
      await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', ...scoped }))
      await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', ...scoped }))
      await e.store.create(record({ id: 'mem_c', name: '丙', content: '测试用 vitest', ...scoped }))
      await e.store.create(record({ id: 'mem_d', name: '丁', content: '单测跑 vitest', ...scoped }))
    }
    const healthScores = async (e: ReturnType<typeof env>) =>
      healthViewSchema.parse(await e.readView('health')).layers.map(l => ({ layer: l.layer, score: l.score }))

    it('新增的冲突算待处理、新增的内容重复算建议；体检前就有的（很久没确认）不算；分数与健康视图一致', async () => {
      const e = env({ llm: answering(() => [conflict, redundancy]) })
      await seedFour(e)
      const body = ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
      expect(body.added).toEqual({ pending: 1, advice: 1, pendingLevel: 'your-call' })
      // 项目体检覆盖全局与本项目两层
      expect(body.scores).toEqual(await healthScores(e))
      expect(body.scores!.map(s => s.layer)).toEqual([{ kind: 'global' }, { kind: 'workspace', workspacePath: SESSION_WS }])
    })

    it('未决的垂直冲突再体检时模型换了基线出处的措辞：不算新增，待处理里仍是一张卡、健康照样扣分', async () => {
      let wording = 'AGENTS.md：包管理用 pnpm'
      const e = env({ llm: answering(() => [{ type: 'conflict', memoryIds: ['mem_a'], baselineRef: wording, summary: '与基线矛盾' }]), instructions: { [SESSION_WS]: '包管理统一用 pnpm' } })
      await seedFour(e)
      expect(ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS })).added).toEqual({ pending: 1, advice: 0, pendingLevel: 'your-call' })
      wording = 'AGENTS.md 里「统一用 pnpm」那条'
      expect(ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS })).added).toEqual({ pending: 0, advice: 0 })
      expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending'))).map(i => i.kind)).toEqual(['conflict-vertical'])
      const ws = healthViewSchema.parse(await e.readView('health')).layers.find(l => l.layer.kind === 'workspace')!
      expect(ws.issues).toContainEqual(expect.objectContaining({ type: 'conflict', count: 1 }))
    })

    it('新增的待处理分在两组（密钥和冲突）：不给 pendingLevel', async () => {
      const seeding = env()
      await seedFour(seeding)
      await seeding.store.create(record({ id: 'mem_o', name: '戊', content: '别的项目', scope: 'workspace', workspacePath: OTHER_WS }))
      const e = env({ llm: savingSecretMeanwhile(seeding, answering(() => [conflict])) })
      expect(ok(await e.run({ cmd: 'scan' })).added).toEqual({ pending: 2, advice: 0 })
    })

    it('再体检一次、发现没变：都是 0', async () => {
      const e = env({ llm: answering(() => [conflict, redundancy]) })
      await seedFour(e)
      ok(await e.run({ cmd: 'scan' }))
      expect(ok(await e.run({ cmd: 'scan' })).added).toEqual({ pending: 0, advice: 0 })
    })

    /** 体检进行中（第一次调模型时），另一个会话往别的项目存了一条含密钥的记忆。 */
    const savingSecretMeanwhile = (e: ReturnType<typeof env>, inner: SemanticLlm): SemanticLlm => ({
      complete: async (input) => {
        if ((await e.store.get('mem_x', { workspacePath: OTHER_WS })) === undefined) {
          await e.store.create(record({ id: 'mem_x', name: '己', content: `token ${FAKE_SECRET.sk}`, scope: 'workspace', workspacePath: OTHER_WS, lastConfirmedAt: NOW }))
        }
        return inner.complete(input)
      },
    })

    it('只算本次体检覆盖的层：体检期间别的项目冒出来的问题不算，分数也只给覆盖的层', async () => {
      const seeding = env()
      await seedFour(seeding)
      await seeding.store.create(record({ id: 'mem_o', name: '戊', content: '别的项目', scope: 'workspace', workspacePath: OTHER_WS }))
      const e = env({ llm: savingSecretMeanwhile(seeding, answering(() => [redundancy])) })
      const body = ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
      expect(pendingViewSchema.parse(await e.readView('pending')).items.some(i => i.kind === 'secret')).toBe(true)
      expect(body.added).toEqual({ pending: 0, advice: 1 })
      expect(body.scores!.map(s => s.layer)).toEqual([{ kind: 'global' }, { kind: 'workspace', workspacePath: SESSION_WS }])
    })

    it('全库体检覆盖全部层：别的项目新出的问题也算，分数给每一层', async () => {
      const seeding = env()
      await seedFour(seeding)
      await seeding.store.create(record({ id: 'mem_o', name: '戊', content: '别的项目', scope: 'workspace', workspacePath: OTHER_WS }))
      const e = env({ llm: savingSecretMeanwhile(seeding, answering(() => [])) })
      const body = ok(await e.run({ cmd: 'scan' }))
      expect(body.added).toEqual({ pending: 1, advice: 0, pendingLevel: 'must-fix' })
      expect(body.scores).toEqual(await healthScores(e))
      expect(body.scores).toHaveLength(3)
    })
  })
})

describe('scan：上次体检与完成记录', () => {
  const OTHER = { kind: 'workspace' as const, workspacePath: OTHER_WS }
  const SESSION = { kind: 'workspace' as const, workspacePath: SESSION_WS }
  const GLOBAL = { kind: 'global' as const }
  const answering = (findings: () => object[]): SemanticLlm => ({ complete: async () => JSON.stringify({ findings: findings() }) })
  const quiet = answering(() => [])
  /** 体检记录表里这个范围的完成记录；没有为 undefined。 */
  const completedOf = async (e: ReturnType<typeof env>, layer: Parameters<typeof checkupKey>[0]) =>
    (await e.checkups.list()).find(r => r.id === checkupKey(layer))?.completed
  /** 健康视图里各层的上次体检，按层：global 记作 'global'，项目记作路径。 */
  const lastCheckups = async (e: ReturnType<typeof env>) => Object.fromEntries(healthViewSchema.parse(await e.readView('health')).layers
    .map(l => [l.layer.kind === 'global' ? 'global' : l.layer.workspacePath, l.lastCheckupAt]))
  const healthOf = async (e: ReturnType<typeof env>, kind: 'global') =>
    healthViewSchema.parse(await e.readView('health')).layers.find(l => l.layer.kind === kind)!
  async function seedScopes(e: ReturnType<typeof env>) {
    await e.store.create(record({ id: 'mem_g', name: '全局', content: '回答用中文' }))
    await e.store.create(record({ id: 'mem_s', name: '本项目', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_o', name: '别的项目', content: '用 npm', scope: 'workspace', workspacePath: OTHER_WS }))
  }

  it('项目体检：只给本项目写完成记录（发起方界面手动、开始与完成时间）和缓存；全局的分数与上次体检不变', async () => {
    const e = env({ llm: answering(() => [{ type: 'unclear', memoryIds: ['mem_g'], summary: '说得不清楚' }]) })
    await seedScopes(e)
    ok(await e.run({ cmd: 'refresh-views' }))
    const globalBefore = await healthOf(e, 'global')
    e.clock.now = NOW + 1000
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect(await completedOf(e, SESSION)).toEqual({ startedAt: NOW + 1000, completedAt: NOW + 1000, by: 'manual' })
    expect(await completedOf(e, GLOBAL)).toBeUndefined()
    expect((await e.cache.list()).map(([key]) => key)).toEqual([scopeCacheKey({ kind: 'workspace', workspacePath: SESSION_WS })])
    const globalAfter = await healthOf(e, 'global')
    expect(globalAfter.score).toBe(globalBefore.score)
    expect(globalAfter.lastCheckupAt).toBeNull()
    expect(await lastCheckups(e)).toEqual({ global: null, [SESSION_WS]: NOW + 1000, [OTHER_WS]: null })
  })

  it('项目体检拿全局记忆来比较：模型收到全局与本项目的记忆、收不到别的项目，跨层冲突照常进待处理', async () => {
    const seen: string[] = []
    // 只有同时看到全局和本项目那两条时才报跨层冲突：输入少了哪一方，就不会有这条结果
    const e = env({ llm: { complete: async (input) => {
      const text = JSON.stringify(input)
      seen.push(text)
      const findings = text.includes('mem_g') && text.includes('mem_s')
        ? [{ type: 'conflict', memoryIds: ['mem_s', 'mem_g'], summary: '回答语言与包管理说法矛盾', suggestedAction: '裁决' }]
        : []
      return JSON.stringify({ findings })
    } } })
    await seedScopes(e)
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.join('\n')).toContain('mem_g')
    expect(seen.join('\n')).toContain('mem_s')
    expect(seen.join('\n')).not.toContain('mem_o')
    const [entry, ...rest] = await e.decisions.list()
    expect(rest).toEqual([])
    expect([...entry!.memoryIds].sort()).toEqual(['mem_g', 'mem_s'])
    expect(entry!.workspaces).toEqual(expect.arrayContaining([SESSION_WS, 'global']))
    expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending'))).map(i => i.kind)).toEqual(['conflict-horizontal'])
  })

  it('只查全局：只读写全局层，只写全局的缓存与完成记录；结果只给全局的分数', async () => {
    const seen: string[] = []
    const e = env({ llm: { complete: async (input) => { seen.push(JSON.stringify(input)); return '{"findings":[]}' } } })
    await seedScopes(e)
    const body = ok(await e.run({ cmd: 'scan', layer: { kind: 'global' } }))
    expect(seen.join('\n')).toContain('mem_g')
    expect(seen.join('\n')).not.toContain('mem_s')
    expect((await e.cache.list()).map(([key]) => key)).toEqual([scopeCacheKey({ kind: 'global' })])
    expect(await completedOf(e, GLOBAL)).toEqual({ startedAt: NOW, completedAt: NOW, by: 'manual' })
    expect(await completedOf(e, SESSION)).toBeUndefined()
    expect(body.scores!.map(s => s.layer)).toEqual([{ kind: 'global' }])
    expect(await lastCheckups(e)).toEqual({ global: NOW, [SESSION_WS]: null, [OTHER_WS]: null })
  })

  it('只查全局与项目路径不能同时给', async () => {
    const e = env({ llm: quiet })
    expect(err(await e.run({ cmd: 'scan', layer: { kind: 'global' }, workspacePath: SESSION_WS } as MemoryCommand)).code).toBe('invalid-args')
  })

  it('全部体检：全局和每个项目都写完成记录，健康视图里的上次体检都更新', async () => {
    const e = env({ llm: quiet })
    await seedScopes(e)
    ok(await e.run({ cmd: 'scan' }))
    for (const layer of [GLOBAL, SESSION, OTHER]) expect(await completedOf(e, layer)).toEqual({ startedAt: NOW, completedAt: NOW, by: 'manual' })
    expect(await lastCheckups(e)).toEqual({ global: NOW, [SESSION_WS]: NOW, [OTHER_WS]: NOW })
  })

  it('内容检查失败：不写完成记录，上次体检仍是之前那次', async () => {
    let failing = false
    const e = env({ llm: { complete: async () => { if (failing) throw new Error('模型报错'); return '{"findings":[]}' } } })
    await seedScopes(e)
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    failing = true
    e.clock.now = NOW + 1000
    expect(ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS })).notes).toContain('semantic-failed')
    expect(await completedOf(e, SESSION)).toEqual({ startedAt: NOW, completedAt: NOW, by: 'manual' })
    expect((await lastCheckups(e))[SESSION_WS]).toBe(NOW)
  })

  it.each([
    ['ACCOUNT_SIGN_IN_REQUIRED', 'model-unavailable', 'semantic-failed'],
    ['MISSING_CREDENTIAL', 'model-unavailable', 'semantic-failed'],
    ['RATE_LIMIT', 'semantic-failed', 'model-unavailable'],
  ] as const)('借用会话的模型报宿主错误码 %s：说明码是 %s，不是 %s；不写完成记录', async (code, note, other) => {
    const e = env({ llm: { complete: async () => { throw Object.assign(new Error(`host ${code}`), { code }) } } })
    await seedScopes(e)
    const notes = ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS })).notes
    expect(notes).toContain(note)
    expect(notes).not.toContain(other)
    expect(await completedOf(e, SESSION)).toBeUndefined()
  })

  it('手动体检成功：清掉这个范围自动体检的失败计数和「模型用不了」，体检视图跟着更新', async () => {
    const e = env({ llm: quiet })
    await seedScopes(e)
    ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'all' }, frequency: 1 }))
    await e.checkups.recordFailure(SESSION, { kind: 'model-error', hostCode: 'RATE_LIMIT', message: 'too many requests' }, NOW - 1000)
    await e.checkups.recordFailure(SESSION, { kind: 'unparseable' }, NOW - 500)
    await e.checkups.recordModelUnavailable(GLOBAL, { kind: 'no-default-model' }, NOW)
    ok(await e.run({ cmd: 'refresh-views' }))
    const before = await e.readCheckupView()
    expect(before.scopes.find(s => s.scope.kind === 'workspace' && s.scope.workspacePath === SESSION_WS)).toMatchObject({
      failure: { count: 2, retryAt: NOW - 500 + 3_600_000, isRetryLimitReached: false, cause: { kind: 'unparseable' } }, modelUnavailable: null,
    })
    expect(before.scopes.find(s => s.scope.kind === 'global')).toMatchObject({ failure: null, modelUnavailable: { kind: 'no-default-model' } })
    ok(await e.run({ cmd: 'scan' }))
    const after = await e.readCheckupView()
    expect(after.scopes.map(s => [s.failure, s.modelUnavailable])).toEqual([[null, null], [null, null], [null, null]])
  })

  it('挂账挂到一半时进程退出：视图和完成记录都不写，上次体检仍是之前那次；重跑后每个冲突只有一张卡', async () => {
    let dying = false
    let puts = 0
    const e = env({
      llm: answering(() => [
        { type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', suggestedAction: '裁决' },
        { type: 'conflict', memoryIds: ['mem_c', 'mem_d'], summary: '测试框架矛盾', suggestedAction: '裁决' },
      ]),
      // 第二个冲突挂账时进程没了（第一个已挂上）
      wrapPending: table => ({
        get: k => table.get(k), list: () => table.list(), delete: k => table.delete(k), deleteIf: (k, isStill) => table.deleteIf(k, isStill), claim: k => table.claim(k),
        put: async (k, v) => { if (dying && ++puts === 2) throw new Error('进程退出'); return table.put(k, v) },
      }),
    })
    const scoped = { scope: 'workspace' as const, workspacePath: SESSION_WS }
    for (const [id, content] of [['mem_a', '用 pnpm'], ['mem_b', '用 npm'], ['mem_c', '用 vitest'], ['mem_d', '用 jest']]) {
      await e.store.create(record({ id, name: id, content, ...scoped }))
    }
    const seeded = await e.decisions.list()
    expect(seeded).toEqual([])
    // 之前做完过一次（那时模型什么都没报）
    const earlier = env({ llm: quiet })
    ok(await earlier.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    dying = true
    e.clock.now = NOW + 1000
    expect(err(await e.run({ cmd: 'scan', workspacePath: SESSION_WS })).code).toBe('failed')
    expect((await e.cache.get(scopeCacheKey({ kind: 'workspace', workspacePath: SESSION_WS })))?.scannedAt).toBe(NOW)
    expect(await completedOf(e, SESSION)).toEqual({ startedAt: NOW, completedAt: NOW, by: 'manual' })
    ok(await e.run({ cmd: 'refresh-views' }))
    expect((await lastCheckups(e))[SESSION_WS]).toBe(NOW)
    dying = false
    e.clock.now = NOW + 2000
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect(await completedOf(e, SESSION)).toEqual({ startedAt: NOW + 2000, completedAt: NOW + 2000, by: 'manual' })
    const cards = ledgerItems(pendingViewSchema.parse(await e.readView('pending')))
    expect(cards.map(i => i.kind)).toEqual(['conflict-horizontal', 'conflict-horizontal'])
    expect(await e.decisions.list()).toHaveLength(2)
  })

  it('两次体检重叠：开始得早、结束得晚的 agent 体检不让上次体检和缓存往回退', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    // 先开始的 agent 体检：模型卡住，等界面体检做完再返回，报的发现也不同
    const slow: SemanticLlm = { complete: async () => { await gate; return JSON.stringify({ findings: [{ type: 'unclear', memoryIds: ['mem_s'], summary: '旧结论' }] }) } }
    const e = env({ llm: quiet })
    await seedScopes(e)
    e.clock.now = NOW + 1000
    const late = executeScan({ scope: SESSION_WS }, {
      store: e.store, registry, decisions: e.decisions, cache: e.cache, checkups: e.checkups,
      host: { contextOf: async () => ({ workspacePath: SESSION_WS }), llmOf: () => slow }, instructions: noInstructions, now: () => e.clock.now,
    }, fakeExec())
    e.clock.now = NOW + 2000
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    e.clock.now = NOW + 3000
    release()
    expect((await late).kind).toBe('single')
    expect(await completedOf(e, SESSION)).toEqual({ startedAt: NOW + 2000, completedAt: NOW + 2000, by: 'manual' })
    const cached = await e.cache.get(scopeCacheKey({ kind: 'workspace', workspacePath: SESSION_WS }))
    expect(cached).toMatchObject({ scannedAt: NOW + 2000, findings: [] })
    ok(await e.run({ cmd: 'refresh-views' }))
    expect((await lastCheckups(e))[SESSION_WS]).toBe(NOW + 2000)
  })

  it('升级后还没有完成记录：上次体检取内容检查缓存的时间；有了完成记录就取完成记录', async () => {
    const e = env({ llm: quiet })
    await seedScopes(e)
    await e.cache.put(scopeCacheKey({ kind: 'workspace', workspacePath: SESSION_WS }), { id: scopeCacheKey({ kind: 'workspace', workspacePath: SESSION_WS }), scannedAt: NOW - 5000, scope: SESSION_WS, findings: [] })
    await e.cache.put(scopeCacheKey({ kind: 'workspace', workspacePath: OTHER_WS }), { id: scopeCacheKey({ kind: 'workspace', workspacePath: OTHER_WS }), scannedAt: NOW - 5000, scope: OTHER_WS, findings: [] })
    await e.checkups.complete([OTHER], { startedAt: NOW - 4000, completedAt: NOW - 3000, by: 'agent' })
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await lastCheckups(e)).toEqual({ global: null, [SESSION_WS]: NOW - 5000, [OTHER_WS]: NOW - 3000 })
  })

  it('项目真正删掉了（记忆根下没有它的目录，项目文件夹也不在）：它的完成记录在视图生成时清掉，其余的留着', async () => {
    await withTempDir(async parent => {
      const e = env({ llm: quiet })
      await seedScopes(e)
      // 上级文件夹在、项目文件夹不在：确定是删掉了
      const GONE = { kind: 'workspace' as const, workspacePath: join(parent, 'gone') }
      await e.checkups.complete([GLOBAL, SESSION, GONE], { startedAt: NOW, completedAt: NOW, by: 'manual' })
      ok(await e.run({ cmd: 'refresh-views' }))
      expect((await e.checkups.list()).map(r => r.id).sort()).toEqual([checkupKey(GLOBAL), checkupKey(SESSION)].sort())
    })
  })
})

describe('scan：最近一次结果', () => {
  const GLOBAL = { kind: 'global' as const }
  const SESSION = { kind: 'workspace' as const, workspacePath: SESSION_WS }
  const OTHER = { kind: 'workspace' as const, workspacePath: OTHER_WS }
  const crossConflict = { type: 'conflict', memoryIds: ['mem_g1', 'mem_s1'], summary: '全局和本项目矛盾', suggestedAction: '裁决' }
  /**
   * 模型只报这次输入里有的记忆之间的发现（项目体检的输入是全局加本项目，全局体检只有全局）；每次调用宿主报 usage 个 token，
   * 不给 usage 就是宿主没报。
   */
  const answering = (findings: object[], usage?: number) => {
    const calls = { count: 0 }
    const llm: SemanticLlm = {
      complete: async (input, _signal, onUsage) => {
        calls.count++
        if (usage !== undefined) onUsage?.(usage)
        const text = JSON.stringify(input)
        return JSON.stringify({ findings: findings.filter(f => (f as { memoryIds: string[] }).memoryIds.every(id => text.includes(id))) })
      },
    }
    return { llm, calls }
  }
  async function seed(e: ReturnType<typeof env>) {
    await e.store.create(record({ id: 'mem_g1', name: '全局甲', content: '回答用中文' }))
    await e.store.create(record({ id: 'mem_g2', name: '全局乙', content: '回答用英文' }))
    await e.store.create(record({ id: 'mem_s1', name: '本项目甲', content: '测试用 vitest', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_s2', name: '本项目乙', content: '单测跑 vitest', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_o', name: '别的项目', content: '那个配置', scope: 'workspace', workspacePath: OTHER_WS }))
  }
  const recordOf = async (e: ReturnType<typeof env>, key: string) => (await e.checkups.list()).find(r => r.id === key)
  const resultOf = async (e: ReturnType<typeof env>, layer: Parameters<typeof checkupKey>[0]) => (await recordOf(e, checkupKey(layer)))?.lastResult

  it('全部体检的说明码按范围给：一个范围内容检查没做完，别的范围不带；指令文件被截断只记在那个范围；整次的合并记在 all', async () => {
    // 输入里有别的项目的记忆就输出无法解析（这个项目的内容检查没做成，体检就此停下，跨项目重复不再比），其余照常
    const llm: SemanticLlm = { complete: async (input) => JSON.stringify(input).includes('mem_o') ? 'not json' : '{"findings":[]}' }
    const e = env({ llm, instructions: { [OTHER_WS]: { kind: 'found', texts: ['用 pnpm'], isTruncated: true } } })
    await seed(e)
    ok(await e.run({ cmd: 'scan' }))
    const codes = async (layer: Parameters<typeof checkupKey>[0]) => (await resultOf(e, layer))!.notes.map(n => n.code)
    expect(await codes(SESSION)).toEqual([])
    expect(await codes(GLOBAL)).toEqual([])
    expect((await codes(OTHER)).sort()).toEqual(['baseline-truncated', 'semantic-failed'])
    expect((await recordOf(e, 'all'))!.lastResult!.notes.map(n => n.code).sort())
      .toEqual(['baseline-truncated', 'semantic-failed'])
  })

  it('agent 体检（memory_scan）只写完成记录、不写结果：之前的最近一次结果原样留着', async () => {
    const { llm } = answering([crossConflict])
    const e = env({ llm })
    await seed(e)
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    const before = await resultOf(e, SESSION)
    e.clock.now = NOW + 1000
    await executeScan({ scope: OTHER_WS }, {
      store: e.store, registry, decisions: e.decisions, cache: e.cache, checkups: e.checkups,
      host: { contextOf: async () => ({ workspacePath: SESSION_WS }), llmOf: () => llm }, instructions: noInstructions, now: () => e.clock.now,
    }, fakeExec())
    await executeScan({ scope: SESSION_WS }, {
      store: e.store, registry, decisions: e.decisions, cache: e.cache, checkups: e.checkups,
      host: { contextOf: async () => ({ workspacePath: SESSION_WS }), llmOf: () => llm }, instructions: noInstructions, now: () => e.clock.now,
    }, fakeExec())
    expect(await recordOf(e, checkupKey(OTHER))).toEqual({ id: checkupKey(OTHER), completed: { startedAt: NOW + 1000, completedAt: NOW + 1000, by: 'agent' } })
    expect((await recordOf(e, checkupKey(SESSION)))).toMatchObject({ completed: { by: 'agent' }, lastResult: before })
  })

  it('说明码：分了批、指令文件被截断（查的不是会话所在的项目也照样对照它自己的）', async () => {
    const e = env({ llm: answering([]).llm, instructions: { [OTHER_WS]: { kind: 'found', texts: ['用 pnpm'], isTruncated: true } } })
    for (let i = 0; i < 6; i++) await e.store.create(record({ id: `mem_big${i}`, name: `大${i}`, content: '记'.repeat(10_000), scope: 'workspace', workspacePath: OTHER_WS }))
    ok(await e.run({ cmd: 'scan', workspacePath: OTHER_WS }))
    expect((await resultOf(e, OTHER))!.notes.map(n => n.code)).toEqual(expect.arrayContaining(['semantic-batched', 'baseline-truncated']))
  })

})

describe('scan：按范围认领', () => {
  const GLOBAL = { kind: 'global' as const }
  const SESSION = { kind: 'workspace' as const, workspacePath: SESSION_WS }
  const OTHER = { kind: 'workspace' as const, workspacePath: OTHER_WS }
  /** 同一个记忆根上的另一个宿主进程：另一份侧表（同一个时钟）。 */
  const otherProcess = (e: ReturnType<typeof env>) => new SidecarStore({
    root, schemas: sidecarSchemas, now: () => e.clock.now,
  }).checkups
  async function seedScopes(e: ReturnType<typeof env>) {
    await e.store.create(record({ id: 'mem_g', name: '全局', content: '回答用中文' }))
    await e.store.create(record({ id: 'mem_s', name: '本项目', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_o', name: '别的项目', content: '用 npm', scope: 'workspace', workspacePath: OTHER_WS }))
  }
  /** 记下调用次数；gate 给出时等它开了再回（不理会取消信号：模型在认领丢了之后才回来）。 */
  function countingLlm(opts: { gate?: Promise<void>; findings?: object[] } = {}) {
    const calls: string[] = []
    let onCall: (() => void) | undefined
    const called = new Promise<void>(resolve => { onCall = resolve })
    const llm: SemanticLlm = {
      complete: async (input) => {
        calls.push(input.user)
        onCall?.()
        if (opts.gate !== undefined) await opts.gate
        return JSON.stringify({ findings: opts.findings ?? [] })
      },
    }
    return { llm, calls, called }
  }
  const inProgress = async (e: ReturnType<typeof env>) => Object.fromEntries((await e.readCheckupView()).scopes
    .map(s => [s.scope.kind === 'global' ? 'global' : s.scope.workspacePath, s.isInProgress]))

  it('范围正在体检（别的进程认领着）：回 busy，说明里写明是哪个范围', async () => {
    const m = countingLlm()
    const e = env({ llm: m.llm })
    await seedScopes(e)
    const other = otherProcess(e)
    const heldGlobal = await other.claimRefreshable(checkupKey(GLOBAL))
    const heldOther = await other.claimRefreshable(checkupKey(OTHER))
    const busy = err(await e.run({ cmd: 'scan', layer: { kind: 'global' } }))
    expect(busy).toMatchObject({ code: 'busy', detail: expect.stringContaining('全局') })
    expect(err(await e.run({ cmd: 'scan', workspacePath: OTHER_WS }))).toMatchObject({ code: 'busy', detail: expect.stringContaining(OTHER_WS) })
    expect(m.calls).toEqual([])
    await heldGlobal!.release()
    await heldOther!.release()
  })

  it('体检进行中：体检视图里这个范围「进行中」，别的进程认领不到；做完放掉认领，视图回到不在进行中', async () => {
    let open!: () => void
    const m = countingLlm({ gate: new Promise<void>(resolve => { open = resolve }) })
    const e = env({ llm: m.llm })
    await seedScopes(e)
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await inProgress(e)).toEqual({ global: false, [SESSION_WS]: false, [OTHER_WS]: false })
    const running = e.run({ cmd: 'scan', workspacePath: SESSION_WS })
    await m.called
    expect(await inProgress(e)).toEqual({ global: false, [SESSION_WS]: true, [OTHER_WS]: false })
    expect(await otherProcess(e).claimRefreshable(checkupKey(SESSION))).toBeUndefined()
    open()
    ok(await running)
    expect(await inProgress(e)).toEqual({ global: false, [SESSION_WS]: false, [OTHER_WS]: false })
    expect(await otherProcess(e).isClaimed(checkupKey(SESSION))).toBe(false)
  })

  it('认领期间每 10 秒刷新一次；心跳发现认领已被别人接手：这次不再提交（不写缓存、不挂账、不写完成记录），回 busy', async () => {
    const beats: Array<{ callback: () => void; delayMs: number; isLive: boolean }> = []
    const heartbeat = (callback: () => void, delayMs: number) => {
      const beat = { callback, delayMs, isLive: true }
      beats.push(beat)
      return () => { beat.isLive = false }
    }
    let open!: () => void
    const m = countingLlm({
      gate: new Promise<void>(resolve => { open = resolve }),
      findings: [{ type: 'conflict', memoryIds: ['mem_s', 'mem_s2'], summary: '包管理器矛盾', suggestedAction: '裁决' }],
    })
    const infos: string[] = []
    const e = env({ llm: m.llm, heartbeat, log: { info: (msg: string) => { infos.push(msg) }, warn() {}, error() {} } })
    await seedScopes(e)
    await e.store.create(record({ id: 'mem_s2', name: '本项目二', content: '用 yarn', scope: 'workspace', workspacePath: SESSION_WS }))
    const running = e.run({ cmd: 'scan', workspacePath: SESSION_WS })
    await m.called
    expect(beats.map(b => [b.delayMs, b.isLive])).toEqual([[10_000, true]])
    const claimFile = join(root, STATE_DIR, 'checkups', `${createHash('sha1').update(SESSION_WS).digest('hex')}.claim`)
    const claimAt = async () => (JSON.parse(await readFile(claimFile, 'utf8')) as { at: number }).at
    expect(await claimAt()).toBe(NOW)
    e.clock.now = NOW + 10_000
    beats[0]!.callback()
    await vi.waitFor(async () => { expect(await claimAt()).toBe(NOW + 10_000) })
    // 别的进程把它当残留清掉、接手了
    await rm(claimFile)
    const taker = await otherProcess(e).claimRefreshable(checkupKey(SESSION))
    expect(taker).toBeDefined()
    beats[0]!.callback()
    await vi.waitFor(() => { expect(infos.some(m => m.includes('被别的进程接手'))).toBe(true) })
    // 模型在认领丢了之后才回来
    open()
    expect(err(await running).code).toBe('busy')
    expect(await e.cache.list()).toEqual([])
    expect(await e.decisions.list()).toEqual([])
    expect(await e.checkups.list()).toEqual([])
    expect(beats[0]!.isLive).toBe(false)
    // 接手者的认领没被旧持有者删掉
    expect(await otherProcess(e).isClaimed(checkupKey(SESSION))).toBe(true)
    await taker!.release()
  })

  it('待决项被别的操作认领时仍回 claimed，不是 busy', async () => {
    const e = env()
    const entry = await seedPair(e)
    const release = await e.decisions.withClaim(entry.id, async () => err(await e.run({ cmd: 'undo', decisionId: entry.id })))
    expect(release.isClaimed && release.value.code).toBe('claimed')
  })
})

describe('set-auto-checkup', () => {
  const ALL = { kind: 'all' as const }
  const DISCUSSION = { kind: 'workspace' as const, workspacePath: '/work/discussion' }
  const settings = async (e: ReturnType<typeof env>) => Object.fromEntries(await e.autoCheckups.read())

  it('选具体值写设置表（和默认值相同也写），「跟随」删掉这一条；每次都通知本进程的调度重算', async () => {
    const e = env()
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 7 }))
    ok(await e.run({ cmd: 'set-auto-checkup', scope: DISCUSSION, frequency: 7 }))
    ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'global' }, frequency: 'manual' }))
    expect(await settings(e)).toEqual({ all: 7, '/work/discussion': 7, global: 'manual' })
    ok(await e.run({ cmd: 'set-auto-checkup', scope: DISCUSSION, frequency: 'follow' }))
    expect(await settings(e)).toEqual({ all: 7, global: 'manual' })
    // 本来就在跟随时再选「跟随」也算成功
    ok(await e.run({ cmd: 'set-auto-checkup', scope: DISCUSSION, frequency: 'follow' }))
    expect(e.autoCheckupChanges.count).toBe(5)
  })

  it('「全部」选仅手动是写一条 manual，不是删掉', async () => {
    const e = env()
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 'manual' }))
    expect(await settings(e)).toEqual({ all: 'manual' })
  })

  it.each([
    ['「全部」没有可跟随的', ' set-auto-checkup {"scope":{"kind":"all"},"frequency":"follow"}'],
    ['天数小于 1', ' set-auto-checkup {"scope":{"kind":"all"},"frequency":0}'],
    ['天数大于 90', ' set-auto-checkup {"scope":{"kind":"global"},"frequency":91}'],
    ['天数不是整数', ' set-auto-checkup {"scope":{"kind":"global"},"frequency":1.5}'],
    ['未知取值', ' set-auto-checkup {"scope":{"kind":"global"},"frequency":"daily"}'],
    ['项目路径不是绝对路径', ' set-auto-checkup {"scope":{"kind":"workspace","workspacePath":"discussion"},"frequency":1}'],
  ])('%s → invalid-args，设置表不动、不通知调度', async (_label, raw) => {
    const e = env()
    expect(err(await e.runRaw(raw)).code).toBe('invalid-args')
    expect(await settings(e)).toEqual({})
    expect(e.autoCheckupChanges.count).toBe(0)
  })

  it('体检开关关着时也能改设置（只是调度不跑），体检视图写明开关关着', async () => {
    const e = env({ governanceEnabled: false })
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 1 }))
    expect(await settings(e)).toEqual({ all: 1 })
    expect((await e.readCheckupView()).governanceEnabled).toBe(false)
  })

  it('写完立刻重写体检视图（别的全局视图不重写）：按「自动体检情况表」逐行，各范围的有效频率和跟随 / 单独设置', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', name: '全局' }))
    await e.store.create(record({ id: 'mem_d', name: '讨论', scope: 'workspace', workspacePath: '/work/discussion' }))
    await e.store.create(record({ id: 'mem_o', name: '其他', scope: 'workspace', workspacePath: '/work/other' }))
    const rows = async () => {
      const view = await e.readCheckupView()
      return [view.defaultFrequency, ...view.scopes.map(s => `${s.scope.kind === 'workspace' ? s.scope.workspacePath : 'global'} ${s.frequency}${s.isOwn ? ' 单独' : ''}`)]
    }
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 'manual' }))
    expect(await rows()).toEqual(['manual', 'global manual', '/work/discussion manual', '/work/other manual'])
    await expect(stat(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.pending))).rejects.toMatchObject({ code: 'ENOENT' })
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 7 }))
    expect(await rows()).toEqual([7, 'global 7', '/work/discussion 7', '/work/other 7'])
    ok(await e.run({ cmd: 'set-auto-checkup', scope: DISCUSSION, frequency: 1 }))
    expect(await rows()).toEqual([7, 'global 7', '/work/discussion 1 单独', '/work/other 7'])
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 'manual' }))
    expect(await rows()).toEqual(['manual', 'global manual', '/work/discussion 1 单独', '/work/other manual'])
    ok(await e.run({ cmd: 'set-auto-checkup', scope: DISCUSSION, frequency: 'follow' }))
    expect(await rows()).toEqual(['manual', 'global manual', '/work/discussion manual', '/work/other manual'])
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 7 }))
    ok(await e.run({ cmd: 'set-auto-checkup', scope: DISCUSSION, frequency: 7 }))
    expect(await rows()).toEqual([7, 'global 7', '/work/discussion 7 单独', '/work/other 7'])
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 1 }))
    expect(await rows()).toEqual([1, 'global 1', '/work/discussion 7 单独', '/work/other 1'])
    // 新加一个项目：跟随「全部」当前的值；重启插件（新的侧表与写入器实例）后照旧
    await e.store.create(record({ id: 'mem_n', name: '新', scope: 'workspace', workspacePath: '/work/new' }))
    ok(await env().run({ cmd: 'refresh-views' }))
    expect(await rows()).toEqual([1, 'global 1', '/work/discussion 7 单独', '/work/new 1', '/work/other 1'])
  })

  it('体检视图的上次、下次和到期：按完成记录算；从没体检过的开了自动体检就算到期', async () => {
    const DAY = 86_400_000
    const e = env()
    await e.store.create(record({ id: 'mem_g', name: '全局' }))
    await e.store.create(record({ id: 'mem_d', name: '讨论', scope: 'workspace', workspacePath: '/work/discussion' }))
    await e.checkups.complete([{ kind: 'global' }], { startedAt: NOW - 2 * DAY, completedAt: NOW - 2 * DAY, by: 'agent' })
    ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 3 }))
    expect((await e.readCheckupView()).scopes).toEqual([
      { scope: { kind: 'global' }, isCheckable: true, frequency: 3, isOwn: false, lastCheckupAt: NOW - 2 * DAY, nextCheckupAt: NOW + DAY, isDue: false, isInProgress: false, failure: null, modelUnavailable: null, lastResult: null },
      { scope: DISCUSSION, isCheckable: true, frequency: 3, isOwn: false, lastCheckupAt: null, nextCheckupAt: null, isDue: true, isInProgress: false, failure: null, modelUnavailable: null, lastResult: null },
    ])
  })

  it('项目真正删掉了（记忆根下没有它的目录，项目文件夹也不在），它的设置在视图生成时清掉（全部、全局不动）', async () => {
    await withTempDir(async parent => {
      const e = env()
      await e.store.create(record({ id: 'mem_s', scope: 'workspace', workspacePath: SESSION_WS }))
      ok(await e.run({ cmd: 'set-auto-checkup', scope: ALL, frequency: 7 }))
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'global' }, frequency: 1 }))
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'workspace', workspacePath: SESSION_WS }, frequency: 1 }))
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'workspace', workspacePath: join(parent, 'gone') }, frequency: 1 }))
      ok(await e.run({ cmd: 'refresh-views' }))
      expect(await settings(e)).toEqual({ all: 7, global: 1, [SESSION_WS]: 1 })
    })
  })

  it('项目路径变成了普通文件、或上级路径变成了普通文件：都算真正删掉，单独设置在视图生成时清掉', async () => {
    await withTempDir(async parent => {
      const e = env()
      const asFile = join(parent, 'proj')
      await writeFile(asFile, '')
      // 上级是普通文件：取项目文件夹报 ENOTDIR
      const underFile = join(asFile, 'sub')
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'workspace', workspacePath: asFile }, frequency: 1 }))
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'workspace', workspacePath: underFile }, frequency: 1 }))
      ok(await e.run({ cmd: 'refresh-views' }))
      expect(await settings(e)).toEqual({})
    })
  })

  it('项目文件夹和它的上级都不在（像外接盘没挂载）：分不清是不是删掉了，单独设置留着', async () => {
    await withTempDir(async parent => {
      const e = env()
      const unmounted = join(parent, 'volume', 'proj')
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'workspace', workspacePath: unmounted }, frequency: 3 }))
      ok(await e.run({ cmd: 'refresh-views' }))
      expect(await settings(e)).toEqual({ [unmounted]: 3 })
    })
  })

  it('项目文件夹不在、上级文件夹还在：算真正删掉，单独设置清掉', async () => {
    await withTempDir(async parent => {
      const e = env()
      const removed = join(parent, 'proj')
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'workspace', workspacePath: removed }, frequency: 3 }))
      ok(await e.run({ cmd: 'refresh-views' }))
      expect(await settings(e)).toEqual({})
    })
  })

  it('还没有自己记忆的项目（记忆根下没有它的目录，项目文件夹还在）：单独设置和体检记录在视图生成后留着，体检视图写它的设置、不可体检、不到期', async () => {
    const project = await mkdtemp(join(tmpdir(), 'pm-cmd-project-'))
    try {
      const e = env()
      await e.store.create(record({ id: 'mem_g' }))
      ok(await e.run({ cmd: 'set-auto-checkup', scope: { kind: 'workspace', workspacePath: project }, frequency: 3 }))
      await e.checkups.recordResults([{ key: project, result: { checkupId: 'ck1', by: 'manual', completedAt: NOW, added: { keys: [], pending: 0, advice: 0 }, notes: [] } }])
      ok(await e.run({ cmd: 'refresh-views' }))
      expect(await settings(e)).toEqual({ [project]: 3 })
      expect((await e.checkups.list()).map(r => r.id)).toEqual([project])
      expect((await e.readCheckupView()).scopes).toEqual([
        expect.objectContaining({ scope: { kind: 'global' } }),
        expect.objectContaining({ scope: { kind: 'workspace', workspacePath: project }, isCheckable: false, frequency: 3, isOwn: true, lastCheckupAt: null, nextCheckupAt: null, isDue: false }),
      ])
      // 有了第一条记忆：照这个设置自动体检（从没体检过，开着就到期）
      await e.store.create(record({ id: 'mem_p', scope: 'workspace', workspacePath: project }))
      ok(await e.run({ cmd: 'refresh-views' }))
      expect((await e.readCheckupView()).scopes[1]).toMatchObject({ isCheckable: true, frequency: 3, isOwn: true, isDue: true })
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('项目记忆删光了：单独设置和完成记录都留着；体检视图写单独设置、上次体检，不可体检；恢复后照旧按原设置和上次体检算下次', async () => {
    const DAY = 86_400_000
    const e = env()
    // 会话所在的项目：删除、恢复不用越项目确认
    const SESSION = { kind: 'workspace' as const, workspacePath: SESSION_WS }
    await e.store.create(record({ id: 'mem_d', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'set-auto-checkup', scope: SESSION, frequency: 3 }))
    await e.checkups.complete([SESSION], { startedAt: NOW - DAY, completedAt: NOW - DAY, by: 'manual' })
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_d', layer: SESSION }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await settings(e)).toEqual({ [SESSION_WS]: 3 })
    expect((await e.checkups.list()).map(r => r.id)).toEqual([SESSION_WS])
    const deleted = (await e.readCheckupView()).scopes.find(s => s.scope.kind === 'workspace')
    expect(deleted).toMatchObject({ scope: SESSION, isCheckable: false, frequency: 3, isOwn: true, lastCheckupAt: NOW - DAY, nextCheckupAt: null, isDue: false })
    // 健康视图不列它（没有在用的记忆）
    expect(healthViewSchema.parse(await e.readView('health')).layers.map(l => l.layer)).toEqual([{ kind: 'global' }])
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_d', layer: SESSION }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect((await e.readCheckupView()).scopes.find(s => s.scope.kind === 'workspace'))
      .toMatchObject({ scope: SESSION, isCheckable: true, frequency: 3, isOwn: true, lastCheckupAt: NOW - DAY, nextCheckupAt: NOW + 2 * DAY, isDue: false })
    expect(healthViewSchema.parse(await e.readView('health')).layers.find(l => l.layer.kind === 'workspace')).toMatchObject({ layer: SESSION, lastCheckupAt: NOW - DAY })
  })

  it('项目顶层只有非在用的记录（手改了 status）：体检这个项目照常写完成记录，之后按设置不再到期', async () => {
    const e = env({ llm: { complete: async () => '{"findings":[]}' } })
    const SESSION = { kind: 'workspace' as const, workspacePath: SESSION_WS }
    await e.store.create(record({ id: 'mem_g' }))
    const dir = join(root, workspaceDirName(SESSION_WS))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WORKSPACE_MARKER), SESSION_WS + '\n')
    await writeFile(join(dir, 'old.md'), encodeRecord(record({ id: 'mem_old', scope: 'workspace', workspacePath: SESSION_WS, status: 'deleted', deletedAt: NOW }), {}))
    ok(await e.run({ cmd: 'set-auto-checkup', scope: SESSION, frequency: 1 }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect((await e.readCheckupView()).scopes.find(s => s.scope.kind === 'workspace')).toMatchObject({ scope: SESSION, isCheckable: true, isDue: true })
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect((await e.checkups.list()).find(r => r.id === SESSION_WS)?.completed?.completedAt).toBe(NOW)
    ok(await e.run({ cmd: 'refresh-views' }))
    expect((await e.readCheckupView()).scopes.find(s => s.scope.kind === 'workspace')).toMatchObject({ scope: SESSION, isCheckable: true, lastCheckupAt: NOW, isDue: false })
  })

  it('项目记忆全在最近删除时体检这个项目：不写完成记录；恢复后上次体检、下次体检和到期照旧按删除前的那次算', async () => {
    const DAY = 86_400_000
    const e = env({ llm: { complete: async () => '{"findings":[]}' } })
    const SESSION = { kind: 'workspace' as const, workspacePath: SESSION_WS }
    await e.store.create(record({ id: 'mem_d', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'set-auto-checkup', scope: SESSION, frequency: 3 }))
    await e.checkups.complete([SESSION], { startedAt: NOW - DAY, completedAt: NOW - DAY, by: 'manual' })
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_d', layer: SESSION }))
    ok(await e.run({ cmd: 'scan', workspacePath: SESSION_WS }))
    expect((await e.checkups.list()).find(r => r.id === SESSION_WS)?.completed?.completedAt).toBe(NOW - DAY)
    ok(await e.run({ cmd: 'restore', memoryId: 'mem_d', layer: SESSION }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect((await e.readCheckupView()).scopes.find(s => s.scope.kind === 'workspace'))
      .toMatchObject({ scope: SESSION, isCheckable: true, lastCheckupAt: NOW - DAY, nextCheckupAt: NOW + 2 * DAY, isDue: false })
    expect(healthViewSchema.parse(await e.readView('health')).layers.find(l => l.layer.kind === 'workspace')).toMatchObject({ layer: SESSION, lastCheckupAt: NOW - DAY })
  })
})

describe('confirm（仍然有效）', () => {
  const DAY = 86_400_000
  const staleIds = async (e: ReturnType<typeof env>) => pendingViewSchema.parse(await e.readView('pending')).items
    .flatMap(i => i.kind === 'advice' && i.type === 'stale' ? i.memories.map(m => m.id) : [])

  it('刷新确认时间、内容与 updatedAt 不动；重写视图，「很久没确认」项消失', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_old', type: 'project', scope: 'workspace', workspacePath: SESSION_WS, lastConfirmedAt: NOW - 8 * DAY, updatedAt: 5 }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await staleIds(e)).toEqual(['mem_old'])

    const body = ok(await e.run({ cmd: 'confirm', memoryId: 'mem_old', layer: { kind: 'workspace', workspacePath: SESSION_WS } }))
    expect(body).toMatchObject({ cmd: 'confirm', memoryIds: ['mem_old'] })
    const after = (await e.store.get('mem_old'))!
    expect([after.lastConfirmedAt, after.updatedAt, after.content]).toEqual([NOW, 5, '内容'])
    expect(await staleIds(e)).toEqual([])
  })

  it('已删除或不存在的记忆 → not-found', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_gone' }))
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_gone' }))
    expect(err(await e.run({ cmd: 'confirm', memoryId: 'mem_gone' })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'confirm', memoryId: 'mem_none' })).code).toBe('not-found')
  })

  it('别的项目的记忆：先要 allowCrossWorkspace，带上才刷新', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_o', scope: 'workspace', workspacePath: OTHER_WS, lastConfirmedAt: 1 }))
    const layer = { kind: 'workspace', workspacePath: OTHER_WS } as const
    expect(err(await e.run({ cmd: 'confirm', memoryId: 'mem_o', layer }))).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_o', workspacePath: OTHER_WS }] })
    expect((await e.store.get('mem_o'))!.lastConfirmedAt).toBe(1)
    ok(await e.run({ cmd: 'confirm', memoryId: 'mem_o', layer, allowCrossWorkspace: true }))
    expect((await e.store.get('mem_o'))!.lastConfirmedAt).toBe(NOW)
  })

  it('同 id 在全局和本项目各一份：带层时只刷新那一份', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '全局那份', lastConfirmedAt: 1 }))
    await e.store.create(record({ id: 'mem_dup', name: '本项目那份', scope: 'workspace', workspacePath: SESSION_WS, lastConfirmedAt: 1 }))
    ok(await e.run({ cmd: 'confirm', memoryId: 'mem_dup', layer: { kind: 'global' } }))
    const copy = async (layer: Parameters<MemoryStore['readRaw']>[0]) =>
      (await e.store.readRaw(layer, { includeArchive: true })).records.find(l => l.record.id === 'mem_dup')!.record.lastConfirmedAt
    expect(await copy({ kind: 'global' })).toBe(NOW)
    expect(await copy({ kind: 'workspace', workspacePath: SESSION_WS })).toBe(1)
  })
})