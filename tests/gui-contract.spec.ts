import { describe, expect, it } from 'vitest'
import {
  checkupResultSchema, CROSS_WORKSPACE_COMMANDS, directoryIssueSchema, encodeMemoryCommand, MEMORY_COMMAND_NAME, memoryCommandResultSchema,
  MAX_BATCH_EDIT, memoryCommandSchema, OPEN_ITEM_COMMANDS, parseMemoryCommand, pendingItemSchema, type MemoryCommand, type RequestedProposal,
} from '../src/gui/contract.ts'
import { SAMPLE_COMMANDS } from '../client/command/test-commands.ts'

describe('契约的枚举字段', () => {
  it('PA-18 目录问题码、体检结果说明码、scan 命令说明码：认识的取值通过，不认识的拒绝', () => {
    const issue = (code: string) => directoryIssueSchema.safeParse({ code, path: '/m/a.md' }).success
    expect([issue('duplicate-id'), issue('dir-gone')]).toEqual([true, false])

    const result = (code: string) => checkupResultSchema.safeParse({
      checkupId: 'c1', by: 'manual', completedAt: 1, added: { keys: [], pending: 0, advice: 0 }, notes: [{ code }],
    }).success
    expect([result('semantic-batched'), result('semantic-timeout')]).toEqual([true, false])

    const scan = (code: string) => memoryCommandResultSchema.safeParse({ ok: true, cmd: 'scan', notes: [code] }).success
    expect([scan('baseline-missing'), scan('baseline-gone')]).toEqual([true, false])
  })
})

describe('契约里界面要用的命令集', () => {
  it('可带跨项目确认的命令：恰好是 schema 收下 allowCrossWorkspace 的那些', () => {
    for (const [cmd, sample] of Object.entries(SAMPLE_COMMANDS)) {
      const parsed = memoryCommandSchema.parse({ ...sample, allowCrossWorkspace: true })
      expect({ cmd, isKept: 'allowCrossWorkspace' in parsed }).toEqual({ cmd, isKept: CROSS_WORKSPACE_COMMANDS.has(cmd as never) })
    }
    expect([...CROSS_WORKSPACE_COMMANDS].sort()).toEqual([
      'apply-edits', 'apply-proposal', 'confirm', 'edit-memory', 'forget', 'hard-delete', 'keep-local', 'keep-local-memory', 'merge-memories', 'move-memory',
      'promote', 'promote-memory', 'resolve', 'restore', 'undo',
    ])
  })

  it('not-found 算别处已处理的命令：都是 schema 里的命令，不含 undo（快照过期也回 not-found）', () => {
    const known = new Set(memoryCommandSchema.options.map(o => o.shape.cmd.value))
    expect([...OPEN_ITEM_COMMANDS].filter(cmd => !known.has(cmd))).toEqual([])
    expect(OPEN_ITEM_COMMANDS.has('undo')).toBe(false)
  })
})

describe('draft-edit 的放宽', () => {
  const ref = { memoryId: 'm1', layer: { kind: 'global' } } as const

  it('不带建议类型时要求必填（只有空白也算没写）；带建议类型时要求可空', () => {
    const accepts = (args: object) => memoryCommandSchema.safeParse({ cmd: 'draft-edit', memories: [ref], ...args }).success
    expect(accepts({ request: '「每周三」改成每周四' })).toBe(true)
    expect(accepts({})).toBe(false)
    expect(accepts({ request: '  \n' })).toBe(false)
    expect(accepts({ adviceType: 'bloat' })).toBe(true)
  })

  it('此前的要求、计划、并入的记忆随命令文本往返', () => {
    const command = {
      cmd: 'draft-edit', memories: [ref], request: '再短一点', priorRequests: ['周三改成周四', '命令保留'],
      planNote: { reason: '和另一条说法矛盾', question: { text: '以哪条为准？', placeholder: '不填就以较新的为准' }, answer: '以周四为准' },
      absorbs: [{ memoryId: 'm2', layer: { kind: 'global' } }],
      previous: { content: '每周四发版', summary: '发版日' },
    } as const satisfies MemoryCommand
    const parsed = parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))
    expect(parsed).toEqual({ ok: true, command })
  })

  it('计划只有理由也收；提问缺占位文字不收', () => {
    const accepts = (planNote: object) => memoryCommandSchema.safeParse({ cmd: 'draft-edit', memories: [ref], request: '改', planNote }).success
    expect(accepts({ reason: '过时了' })).toBe(true)
    expect(accepts({ reason: '过时了', question: { text: '换成什么？' } })).toBe(false)
  })
})

