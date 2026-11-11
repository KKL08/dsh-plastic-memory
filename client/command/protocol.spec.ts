import { describe, expect, it } from 'vitest'
import { CROSS_WORKSPACE_COMMANDS, GUI_ERROR_CODES, OPEN_ITEM_COMMANDS, type GuiErrorCode, type MemoryCommand, type MemoryCommandResult, type RequestedProposal } from '../../src/gui/contract.ts'
import type { LocaleKey } from '../locales.ts'
import { interpret, refuseBeforeSend, type Outcome } from './protocol.ts'
import { SAMPLE_COMMANDS } from './test-commands.ts'

const COMMANDS = Object.values(SAMPLE_COMMANDS) as MemoryCommand[]
/** 按要求生成的融合方案（draft-proposal 回的形状）。 */
const EDIT_OP = { kind: 'edit', memoryId: 'm1', content: '正文', name: '名称', summary: '摘要', tags: ['标签'] } as const satisfies RequestedProposal['ops'][number]
const PROPOSAL: RequestedProposal = {
  action: 'merge', reason: '照你说的', basis: { memories: [{ memoryId: 'm1', fingerprint: 'f1' }, { memoryId: 'm2', fingerprint: 'f2' }] },
  ops: [{ ...EDIT_OP, tags: [...EDIT_OP.tags] }, { kind: 'forget', memoryId: 'm2' }],
}

const refusal = (command: MemoryCommand, code: GuiErrorCode, extra: Partial<Extract<MemoryCommandResult, { ok: false }>> = {}): MemoryCommandResult =>
  ({ ok: false, cmd: command.cmd, code, detail: `原话：${code}`, rejected: [{ id: 'm1', workspacePath: '/w/blog' }], ...extra })

const raw = (code: GuiErrorCode): Outcome => ({ kind: 'failed', code, detail: `原话：${code}`, isLocalized: false })
const local = (code: GuiErrorCode, detail: LocaleKey): Outcome => ({ kind: 'failed', code, detail, isLocalized: true })
const is = (command: MemoryCommand, ...cmds: Array<MemoryCommand['cmd']>) => cmds.includes(command.cmd)
/** 整理所选的三条命令：stale、not-found 按整理口径。 */
const isTidy = (command: MemoryCommand) => is(command, 'plan-edits', 'draft-plan', 'apply-edits')

/** 每个结果码在每个命令上应得的 Outcome。 */
const EXPECTED: Record<GuiErrorCode, (command: MemoryCommand) => Outcome> = {
  'cross-workspace': c => CROSS_WORKSPACE_COMMANDS.has(c.cmd as never)
    ? { kind: 'confirm-cross', workspacePath: '/w/blog', isMove: c.cmd === 'move-memory', resend: { ...c, allowCrossWorkspace: true } as MemoryCommand }
    : raw('cross-workspace'),
  'has-secret': c => c.cmd === 'forget' ? { kind: 'confirm-secret', resend: { ...c, cmd: 'hard-delete' } } : raw('has-secret'),
  'secret-suspected': c => c.cmd === 'edit-memory' || c.cmd === 'merge-memories' || c.cmd === 'apply-edits' ? { kind: 'confirm-suspected', resend: { ...c, force: true } } : raw('secret-suspected'),
  'claimed': () => ({ kind: 'handled-elsewhere' }),
  'not-found': c => OPEN_ITEM_COMMANDS.has(c.cmd) ? { kind: 'handled-elsewhere' } : isTidy(c) ? local('not-found', 'library.batch.stale')
    : 'memoryId' in c || 'memories' in c ? local('not-found', 'pending.memory.gone') : raw('not-found'),
  'stale': c => local('stale', isTidy(c) ? 'library.batch.stale' : is(c, 'undo', 'restore') ? 'pending.undo.stale' : is(c, 'ignore-advice') ? 'pending.ignore.stale' : 'pending.edit.stale'),
  'secret-critical': () => local('secret-critical', 'pending.edit.secretCritical'),
  'no-baseline': () => local('no-baseline', 'pending.vertical.needProject'),
  'target-taken': c => local('target-taken', is(c, 'undo') ? 'pending.move.undoTaken' : is(c, 'promote', 'promote-memory') ? 'pending.promote.taken' : 'pending.move.taken'),
  'llm-unavailable': () => local('llm-unavailable', 'pending.model.unavailable'),
  'llm-invalid-output': () => local('llm-invalid-output', 'pending.model.invalid'),
  'llm-failed': () => raw('llm-failed'),
  'invalid-args': () => raw('invalid-args'),
  'subagent-readonly': () => raw('subagent-readonly'),
  'governance-disabled': () => raw('governance-disabled'),
  'busy': () => raw('busy'),
  'failed': () => raw('failed'),
}

