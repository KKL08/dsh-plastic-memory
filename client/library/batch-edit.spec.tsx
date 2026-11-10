// 整理工作区：步骤条与选中时的快照。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import type { EditPlan, MemoryCommand, MemoryCommandResult, MemoryDraft } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import type { BorrowedSession } from '../gateway.ts'
import { memory, renderInShell } from '../test-utils.tsx'
import { applicationOf, BatchEdit, batchEditCss, BatchSteps, toBatchItems, toggleWithDependents, type BatchItem, type PlanChoice } from './batch-edit.tsx'

describe('整理工作区', () => {
  it('故事 18：步骤条「写要求 / 看计划 / 对照应用」，当前步标 aria-current、加粗，已完成的步前加「✓」', () => {
    renderInShell(<BatchSteps current="apply" />)
    const items = within(screen.getByRole('list', { name: '步骤' })).getAllByRole('listitem')
    expect(items.map(li => li.textContent)).toEqual(['✓写要求', '✓看计划', '对照应用'])
    expect(items.map(li => li.getAttribute('aria-current'))).toEqual([null, null, 'step'])
    expect(items[2]).toHaveClass('pm-batch-step--current')
    expect(items.map(li => li.classList.contains('pm-batch-step--done'))).toEqual([true, true, false])
  })

  it('快照带上每条的作用域和版本（命令里核对用的 base），之后卡片对象换了也不变', () => {
    const card = memory({ id: 'a1', digest: 'sha1:a1', updatedAt: 111 })
    const global = memory({ id: 'g1', scope: 'global', workspacePath: undefined, digest: 'sha1:g1', updatedAt: 222 })
    expect(toBatchItems([card, global])).toEqual([
      { memory: card, ref: { memoryId: 'a1', layer: { kind: 'workspace', workspacePath: '/w/app' }, base: { updatedAt: 111, digest: 'sha1:a1' } } },
      { memory: global, ref: { memoryId: 'g1', layer: { kind: 'global' }, base: { updatedAt: 222, digest: 'sha1:g1' } } },
    ])
  })
})