describe('plan-edits（整理所选的计划）', () => {
  const ref = (memoryId: string) => ({ memoryId, layer: { kind: 'global' }, base: { updatedAt: 1, digest: `sha1:${memoryId}` } }) as const
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ref(`m${i + 1}`))

  it(`选中条数 2–${MAX_BATCH_EDIT}：1 条、${MAX_BATCH_EDIT + 1} 条不收`, () => {
    const accepts = (n: number) => memoryCommandSchema.safeParse({ cmd: 'plan-edits', memories: refs(n), request: '合成一条' }).success
    expect([1, 2, MAX_BATCH_EDIT, MAX_BATCH_EDIT + 1].map(accepts)).toEqual([false, true, true, false])
  })

  it('要求必填（只有空白也算没写）；每条都要带卡片版本', () => {
    const accepts = (args: object) => memoryCommandSchema.safeParse({ cmd: 'plan-edits', memories: refs(2), ...args }).success
    expect([accepts({ request: '合成一条' }), accepts({}), accepts({ request: ' \n' })]).toEqual([true, false, false])
    expect(memoryCommandSchema.safeParse({ cmd: 'plan-edits', memories: [ref('m1'), { memoryId: 'm2' }], request: '合' }).success).toBe(false)
  })

  it('不带跨项目确认：只读，不过门', () => {
    expect(CROSS_WORKSPACE_COMMANDS.has('plan-edits' as never)).toBe(false)
  })

  it('命令与结果随文本往返；动作只收改写、删除、不动', () => {
    const command = { cmd: 'plan-edits', memories: refs(3), request: '以 biome 为准' } as const satisfies MemoryCommand
    expect(parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))).toEqual({ ok: true, command })
    const plan = {
      understanding: '以 biome 为准',
      ops: [
        { memoryId: 'm1', action: 'delete', reason: '被取代', into: 'm2' },
        { memoryId: 'm2', action: 'rewrite', reason: '补进命令', question: { text: '配置写哪？', placeholder: '不填就只换名字' } },
        { memoryId: 'm3', action: 'keep', reason: '已是新说法' },
      ],
    }
    const result = { ok: true, cmd: 'plan-edits', plan, model: 'deepseek-v4-flash' }
    expect(memoryCommandResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result)
    expect(memoryCommandResultSchema.safeParse({ ...result, plan: { ...plan, ops: [{ memoryId: 'm1', action: 'merge', reason: '合' }] } }).success).toBe(false)
  })
})

