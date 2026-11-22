import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suggestionBasis } from '../src/governance/decisions.ts'
import { editFingerprint } from '../src/governance/snapshots.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { SUGGESTION_ATTEMPT_LIMIT } from '../src/gui/checkup-suggestions.ts'
import { healthViewSchema, pendingViewSchema } from '../src/gui/contract.ts'
import type { ReadEventFn } from '../src/tools/source.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { NOW, SESSION_WS, root, setRoot, env, ok, err, seedPair, allEntries, memoryTree } from './helpers/gui-command-env.ts'


describe('suggest（补上建议）', () => {
  function scripted(...answers: Array<string | Error | (() => Promise<string>)>) {
    const prompts: Array<{ system: string; user: string }> = []
    const llm: SemanticLlm = {
      model: 'deepseek-v4-flash',
      complete: async (prompt) => {
        prompts.push(prompt)
        const next = answers.shift() ?? ''
        if (next instanceof Error) throw next
        return typeof next === 'function' ? next() : next
      },
    }
    return { llm, prompts }
  }
  const KEEP_A = JSON.stringify({ action: 'keep-a', reason: 'A 更新' })
  const horizontalOf = async (e: ReturnType<typeof env>, id: string) => {
    const item = pendingViewSchema.parse(await e.readView('pending')).items.find(i => 'decisionId' in i && i.decisionId === id)
    if (item?.kind !== 'conflict-horizontal') throw new Error(`没有横向冲突项 ${id}`)
    return item
  }

  it('体检发起的尝试次数到了上限，用户点「补上建议」照样生成，也不记尝试', async () => {
    const { llm, prompts } = scripted(KEEP_A)
    const e = env({ llm })
    const entry = await seedPair(e)
    const [a, b] = [await e.store.get('mem_a'), await e.store.get('mem_b')]
    const failure = { basis: suggestionBasis(entry, [a!, b!]), cause: { kind: 'unparseable' as const }, at: NOW }
    for (let i = 0; i < SUGGESTION_ATTEMPT_LIMIT; i++) await e.decisions.writeSuggestion(entry.id, { failure }, id => e.store.get(id), { isAttempt: true })
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect(prompts).toHaveLength(1)
    const saved = await e.decisions.get(entry.id)
    expect(saved?.suggestion?.action).toBe('keep-a')
    expect(saved?.suggestionAttempts?.count).toBe(SUGGESTION_ATTEMPT_LIMIT)
  })

  it('写到账本条目上（带 id 和依据版本、不回查出处），视图里换成建议；回结果带模型名', async () => {
    const { llm, prompts } = scripted(KEEP_A)
    const e = env({ llm })
    const entry = await seedPair(e)
    const memoriesBefore = await memoryTree()
    const recordsBefore = [await e.store.get('mem_a'), await e.store.get('mem_b')]
    expect(ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))).toEqual({ ok: true, cmd: 'suggest', decisionId: entry.id, model: 'deepseek-v4-flash' })
    expect(prompts).toHaveLength(1)
    const saved = (await e.decisions.get(entry.id))!
    const [a, b] = [await e.store.get('mem_a'), await e.store.get('mem_b')]
    expect(saved.suggestion).toMatchObject({
      action: 'keep-a', reason: 'A 更新', isSourced: false, generatedAt: NOW,
      ops: [{ kind: 'keep', memoryId: 'mem_a' }, { kind: 'forget', memoryId: 'mem_b' }],
      basis: { conflictFingerprint: 'fp-ab', memories: [{ memoryId: 'mem_a', fingerprint: editFingerprint(a!) }, { memoryId: 'mem_b', fingerprint: editFingerprint(b!) }] },
    })
    expect(saved.suggestion!.id).toMatch(/^sg_/)
    const item = await horizontalOf(e, entry.id)
    expect(item.suggestion).toEqual({ id: saved.suggestion!.id, action: 'keep-a', reason: 'A 更新', ops: saved.suggestion!.ops, isSourced: false })
    expect(item.noSuggestion).toBeUndefined()
    // 不写记忆、不拍快照
    expect(await e.snapshots.list()).toEqual([])
    expect(await e.store.get('mem_b')).toMatchObject({ status: 'active', content: '用 npm' })
    expect([a, b]).toEqual(recordsBefore)
    expect(await memoryTree()).toEqual(memoriesBefore)
  })

  it('不认领体检范围、不写体检完成记录：生成期间同一范围照样能体检，之后上次体检时间不变', async () => {
    const PROJECT = { kind: 'workspace' as const, workspacePath: SESSION_WS }
    const GLOBAL = { kind: 'global' as const }
    let e!: ReturnType<typeof env>
    const inProgress: boolean[] = []
    const llm: SemanticLlm = {
      complete: async () => {
        inProgress.push(await e.checkups.isInProgress(PROJECT), await e.checkups.isInProgress(GLOBAL))
        return KEEP_A
      },
    }
    e = env({ llm })
    const entry = await seedPair(e, SESSION_WS)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect((await e.decisions.get(entry.id))!.suggestion?.action).toBe('keep-a')
    expect(inProgress).toEqual([false, false])
    expect(await e.checkups.list()).toEqual([])
    const lastCheckups = healthViewSchema.parse(await e.readView('health')).layers.map(l => l.lastCheckupAt)
    expect(lastCheckups.length).toBeGreaterThan(0)
    expect(lastCheckups.every(at => at === null)).toBe(true)
  })

  it('已有当前依据的建议时直接回成功、不调用模型；两条被改过后依据作废，再点会重新生成', async () => {
    const { llm, prompts } = scripted(KEEP_A, JSON.stringify({ action: 'keep-b', reason: 'B 改过了' }))
    const e = env({ llm })
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    const first = (await e.decisions.get(entry.id))!.suggestion!.id
    expect(ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))).toEqual({ ok: true, cmd: 'suggest', decisionId: entry.id })
    expect(prompts).toHaveLength(1)
    await e.store.update({ id: 'mem_b' }, r => ({ ...r, summary: '只改了摘要', updatedAt: 5 }))
    await e.run({ cmd: 'refresh-views' })
    expect((await horizontalOf(e, entry.id)).noSuggestion).toEqual({ code: 'not-generated' })
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect(prompts).toHaveLength(2)
    const second = (await e.decisions.get(entry.id))!.suggestion!
    expect(second.id).not.toBe(first)
    expect((await horizontalOf(e, entry.id)).suggestion).toMatchObject({ id: second.id, action: 'keep-b' })
  })

  it('融合：融合稿写进按合并规则保留的那条（全局优先），另一条删除', async () => {
    const draft = { content: '前端用 pnpm，脚本仓用 npm', summary: '包管理器按仓库选', name: '包管理器' }
    const { llm } = scripted(JSON.stringify({ action: 'merge', reason: '各有场景', draft }))
    const e = env({ llm, workspacePath: SESSION_WS })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', tags: ['npm'] }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect((await horizontalOf(e, entry.id)).suggestion?.ops).toEqual([
      { kind: 'forget', memoryId: 'mem_a' },
      { kind: 'edit', memoryId: 'mem_b', ...draft, tags: ['npm'] },
    ])
  })

  it('任一条含高危密钥：回 has-secret，不调用模型；视图原因码是 has-secret', async () => {
    const { llm, prompts } = scripted(KEEP_A)
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: `用 pnpm，token ${FAKE_SECRET.github}` }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm' }))
    const { entry } = await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)
    expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('has-secret')
    expect(prompts).toEqual([])
    await e.run({ cmd: 'refresh-views' })
    expect((await horizontalOf(e, entry.id)).noSuggestion).toEqual({ code: 'has-secret' })
  })

  it('治理开关关着、子 agent 会话：拒绝，不调用模型', async () => {
    for (const opts of [{ governanceEnabled: false }, { delegationDepth: 1 }]) {
      const { llm, prompts } = scripted(KEEP_A)
      const e = env({ llm, ...opts })
      const entry = await seedPair(e)
      expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('governanceEnabled' in opts ? 'governance-disabled' : 'subagent-readonly')
      expect(prompts).toEqual([])
      expect((await e.decisions.get(entry.id))!.suggestion).toBeUndefined()
      await rm(root, { recursive: true, force: true })
      setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
    }
  })

  it('拿不到模型：llm-unavailable，账本不动', async () => {
    const e = env({ llm: null })
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('llm-unavailable')
    expect(await e.decisions.get(entry.id)).toEqual(entry)
  })

  it('条目不在、不是冲突、垂直冲突缺基线、一方已不在用：not-found / invalid-args / no-baseline / not-found 带记忆 id', async () => {
    const { llm, prompts } = scripted(KEEP_A)
    const e = env({ llm })
    expect(err(await e.run({ cmd: 'suggest', decisionId: 'pd_ghost' })).code).toBe('not-found')
    await e.store.create(record({ id: 'mem_v', content: '用 npm' }))
    const vertical = (await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：用 pnpm', summary: 'v', fingerprint: 'fp-v' }, 1)).entry
    expect(err(await e.run({ cmd: 'suggest', decisionId: vertical.id })).code).toBe('no-baseline')
    await e.decisions.syncOverflow(SESSION_WS, { mode: 'relax', tier: 1 }, 1, '超限')
    const overflow = (await e.decisions.list()).find(d => d.kind === 'overflow')!
    expect(err(await e.run({ cmd: 'suggest', decisionId: overflow.id })).code).toBe('invalid-args')
    const entry = await seedPair(e)
    await e.store.update({ id: 'mem_b' }, r => ({ ...r, status: 'deleted', deletedAt: NOW }))
    expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id }))).toMatchObject({ code: 'not-found', memoryIds: ['mem_b'] })
    expect(prompts).toEqual([])
  })

  it('生成期间任一条被改过：回 stale，这一份不写', async () => {
    let e!: ReturnType<typeof env>
    const { llm } = scripted(async () => {
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, tags: ['别处加的'], updatedAt: 5 }))
      return KEEP_A
    })
    e = env({ llm })
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('stale')
    expect((await e.decisions.get(entry.id))!.suggestion).toBeUndefined()
    expect((await horizontalOf(e, entry.id)).noSuggestion).toEqual({ code: 'not-generated' })
  })

  it('生成期间别处已写下当前依据的建议：不覆盖，丢掉这一份，回成功', async () => {
    let e!: ReturnType<typeof env>
    let otherId = ''
    const { llm } = scripted(async () => {
      // 另一个标签页同时点了「补上建议」，先写完
      const other = env({ llm: scripted(JSON.stringify({ action: 'keep-both', reason: '不矛盾' })).llm })
      ok(await other.run({ cmd: 'suggest', decisionId: (await e.decisions.list())[0]!.id }))
      otherId = (await e.decisions.list())[0]!.suggestion!.id
      return KEEP_A
    })
    e = env({ llm })
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect((await e.decisions.get(entry.id))!.suggestion).toMatchObject({ id: otherId, action: 'keep-both' })
  })

  it('写入时条目正被别处认领：回 claimed，这一份丢弃', async () => {
    let e!: ReturnType<typeof env>
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let held: Promise<unknown> = Promise.resolve()
    const { llm } = scripted(async () => {
      const id = (await e.decisions.list())[0]!.id
      let acquired!: () => void
      const isAcquired = new Promise<void>(resolve => { acquired = resolve })
      held = e.decisions.withClaim(id, async () => { acquired(); await gate })
      await isAcquired
      return KEEP_A
    })
    e = env({ llm })
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('claimed')
    release()
    await held
    expect((await e.decisions.get(entry.id))!.suggestion).toBeUndefined()
  })

  it('融合稿带进了原文没有的密钥：整份丢弃，回 llm-invalid-output，失败记在条目上、视图原因码 failed', async () => {
    const raw = JSON.stringify({ action: 'merge', reason: '合', draft: { content: `用 pnpm，${FAKE_SECRET.sk}`, summary: 's' } })
    const e = env({ llm: scripted(raw).llm })
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'suggest', decisionId: entry.id })).code).toBe('llm-invalid-output')
    expect((await e.decisions.get(entry.id))!.suggestion).toBeUndefined()
    expect((await horizontalOf(e, entry.id)).noSuggestion).toEqual({ code: 'failed', cause: { kind: 'secret-in-draft' } })
  })

  it('模型报错：原话脱敏后回 llm-failed 并记进视图；鉴权错误只给错误码；之后再试成功会清掉失败', async () => {
    const { llm } = scripted(new Error(`upstream said ${FAKE_SECRET.sk}`), Object.assign(new Error(`401 ${FAKE_SECRET.sk}`), { code: 'AUTH' }), KEEP_A)
    const e = env({ llm })
    const entry = await seedPair(e)
    const masked = err(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect(masked).toMatchObject({ code: 'llm-failed', detail: 'upstream said [已隐藏]' })
    expect((await horizontalOf(e, entry.id)).noSuggestion).toEqual({ code: 'failed', cause: { kind: 'model-error', message: 'upstream said [已隐藏]' } })
    const auth = err(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect(auth).toEqual({ ok: false, cmd: 'suggest', code: 'llm-failed', detail: 'AUTH' })
    expect((await horizontalOf(e, entry.id)).noSuggestion).toEqual({ code: 'failed', cause: { kind: 'model-error', hostCode: 'AUTH' } })
    expect(JSON.stringify(await allEntries(e))).not.toContain(FAKE_SECRET.sk)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    const saved = (await e.decisions.get(entry.id))!
    expect(saved).not.toHaveProperty('suggestionFailure')
    expect((await horizontalOf(e, entry.id)).suggestion?.action).toBe('keep-a')
  })

  it('模型判断不了哪条对：回成功（模型正常答了），记在条目上、跟着依据走，视图原因码 undecided 带遮盖后的理由；再试一次成功会清掉', async () => {
    const unsure = JSON.stringify({ action: 'unsure', reason: '两条都没写适用场景；需要你确认 password: abc12345x 归哪个项目' })
    const { llm, prompts } = scripted(unsure, KEEP_A)
    const e = env({ llm })
    const entry = await seedPair(e)
    expect(ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))).toEqual({ ok: true, cmd: 'suggest', decisionId: entry.id, model: 'deepseek-v4-flash' })
    const saved = (await e.decisions.get(entry.id))!
    expect(saved.suggestion).toBeUndefined()
    expect(saved.suggestionFailure?.cause).toEqual({ kind: 'undecided', reason: '两条都没写适用场景；需要你确认 [已隐藏] 归哪个项目' })
    expect((await horizontalOf(e, entry.id)).noSuggestion).toEqual({ code: 'undecided', reason: '两条都没写适用场景；需要你确认 [已隐藏] 归哪个项目' })
    // 判断不了不算有当前建议：再点会重新问模型
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect(prompts).toHaveLength(2)
    expect((await e.decisions.get(entry.id))).not.toHaveProperty('suggestionFailure')
    expect((await horizontalOf(e, entry.id)).suggestion?.action).toBe('keep-a')
  })

  it('理由按疑似级遮盖后存', async () => {
    const e = env({ llm: scripted(JSON.stringify({ action: 'keep-a', reason: 'A 里写了 password: abc12345x' })).llm })
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
    expect((await e.decisions.get(entry.id))!.suggestion!.reason).toBe('A 里写了 [已隐藏]')
  })

  describe('回查出处', () => {
    /** 宿主读事件服务的替身：按会话 id 给一条用户消息、一条助手回复；不认识的会话按宿主抛 not found。记下问过哪些会话。 */
    function sessionsSaying(said: Record<string, string>) {
      const asked: string[] = []
      const readEvent: ReadEventFn = async ({ sessionId }) => {
        asked.push(sessionId)
        const text = said[sessionId]
        if (text === undefined) throw new Error(`session "${sessionId}" not found`)
        return {
          session: { id: sessionId, cwd: SESSION_WS },
          events: [
            { type: 'user/message', seq: 1, data: { id: `u-${sessionId}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } },
            { type: 'tool/result', seq: 2, data: { message: { role: 'tool', content: [{ type: 'text', text: `工具输出-${sessionId}` }] } } },
            { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: `a-${sessionId}`, role: 'assistant', content: [{ type: 'text', text: '好的，记下了' }], source: { kind: 'model' } } } },
          ],
        }
      }
      return { readEvent, asked }
    }
    const anchored = (id: string, content: string, partial: Partial<MemoryRecord> = {}) => record({
      id, name: id, content, scope: 'workspace', workspacePath: SESSION_WS, source: { sessionId: `sess-${id}`, eventRange: [0, 4], sourceMode: 'user-explicit' }, ...partial,
    })
    /** 体检挂账的样子：条目记下每条所属的作用域。 */
    async function seedAnchored(e: ReturnType<typeof env>, b: Partial<MemoryRecord> = {}) {
      const right = anchored('mem_b', '用 npm', b)
      await e.store.create(anchored('mem_a', '用 pnpm'))
      await e.store.create(right)
      const label = right.scope === 'global' ? 'global' : right.workspacePath!
      return (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', workspaces: [SESSION_WS, label], fingerprint: 'fp-ab' }, 1)).entry
    }

    it('两条都回查到：提示词带两段出处（只有用户和助手的话，遮过疑似密钥），建议记 isSourced 为真，视图里也是', async () => {
      const { llm, prompts } = scripted(KEEP_A)
      const { readEvent } = sessionsSaying({ 'sess-mem_a': '前端仓库用 pnpm，password: abc12345x', 'sess-mem_b': '脚本仓库用 npm' })
      const e = env({ llm, readEvent })
      const entry = await seedAnchored(e)
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      const { user } = prompts[0]!
      expect(user).toContain('## 记忆 A 的出处')
      expect(user).toContain('## 记忆 B 的出处')
      expect(user).toContain('前端仓库用 pnpm，[已隐藏]')
      expect(user).toContain('好的，记下了')
      expect(user).not.toContain('abc12345x')
      expect(user).not.toContain('工具输出')
      expect((await e.decisions.get(entry.id))!.suggestion!.isSourced).toBe(true)
      expect((await horizontalOf(e, entry.id)).suggestion?.isSourced).toBe(true)
    })

    it('全局与项目之间的冲突：两个作用域的出处都读', async () => {
      const { llm, prompts } = scripted(KEEP_A)
      const { readEvent, asked } = sessionsSaying({ 'sess-mem_a': '前端仓库用 pnpm', 'sess-mem_b': '所有项目默认 npm' })
      const e = env({ llm, readEvent })
      const entry = await seedAnchored(e, { scope: 'global', workspacePath: undefined })
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      expect(asked.sort()).toEqual(['sess-mem_a', 'sess-mem_b'])
      expect(prompts[0]!.user).toContain('所有项目默认 npm')
      expect((await e.decisions.get(entry.id))!.suggestion!.isSourced).toBe(true)
    })

    it('只读到一条（另一条的会话不在了）：照常生成，只带那一段，isSourced 为假', async () => {
      const { llm, prompts } = scripted(KEEP_A)
      const { readEvent } = sessionsSaying({ 'sess-mem_a': '前端仓库用 pnpm' })
      const e = env({ llm, readEvent })
      const entry = await seedAnchored(e)
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      expect(prompts[0]!.user).toContain('## 记忆 A 的出处')
      expect(prompts[0]!.user).not.toContain('## 记忆 B 的出处')
      expect(prompts[0]!.system).toContain('记忆 B 没有查到出处')
      expect((await e.decisions.get(entry.id))!.suggestion!.isSourced).toBe(false)
      expect((await horizontalOf(e, entry.id)).suggestion?.isSourced).toBe(false)
    })

    it('宿主没有读事件服务（较老宿主）：照常生成，不带出处、不提回查，不报错', async () => {
      const { llm, prompts } = scripted(KEEP_A)
      const e = env({ llm })
      const entry = await seedAnchored(e)
      ok(await e.run({ cmd: 'suggest', decisionId: entry.id }))
      expect(prompts[0]!.system).not.toContain('出处')
      expect(prompts[0]!.user).not.toContain('出处')
      expect((await e.decisions.get(entry.id))!.suggestion!.isSourced).toBe(false)
    })

    it('拿不到模型、已有当前建议、含高危密钥时不去读会话', async () => {
      const { readEvent, asked } = sessionsSaying({ 'sess-mem_a': 'a', 'sess-mem_b': 'b' })
      const none = env({ llm: null, readEvent })
      expect(err(await none.run({ cmd: 'suggest', decisionId: (await seedAnchored(none)).id })).code).toBe('llm-unavailable')
      await rm(root, { recursive: true, force: true })
      setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
      const secret = env({ llm: scripted(KEEP_A).llm, readEvent })
      expect(err(await secret.run({ cmd: 'suggest', decisionId: (await seedAnchored(secret, { content: `用 npm，${FAKE_SECRET.github}` })).id })).code).toBe('has-secret')
      expect(asked).toEqual([])
      await rm(root, { recursive: true, force: true })
      setRoot(await mkdtemp(join(tmpdir(), 'pm-gui-commands-')))
      const current = env({ llm: scripted(KEEP_A).llm, readEvent })
      const entry = await seedAnchored(current)
      ok(await current.run({ cmd: 'suggest', decisionId: entry.id }))
      asked.length = 0
      ok(await current.run({ cmd: 'suggest', decisionId: entry.id }))
      expect(asked).toEqual([])
    })
  })
})