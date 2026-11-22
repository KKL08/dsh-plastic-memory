import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type PendingItem } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { ALL_SCOPE, createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { SESSION, config, secret, view, scannedHealth, setup } from './test-pending.tsx'


describe('待处理：手动改与手动合并', () => {
  const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
  const long = `发版流程：${'先跑测试再打包，'.repeat(30)}`
  const target = memory({ id: 'b1', name: '发版流程', type: 'project', content: long, summary: '发版的步骤', tags: ['发版', 'npm'], digest: 'sha1:b1', updatedAt: 111, filePath: '/m/app/b1.md' })
  const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [target] }
  const stale: PendingItem = { kind: 'advice', level: 'advice', type: 'stale', memories: [memory({ id: 's9', name: '很久的', digest: 'sha1:s9' })] }
  const base = { updatedAt: 111, digest: 'sha1:b1' }
  const edited = { ok: true as const, cmd: 'edit-memory', decisionId: 'pd_e', memoryIds: ['b1'], snapshotId: 'snap_e', filePath: '/m/app/release.md' }
  const respondEdit = (command: MemoryCommand): MemoryCommandResult => (command.cmd === 'edit-memory' ? edited : { ok: true, cmd: command.cmd })
  /** 点「修改」，切到「手动改」。 */
  const startEdit = () => {
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    fireEvent.click(screen.getByRole('tab', { name: '手动改' }))
  }
  const save = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) }) }

  it('点「修改」切到手动改：正文变成预填的编辑框，原来的按钮行收起；保存发 edit-memory（带层和卡片版本），名称、摘要、标签照原样', async () => {
    const { commands } = setup([bloat], { respond: respondEdit })
    startEdit()
    const box = screen.getByRole('textbox', { name: '正文' })
    expect(box).toHaveValue(long)
    expect(screen.queryByRole('button', { name: '打开文件' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull()
    expect(screen.getByRole('button', { name: '取消' })).toHaveClass('pm-btn--ghost')
    expect(screen.getByRole('button', { name: '保存' })).toHaveClass('pm-btn--primary')
    const next = '1. 跑测试\n2. 发版'
    fireEvent.change(box, { target: { value: next } })
    expect(screen.getByText(`${long.length} 字 → ${next.length} 字`)).toBeInTheDocument()
    await save()
    expect(commands()).toEqual([{ cmd: 'edit-memory', memoryId: 'b1', layer, base, content: next, name: '发版流程', summary: '发版的步骤', tags: ['发版', 'npm'] }])
  })

  it('「更多」展开名称、摘要、标签，底部说明写明保存后可撤销、类型改不了；标签点 × 移除、回车添加（空的和重复的不加）；保存带上改过的三项', async () => {
    const { commands } = setup([bloat], { respond: respondEdit })
    startEdit()
    const more = screen.getByRole('button', { name: '更多' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    // 箭头、叉用图标，不用文字字符
    expect(more.textContent).toBe('更多')
    expect(more.querySelector('svg')).not.toBeNull()
    fireEvent.click(more)
    const removeNpm = screen.getByRole('button', { name: '移除标签 npm' })
    expect(removeNpm.textContent).toBe('')
    expect(removeNpm.querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('直接改正文，保存后可以撤销。类型改不了：换类型要先删再记。')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '发版步骤' } })
    fireEvent.change(screen.getByRole('textbox', { name: '摘要' }), { target: { value: '发版前后的固定步骤' } })
    fireEvent.click(screen.getByRole('button', { name: '移除标签 npm' }))
    const tagInput = screen.getByRole('textbox', { name: '标签' })
    for (const value of ['release', '发版', '  ']) {
      fireEvent.change(tagInput, { target: { value } })
      fireEvent.keyDown(tagInput, { key: 'Enter' })
    }
    expect(screen.getByRole('button', { name: '移除标签 release' })).toBeInTheDocument()
    await save()
    expect(commands()).toEqual([{ cmd: 'edit-memory', memoryId: 'b1', layer, base, content: long, name: '发版步骤', summary: '发版前后的固定步骤', tags: ['发版', 'release'] }])
  })

  it('正文改了、摘要没动：提示摘要还是旧的，不挡保存；点「去改摘要」展开更多并聚焦摘要，改了摘要提示消失', () => {
    setup([bloat])
    startEdit()
    expect(screen.queryByText('正文改了，摘要还是旧的')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '短了' } })
    expect(screen.getByText('正文改了，摘要还是旧的')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('button', { name: '去改摘要' }))
    const summary = screen.getByRole('textbox', { name: '摘要' })
    expect(summary).toHaveFocus()
    fireEvent.change(summary, { target: { value: '新的摘要' } })
    expect(screen.queryByText('正文改了，摘要还是旧的')).toBeNull()
  })

  it('正文或名称清空：保存不可用；「取消」收起编辑框、回到原来的卡片，不发命令', () => {
    const { commands } = setup([bloat])
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox', { name: '正文' })).toBeNull()
    expect(screen.getByRole('button', { name: '修改' })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('保存后卡片收成一行「已修改 · 名称 · 字数变化」；打开文件打开写完后的文件，撤销发 undo，撤销后回到原卡片', async () => {
    const { commands, gateway } = setup([bloat], { respond: respondEdit })
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '跑测试再发' } })
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '发版步骤' } })
    await save()
    expect(screen.getByText('已修改')).toBeInTheDocument()
    expect(screen.getByText(`发版步骤 · ${long.length} 字 → 5 字`)).toBeInTheDocument()
    // 「撤销」和别处一样是标准尺寸的幽灵按钮
    expect(screen.getByRole('button', { name: '撤销' })).toHaveClass('pm-btn--ghost')
    expect(screen.getByRole('button', { name: '撤销' })).not.toHaveClass('pm-btn--sm')
    expect(screen.getByRole('button', { name: '打开文件' })).toHaveClass('pm-btn--secondary')
    expect(screen.queryByRole('textbox', { name: '正文' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开文件' })) })
    expect(gateway.opened).toEqual([{ path: '/m/app/release.md' }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'pd_e' })
    expect(await screen.findByRole('button', { name: '修改' })).toBeInTheDocument()
  })

  it('撤销时这条之后又被改过（stale）：写明没有撤销，不用手动改的提示', async () => {
    setup([bloat], { respond: command => (command.cmd === 'undo' ? { ok: false, cmd: command.cmd, code: 'stale', detail: '又改过' } : respondEdit(command)) })
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '跑测试再发' } })
    await save()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(await screen.findByRole('alert')).toHaveTextContent('这条记忆之后又被改过，撤销会冲掉之后的改动，没有撤销。')
  })

  it('含密钥的记忆不给「修改」「合并」', () => {
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [memory({ id: 'x1', digest: 'sha1:x1', hasSecret: true }), memory({ id: 'x2', digest: 'sha1:x2' })] }
    setup([{ ...bloat, memories: [{ ...target, hasSecret: true }] }, pair])
    // 两张卡确实渲染出来了（各有「打开文件」），否定断言才有意义
    const cards = ['内容过长', '内容重复'].map(title => screen.getByRole('heading', { level: 3, name: title }).closest('article')!)
    for (const card of cards) expect(within(card).getAllByRole('button', { name: '打开文件' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '修改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '合并' })).toBeNull()
  })

  it('新内容有高危密钥：卡片里写原因，编辑框留着可以接着改', async () => {
    setup([bloat], { respond: command => ({ ok: false, cmd: command.cmd, code: 'secret-critical', detail: '检测到高危密钥（sk- 系列密钥），未保存' }) })
    startEdit()
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。改写成不含密钥的说法再存。')
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toHaveAttribute('aria-disabled')
  })

  // 厂商形状的假密钥运行时拼接，源码里不出现完整字面量
  const criticalKey = 'sk-' + 'TESTONLY'.padEnd(24, 'a')

  it('新内容有高危密钥：本地就拦住，不发命令（命令文本会进借用会话的日志），提示同服务端拦下时', async () => {
    const { commands } = setup([bloat], { respond: respondEdit })
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: `发版用 ${criticalKey}` } })
    await save()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。改写成不含密钥的说法再存。')
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toHaveAttribute('aria-disabled')
  })

  it('新内容像密钥：卡片里再确认一次，「仍然保存」带 force 重发', async () => {
    const { commands } = setup([bloat], {
      respond: command => (command.cmd === 'edit-memory' && command.force !== true ? { ok: false, cmd: command.cmd, code: 'secret-suspected' } : edited),
    })
    startEdit()
    await save()
    expect(screen.getByText('内容里有像密钥的片段。确定不是密钥再保存。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '仍然保存' })) })
    await screen.findByText('已修改')
    expect(commands().map(c => c.cmd === 'edit-memory' && c.force)).toEqual([undefined, true])
  })

  it('记忆在卡片加载后被改过：没有保存，写明重新打开修改；视图换成新版本后稿子留着，再保存仍按开始改时的版本核对，不冲掉别处的改动', async () => {
    const { gateway, commands } = setup([bloat], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '这条记忆刚被改过' }) })
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '我的稿子' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('这条记忆刚被改过，没有保存。重新打开修改，会从最新内容开始。')
    // 服务端因这次失败重写了视图：卡片换成别处改过的版本
    const changed = { ...target, content: '别处改的', digest: 'sha1:b1x', updatedAt: 222 }
    act(() => { gateway.setView('pending', view({ ...bloat, memories: [changed] })) })
    expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('我的稿子')
    await save()
    expect(commands().map(c => c.cmd === 'edit-memory' && c.base)).toEqual([base, base])

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    startEdit()
    expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('别处改的')
    await save()
    expect(commands().map(c => c.cmd === 'edit-memory' && c.base).at(-1)).toEqual({ updatedAt: 222, digest: 'sha1:b1x' })
  })

  it('点「不再提醒」时记忆刚被改过：写明卡片已换成最新内容，看过再决定', async () => {
    setup([bloat], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '这条记忆刚被改过' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提醒' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('这条记忆刚被改过，已换成最新内容，看过再决定要不要忽略。')
  })

  it('保存中只锁这张卡：保存、取消置灰，别的卡照常可用', async () => {
    setup([bloat, stale], { respond: command => (command.cmd === 'edit-memory' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    startEdit()
    await save()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '取消' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '仍然有效' })).not.toHaveAttribute('aria-disabled')
  })

  it('同卡别的动作在进行：「修改」置灰', async () => {
    setup([bloat], { respond: command => (command.cmd === 'ignore-advice' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提醒' })) })
    expect(screen.getByRole('button', { name: '修改' })).toHaveAttribute('aria-disabled', 'true')
  })

  describe('手动合并', () => {
    const left = memory({ id: 'r1', name: '翻译腔', content: '避免翻译腔。', summary: '少翻译腔', tags: ['中文'], createdAt: 2, updatedAt: 21, digest: 'sha1:r1' })
    const right = memory({ id: 'r2', name: '被字句', content: '少用被字句。', summary: '少被字句', tags: ['写作', '中文'], createdAt: 1, updatedAt: 22, digest: 'sha1:r2' })
    const pairOf = (...memories: MemoryCard[]): PendingItem => ({ kind: 'advice', level: 'advice', type: 'redundancy', memories })
    const merged = { ok: true as const, cmd: 'merge-memories', decisionId: 'pd_m', memoryIds: ['r2', 'r1'], snapshotId: 'snap_m', filePath: '/m/app/r2.md' }
    /** 点「合并」，切到「手动合并」。 */
    const startMerge = () => {
      fireEvent.click(screen.getByRole('button', { name: '合并' }))
      fireEvent.click(screen.getByRole('tab', { name: '手动合并' }))
    }

    it('编辑框预填两条正文（保留的那条在前，空行分隔）；更多里是保留那条的名称、摘要和两条标签的并集；底部写明另一条进最近删除', async () => {
      const { commands } = setup([pairOf(left, right)], { respond: command => (command.cmd === 'merge-memories' ? merged : { ok: true, cmd: command.cmd }) })
      startMerge()
      expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('少用被字句。\n\n避免翻译腔。')
      expect(screen.getByText('保存后另一条进最近删除')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '删除左边' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '更多' }))
      expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('被字句')
      expect(screen.getByRole('textbox', { name: '摘要' })).toHaveValue('少被字句')
      await save()
      expect(commands()).toEqual([{
        cmd: 'merge-memories',
        memories: [{ memoryId: 'r1', layer, base: { updatedAt: 21, digest: 'sha1:r1' } }, { memoryId: 'r2', layer, base: { updatedAt: 22, digest: 'sha1:r2' } }],
        content: '少用被字句。\n\n避免翻译腔。', name: '被字句', summary: '少被字句', tags: ['写作', '中文'],
      }])
      expect(screen.getByText('已合并')).toBeInTheDocument()
      expect(screen.getByText(`被字句 · 12 字 → 14 字`)).toBeInTheDocument()
    })

    it('合并中两条里有一条被别处改了、视图换成新版本：保存仍按打开合并时的两条版本核对，编辑框不变', async () => {
      const { gateway, commands } = setup([pairOf(left, right)], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale' }) })
      startMerge()
      act(() => { gateway.setView('pending', view(pairOf({ ...left, content: '别处改的', updatedAt: 99, digest: 'sha1:r1x' }, right))) })
      expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('少用被字句。\n\n避免翻译腔。')
      await save()
      const sent = commands().at(-1)
      expect(sent?.cmd === 'merge-memories' && sent.memories.map(m => m.base)).toEqual([{ updatedAt: 21, digest: 'sha1:r1' }, { updatedAt: 22, digest: 'sha1:r2' }])
    })

    it('一条全局一条项目：保留全局那条，预填它的名称', () => {
      const global = { ...left, scope: 'global', workspacePath: undefined } as MemoryCard
      setup([pairOf(right, global)])
      startMerge()
      expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('避免翻译腔。\n\n少用被字句。')
      fireEvent.click(screen.getByRole('button', { name: '更多' }))
      expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('翻译腔')
    })
  })
})

describe('待处理：三条以上内容重复的合并', () => {
  const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
  const dup = (id: string, overrides: Partial<MemoryCard> = {}) =>
    memory({ id, name: `重复 ${id}`, content: `${id} 的内容。`, filePath: `/m/app/${id}.md`, digest: `sha1:${id}`, updatedAt: 100, ...overrides })
  const three = [dup('d1'), dup('d2'), dup('d3')]
  const group = (memories: MemoryCard[]): PendingItem => ({ kind: 'advice', level: 'advice', type: 'redundancy', memories })
  const refOf = (m: MemoryCard) => ({ memoryId: m.id, layer, base: { updatedAt: m.updatedAt, digest: m.digest } })
  const PRESET = '合成一条，各自独有的信息都留下'
  const plan = {
    understanding: '三条合成 d1。',
    ops: [
      { memoryId: 'd1', action: 'rewrite', reason: '承接另外两条。' },
      { memoryId: 'd2', action: 'delete', reason: '并进 d1。', into: 'd1' },
      { memoryId: 'd3', action: 'delete', reason: '并进 d1。', into: 'd1' },
    ],
  }
  const respond = (command: MemoryCommand): MemoryCommandResult => {
    if (command.cmd === 'plan-edits') return { ok: true, cmd: 'plan-edits', plan, model: 'deepseek-v4-flash' } as MemoryCommandResult
    if (command.cmd === 'draft-plan') return { ok: true, cmd: 'draft-plan', drafts: [{ memoryId: 'd1', draft: { content: '三条合成的内容。', summary: '合成' } }] } as MemoryCommandResult
    if (command.cmd === 'apply-edits') return { ok: true, cmd: 'apply-edits', decisionId: 'pd_b', memoryIds: ['d1', 'd2', 'd3'], snapshotId: 'snap_b' }
    return { ok: true, cmd: command.cmd }
  }
  const cardOf = () => screen.getByRole('heading', { level: 3, name: '内容重复' }).closest('article')!
  const click = async (name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })) }) }

  it('同一作用域、都能改：说明写可以合并，卡片底部「合并」', () => {
    setup([group(three)])
    expect(screen.getByText('这几条内容有重叠。说的是同一件事，点「合并」让模型合成一条，各自独有的信息都留下；其实是不同的事，点右上角不再提醒。')).toBeInTheDocument()
    expect(within(cardOf()).getByRole('button', { name: '合并' }).closest('.pm-pending-actions')).not.toBeNull()
  })

  it.each([
    ['跨了作用域', [...three.slice(0, 2), dup('d3', { scope: 'global', workspacePath: undefined })]],
    ['超过 20 条', Array.from({ length: 21 }, (_, i) => dup(`d${i}`))],
    ['去掉含密钥的只剩一条', [dup('d1'), dup('d2', { hasSecret: true }), dup('d3', { hasSecret: true })]],
  ])('%s：不出「合并」，说明照旧', (_label, memories) => {
    setup([group(memories)])
    expect(within(cardOf()).queryByRole('button', { name: '合并' })).toBeNull()
    expect(screen.getByText('这几条内容有重叠。说的是同一件事，留一条就够；其实是不同的事，点右上角不再提醒。')).toBeInTheDocument()
  })

  it('点「合并」在卡片里展开整理所选的三步，要求预填好；生成计划发 plan-edits，含密钥的那条不发', async () => {
    const { commands } = setup([group([...three, dup('d4', { hasSecret: true })])], { respond })
    await click('合并')
    expect(within(cardOf()).getByRole('heading', { name: '合并这 3 条' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: '想怎么整理这几条？' })).toHaveValue(PRESET)
    // 展开后右上角的叉收起
    expect(within(cardOf()).queryByRole('button', { name: '不再提醒' })).toBeNull()
    await click('生成整理计划')
    expect(commands()).toEqual([{ cmd: 'plan-edits', memories: three.map(refOf), request: PRESET }])
  })

  it('「取消」收起回到卡片，焦点回到「合并」，不写', async () => {
    const { commands } = setup([group(three)], { respond })
    const merge = screen.getByRole('button', { name: '合并' })
    merge.focus()
    await click('合并')
    await click('返回')
    await waitFor(() => { expect(screen.getByRole('button', { name: '合并' })).toHaveFocus() })
    expect(commands()).toEqual([])
  })

  it('看计划 → 出稿 → 应用全部（确认删除）发 apply-edits；卡片原位换成结果，写改写、删除几条，撤销发 undo', async () => {
    const { commands, gateway } = setup([group(three)], { respond })
    await click('合并')
    await click('生成整理计划')
    await click('按计划出稿')
    await click('应用全部')
    await click('确认应用')
    expect(commands()[2]).toEqual({
      cmd: 'apply-edits',
      ops: [
        { kind: 'edit', ...refOf(three[0]!), content: '三条合成的内容。', summary: '合成', name: '重复 d1', tags: [] },
        { kind: 'forget', ...refOf(three[1]!), into: 'd1' },
        { kind: 'forget', ...refOf(three[2]!), into: 'd1' },
      ],
    })
    expect(await screen.findByText('已合并')).toBeInTheDocument()
    expect(screen.getByText('改写 1 条、删除 2 条；删掉的 14 天内可在「最近删除」恢复。')).toBeInTheDocument()
    // 视图刷新、这张卡已不在待处理：结果仍在原位
    act(() => { gateway.setView('pending', view()) })
    const undo = screen.getByRole('button', { name: '撤销' })
    await act(async () => { fireEvent.click(undo) })
    expect(commands()[3]).toEqual({ cmd: 'undo', decisionId: 'pd_b' })
  })
})