describe('命令往返协议：命令 × 结果码', () => {
  it('PA-42 每个结果码都在表里', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...GUI_ERROR_CODES].sort())
  })

  it.each([...GUI_ERROR_CODES])('PA-42 %s：每个命令映射到确定的 Outcome', (code) => {
    for (const command of COMMANDS) {
      expect({ cmd: command.cmd, outcome: interpret(command, refusal(command, code)) }).toEqual({ cmd: command.cmd, outcome: EXPECTED[code](command) })
    }
  })

  it('PA-42 成功：每个命令都是 ok，带回结果', () => {
    for (const command of COMMANDS) {
      const result: MemoryCommandResult = { ok: true, cmd: command.cmd, decisionId: 'd9' }
      expect(interpret(command, result)).toEqual({ kind: 'ok', result })
    }
  })

  it('PA-42 跨项目：已经带过 allowCrossWorkspace、或没写被拒的项目时不再确认，显示原话', () => {
    const forget = SAMPLE_COMMANDS.forget
    expect(interpret({ ...forget, allowCrossWorkspace: true }, refusal(forget, 'cross-workspace'))).toEqual(raw('cross-workspace'))
    expect(interpret(forget, refusal(forget, 'cross-workspace', { rejected: [] }))).toEqual(raw('cross-workspace'))
  })

  it('PA-42 确认后重发的命令：彻底删除沿用 forget 带过的作用域与跨项目许可；疑似密钥沿用跨项目许可', () => {
    const forget = { ...SAMPLE_COMMANDS.forget, allowCrossWorkspace: true }
    expect(interpret(forget, refusal(forget, 'has-secret'))).toEqual({ kind: 'confirm-secret', resend: { ...forget, cmd: 'hard-delete' } })
    const edit = { ...SAMPLE_COMMANDS['edit-memory'], allowCrossWorkspace: true }
    expect(interpret(edit, refusal(edit, 'secret-suspected'))).toEqual({ kind: 'confirm-suspected', resend: { ...edit, force: true } })
  })

  it('按要求应用的融合稿像密钥：确认后带 force 重发（采纳建议不确认，照常显示原话）', () => {
    const apply: MemoryCommand = { cmd: 'apply-proposal', decisionId: 'd1', proposal: PROPOSAL }
    expect(interpret(apply, refusal(apply, 'secret-suspected'))).toEqual({ kind: 'confirm-suspected', resend: { ...apply, force: true } })
  })

  it('stale、not-found 带回服务端列出的 memoryIds（整理所选据此等视图换成最新内容）', () => {
    const apply = SAMPLE_COMMANDS['apply-edits']
    expect(interpret(apply, refusal(apply, 'stale', { memoryIds: ['m1'] }))).toEqual({ ...local('stale', 'library.batch.stale'), memoryIds: ['m1'] })
    const plan = SAMPLE_COMMANDS['plan-edits']
    expect(interpret(plan, refusal(plan, 'not-found', { memoryIds: ['m2'] }))).toEqual({ ...local('not-found', 'library.batch.stale'), memoryIds: ['m2'] })
  })

  it('PA-42 服务端没给原话：失败写结果码', () => {
    const forget = SAMPLE_COMMANDS.forget
    expect(interpret(forget, { ok: false, cmd: 'forget', code: 'failed' })).toEqual({ kind: 'failed', code: 'failed', detail: 'failed', isLocalized: false })
  })
})