describe('draft-plan（整理所选按计划出稿）', () => {
  const ref = (memoryId: string) => ({ memoryId, layer: { kind: 'global' }, base: { updatedAt: 1, digest: `sha1:${memoryId}` } }) as const
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ref(`m${i + 1}`))
  const op = { memoryId: 'm2', reason: '补进命令' }

  it(`选中条数 2–${MAX_BATCH_EDIT}：1 条、${MAX_BATCH_EDIT + 1} 条不收；改写项 1 项起`, () => {
    const accepts = (n: number, ops: object[] = [op]) => memoryCommandSchema.safeParse({ cmd: 'draft-plan', memories: refs(n), request: '合成一条', ops }).success
    expect([1, 2, MAX_BATCH_EDIT, MAX_BATCH_EDIT + 1].map(n => accepts(n))).toEqual([false, true, true, false])
    expect([accepts(2, []), accepts(2, [op])]).toEqual([false, true])
  })

  it('要求必填；提问缺占位文字不收；不带跨项目确认（只读，不过门）', () => {
    const accepts = (args: object) => memoryCommandSchema.safeParse({ cmd: 'draft-plan', memories: refs(2), ops: [op], ...args }).success
    expect([accepts({ request: '合成一条' }), accepts({}), accepts({ request: ' ' })]).toEqual([true, false, false])
    expect(accepts({ request: '合', ops: [{ ...op, question: { text: '写哪？' } }] })).toBe(false)
    expect(CROSS_WORKSPACE_COMMANDS.has('draft-plan' as never)).toBe(false)
  })

  it('命令与结果随文本往返：改写项带理由、提问、回答、承接的删除项；结果每项一稿', () => {
    const command = {
      cmd: 'draft-plan', memories: refs(3), request: '以 biome 为准',
      ops: [{ memoryId: 'm2', reason: '补进命令', question: { text: '配置写哪？', placeholder: '不填就只换名字' }, answer: '选第二种', absorbs: ['m1'] }],
    } as const satisfies MemoryCommand
    expect(parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))).toEqual({ ok: true, command })
    const result = { ok: true, cmd: 'draft-plan', drafts: [{ memoryId: 'm2', draft: { content: '用 biome', summary: '格式化', name: '格式化' } }], model: 'deepseek-v4-flash' }
    expect(memoryCommandResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result)
  })
})

describe('apply-edits（整理所选应用全部）', () => {
  const ref = (memoryId: string) => ({ memoryId, layer: { kind: 'global' }, base: { updatedAt: 1, digest: `sha1:${memoryId}` } }) as const
  const edit = (memoryId: string) => ({ kind: 'edit' as const, ...ref(memoryId), content: '新正文', name: '新名称', summary: '新摘要', tags: ['标签'] })
  const forget = (memoryId: string, into?: string) => ({ kind: 'forget', ...ref(memoryId), ...(into !== undefined ? { into } : {}) }) as const
  const ops = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? edit(`m${i + 1}`) : forget(`m${i + 1}`)))

  it(`改动 1–${MAX_BATCH_EDIT} 项：0 项、${MAX_BATCH_EDIT + 1} 项不收`, () => {
    const accepts = (n: number) => memoryCommandSchema.safeParse({ cmd: 'apply-edits', ops: ops(n) }).success
    expect([0, 1, MAX_BATCH_EDIT, MAX_BATCH_EDIT + 1].map(accepts)).toEqual([false, true, true, false])
  })

  it('改写项四个面都要带、正文和名称不能空；每项都要带卡片版本', () => {
    const accepts = (op: object) => memoryCommandSchema.safeParse({ cmd: 'apply-edits', ops: [op] }).success
    expect(accepts(edit('m1'))).toBe(true)
    expect(accepts({ ...edit('m1'), content: '' })).toBe(false)
    expect(accepts({ ...edit('m1'), name: '' })).toBe(false)
    const { tags: _tags, ...noTags } = edit('m1')
    expect(accepts(noTags)).toBe(false)
    const { base: _base, ...noBase } = forget('m1')
    expect(accepts(noBase)).toBe(false)
  })

  it('带跨项目确认：写入，过门', () => {
    expect(CROSS_WORKSPACE_COMMANDS.has('apply-edits')).toBe(true)
  })

  it('命令与结果随文本往返：改写、删除（带承接）、不动的核对项、force；结果带条目、记忆、快照，部分生效另带 isPartial', () => {
    const command = {
      cmd: 'apply-edits', ops: [forget('m1', 'm3'), edit('m2')], keep: [ref('m3')], force: true, allowCrossWorkspace: true,
    } as const satisfies MemoryCommand
    expect(parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))).toEqual({ ok: true, command })
    const result = { ok: true, cmd: 'apply-edits', decisionId: 'pd_1', memoryIds: ['m1', 'm2'], snapshotId: 'snap_1' }
    expect(memoryCommandResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result)
    expect(memoryCommandResultSchema.parse({ ...result, isPartial: true })).toEqual({ ...result, isPartial: true })
    const partial = { ok: true, cmd: 'apply-edits', memoryIds: ['m2'], snapshotId: 'snap_1', isPartial: true, unrecordedIds: ['m1'] }
    expect(memoryCommandResultSchema.parse(JSON.parse(JSON.stringify(partial)))).toEqual(partial)
  })

  it('失败结果可带 memoryIds（stale、not-found 列出对不上或找不到的），随文本往返；不带也合法', () => {
    const failure = { ok: false, cmd: 'apply-edits', code: 'stale', detail: '有记忆刚被改过', memoryIds: ['m1', 'm3'] }
    expect(memoryCommandResultSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure)
    const { memoryIds: _ids, ...bare } = failure
    expect(memoryCommandResultSchema.parse(bare)).toEqual(bare)
  })
})