describe('待处理：让模型改与让模型合并', () => {
  const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
  const target = memory({ id: 'b1', name: '发版流程', type: 'project', content: '先跑测试，再打包，再发版。', summary: '发版的步骤', tags: ['发版'], digest: 'sha1:b1', updatedAt: 111 })
  const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [target] }
  const stale: PendingItem = { kind: 'advice', level: 'advice', type: 'stale', memories: [memory({ id: 's9', name: '很久的', digest: 'sha1:s9' })] }
  const base = { updatedAt: 111, digest: 'sha1:b1' }
  const drafted = (draft: object): MemoryCommandResult => ({ ok: true, cmd: 'draft-edit', draft: { content: '先跑单测，再发版。', summary: '发版的步骤', ...draft }, model: 'deepseek-v4-flash' } as MemoryCommandResult)
  const edited = { ok: true as const, cmd: 'edit-memory', decisionId: 'pd_e', memoryIds: ['b1'], snapshotId: 'snap_e', filePath: '/m/app/b1.md' }
  /** 生成回给定的稿子，其余命令照常成功。 */
  const respondWith = (draft: object = {}) => (command: MemoryCommand): MemoryCommandResult =>
    command.cmd === 'draft-edit' ? drafted(draft) : command.cmd === 'edit-memory' ? edited : { ok: true, cmd: command.cmd }
  /** 点「修改」或「合并」：默认停在让模型改那一侧。 */
  const open = (name = '修改') => { fireEvent.click(screen.getByRole('button', { name })) }
  const generate = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改' })) }) }
  const textOf = (pane: string, tag: 'del' | 'ins') => [...screen.getByRole('region', { name: pane }).querySelectorAll(tag)].map(e => e.textContent).join('|')

  it('点「修改」默认停在让模型改：就地写要求，说明按哪类建议默认处理、用哪个模型；「取消」收起，不发命令', () => {
    const { commands } = setup([bloat], { model: 'deepseek-v4-flash' })
    expect(within(screen.getByRole('article')).getAllByRole('button').map(b => b.textContent)).toEqual(['不再提醒', '打开文件', '修改'])
    open()
    expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「内容过长」默认处理' })).toHaveValue('')
    // 改的过程中右上角的叉收起
    expect(screen.queryByRole('button', { name: '不再提醒' })).toBeNull()
    expect(screen.getByText('用当前模型 deepseek-v4-flash 生成，先给你看结果再决定')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '修改' })).toBeNull()
    expect(screen.getByRole('button', { name: '取消' })).toHaveClass('pm-btn--ghost')
    expect(screen.getByRole('button', { name: '生成修改' })).toHaveClass('pm-btn--primary')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '修改' })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('31：建议卡的让模型改也有「常用写法（可选）」四个快捷意图（同记忆查看），要求照样可以不写；没有记忆查看那句说明', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    const intents = screen.getByRole('group', { name: '常用写法（可选）' })
    expect(within(intents).getAllByRole('button').map(b => b.textContent)).toEqual(['压缩要点', '改清楚', '纠正内容', '补充信息'])
    fireEvent.click(within(intents).getByRole('button', { name: '压缩要点' }))
    expect(screen.getByRole('textbox', { name: /想怎么改？不写也行/ })).toHaveValue('压缩成要点，保留 ___，可以删掉 ___。')
    expect(screen.queryByText(/它只用你写的信息/)).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '' } })
    expect(screen.getByRole('button', { name: '生成修改' })).not.toHaveAttribute('aria-disabled')
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'b1', layer }] }])
  })

  it('拿不到模型名：提示只写后半句', () => {
    setup([bloat])
    open()
    expect(screen.getByText('先给你看结果再决定')).toBeInTheDocument()
  })

  it('生成：发 draft-edit（建议类型、层、要求）；结果左右对照，删掉的划线、新增的高亮，下面一行字数变化；这时什么都没写', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '命令保留原样' } })
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'b1', layer }], request: '命令保留原样' }])
    expect(textOf('原文', 'del')).toContain('打包')
    expect(textOf('改后', 'ins')).toContain('单测')
    expect(textOf('原文', 'ins')).toBe('')
    expect(textOf('改后', 'del')).toBe('')
    expect(screen.getByText('13 字 → 9 字')).toBeInTheDocument()
    expect(screen.getAllByRole('button').slice(-3).map(b => b.textContent)).toEqual(['放弃', '再改改', '应用'])
  })

  it('要求里有高危密钥：本地拦住，不发 draft-edit，就地写明原因', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: `把 ${'sk-' + 'TESTONLY'.padEnd(24, 'a')} 删掉` } })
    await generate()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toBeInTheDocument()
  })

  it('没写要求：draft-edit 不带 request', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'b1', layer }] }])
  })

  it('摘要、名称、标签变了也对照显示；没变的不显示', async () => {
    setup([bloat], { respond: respondWith({ summary: '发版两步', name: '发版步骤' }) })
    open()
    await generate()
    const after = screen.getByRole('region', { name: '改后' })
    expect(within(after).getByText('摘要')).toBeInTheDocument()
    expect(within(after).getByText('名称')).toBeInTheDocument()
    expect(within(after).queryByText('标签')).toBeNull()
    expect(textOf('改后', 'ins')).toContain('两步')
  })

  it('应用：发 edit-memory（卡片版本 + 改后稿，模型没改的名称、标签沿用原值），之后同手动改：收成一行，可撤销', async () => {
    const { commands } = setup([bloat], { respond: respondWith({ summary: '发版两步' }) })
    open()
    await generate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'edit-memory', memoryId: 'b1', layer, base, content: '先跑单测，再发版。', name: '发版流程', summary: '发版两步', tags: ['发版'] })
    expect(screen.getByText('已修改')).toBeInTheDocument()
    expect(screen.getByText('发版流程 · 13 字 → 9 字')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'pd_e' })
  })

  it('面板开着时视图换成别处改过的版本：应用仍按打开时的卡片版本核对（服务端回 stale，不冲掉别处的改动）', async () => {
    const { gateway, commands } = setup([bloat], { respond: respondWith() })
    open()
    act(() => { gateway.setView('pending', view({ ...bloat, memories: [{ ...target, content: '别处改的', updatedAt: 222, digest: 'sha1:b1x' }] })) })
    await generate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    const sent = commands().at(-1)
    expect(sent?.cmd === 'edit-memory' && sent.base).toEqual(base)
  })

  it('「放弃」只清掉这一稿、回到写要求（要求还在），不写', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '短一点' } })
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(screen.queryByRole('region', { name: '改后' })).toBeNull()
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveValue('短一点')
    expect(screen.queryByRole('button', { name: '修改' })).toBeNull()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit'])
  })

  it('再改改：回到输入框，第二次请求带上一稿与新要求', async () => {
    const { commands } = setup([bloat], { respond: respondWith({ name: '发版步骤' }) })
    open()
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '再改改' }))
    const box = screen.getByRole('textbox', { name: /想怎么改/ })
    expect(box).toHaveValue('')
    fireEvent.change(box, { target: { value: '再短一点' } })
    await generate()
    expect(commands().at(-1)).toEqual({
      cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'b1', layer }], request: '再短一点',
      previous: { content: '先跑单测，再发版。', summary: '发版的步骤', name: '发版步骤', tags: ['发版'] },
    })
  })

  it('再改改：此前每一轮写过的要求按先后带在 priorRequests 里（没写要求的那轮不带）', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    const ask = (text: string) => { fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: text } }) }
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '再改改' }))
    ask('「打包」改成「构建」')
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '再改改' }))
    ask('再短一点')
    await generate()
    expect(commands().map(c => c.cmd === 'draft-edit' ? [c.request, c.priorRequests] : c.cmd)).toEqual([
      [undefined, undefined],
      ['「打包」改成「构建」', undefined],
      ['再短一点', ['「打包」改成「构建」']],
    ])
  })

  it('上一稿里有高危密钥：再改改时本地拦住，不发 draft-edit，就地写明原因', async () => {
    const { commands } = setup([bloat], { respond: respondWith({ content: `部署 token ${'sk-' + 'TESTONLY'.padEnd(24, 'a')}` }) })
    open()
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '再改改' }))
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '去掉 token' } })
    await generate()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit'])
    expect(screen.getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
  })

  it('生成中只锁这张卡：显示「正在生成修改……」和「停止」，别的卡照常可用', async () => {
    setup([bloat, stale], { respond: command => (command.cmd === 'draft-edit' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    open()
    await generate()
    expect(screen.getByText('正在生成修改……')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止' })).toHaveClass('pm-btn--ghost')
    expect(screen.queryByRole('button', { name: '生成修改' })).toBeNull()
    expect(screen.getByRole('button', { name: '仍然有效' })).not.toHaveAttribute('aria-disabled')
  })

  it('停止：回到输入框（写的要求还在），之后到达的结果直接丢弃，不显示、不写', async () => {
    let resolve: (r: MemoryCommandResult) => void = () => {}
    const { commands } = setup([bloat], {
      respond: command => (command.cmd === 'draft-edit' ? new Promise<MemoryCommandResult>((r) => { resolve = r }) : { ok: true, cmd: command.cmd }),
    })
    open()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '短一点' } })
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveValue('短一点')
    await act(async () => { resolve(drafted({})) })
    expect(screen.queryByRole('region', { name: '改后' })).toBeNull()
    expect(screen.getByRole('button', { name: '生成修改' })).toBeInTheDocument()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit'])
  })

  it.each([
    ['输出不合格式', { ok: false, cmd: 'draft-edit', code: 'llm-invalid-output', detail: '模型的输出不是要求的 JSON 格式' }, '模型返回的内容格式不对，再试一次。'],
    ['模型报错', { ok: false, cmd: 'draft-edit', code: 'llm-failed', detail: 'rate limited' }, '模型出错了：rate limited'],
    ['拿不到模型', { ok: false, cmd: 'draft-edit', code: 'llm-unavailable', detail: '借用的会话拿不到模型' }, '拿不到当前会话的模型。'],
    // 和整理所选同一套命令协议：记忆已不在换本地文案，不显示服务端原话
    ['记忆已不在', { ok: false, cmd: 'draft-edit', code: 'not-found', detail: '不存在或已处理：b1' }, '这条记忆已经不在了，可能在别处删掉了。列表已更新。'],
  ] as const)('生成失败（%s）：卡片写原因，可以重试', async (_label, failure, message) => {
    const replies: MemoryCommandResult[] = [failure as MemoryCommandResult, drafted({})]
    const { commands } = setup([bloat], { respond: command => (command.cmd === 'draft-edit' ? replies.shift()! : { ok: true, cmd: command.cmd }) })
    open()
    await generate()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    await generate()
    expect(screen.getByRole('region', { name: '改后' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit', 'draft-edit'])
  })

  it('表述不清也能让模型改，默认按「表述不清」处理', async () => {
    const { commands } = setup([{ ...bloat, type: 'unclear' }], { respond: respondWith() })
    open()
    expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「表述不清」默认处理' })).toBeInTheDocument()
    await generate()
    expect(commands()[0]).toMatchObject({ cmd: 'draft-edit', adviceType: 'unclear' })
  })

  it('页面加载时不问模型，点开「修改」「合并」才问', () => {
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [memory({ id: 'r1', digest: 'sha1:r1' }), memory({ id: 'r2', digest: 'sha1:r2' })] }
    const { gateway } = setup([bloat, pair], { model: 'deepseek-v4-flash' })
    expect(gateway.modelRequests).toEqual([])
    open()
    expect(gateway.modelRequests.at(-1)).toBe('s1')
  })

  it('模型不可用：按钮照常能点；点开后面板里写原因，「生成修改」不可用，不发请求', async () => {
    const { commands } = setup([bloat], { model: null })
    expect(screen.getByRole('button', { name: '修改' })).not.toHaveAttribute('aria-disabled')
    open()
    expect(screen.getByText('拿不到当前会话的模型。')).toBeInTheDocument()
    expect(screen.queryByText('先给你看结果再决定')).toBeNull()
    expect(screen.getByRole('button', { name: '生成修改' })).toHaveAttribute('aria-disabled', 'true')
    await generate()
    expect(commands()).toEqual([])
  })

  it('含密钥的记忆：没有「修改」「合并」，也不发请求', () => {
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [memory({ id: 'x1', digest: 'sha1:x1', hasSecret: true }), memory({ id: 'x2', digest: 'sha1:x2' })] }
    const { commands } = setup([{ ...bloat, memories: [{ ...target, hasSecret: true }] }, pair])
    // 两张卡确实渲染出来了（各有「打开文件」），否定断言才有意义
    const cards = ['内容过长', '内容重复'].map(title => screen.getByRole('heading', { level: 3, name: title }).closest('article')!)
    for (const card of cards) expect(within(card).getAllByRole('button', { name: '打开文件' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '修改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '合并' })).toBeNull()
    expect(commands()).toEqual([])
  })

  describe('让模型合并', () => {
    const left = memory({ id: 'r1', name: '翻译腔', content: '避免翻译腔。', summary: '少翻译腔', tags: ['中文'], createdAt: 2, updatedAt: 21, digest: 'sha1:r1' })
    const right = memory({ id: 'r2', name: '被字句', content: '少用被字句。', summary: '少被字句', tags: ['写作', '中文'], createdAt: 1, updatedAt: 22, digest: 'sha1:r2' })
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [left, right] }
    const merged = { ok: true as const, cmd: 'merge-memories', decisionId: 'pd_m', memoryIds: ['r2', 'r1'], snapshotId: 'snap_m', filePath: '/m/app/r2.md' }
    const respond = (command: MemoryCommand): MemoryCommandResult => (command.cmd === 'draft-edit'
      ? { ok: true, cmd: 'draft-edit', draft: { content: '中文写作避免翻译腔，少用被字句。', summary: '中文写作要自然' } }
      : command.cmd === 'merge-memories' ? merged : { ok: true, cmd: command.cmd })

    it('点「合并」默认停在让模型合并（没有快捷意图）；结果左边两条原文、右边合并稿，标明保留哪条的 id，不高亮', async () => {
      const { commands } = setup([pair], { respond })
      expect(within(screen.getByRole('article')).getAllByRole('button').at(-1)?.textContent).toBe('合并')
      open('合并')
      expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「内容重复」默认处理' })).toBeInTheDocument()
      // 快捷意图只给单条
      expect(screen.queryByRole('group', { name: '常用写法（可选）' })).toBeNull()
      expect(screen.queryByRole('button', { name: '不再提醒' })).toBeNull()
      await generate()
      expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'redundancy', memories: [{ memoryId: 'r1', layer }, { memoryId: 'r2', layer }] }])
      const before = screen.getByRole('region', { name: '两条原文' })
      expect(within(before).getByText('避免翻译腔。')).toBeInTheDocument()
      expect(within(before).getByText('少用被字句。')).toBeInTheDocument()
      // r2 创建较早，同层合并保留创建较早的那条：它是右边那条
      const after = screen.getByRole('region', { name: '合并后（保留右边那条的 id）' })
      expect(within(after).getByText('中文写作避免翻译腔，少用被字句。')).toBeInTheDocument()
      expect(document.querySelectorAll('.pm-model-compare del, .pm-model-compare ins')).toHaveLength(0)
      expect(screen.getByText(/应用后左边那条进最近删除，14 天内可恢复/)).toBeInTheDocument()
    })

    it('应用：发 merge-memories（两条的卡片版本，名称取保留那条、标签取并集），应用后收成「已合并」一行', async () => {
      const { commands } = setup([pair], { respond })
      open('合并')
      await generate()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
      expect(commands().at(-1)).toEqual({
        cmd: 'merge-memories',
        memories: [{ memoryId: 'r1', layer, base: { updatedAt: 21, digest: 'sha1:r1' } }, { memoryId: 'r2', layer, base: { updatedAt: 22, digest: 'sha1:r2' } }],
        content: '中文写作避免翻译腔，少用被字句。', name: '被字句', summary: '中文写作要自然', tags: ['写作', '中文'],
      })
      expect(screen.getByText('已合并')).toBeInTheDocument()
    })
  })
})