describe('发出之前拦下', () => {
  // 厂商形状的假密钥运行时拼接，源码里不出现完整字面量
  const key = 'sk-' + 'TESTONLY'.padEnd(24, 'a')

  it('直接改、直接合并的四个面任一处含高危密钥：不发，给本地文案', () => {
    const edit = SAMPLE_COMMANDS['edit-memory']
    const merge = SAMPLE_COMMANDS['merge-memories']
    for (const command of [{ ...edit, content: key }, { ...edit, name: key }, { ...edit, summary: key }, { ...edit, tags: [key] }, { ...merge, content: key }]) {
      expect(refuseBeforeSend(command)).toEqual(local('secret-critical', 'pending.edit.secretCritical'))
    }
  })

  it('整理所选任一改写项的四个面含高危密钥：不发，给本地文案；删除项不看', () => {
    const apply = SAMPLE_COMMANDS['apply-edits']
    const [forget, edit] = apply.ops as [Extract<typeof apply.ops[number], { kind: 'forget' }>, Extract<typeof apply.ops[number], { kind: 'edit' }>]
    for (const changed of [{ content: key }, { name: key }, { summary: key }, { tags: ['x', key] }]) {
      expect(refuseBeforeSend({ ...apply, ops: [forget, { ...edit, ...changed }] })).toEqual(local('secret-critical', 'pending.edit.secretCritical'))
    }
    expect(refuseBeforeSend({ ...apply, ops: [forget, { ...edit, content: 'api_key: abc12345' }] })).toBeUndefined()
  })

  it('让模型改的要求、此前的要求、上一稿四个面、计划的文字任一处含高危密钥：不发，给让模型改的本地文案', () => {
    const draft = { ...SAMPLE_COMMANDS['draft-edit'], request: '再短一点' }
    const previous = { content: '正文', summary: '摘要', name: '名称', tags: ['标签'] }
    const question = { text: '换成什么？', placeholder: '不填就保留' }
    for (const command of [
      { ...draft, request: key },
      { ...draft, priorRequests: ['先改短', key] },
      { ...draft, previous: { ...previous, content: key } },
      { ...draft, previous: { ...previous, name: key } },
      { ...draft, previous: { ...previous, summary: key } },
      { ...draft, previous: { ...previous, tags: [key] } },
      { ...draft, planNote: { reason: key } },
      { ...draft, planNote: { reason: '过时了', question: { ...question, text: key } } },
      { ...draft, planNote: { reason: '过时了', question: { ...question, placeholder: key } } },
      { ...draft, planNote: { reason: '过时了', question, answer: key } },
    ]) {
      expect(refuseBeforeSend(command)).toEqual(local('secret-critical', 'pending.model.secretCritical'))
    }
    expect(refuseBeforeSend({ ...draft, priorRequests: ['先改短'], previous, planNote: { reason: '过时了', question, answer: '保留' } })).toBeUndefined()
  })

  it('整理计划的要求含高危密钥：不发，给让模型改的本地文案；疑似的照常发', () => {
    const plan = SAMPLE_COMMANDS['plan-edits']
    expect(refuseBeforeSend({ ...plan, request: `以 biome 为准 ${key}` })).toEqual(local('secret-critical', 'pending.model.secretCritical'))
    expect(refuseBeforeSend({ ...plan, request: '以 biome 为准，api_key: abc12345' })).toBeUndefined()
  })

  it('故事 30：按计划出稿的要求、理由、提问、默认处理、回答任一处含高危密钥：不发，给让模型改的本地文案', () => {
    const draft = SAMPLE_COMMANDS['draft-plan']
    const op = draft.ops[0]!
    const question = op.question!
    for (const command of [
      { ...draft, request: key },
      { ...draft, ops: [{ ...op, reason: key }] },
      { ...draft, ops: [{ ...op, question: { ...question, text: key } }] },
      { ...draft, ops: [{ ...op, question: { ...question, placeholder: key } }] },
      { ...draft, ops: [{ memoryId: 'm1', reason: '换命令' }, { ...op, answer: key }] },
    ]) {
      expect(refuseBeforeSend(command)).toEqual(local('secret-critical', 'pending.model.secretCritical'))
    }
    expect(refuseBeforeSend({ ...draft, ops: [{ ...op, answer: 'api_key: abc12345' }] })).toBeUndefined()
  })

  it('补充要求的要求、此前的要求、上一份方案（说明和稿的四个面）任一处含高危密钥：不发，给让模型改的本地文案；疑似的照常发', () => {
    const draft = SAMPLE_COMMANDS['draft-proposal']
    const previous = { action: PROPOSAL.action, reason: PROPOSAL.reason, ops: [...PROPOSAL.ops] }
    const editOf = (changed: { content?: string; name?: string; summary?: string; tags?: string[] }) => ({ ...previous, ops: [{ ...EDIT_OP, tags: [...EDIT_OP.tags], ...changed }, PROPOSAL.ops[1]!] })
    for (const command of [
      { ...draft, request: key },
      { ...draft, priorRequests: ['以 A 为准', key] },
      { ...draft, previous: { ...previous, reason: key } },
      { ...draft, previous: editOf({ content: key }) },
      { ...draft, previous: editOf({ name: key }) },
      { ...draft, previous: editOf({ summary: key }) },
      { ...draft, previous: editOf({ tags: [key] }) },
    ]) {
      expect(refuseBeforeSend(command)).toEqual(local('secret-critical', 'pending.model.secretCritical'))
    }
    expect(refuseBeforeSend({ ...draft, request: '并进 api_key: abc12345', priorRequests: ['以 A 为准'], previous })).toBeUndefined()
  })

  it('按要求应用的融合稿四个面含高危密钥：不发，给直接改的本地文案；疑似的照常发，等服务端确认', () => {
    const apply = (changed: { content?: string; name?: string; summary?: string; tags?: string[] }): MemoryCommand => ({ cmd: 'apply-proposal', decisionId: 'd1', proposal: { ...PROPOSAL, ops: [{ ...EDIT_OP, tags: [...EDIT_OP.tags], ...changed }, PROPOSAL.ops[1]!] } })
    for (const changed of [{ content: key }, { name: key }, { summary: key }, { tags: [key] }]) {
      expect(refuseBeforeSend(apply(changed))).toEqual(local('secret-critical', 'pending.edit.secretCritical'))
    }
    expect(refuseBeforeSend(apply({ content: 'api_key: abc12345' }))).toBeUndefined()
  })

  it('其余命令、以及只是像密钥的内容：照常发', () => {
    for (const command of COMMANDS) expect(refuseBeforeSend(command)).toBeUndefined()
    expect(refuseBeforeSend({ ...SAMPLE_COMMANDS['edit-memory'], content: 'password: abc12345' })).toBeUndefined()
  })
})