describe('suggest（补上建议）与待处理冲突项的处理建议', () => {
  it('suggest 只带条目 id', () => {
    const command: MemoryCommand = { cmd: 'suggest', decisionId: 'pd_1' }
    expect(parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))).toEqual({ ok: true, command })
    expect(memoryCommandSchema.safeParse({ cmd: 'suggest' }).success).toBe(false)
  })

  const horizontal = {
    kind: 'conflict-horizontal', level: 'your-call', decisionId: 'pd_1', firstSeenAt: 1, summary: 's', left: null, right: null,
  }
  it('横向冲突项可带处理建议（四种结论、三种操作）或没有建议的原因码；不认识的结论、原因码拒绝', () => {
    const item = (extra: object) => pendingItemSchema.safeParse({ ...horizontal, ...extra }).success
    const suggestion = (action: string) => ({
      id: 'sg_1', action, reason: 'r', isSourced: false,
      ops: [{ kind: 'edit', memoryId: 'a', content: 'c', name: 'n', summary: 's', tags: [] }, { kind: 'forget', memoryId: 'b' }, { kind: 'keep', memoryId: 'c' }],
    })
    expect(['merge', 'keep-a', 'keep-b', 'keep-both', 'rewrite'].map(a => item({ suggestion: suggestion(a) }))).toEqual([true, true, true, true, false])
    expect(['has-secret', 'not-generated', 'failed', 'quota'].map(code => item({ noSuggestion: { code } }))).toEqual([true, true, true, false])
    expect(item({ noSuggestion: { code: 'failed', cause: { kind: 'model-error', hostCode: 'AUTH' } } })).toBe(true)
    expect(item({ noSuggestion: { code: 'failed', cause: { kind: 'secret-in-draft' } } })).toBe(true)
    expect(item({})).toBe(true)
  })

  it('模型判断不了：原因码 undecided 带理由；unsure 不是处理方案的结论，判断不了也不当作生成失败的原因', () => {
    const item = (extra: object) => pendingItemSchema.safeParse({ ...horizontal, ...extra }).success
    expect(item({ noSuggestion: { code: 'undecided', reason: '需要你确认用哪个' } })).toBe(true)
    expect(item({ suggestion: { id: 'sg_1', action: 'unsure', reason: 'r', isSourced: false, ops: [] } })).toBe(false)
    expect(item({ noSuggestion: { code: 'failed', cause: { kind: 'undecided' } } })).toBe(false)
  })

  it('自动体检名额用完：单独的原因码 quota-exhausted，不当作生成失败的原因；「正在生成」标记和没有建议的原因并存', () => {
    const item = (extra: object) => pendingItemSchema.safeParse({ ...horizontal, ...extra }).success
    expect(item({ noSuggestion: { code: 'quota-exhausted' } })).toBe(true)
    expect(item({ noSuggestion: { code: 'failed', cause: { kind: 'quota-exhausted' } } })).toBe(false)
    expect(item({ noSuggestion: { code: 'not-generated' }, isGeneratingSuggestion: true })).toBe(true)
    expect(item({ isGeneratingSuggestion: false })).toBe(false)
  })
})