// —— 修改面板顶部两段切换：让模型改 | 手动改（合并卡是让模型合并 | 手动合并） ——

describe('待处理：修改方式两段切换', () => {
  const target = memory({ id: 'b1', name: '发版流程', content: '先跑测试，再打包，再发版。', summary: '发版的步骤', tags: ['发版'], digest: 'sha1:b1', updatedAt: 111 })
  const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [target] }
  const pair: PendingItem = {
    kind: 'advice', level: 'advice', type: 'redundancy',
    memories: [memory({ id: 'r1', content: '避免翻译腔。', digest: 'sha1:r1', createdAt: 2 }), memory({ id: 'r2', content: '少用被字句。', digest: 'sha1:r2', createdAt: 1 })],
  }
  const drafted: MemoryCommandResult = { ok: true, cmd: 'draft-edit', draft: { content: '先跑单测，再发版。', summary: '发版的步骤' } } as MemoryCommandResult
  const edited = { ok: true as const, cmd: 'edit-memory', decisionId: 'pd_e', memoryIds: ['b1'], snapshotId: 'snap_e', filePath: '/m/app/b1.md' }
  const cardOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('article')!
  const tab = (name: string, scope: HTMLElement = document.body) => within(scope).getByRole('tab', { name })
  const generate = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改' })) }) }
  const save = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) }) }
  const expectLocked = (isLocked: boolean) => {
    for (const name of ['让模型改', '手动改']) {
      if (isLocked) expect(tab(name)).toBeDisabled()
      else expect(tab(name)).toBeEnabled()
    }
  }

  it('2a：面板顶部一组 tab「修改方式」，两段「让模型改」「手动改」；第一次打开停在让模型改', () => {
    setup([bloat])
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    const modes = screen.getByRole('tablist', { name: '修改方式' })
    expect(within(modes).getAllByRole('tab').map(t => t.textContent)).toEqual(['让模型改', '手动改'])
    expect(tab('让模型改')).toHaveAttribute('aria-selected', 'true')
    expect(tab('手动改')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel', { name: '让模型改' })).toContainElement(screen.getByRole('textbox', { name: /想怎么改/ }))
  })

  it('2a：记住上次选的方式，下次打开停在那一侧', () => {
    setup([bloat])
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    fireEvent.click(tab('手动改'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    expect(tab('手动改')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /想怎么改/ })).toBeNull()
  })

  it('2b：切换不丢输入，两种方式各自保留已写的内容', () => {
    setup([bloat])
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '只留两步' } })
    fireEvent.click(tab('手动改'))
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '跑测试，发版。' } })
    fireEvent.click(tab('让模型改'))
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveValue('只留两步')
    fireEvent.click(tab('手动改'))
    expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('跑测试，发版。')
  })

  it('2b：生成中、对照中不能切；模型一侧「放弃」后回到写要求，又能切到手动', async () => {
    let resolve: (r: MemoryCommandResult) => void = () => {}
    setup([bloat], { respond: command => (command.cmd === 'draft-edit' ? new Promise<MemoryCommandResult>((r) => { resolve = r }) : { ok: true, cmd: command.cmd }) })
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    expectLocked(false)
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '短一点' } })
    await generate()
    expectLocked(true)
    await act(async () => { resolve(drafted) })
    expect(screen.getByRole('region', { name: '改后' })).toBeInTheDocument()
    expectLocked(true)
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveValue('短一点')
    expectLocked(false)
    fireEvent.click(tab('手动改'))
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument()
  })

  it('2b：手动一侧保存中、等确认（疑似密钥）时不能切；取消确认后又能切', async () => {
    let resolve: (r: MemoryCommandResult) => void = () => {}
    setup([bloat], { respond: command => (command.cmd === 'edit-memory' ? new Promise<MemoryCommandResult>((r) => { resolve = r }) : { ok: true, cmd: command.cmd }) })
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    fireEvent.click(tab('手动改'))
    await save()
    expectLocked(true)
    await act(async () => { resolve({ ok: false, cmd: 'edit-memory', code: 'secret-suspected' }) })
    expect(screen.getByText('内容里有像密钥的片段。确定不是密钥再保存。')).toBeInTheDocument()
    expectLocked(true)
    const confirm = screen.getByRole('group', { name: '仍然保存' })
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByText('内容里有像密钥的片段。确定不是密钥再保存。')).toBeNull()
    expectLocked(false)
  })

  it('2b：Esc 关闭整个面板，不发命令', () => {
    const { commands } = setup([bloat])
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: /想怎么改/ }), { key: 'Escape' })
    expect(screen.queryByRole('tablist', { name: '修改方式' })).toBeNull()
    expect(screen.getByRole('button', { name: '修改' })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('31：篇幅过长、表述含糊只有一个「修改」；让模型改那一侧要求可以不写，按建议类型默认处理', async () => {
    const { commands } = setup([bloat, { ...bloat, type: 'unclear', memories: [{ ...target, id: 'u1', digest: 'sha1:u1' }] }], {
      respond: command => (command.cmd === 'draft-edit' ? drafted : command.cmd === 'edit-memory' ? edited : { ok: true, cmd: command.cmd }),
    })
    for (const title of ['内容过长', '表述不清']) {
      expect(within(cardOf(title)).getAllByRole('button', { name: '修改' })).toHaveLength(1)
      expect(within(cardOf(title)).queryByRole('button', { name: /直接改|让模型改/ })).toBeNull()
    }
    fireEvent.click(within(cardOf('表述不清')).getByRole('button', { name: '修改' }))
    expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「表述不清」默认处理' })).toHaveValue('')
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'unclear', memories: [{ memoryId: 'u1', layer: { kind: 'workspace', workspacePath: '/w/app' } }] }])
  })

  it('32：内容重复两条只有一个「合并」；面板两段「让模型合并」「手动合并」，两侧各是模型合并和合并编辑器', () => {
    setup([pair])
    expect(within(cardOf('内容重复')).queryByRole('button', { name: /直接合并|让模型合并/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '合并' }))
    expect(within(screen.getByRole('tablist', { name: '修改方式' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['让模型合并', '手动合并'])
    expect(tab('让模型合并')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「内容重复」默认处理' })).toBeInTheDocument()
    fireEvent.click(tab('手动合并'))
    expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('少用被字句。\n\n避免翻译腔。')
    expect(screen.getByText('保存后另一条进最近删除')).toBeInTheDocument()
  })

  it('33：方式偏好共用：在一张卡选了手动，另一张卡点「合并」也停在手动；开着的面板不受别处改偏好影响', () => {
    setup([bloat, pair])
    fireEvent.click(within(cardOf('内容过长')).getByRole('button', { name: '修改' }))
    fireEvent.click(within(cardOf('内容重复')).getByRole('button', { name: '合并' }))
    fireEvent.click(tab('手动合并', cardOf('内容重复')))
    // 内容过长那张是在改偏好之前打开的：仍停在让模型改
    expect(tab('让模型改', cardOf('内容过长'))).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(within(cardOf('内容过长')).getByRole('button', { name: '取消' }))
    fireEvent.click(within(cardOf('内容过长')).getByRole('button', { name: '修改' }))
    expect(tab('手动改', cardOf('内容过长'))).toHaveAttribute('aria-selected', 'true')
  })
})

// —— 放错层只回答挪不挪：项目 → 全局是提升，全局 → 项目是移到项目（行内选项目） ——

describe('待处理：放错层只给挪层', () => {
  const toGlobal: PendingItem = { kind: 'advice', level: 'advice', type: 'misplaced', memories: [memory({ id: 'mu', name: '记忆 mu', filePath: '/m/app/mu.md', digest: 'sha1:mu' })] }
  const toProject: PendingItem = {
    kind: 'advice', level: 'advice', type: 'misplaced',
    memories: [memory({ id: 'md', name: '记忆 md', scope: 'global', workspacePath: undefined, filePath: '/m/global/md.md', digest: 'sha1:md' })],
  }
  /** 借来的会话带着归属对照：已知项目是 app、blog（两个 cwd 落在 blog）。 */
  const session = { kind: 'ready', sessionId: 's1', cwd: '/w/app', workspaces: { '/w/app': '/w/app', '/w/blog': '/w/blog', '/w/blog/web': '/w/blog' } } as const
  /** pageProject：页面作用域的项目，null = 页面在全局。 */
  function setupMove(items: PendingItem[], init: FakeGatewayInit = {}, pageProject: string | null = '/w/app') {
    const gateway = createFakeGateway({ session, config, views: { pending: view(...items), health: scannedHealth(NOW) }, ...init })
    renderInShell(<PendingTab nav={createNavStore()} session={session} scope={ALL_SCOPE} workspacePath={pageProject ?? undefined} now={NOW} />, gateway)
    return { gateway, commands: () => gateway.executed.map(e => e.command) }
  }
  const cardOf = () => screen.getByRole('heading', { level: 3, name: '放错层' }).closest('article')!
  const openPicker = () => { fireEvent.click(within(cardOf()).getByRole('button', { name: '移到项目…' })) }

  it('两个方向都没有「修改」', () => {
    setupMove([toGlobal, toProject])
    for (const card of screen.getAllByRole('article')) {
      expect(within(card).queryByRole('button', { name: '修改' })).toBeNull()
    }
  })

  it('项目 → 全局：叉「不再提醒」发 ignore-advice，「打开文件」打开那条记忆的文件', async () => {
    const { gateway, commands } = setupMove([toGlobal])
    fireEvent.click(within(cardOf()).getByRole('button', { name: '打开文件' }))
    expect(gateway.opened).toEqual([{ path: '/m/app/mu.md' }])
    fireEvent.click(within(cardOf()).getByRole('button', { name: '不再提醒' }))
    await screen.findByText('不再扣分；内容改了会重新提醒。')
    expect(commands()).toEqual([{ cmd: 'ignore-advice', type: 'misplaced', memories: [{ memoryId: 'mu', layer: { kind: 'workspace', workspacePath: '/w/app' }, base: { updatedAt: toGlobal.kind === 'advice' ? toGlobal.memories[0]!.updatedAt : 0, digest: 'sha1:mu' } }] }])
  })

  it('全局 → 项目：点「移到项目…」在卡片里展开已知项目，默认选当前页面的项目；「取消」收起，什么都不发', () => {
    const { commands } = setupMove([toProject])
    openPicker()
    const group = within(cardOf()).getByRole('group', { name: '移到哪个项目' })
    expect(within(group).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['/w/app', '/w/blog'])
    expect(within(group).getByRole('radio', { name: /^app/ })).toBeChecked()
    // 只写项目名，不露本机路径（截图、共享屏幕时会带出用户名和目录）
    expect(within(group).getAllByRole('radio').map(r => r.closest('label')!.textContent)).toEqual(['app', 'blog'])
    expect(within(cardOf()).queryByRole('button', { name: '不再提醒' })).toBeNull()
    fireEvent.click(within(cardOf()).getByRole('button', { name: '取消' }))
    expect(within(cardOf()).queryByRole('group', { name: '移到哪个项目' })).toBeNull()
    expect(within(cardOf()).getByRole('button', { name: '移到项目…' })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('项目同名时加上一级目录区分；面板的文字和悬停提示里都没有绝对路径', () => {
    const layer = (workspacePath: string) => ({ layer: { kind: 'workspace', workspacePath }, items: [] })
    setupMove([toProject], {
      views: {
        pending: view(toProject), health: scannedHealth(NOW),
        library: { version: GUI_VIEW_VERSION, layers: [{ layer: { kind: 'global' }, items: [] }, layer('/w/clients/web'), layer('/w/admin/web')] } as never,
      },
    })
    openPicker()
    const group = within(cardOf()).getByRole('group', { name: '移到哪个项目' })
    const labels = Object.fromEntries(within(group).getAllByRole('radio').map(r => [(r as HTMLInputElement).value, r.closest('label')!.textContent]))
    expect(labels).toEqual({ '/w/app': 'app', '/w/blog': 'blog', '/w/admin/web': 'admin/web', '/w/clients/web': 'clients/web' })
    expect(group.textContent).not.toMatch(/\/w\//)
    for (const el of group.querySelectorAll('[title]')) expect(el.getAttribute('title')).not.toMatch(/\/w\//)
  })

  it('页面在全局：默认选借来的会话所在的项目；全部记忆里有记忆的项目也列出来', () => {
    setupMove([toProject], {
      currentWorkspace: '/w/blog',
      views: {
        pending: view(toProject), health: scannedHealth(NOW),
        library: { version: GUI_VIEW_VERSION, layers: [{ layer: { kind: 'global' }, items: [] }, { layer: { kind: 'workspace', workspacePath: '/w/docs' }, items: [] }] } as never,
      },
    }, null)
    openPicker()
    const group = within(cardOf()).getByRole('group', { name: '移到哪个项目' })
    expect(within(group).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['/w/blog', '/w/app', '/w/docs'])
    expect(within(group).getByRole('radio', { name: /^blog/ })).toBeChecked()
  })

  it('选好项目点「移过去」才发 move-memory；结果卡写「已移到 <项目名>」，撤销发 undo', async () => {
    const { commands } = setupMove([toProject], {
      respond: command => command.cmd === 'move-memory'
        ? { ok: true, cmd: command.cmd, decisionId: 'pd_mv', memoryIds: ['md'], snapshotId: 'snap_1', filePath: '/m/blog/md.md' }
        : { ok: true, cmd: command.cmd },
    })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('radio', { name: /^blog/ }))
    expect(commands()).toEqual([])
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    await screen.findByText('已移到 blog')
    expect(screen.getByText('只在这个项目里带入，14 天内可撤销。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands()).toEqual([{ cmd: 'move-memory', memoryId: 'md', workspacePath: '/w/blog' }, { cmd: 'undo', decisionId: 'pd_mv' }])
  })

  it('目标不是借来的会话所在项目：服务端拒（cross-workspace）→ 行内写明要移去的项目；「继续处理」带 allowCrossWorkspace 重发', async () => {
    const { commands } = setupMove([toProject], {
      respond: command => command.cmd === 'move-memory' && command.allowCrossWorkspace !== true
        ? { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'md', workspacePath: '/w/blog' }] }
        : { ok: true, cmd: command.cmd, decisionId: 'pd_mv' },
    })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('radio', { name: /^blog/ }))
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    expect(await screen.findByText('要移去的 blog 不是当前项目。确定从这里移过去吗？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续处理' }))
    await screen.findByText('已移到 blog')
    expect(commands()).toEqual([
      { cmd: 'move-memory', memoryId: 'md', workspacePath: '/w/blog' },
      { cmd: 'move-memory', memoryId: 'md', workspacePath: '/w/blog', allowCrossWorkspace: true },
    ])
  })

  it('目标项目已有同一条（target-taken）：卡片里写明没有移动', async () => {
    setupMove([toProject], { respond: command => ({ ok: false, cmd: command.cmd, code: 'target-taken', detail: '已有' }) })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('这个项目里已经有同一条记忆（也可能在最近删除里），没有移动。')
  })

  it('别处已移走或删掉（not-found）：卡片外提示没有生效', async () => {
    setupMove([toProject], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found', detail: '不存在或已处理：md' }) })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('你对「放错层」的选择没有生效：它正在别处处理，或者刚在别处处理完。')
  })

  it('一个已知项目都没有：写明原因，「移过去」不可用', () => {
    const lonely = { kind: 'ready', sessionId: 's1', cwd: undefined } as const
    const gateway = createFakeGateway({ session: lonely, config, views: { pending: view(toProject), health: scannedHealth(NOW) } })
    renderInShell(<PendingTab nav={createNavStore()} session={lonely} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    openPicker()
    expect(within(cardOf()).getByText('还没有已知的项目：在某个项目里开过对话后，它会出现在这里。')).toBeInTheDocument()
    expect(within(cardOf()).getByRole('button', { name: '移过去' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('展开时焦点落在选中的项目上', () => {
    setupMove([toProject])
    openPicker()
    expect(within(cardOf()).getByRole('radio', { name: /^app/ })).toHaveFocus()
  })

  it('一个已知项目都没有：展开时焦点落在「取消」，不随收起的「移到项目…」掉到页面上', () => {
    const lonely = { kind: 'ready', sessionId: 's1', cwd: undefined } as const
    const gateway = createFakeGateway({ session: lonely, config, views: { pending: view(toProject), health: scannedHealth(NOW) } })
    renderInShell(<PendingTab nav={createNavStore()} session={lonely} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    openPicker()
    expect(within(cardOf()).getByRole('button', { name: '取消' })).toHaveFocus()
  })
})

describe('PA-20 类型显示名', () => {
  const typedSecret = (type: string): PendingItem => ({ ...secret, memory: { ...secret.memory, type } })
  const chipsOf = (card: Element) => [...card.querySelectorAll('.pm-chip')].map(el => el.textContent)

  it('改过名的预设类型显示配置里的名字（和右侧栏、记忆查看同名）', () => {
    setup([typedSecret('procedure')], { config: { ...config, customTypes: { procedure: { label: '发版手册' } } } })
    expect(chipsOf(screen.getByRole('heading', { level: 3, name: '这条记忆里有密钥' }).closest('article')!)).toContain('发版手册')
  })

  it('英文界面下卡片里的类型写英文名，不用视图里的中文名', () => {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(typedSecret('preference')), health: scannedHealth(NOW) } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} /></PanelShell>)
    const card = screen.getByRole('heading', { level: 3, name: /secret/i }).closest('article')!
    expect(chipsOf(card)).toContain('Preference')
    expect(card).not.toHaveTextContent('行为偏好')
  })
})