describe('整理所选：写要求与看计划', () => {
  const session: BorrowedSession = { kind: 'ready', sessionId: 's1', cwd: '/w/app' }
  const app = { kind: 'workspace', workspacePath: '/w/app' } as const
  const card = (id: string, name: string, content: string, type = 'knowledge') =>
    memory({ id, name, content, type, digest: `sha1:${id}`, updatedAt: 100 + Number(id.replace(/\D/g, '')) })
  const p1 = card('p1', '格式化用 prettier', '代码格式化统一用 prettier，配置在 .prettierrc。')
  const c2 = card('c2', '提交前检查', '提交前依次跑 pnpm lint && prettier --write .', 'workflow')
  const e3 = card('e3', '编辑器设置', '编辑器保存时自动格式化：VS Code 装 prettier 扩展。', 'workflow')
  const b4 = card('b4', '格式化改用 biome', '11 月起格式化改用 biome，不再用 prettier。', 'decision')
  const ITEMS = toBatchItems([p1, c2, e3, b4])
  const REQUEST = '这几条在格式化工具上说法矛盾，以 biome 为准，旧说法都改掉。'
  const PLAN: EditPlan = {
    understanding: '以 biome 为准：删掉还写着 prettier 的旧规则，提交流程和编辑器设置里的 prettier 换成 biome。',
    ops: [
      { memoryId: 'p1', action: 'delete', reason: '已被「格式化改用 biome」取代。', into: 'b4' },
      { memoryId: 'c2', action: 'rewrite', reason: 'prettier --write 换成 biome format --write。' },
      { memoryId: 'e3', action: 'rewrite', reason: 'prettier 扩展换成 Biome 扩展。', question: { text: '要不要把 Biome 设成默认格式化工具？', placeholder: '不填就只换扩展名' } },
      { memoryId: 'b4', action: 'keep', reason: '已是现在的说法。' },
    ],
  }
  const planned = (plan: EditPlan = PLAN): MemoryCommandResult => ({ ok: true, cmd: 'plan-edits', plan, model: 'deepseek-v4-flash' })
  const critical = `${'sk-' + 'TESTONLY'.padEnd(24, 'a')}`

  function setup({ items = ITEMS, respond = () => planned(), model = 'deepseek-v4-flash' }: {
    items?: BatchItem[]
    respond?: (command: MemoryCommand) => MemoryCommandResult | Promise<MemoryCommandResult>
    model?: string | null
  } = {}) {
    const onBack = vi.fn()
    const onApply = vi.fn()
    const gateway = createFakeGateway({ respond, model })
    renderInShell(<BatchEdit items={items} session={session} onBack={onBack} onApply={onApply} />, gateway)
    return { gateway, onBack, onApply, commands: () => gateway.executed.map(e => e.command) }
  }
  const ask = () => screen.getByRole('textbox', { name: '想怎么整理这几条？' })
  const write = (text: string) => { fireEvent.change(ask(), { target: { value: text } }) }
  const generateButton = () => screen.getByRole('button', { name: '生成整理计划' })
  const generate = async () => { await act(async () => { fireEvent.click(generateButton()) }) }
  const picked = () => within(screen.getByRole('region', { name: '已选的记忆' }))
  const current = () => screen.getByRole('list', { name: '步骤' }).querySelector('[aria-current="step"]')?.textContent
  const ops = () => within(screen.getByRole('list', { name: '整理计划' })).getAllByRole('listitem')
  const opOf = (name: string) => ops().find(li => within(li).queryByRole('checkbox', { name: new RegExp(`「${name}」$`) }) !== null)!
  const box = (name: string) => within(opOf(name)).getByRole('checkbox')
  const toPlan = async (respond?: (command: MemoryCommand) => MemoryCommandResult | Promise<MemoryCommandResult>) => {
    const env = setup(respond !== undefined ? { respond } : {})
    write(REQUEST)
    await generate()
    return env
  }
  const foot = () => screen.getByText(/计划不写入任何东西$/)
  const confirmButton = () => screen.getByRole('button', { name: /^(按计划出稿|下一步)$/ })

  it('故事 19：已选清单每条是类型标签 + 单行原文 + 「✕」（读屏名「不整理「名称」」），底部一行「N 条」', () => {
    setup()
    const rows = picked().getAllByRole('listitem')
    expect(rows.map(li => li.querySelector('.pm-batch-picked-text')?.textContent)).toEqual([p1.content, c2.content, e3.content, b4.content])
    expect(within(rows[0]!).getByText('事实与经验')).toHaveClass('pm-chip--neutral')
    const remove = within(rows[1]!).getByRole('button', { name: '不整理「提交前检查」' })
    expect(remove).toHaveAttribute('title', '不整理这条')
    // 叉是自画的线性图标，不用文字字符
    expect(remove).toHaveTextContent(/^$/)
    expect(remove.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(picked().getByText('4 条')).toBeInTheDocument()
  })

  it('故事 19：「✕」把这条移出清单，标题、条数跟着变；少于 2 条时「生成整理计划」置灰；发出的命令只带留下的', async () => {
    const { commands } = setup()
    write(REQUEST)
    fireEvent.click(picked().getByRole('button', { name: '不整理「编辑器设置」' }))
    expect(screen.getByRole('heading', { name: '整理所选的 3 条' })).toBeInTheDocument()
    expect(picked().getByText('3 条')).toBeInTheDocument()
    expect(picked().getAllByRole('listitem')).toHaveLength(3)
    // 焦点落到下一条的「✕」，不掉到页面上
    expect(picked().getByRole('button', { name: '不整理「格式化改用 biome」' })).toHaveFocus()
    await generate()
    expect(commands()).toEqual([{ cmd: 'plan-edits', memories: [ITEMS[0]!.ref, ITEMS[1]!.ref, ITEMS[3]!.ref], request: REQUEST }])
  })

  it('故事 19：去到 1 条时「生成整理计划」置灰', () => {
    setup({ items: ITEMS.slice(0, 2) })
    write(REQUEST)
    expect(generateButton()).not.toHaveAttribute('aria-disabled')
    fireEvent.click(picked().getByRole('button', { name: '不整理「格式化用 prettier」' }))
    expect(generateButton()).toHaveAttribute('aria-disabled', 'true')
    expect(generateButton()).toHaveAttribute('title', '至少选 2 条才能整理')
  })

  it('故事 19：四个多条快捷意图，点了把模板填进要求框、按钮按下、选中第一个「___」', () => {
    setup()
    const group = screen.getByRole('group', { name: '常用写法（可选）' })
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['解决矛盾', '合并重复', '删过时内容', '统一说法'])
    fireEvent.click(within(group).getByRole('button', { name: '删过时内容' }))
    const el = ask() as HTMLTextAreaElement
    expect(el).toHaveValue('和 ___ 有关的已经过时了，删掉；___ 还有效，保留。')
    expect(el).toHaveFocus()
    expect([el.selectionStart, el.selectionEnd]).toEqual([2, 5])
    expect(within(group).getByRole('button', { name: '删过时内容' })).toHaveAttribute('aria-pressed', 'true')
    expect(el).toHaveAttribute('placeholder', '也可以直接输入你的要求，例如：这几条在格式化工具上说法矛盾，以 biome 为准，旧说法都改掉。')
  })

  it('故事 20：说明文字；要求只有空白时「生成整理计划」置灰并提示，有内容（留着「___」也算）就能发；「取消」回多选', async () => {
    const { onBack, commands } = setup()
    expect(screen.getByText('模型先给出整理计划，待你确认后逐条优化记忆。整理过程中会产生 token 消耗。')).toBeInTheDocument()
    expect(current()).toBe('写要求')
    write('  \n')
    expect(generateButton()).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('先写要求，或从常用写法开个头')).toBeInTheDocument()
    write('把 ___ 统一叫作 ___。')
    expect(screen.getByText('用当前模型 deepseek-v4-flash 生成，先给你看结果再决定')).toBeInTheDocument()
    await generate()
    expect(commands()).toEqual([{ cmd: 'plan-edits', memories: ITEMS.map(i => i.ref), request: '把 ___ 统一叫作 ___。' }])
    expect(commands()[0]).toMatchObject({ memories: [{ memoryId: 'p1', layer: app, base: { updatedAt: 101, digest: 'sha1:p1' } }, {}, {}, {}] })
    fireEvent.click(screen.getByRole('button', { name: '改要求' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('故事 29：生成中显示「正在生成整理计划……」和「停止」；停止回到写要求，要求和清单都在，之后晚到的计划丢掉', async () => {
    let resolve!: (r: MemoryCommandResult) => void
    setup({ respond: () => new Promise((r) => { resolve = r }) })
    write(REQUEST)
    fireEvent.click(picked().getByRole('button', { name: '不整理「编辑器设置」' }))
    await generate()
    expect(screen.getByRole('status')).toHaveTextContent('正在生成整理计划……')
    expect(current()).toBe('看计划')
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(ask()).toHaveValue(REQUEST)
    expect(picked().getAllByRole('listitem')).toHaveLength(3)
    expect(current()).toBe('写要求')
    await act(async () => { resolve(planned()) })
    expect(screen.queryByRole('list', { name: '整理计划' })).toBeNull()
    expect(ask()).toHaveValue(REQUEST)
  })

  it('故事 21：「模型的理解」一块复述要求；每条一项，按选中的顺序，项头动作标签 + 原文，下一行理由；因取代而删的写「内容并入：{名称}」', async () => {
    await toPlan()
    expect(current()).toBe('看计划')
    const understanding = screen.getByRole('region', { name: '模型的理解' })
    expect(understanding).toHaveTextContent(PLAN.understanding)
    expect(understanding).toHaveClass('pm-plan-understanding')
    expect(ops().map(li => li.querySelector('.pm-plan-action')?.textContent)).toEqual(['删除', '改写', '改写', '不动'])
    expect(ops().map(li => li.querySelector('.pm-plan-op-text')?.textContent)).toEqual([p1.content, c2.content, e3.content, b4.content])
    expect(opOf('格式化用 prettier').querySelector('.pm-plan-reason')).toHaveTextContent('已被「格式化改用 biome」取代。 内容并入：格式化改用 biome')
    expect(opOf('提交前检查').querySelector('.pm-plan-reason')).toHaveTextContent(/^prettier --write 换成 biome format --write。$/)
  })

  it('故事 21：删除、改写项勾选框默认勾上；不动项勾选框置灰；读屏名是「动作「名称」」', async () => {
    await toPlan()
    expect(box('格式化用 prettier')).toHaveAccessibleName('删除「格式化用 prettier」')
    expect([box('格式化用 prettier'), box('提交前检查'), box('编辑器设置')].every(b => (b as HTMLInputElement).checked && !(b as HTMLInputElement).disabled)).toBe(true)
    expect(box('格式化改用 biome')).toBeDisabled()
    expect(box('格式化改用 biome')).not.toBeChecked()
  })

  it('故事 22：提问只出现在改写项下：琥珀圆点 + 「等你决定：」+ 问题，下面一个输入框，占位文字是默认处理；回答留着', async () => {
    await toPlan()
    const asks = document.querySelectorAll('.pm-plan-ask')
    expect(asks).toHaveLength(1)
    const ask_ = opOf('编辑器设置').querySelector<HTMLElement>('.pm-plan-ask')!
    expect(ask_.querySelector('[data-pm-marker="pending"]')).not.toBeNull()
    expect(ask_).toHaveTextContent('等你决定：要不要把 Biome 设成默认格式化工具？')
    const answer = within(ask_).getByRole('textbox', { name: '要不要把 Biome 设成默认格式化工具？' })
    expect(answer).toHaveAttribute('placeholder', '不填就只换扩展名')
    fireEvent.change(answer, { target: { value: '设成默认' } })
    expect(answer).toHaveValue('设成默认')
  })

  it('故事 21a：取消承接的改写，并进它的删除项一起取消并提示；重新勾上改写，删除项不自动勾回，提示收起', async () => {
    const plan: EditPlan = {
      understanding: '合成一条',
      ops: [
        { memoryId: 'p1', action: 'delete', reason: '和「提交前检查」重复。', into: 'c2' },
        { memoryId: 'c2', action: 'rewrite', reason: '补进 .prettierrc 的位置。' },
        { memoryId: 'e3', action: 'delete', reason: '已被「格式化改用 biome」取代。', into: 'b4' },
        { memoryId: 'b4', action: 'keep', reason: '已是现在的说法。' },
      ],
    }
    await toPlan(() => planned(plan))
    fireEvent.click(box('提交前检查'))
    expect(box('格式化用 prettier')).not.toBeChecked()
    expect(opOf('格式化用 prettier')).toHaveTextContent('承接它的改写已取消，这条先不删')
    // 承接的改写没勾上时，删除项勾不回来：单独删掉它，独有的信息就没有去处
    expect(box('格式化用 prettier')).toBeDisabled()
    fireEvent.click(box('格式化用 prettier'))
    expect(box('格式化用 prettier')).not.toBeChecked()
    // 承接项是不动的删除项不受影响
    expect(box('编辑器设置')).toBeChecked()
    expect(opOf('编辑器设置')).not.toHaveTextContent('承接它的改写已取消')
    fireEvent.click(box('提交前检查'))
    expect(box('提交前检查')).toBeChecked()
    expect(box('格式化用 prettier')).not.toBeChecked()
    expect(box('格式化用 prettier')).toBeEnabled()
    expect(opOf('格式化用 prettier')).not.toHaveTextContent('承接它的改写已取消')
    fireEvent.click(box('格式化用 prettier'))
    expect(box('格式化用 prettier')).toBeChecked()
  })

  it('故事 23：底部「N 项改动 · M 条不动 · 计划不写入任何东西」随勾选变；全部取消时「按计划出稿」置灰', async () => {
    await toPlan()
    expect(foot()).toHaveTextContent('3 项改动 · 1 条不动 · 计划不写入任何东西')
    expect(confirmButton()).toHaveTextContent('按计划出稿')
    expect(confirmButton()).toHaveClass('pm-btn--primary')
    fireEvent.click(box('提交前检查'))
    expect(foot()).toHaveTextContent('2 项改动 · 2 条不动')
    fireEvent.click(box('编辑器设置'))
    fireEvent.click(box('格式化用 prettier'))
    expect(foot()).toHaveTextContent('0 项改动 · 4 条不动')
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('故事 23：「改要求」回到写要求，要求保留', async () => {
    await toPlan()
    fireEvent.click(screen.getByRole('button', { name: '改要求' }))
    expect(current()).toBe('写要求')
    expect(ask()).toHaveValue(REQUEST)
    expect(picked().getAllByRole('listitem')).toHaveLength(4)
  })

  it('故事 23：勾选的改动全是删除时按钮换成「下一步」，点了不调用模型，直接进对照应用', async () => {
    const { commands } = await toPlan()
    fireEvent.click(box('提交前检查'))
    fireEvent.click(box('编辑器设置'))
    expect(confirmButton()).toHaveTextContent('下一步')
    await act(async () => { fireEvent.click(confirmButton()) })
    expect(current()).toBe('对照应用')
    expect(commands().map(c => c.cmd)).toEqual(['plan-edits'])
  })


  it('要求含高危密钥：不发，写要求上方报原因', async () => {
    const { commands } = setup()
    write(`以 biome 为准 ${critical}`)
    await generate()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
    expect(current()).toBe('写要求')
  })

  it.each([
    ['llm-invalid-output', '模型返回的内容格式不对，再试一次。'],
    ['llm-failed', '模型出错了：rate limited'],
    ['stale', '有记忆刚被改过或删掉了，已换成最新内容。计划需要重新生成。'],
  ] as const)('计划没生成（%s）：回到写要求，要求保留，报原因', async (code, text) => {
    setup({ respond: () => ({ ok: false, cmd: 'plan-edits', code, detail: 'rate limited' }) })
    write(REQUEST)
    await generate()
    expect(current()).toBe('写要求')
    expect(ask()).toHaveValue(REQUEST)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('样式只用令牌：「模型的理解」是平台底色，琥珀只出现在提问的圆点上', () => {
    expect(batchEditCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(batchEditCss).toMatch(/\.pm-plan-understanding \{[^}]*background: var\(--pm-bg-block\);/)
    expect(batchEditCss).not.toMatch(/--pm-accent|--pm-warn/)
    expect(batchEditCss).toMatch(/\.pm-plan-action \{[^}]*background: var\(--pm-bg-block\);/)
  })

  describe('按计划出稿与逐项对照', () => {
    const QUESTION = { text: '编辑器里换哪个扩展：1. Biome 官方扩展 2. 社区版？', placeholder: '不填就用官方扩展' }
    /** p1 删除并入 c2，c2、e3 改写（e3 带提问），b4 不动。 */
    const MERGE: EditPlan = {
      understanding: '以 biome 为准，重复的合进提交前检查。',
      ops: [
        { memoryId: 'p1', action: 'delete', reason: '和「提交前检查」重复。', into: 'c2' },
        { memoryId: 'c2', action: 'rewrite', reason: '补进 biome.json 的位置。' },
        { memoryId: 'e3', action: 'rewrite', reason: 'prettier 扩展换成 Biome 扩展。', question: QUESTION },
        { memoryId: 'b4', action: 'keep', reason: '已是现在的说法。' },
      ],
    }
    const DRAFTS: Record<string, MemoryDraft> = {
      c2: { content: '提交前依次跑 pnpm lint && biome format --write .（配置在 biome.json）', summary: '提交前先 lint 再用 biome 格式化' },
      e3: { content: '编辑器保存时自动格式化：VS Code 装 Biome 社区版扩展。', summary: '编辑器用 Biome 扩展格式化', name: '编辑器格式化' },
    }
    const drafted = (ids: readonly string[]): MemoryCommandResult => ({ ok: true, cmd: 'draft-plan', drafts: ids.map(memoryId => ({ memoryId, draft: DRAFTS[memoryId]! })), model: 'deepseek-v4-flash' })
    function respondWith({ plan = MERGE, draftPlan, draftEdit }: {
      plan?: EditPlan
      draftPlan?: (command: Extract<MemoryCommand, { cmd: 'draft-plan' }>) => MemoryCommandResult | Promise<MemoryCommandResult>
      draftEdit?: (command: Extract<MemoryCommand, { cmd: 'draft-edit' }>) => MemoryCommandResult | Promise<MemoryCommandResult>
    } = {}) {
      return (command: MemoryCommand): MemoryCommandResult | Promise<MemoryCommandResult> => {
        if (command.cmd === 'draft-plan') return draftPlan?.(command) ?? drafted(command.ops.map(op => op.memoryId))
        if (command.cmd === 'draft-edit') return draftEdit?.(command) ?? { ok: true, cmd: 'draft-edit', draft: { content: '再改过的', summary: '再改过' } }
        return planned(plan)
      }
    }
    const draftButton = () => screen.getByRole('button', { name: '按计划出稿' })
    const answerBox = () => within(opOf('编辑器设置')).getByRole('textbox')
    const toApply = async (options: Parameters<typeof respondWith>[0] = {}, beforeDraft?: () => void) => {
      const env = await toPlan(respondWith(options))
      beforeDraft?.()
      await act(async () => { fireEvent.click(confirmButton()) })
      return env
    }
    const items = () => within(screen.getByRole('list', { name: '逐项对照' })).getAllByRole('listitem')
    const itemOf = (name: string) => within(screen.getByRole('list', { name: '逐项对照' })).getByRole('listitem', { name: new RegExp(`「${name}」$`) })
    const applyFoot = () => screen.getByText(/^将应用/)
    const applyAll = () => screen.getByRole('button', { name: '应用全部' })
    /** 有删除项：点「应用全部」后在确认条里点「确认应用」。 */
    const applyWithConfirm = () => {
      fireEvent.click(applyAll())
      fireEvent.click(within(screen.getByRole('group', { name: /确认应用？$/ })).getByRole('button', { name: '确认应用' }))
    }
    const critical = `${'sk-' + 'TESTONLY'.padEnd(24, 'a')}`

    it('故事 24：「按计划出稿」发 draft-plan：选中的全部记忆、要求、勾选的改写项按计划顺序带理由、提问、回答，并进它的删除项作承接；出稿中显示进度和「停止」', async () => {
      let resolve!: (r: MemoryCommandResult) => void
      const { commands } = await toApply({ draftPlan: () => new Promise((r) => { resolve = r }) }, () => {
        fireEvent.change(answerBox(), { target: { value: '选第二种' } })
      })
      expect(commands()[1]).toEqual({
        cmd: 'draft-plan', memories: ITEMS.map(i => i.ref), request: REQUEST,
        ops: [
          { memoryId: 'c2', reason: '补进 biome.json 的位置。', absorbs: ['p1'] },
          { memoryId: 'e3', reason: 'prettier 扩展换成 Biome 扩展。', question: QUESTION, answer: '选第二种' },
        ],
      })
      expect(current()).toBe('对照应用')
      expect(screen.getByRole('status')).toHaveTextContent('正在按计划出稿……')
      expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
      await act(async () => { resolve(drafted(['c2', 'e3'])) })
      // 按计划顺序逐项，只列勾选的改动项，不动的不列
      expect(items().map(li => li.getAttribute('aria-label'))).toEqual(['删除「格式化用 prettier」', '改写「提交前检查」', '改写「编辑器设置」'])
    })

    it('故事 24：取消勾选的删除项不作承接；没填的回答不带（按默认处理）；取消的改写项不进出稿', async () => {
      const { commands } = await toApply({}, () => {
        fireEvent.click(box('格式化用 prettier'))
        fireEvent.change(answerBox(), { target: { value: '  ' } })
      })
      expect((commands()[1] as Extract<MemoryCommand, { cmd: 'draft-plan' }>).ops).toEqual([
        { memoryId: 'c2', reason: '补进 biome.json 的位置。' },
        { memoryId: 'e3', reason: 'prettier 扩展换成 Biome 扩展。', question: QUESTION },
      ])
      const second = await toApply({}, () => { fireEvent.click(box('提交前检查')) })
      expect((second.commands()[1] as Extract<MemoryCommand, { cmd: 'draft-plan' }>).ops.map(op => op.memoryId)).toEqual(['e3'])
    })

    it('故事 29：出稿中「停止」回到看计划，勾选和回答都在；之后晚到的稿丢掉', async () => {
      let resolve!: (r: MemoryCommandResult) => void
      await toApply({ draftPlan: () => new Promise((r) => { resolve = r }) }, () => {
        fireEvent.click(box('格式化用 prettier'))
        fireEvent.change(answerBox(), { target: { value: '选第二种' } })
      })
      fireEvent.click(screen.getByRole('button', { name: '停止' }))
      expect(current()).toBe('看计划')
      expect(box('格式化用 prettier')).not.toBeChecked()
      expect(box('提交前检查')).toBeChecked()
      expect(answerBox()).toHaveValue('选第二种')
      await act(async () => { resolve(drafted(['c2', 'e3'])) })
      expect(current()).toBe('看计划')
      expect(screen.queryByRole('list', { name: '逐项对照' })).toBeNull()
    })

    it('出稿失败：回到看计划报原因，勾选和回答都在', async () => {
      await toApply({ draftPlan: () => ({ ok: false, cmd: 'draft-plan', code: 'llm-invalid-output' }) }, () => {
        fireEvent.change(answerBox(), { target: { value: '选第二种' } })
      })
      expect(current()).toBe('看计划')
      expect(screen.getByRole('alert')).toHaveTextContent('模型返回的内容格式不对，再试一次。')
      expect(answerBox()).toHaveValue('选第二种')
      expect(draftButton()).toBeInTheDocument()
    })

    it('故事 30：回答里有高危密钥：不发，看计划里报原因', async () => {
      const { commands } = await toApply({}, () => {
        fireEvent.change(answerBox(), { target: { value: `用这个 token ${critical}` } })
      })
      expect(commands().map(c => c.cmd)).toEqual(['plan-edits'])
      expect(current()).toBe('看计划')
      expect(screen.getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
    })

    it('故事 24：改写项给原文 / 改后对照和字数，项头「放弃这项」「再改改」；删除项给划掉的原文和最近删除的说明，项头只有「放弃这项」', async () => {
      await toApply()
      const rewrite = itemOf('提交前检查')
      expect(within(rewrite).getByRole('region', { name: '原文' })).toHaveTextContent(c2.content)
      expect(within(rewrite).getByRole('region', { name: '改后' })).toHaveTextContent(DRAFTS.c2!.content)
      expect(rewrite.querySelector('ins')).not.toBeNull()
      expect(rewrite).toHaveTextContent(`${c2.content.length} 字 → ${DRAFTS.c2!.content.length} 字`)
      expect(within(rewrite).getAllByRole('button').map(b => b.textContent)).toEqual(['放弃这项', '再改改'])
      const removal = itemOf('格式化用 prettier')
      expect(removal.querySelector('del')).toHaveTextContent(p1.content)
      expect([...removal.querySelectorAll('.pm-batch-item-note')].map(p => p.textContent)).toEqual(['内容并入：提交前检查', '应用后进最近删除，14 天内可恢复。'])
      expect(within(removal).getAllByRole('button').map(b => b.textContent)).toEqual(['放弃这项'])
      // 名称变了才列出来
      expect(within(itemOf('编辑器设置')).getByRole('region', { name: '改后' })).toHaveTextContent('名称编辑器格式化')
      expect(applyFoot()).toHaveTextContent('将应用 3 项：删除 1 条、改写 2 条')
    })

    it('故事 24、21a：放弃的项变淡、按钮换成「恢复这项」；放弃改写项时并进它的删除项一起放弃并提示；恢复改写不自动恢复删除', async () => {
      await toApply()
      fireEvent.click(within(itemOf('提交前检查')).getByRole('button', { name: '放弃这项' }))
      expect(itemOf('提交前检查')).toHaveClass('pm-batch-item--dropped')
      expect(within(itemOf('提交前检查')).getAllByRole('button').map(b => b.textContent)).toEqual(['恢复这项'])
      expect(itemOf('格式化用 prettier')).toHaveClass('pm-batch-item--dropped')
      expect(itemOf('格式化用 prettier')).toHaveTextContent('承接它的改写已放弃，这条先不删')
      expect(applyFoot()).toHaveTextContent('将应用 1 项：删除 0 条、改写 1 条')
      // 承接的改写放弃着，删除项恢复不了
      const locked = within(itemOf('格式化用 prettier')).getByRole('button', { name: '恢复这项' })
      expect(locked).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(locked)
      expect(itemOf('格式化用 prettier')).toHaveClass('pm-batch-item--dropped')
      fireEvent.click(within(itemOf('提交前检查')).getByRole('button', { name: '恢复这项' }))
      expect(itemOf('提交前检查')).not.toHaveClass('pm-batch-item--dropped')
      expect(itemOf('格式化用 prettier')).toHaveClass('pm-batch-item--dropped')
      expect(itemOf('格式化用 prettier')).not.toHaveTextContent('承接它的改写已放弃')
      fireEvent.click(within(itemOf('格式化用 prettier')).getByRole('button', { name: '恢复这项' }))
      expect(applyFoot()).toHaveTextContent('将应用 3 项：删除 1 条、改写 2 条')
      // 放弃删除项不牵动别的
      fireEvent.click(within(itemOf('格式化用 prettier')).getByRole('button', { name: '放弃这项' }))
      expect(itemOf('提交前检查')).not.toHaveClass('pm-batch-item--dropped')
    })

    it('故事 24：「再改改」单项走 draft-edit：本轮要求、整体要求作此前的要求、这一项的计划（理由、提问、回答）、上一稿；再来一轮带上上一轮的要求', async () => {
      const replies = [
        { content: '保存时自动格式化：装 Biome 社区版扩展。', summary: '编辑器用 Biome', name: '编辑器格式化' },
        { content: 'Save formats with the Biome community extension.', summary: 'Editor uses Biome' },
      ]
      const { commands } = await toApply({ draftEdit: () => ({ ok: true, cmd: 'draft-edit', draft: replies[commands().filter(x => x.cmd === 'draft-edit').length - 1]! }) }, () => {
        fireEvent.change(answerBox(), { target: { value: '选第二种' } })
      })
      const item = () => itemOf('编辑器设置')
      fireEvent.click(within(item()).getByRole('button', { name: '再改改' }))
      const again = within(item()).getByRole('textbox', { name: '这一项还想怎么改？' })
      expect(again).toHaveValue('')
      expect(within(item()).getByRole('button', { name: '生成修改' })).toHaveAttribute('aria-disabled', 'true')
      fireEvent.change(again, { target: { value: '再短一点' } })
      await act(async () => { fireEvent.click(within(item()).getByRole('button', { name: '生成修改' })) })
      expect(commands()[2]).toEqual({
        cmd: 'draft-edit', memories: [{ memoryId: 'e3', layer: app }], request: '再短一点', priorRequests: [REQUEST],
        planNote: { reason: 'prettier 扩展换成 Biome 扩展。', question: QUESTION, answer: '选第二种' },
        previous: { ...DRAFTS.e3!, tags: e3.tags },
      })
      expect(within(item()).getByRole('region', { name: '改后' })).toHaveTextContent(replies[0]!.content)
      expect(within(item()).queryByRole('textbox')).toBeNull()
      fireEvent.click(within(item()).getByRole('button', { name: '再改改' }))
      fireEvent.change(within(item()).getByRole('textbox'), { target: { value: '用英文' } })
      await act(async () => { fireEvent.click(within(item()).getByRole('button', { name: '生成修改' })) })
      // 模型没改名称、标签时沿用上一稿的
      expect(commands()[3]).toMatchObject({ request: '用英文', priorRequests: [REQUEST, '再短一点'], previous: { ...replies[0]!, tags: e3.tags } })
      expect(within(item()).getByRole('region', { name: '改后' })).toHaveTextContent(replies[1]!.content)
      expect(within(item()).getByRole('region', { name: '改后' })).toHaveTextContent('名称编辑器格式化')
    })

    it('故事 24：承接了删除项的改写「再改改」时带上并进它、仍要删的记忆（absorbs）；那条删除项放弃了就不带', async () => {
      const { commands } = await toApply()
      const item = () => itemOf('提交前检查')
      const again = async (text: string) => {
        fireEvent.click(within(item()).getByRole('button', { name: '再改改' }))
        fireEvent.change(within(item()).getByRole('textbox', { name: '这一项还想怎么改？' }), { target: { value: text } })
        await act(async () => { fireEvent.click(within(item()).getByRole('button', { name: '生成修改' })) })
      }
      await again('再短一点')
      expect(commands().at(-1)).toMatchObject({ cmd: 'draft-edit', memories: [{ memoryId: 'c2', layer: app }], absorbs: [{ memoryId: 'p1', layer: app }] })
      fireEvent.click(within(itemOf('格式化用 prettier')).getByRole('button', { name: '放弃这项' }))
      await again('用英文')
      expect(commands().at(-1)).toMatchObject({ cmd: 'draft-edit', request: '用英文' })
      expect(commands().at(-1)).not.toHaveProperty('absorbs')
    })

    it('故事 29：「再改改」生成中只锁这一项，「停止」回到写要求、输入保留，晚到的稿丢掉；「取消」收起', async () => {
      let resolve!: (r: MemoryCommandResult) => void
      await toApply({ draftEdit: () => new Promise((r) => { resolve = r }) })
      const item = () => itemOf('提交前检查')
      fireEvent.click(within(item()).getByRole('button', { name: '再改改' }))
      fireEvent.change(within(item()).getByRole('textbox'), { target: { value: '再短一点' } })
      await act(async () => { fireEvent.click(within(item()).getByRole('button', { name: '生成修改' })) })
      expect(within(item()).getByRole('status')).toHaveTextContent('正在生成修改……')
      expect(applyAll()).toHaveAttribute('aria-disabled', 'true')
      expect(within(itemOf('编辑器设置')).getByRole('button', { name: '再改改' })).toBeInTheDocument()
      fireEvent.click(within(item()).getByRole('button', { name: '停止' }))
      expect(within(item()).getByRole('textbox')).toHaveValue('再短一点')
      await act(async () => { resolve({ ok: true, cmd: 'draft-edit', draft: { content: '晚到的', summary: '晚到' } }) })
      expect(within(item()).getByRole('region', { name: '改后' })).toHaveTextContent(DRAFTS.c2!.content)
      fireEvent.click(within(item()).getByRole('button', { name: '取消' }))
      expect(within(item()).queryByRole('textbox')).toBeNull()
      expect(applyAll()).not.toHaveAttribute('aria-disabled')
    })

    it('故事 28：「再改改」时这一项已被别处删了（not-found）：回到写要求、要求保留，顶部提示，清单等视图换成最新内容', async () => {
      await toApply({ draftEdit: () => ({ ok: false, cmd: 'draft-edit', code: 'not-found', detail: '不存在', memoryIds: ['c2'] }) })
      const item = () => itemOf('提交前检查')
      fireEvent.click(within(item()).getByRole('button', { name: '再改改' }))
      fireEvent.change(within(item()).getByRole('textbox'), { target: { value: '再短一点' } })
      await act(async () => { fireEvent.click(within(item()).getByRole('button', { name: '生成修改' })) })
      expect(current()).toBe('写要求')
      expect(ask()).toHaveValue(REQUEST)
      expect(screen.getByText('有 1 条刚被改过，已换成最新内容。计划需要重新生成。')).toBeInTheDocument()
      expect(picked().getByRole('status')).toHaveTextContent('正在换成最新内容……')
      expect(generateButton()).toHaveAttribute('aria-disabled', 'true')
    })

    it('故事 30：「再改改」的要求里有高危密钥：不发，这一项里报原因', async () => {
      const { commands } = await toApply()
      const item = () => itemOf('提交前检查')
      fireEvent.click(within(item()).getByRole('button', { name: '再改改' }))
      fireEvent.change(within(item()).getByRole('textbox'), { target: { value: `token ${critical}` } })
      await act(async () => { fireEvent.click(within(item()).getByRole('button', { name: '生成修改' })) })
      expect(commands().map(c => c.cmd)).toEqual(['plan-edits', 'draft-plan'])
      expect(within(item()).getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
    })

    it('故事 23：勾选的全是删除：不出稿，对照里只有删除项', async () => {
      const { commands } = await toPlan(respondWith({ plan: PLAN }))
      fireEvent.click(box('提交前检查'))
      fireEvent.click(box('编辑器设置'))
      await act(async () => { fireEvent.click(confirmButton()) })
      expect(commands().map(c => c.cmd)).toEqual(['plan-edits'])
      expect(items().map(li => li.getAttribute('aria-label'))).toEqual(['删除「格式化用 prettier」'])
      expect(applyFoot()).toHaveTextContent('将应用 1 项：删除 1 条、改写 0 条')
    })

    it('故事 25：「应用全部」交出最终改动：改写项带四个面、删除项带承接，承接到不改写的记忆进 keep；放弃的项不在里面', async () => {
      const { onApply } = await toApply({ plan: PLAN })
      fireEvent.click(within(itemOf('提交前检查')).getByRole('button', { name: '放弃这项' }))
      applyWithConfirm()
      expect(onApply).toHaveBeenCalledWith({
        ops: [
          { kind: 'forget', ...ITEMS[0]!.ref, into: 'b4' },
          { kind: 'edit', ...ITEMS[2]!.ref, content: DRAFTS.e3!.content, summary: DRAFTS.e3!.summary, name: '编辑器格式化', tags: e3.tags },
        ],
        keep: [ITEMS[3]!.ref],
        total: 4,
      }, ITEMS, expect.any(Function))
    })

    it('故事 25：承接到本批改写的删除不另列 keep；承接的改写不在这批里时，依赖它的删除也不交出去，放弃的改写不当作不动', async () => {
      const { onApply } = await toApply()
      applyWithConfirm()
      expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ keep: [] }), ITEMS, expect.any(Function))
      const choice: PlanChoice = { request: '以 biome 为准', plan: { understanding: '合成一条', ops: [
        { memoryId: 'p1', action: 'delete', reason: '重复。', into: 'c2' },
        { memoryId: 'c2', action: 'rewrite', reason: '补进。' },
        { memoryId: 'e3', action: 'rewrite', reason: '换扩展。' },
      ] }, checked: ['p1', 'c2', 'e3'], answers: {} }
      const drafts = { c2: { content: 'c', summary: 's', name: 'n', tags: [] }, e3: { content: 'e', summary: 's', name: 'n', tags: [] } }
      expect(applicationOf(choice, ITEMS, drafts, new Set(['c2']))).toEqual({
        ops: [{ kind: 'edit', ...ITEMS[2]!.ref, ...drafts.e3 }],
        keep: [],
        total: 4,
      })
    })

    it('故事 25：有删除项时「应用全部」先原位换成确认条，写明删哪几条；取消什么都不交、按钮回来', async () => {
      const { onApply } = await toApply()
      fireEvent.click(applyAll())
      const bar = screen.getByRole('group', { name: '其中 1 项会删除「格式化用 prettier」，确认应用？' })
      expect(screen.queryByRole('button', { name: '应用全部' })).toBeNull()
      expect(within(bar).getAllByRole('button').map(b => b.textContent)).toEqual(['确认应用', '取消'])
      fireEvent.click(within(bar).getByRole('button', { name: '取消' }))
      expect(onApply).not.toHaveBeenCalled()
      expect(applyAll()).toBeInTheDocument()
    })

    it('故事 25：没有删除项直接应用，不出确认条', async () => {
      const { onApply } = await toApply()
      fireEvent.click(within(itemOf('格式化用 prettier')).getByRole('button', { name: '放弃这项' }))
      fireEvent.click(applyAll())
      expect(screen.queryByRole('group', { name: /确认应用？$/ })).toBeNull()
      expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ ops: [expect.objectContaining({ kind: 'edit', memoryId: 'c2' }), expect.objectContaining({ kind: 'edit', memoryId: 'e3' })] }), ITEMS, expect.any(Function))
    })

    it('故事 25：全部放弃时「应用全部」置灰；「全部放弃」回多选', async () => {
      const { onBack } = await toApply()
      for (const name of ['提交前检查', '编辑器设置']) fireEvent.click(within(itemOf(name)).getByRole('button', { name: '放弃这项' }))
      expect(applyFoot()).toHaveTextContent('将应用 0 项')
      expect(applyAll()).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(screen.getByRole('button', { name: '全部放弃' }))
      expect(onBack).toHaveBeenCalledTimes(1)
    })
  })
})

describe('取消改写带走依赖它的删除', () => {
  const OPS: EditPlan['ops'] = [
    { memoryId: 'r', action: 'rewrite', reason: '' },
    { memoryId: 'd1', action: 'delete', reason: '', into: 'r' },
    { memoryId: 'd2', action: 'delete', reason: '', into: 'r' },
  ]

  it('取消改写：还选着的删除项一起取消并记进 held，本来没选的不记', () => {
    const next = toggleWithDependents(OPS[0]!, OPS, new Set(['r', 'd1']), new Set())
    expect([...next.active]).toEqual([])
    expect([...next.held]).toEqual(['d1'])
  })

  it('重新选上改写：删除项不带回，只移出 held', () => {
    const next = toggleWithDependents(OPS[0]!, OPS, new Set(), new Set(['d1']))
    expect([...next.active]).toEqual(['r'])
    expect([...next.held]).toEqual([])
  })
})