describe('apply-proposal（采纳建议）', () => {
  it('只带条目 id 和建议 id（不回传建议内容），可带跨项目确认；not-found 算别处已处理', () => {
    const command: MemoryCommand = { cmd: 'apply-proposal', decisionId: 'pd_1', suggestionId: 'sg_1' }
    expect(parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))).toEqual({ ok: true, command })
    expect(memoryCommandSchema.safeParse({ cmd: 'apply-proposal', decisionId: 'pd_1' }).success).toBe(false)
    expect(memoryCommandSchema.parse({ cmd: 'apply-proposal', decisionId: 'pd_1', suggestionId: 'sg_1', action: 'keep-a' })).toEqual(command)
    expect(CROSS_WORKSPACE_COMMANDS.has('apply-proposal')).toBe(true)
    expect(OPEN_ITEM_COMMANDS.has('apply-proposal')).toBe(true)
  })
})

describe('补充要求：draft-proposal 与按要求应用', () => {
  const base = { updatedAt: 1, digest: 'd' }
  const basis = { conflictFingerprint: 'cf', memories: [{ memoryId: 'a', fingerprint: 'fa', scopeKey: 'global' }, { memoryId: 'b', fingerprint: 'fb', scopeKey: 'global' }] }
  const proposal: RequestedProposal = {
    action: 'merge', reason: '各有场景', basis,
    ops: [{ kind: 'edit', memoryId: 'a', content: 'c', name: 'n', summary: 's', tags: [] }, { kind: 'forget', memoryId: 'b' }],
  }

  it('draft-proposal 带条目 id、要求（只有空白算没写）、两条的卡片版本，可带此前的要求和上一份方案（不带依据）；只读，不过跨项目门；not-found 算别处已处理', () => {
    const command: MemoryCommand = {
      cmd: 'draft-proposal', decisionId: 'pd_1', request: '两者融合', bases: [base, base], priorRequests: ['以 A 为准'],
      previous: { action: proposal.action, reason: proposal.reason, ops: proposal.ops },
    }
    expect(parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))).toEqual({ ok: true, command })
    const accepts = (args: object) => memoryCommandSchema.safeParse({ cmd: 'draft-proposal', decisionId: 'pd_1', bases: [base, base], ...args }).success
    expect([accepts({ request: '融合' }), accepts({ request: '  ' }), accepts({}), accepts({ request: '融合', bases: [base] })]).toEqual([true, false, false, false])
    expect(CROSS_WORKSPACE_COMMANDS.has('draft-proposal' as never)).toBe(false)
    expect(OPEN_ITEM_COMMANDS.has('draft-proposal')).toBe(true)
  })

  it('apply-proposal 依据二选一：建议 id，或按要求生成的方案（操作、依据版本）；按要求的可带 force', () => {
    const command: MemoryCommand = { cmd: 'apply-proposal', decisionId: 'pd_1', proposal, force: true }
    expect(parseMemoryCommand(encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME} `.length))).toEqual({ ok: true, command })
    const accepts = (args: object) => memoryCommandSchema.safeParse({ cmd: 'apply-proposal', decisionId: 'pd_1', ...args }).success
    expect([accepts({ suggestionId: 'sg_1', proposal }), accepts({}), accepts({ proposal: { ...proposal, basis: undefined } })]).toEqual([false, false, false])
  })

  it('结果：按要求生成的方案带依据版本；做不到只有一句说明', () => {
    const result = (extra: object) => memoryCommandResultSchema.safeParse({ ok: true, cmd: 'draft-proposal', ...extra }).success
    expect([result({ proposal }), result({ infeasible: { reason: '两条里都没有端口号' } }), result({ infeasible: {} })]).toEqual([true, true, false])
  })
})
