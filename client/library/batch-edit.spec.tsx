// 整理工作区：步骤条与选中时的快照。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import type { EditPlan, MemoryCommand, MemoryCommandResult } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import type { BorrowedSession } from '../gateway.ts'
import { memory, renderInShell } from '../test-utils.tsx'
import { BatchEdit, batchEditCss, BatchSteps, toBatchItems, type BatchItem } from './batch-edit.tsx'

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
    const gateway = createFakeGateway({ respond, model })
    renderInShell(<BatchEdit items={items} session={session} onBack={onBack} />, gateway)
    return { gateway, onBack, commands: () => gateway.executed.map(e => e.command) }
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
    expect(remove).toHaveTextContent('✕')
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
    // 承接项是不动的删除项不受影响
    expect(box('编辑器设置')).toBeChecked()
    expect(opOf('编辑器设置')).not.toHaveTextContent('承接它的改写已取消')
    fireEvent.click(box('提交前检查'))
    expect(box('提交前检查')).toBeChecked()
    expect(box('格式化用 prettier')).not.toBeChecked()
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

  it('故事 23：「按计划出稿」进对照应用（出稿是下一张票）；计划只读，这一步不发写命令', async () => {
    const { commands } = await toPlan()
    fireEvent.change(within(opOf('编辑器设置')).getByRole('textbox'), { target: { value: '设成默认' } })
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
    ['stale', '这条记忆刚被改过'],
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
})
