import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { type MemoryCommand, type PendingItem } from '../../src/gui/contract.ts'
import { memory } from '../test-utils.tsx'
import { B, horizontal, vertical, promote, secret, overflow, view, setup, ruleConflict, ruleVertical } from './test-pending.tsx'


describe('待处理：密钥', () => {
  it('原文打码；「显示」只在本机读文件临时展开，「隐藏」收起；「打开文件改写」打开那个文件', async () => {
    const { gateway } = setup([secret], { files: { '/m/app/deploy.md': '---\nname: deploy\n---\n部署 token sk-live-123' } })
    expect(screen.getByText('部署 token [已隐藏]')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示' }))
    expect(await screen.findByText('部署 token sk-live-123')).toBeInTheDocument()
    expect(gateway.reads).toEqual(['/m/app/deploy.md'])
    fireEvent.click(screen.getByRole('button', { name: '隐藏' }))
    expect(screen.getByText('部署 token [已隐藏]')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开文件改写' }))
    await waitFor(() => { expect(gateway.opened).toEqual([{ path: '/m/app/deploy.md' }]) })
    expect(gateway.executed).toEqual([])
  })

  it('「彻底删除…」就地确认：默认焦点在「取消」，写清不进最近删除、快照副本也抹掉；取消什么都不发', () => {
    const { gateway } = setup([secret])
    fireEvent.click(screen.getByRole('button', { name: '彻底删除…' }))
    expect(screen.getByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '彻底删除…' })).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
  })

  it('确认后发 hard-delete，卡片换成收尾语，没有撤销', async () => {
    const { commands } = setup([secret, promote])
    fireEvent.click(screen.getByRole('button', { name: '彻底删除…' }))
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    expect(commands()).toEqual([{ cmd: 'hard-delete', memoryId: 's', layer: { kind: 'workspace', workspacePath: '/w/app' } }])
  })
})

describe('待处理：裁决后结果留原位、撤销', () => {
  it('裁决 → 原位结果卡（视图还没重写也不重复）→ 撤销发 undo → 视图带回冲突后只剩一张卡', async () => {
    const { gateway, commands } = setup([secret, horizontal, promote])
    ruleConflict('保留 A')
    await screen.findByText('按你的选择处理。「mock-db-in-tests」已删除，14 天内可恢复。')
    // 视图还是旧的（仍含这条冲突）：只显示结果卡，位置不变
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      '这条记忆里有密钥', '测试里怎么准备数据库，两条记忆互相矛盾', '这条适合所有项目',
    ])
    expect(screen.getByText('已保留「postgres-in-tests」')).toBeInTheDocument()
    expect(screen.getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保留 B' })).toBeNull()

    // 视图重写：冲突已不在待处理里，结果卡仍在原位
    act(() => { gateway.setView('pending', view(secret, promote)) })
    expect(screen.getAllByRole('heading', { level: 3 })[1]).toHaveTextContent('测试里怎么准备数据库')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    // 撤销生效、视图还没带回来：原样显示冲突卡，能接着裁决
    expect(await screen.findByRole('button', { name: '保留 B' })).toBeInTheDocument()
    expect(commands()).toEqual([
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' },
      { cmd: 'undo', decisionId: 'd-h' },
    ])

    act(() => { gateway.setView('pending', view(secret, horizontal, promote)) })
    expect(screen.getAllByRole('button', { name: '保留 B' })).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3)
  })

  it('都保留：结果写「以后体检不再把它们当冲突」，可撤销', async () => {
    const { commands } = setup([horizontal])
    ruleConflict('都保留，不算冲突')
    await screen.findByText('按你的选择处理。以后体检不再把它们当冲突。')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-h' }) })
  })

  it('PA-11 败方含密钥被彻底删除（isHardDeleted）：结果写已彻底删除、提醒换凭证，不给撤销', async () => {
    setup([{ ...horizontal, right: { ...B, hasSecret: true } } as PendingItem], { respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-h', isHardDeleted: true }) })
    fireEvent.click(screen.getByRole('button', { name: '保留 A' }))
    expect(screen.getByText('保留 A：B 含密钥，将彻底删除、不可恢复。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await screen.findByText('按你的选择处理。「mock-db-in-tests」含密钥，已彻底删除。如果它是真的凭证，记得去换一个新的。')
    expect(screen.queryByText(/「mock-db-in-tests」已删除，14 天内可恢复。/)).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('结论没记下（isUnrecorded，升级前导入、缺基线的冲突）：结果写下次体检可能还会报，不给撤销', async () => {
    setup([vertical], { respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-v', isUnrecorded: true }) })
    ruleVertical('都保留，不算冲突')
    await screen.findByText('已保留这条记忆')
    expect(screen.getByText('这次的决定没能记下，下次体检可能还会报。')).toBeInTheDocument()
    expect(screen.queryByText('基线和记忆都不变时不再报。')).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })
})

describe('待处理：别处已经在处理同一条', () => {
  const refused = '你对「测试里怎么准备数据库，两条记忆互相矛盾」的选择没有生效：它正在别处处理，或者刚在别处处理完。'
  const claimed = (command: MemoryCommand) => ({ ok: false as const, cmd: command.cmd, code: 'claimed' as const, detail: '待决项 d-h 正在被另一次裁决处理，未做任何改动。' })

  it('另一个标签页同时裁决（claimed）：写明你的选择没有生效，不显示原话；卡随视图更新消失后提示仍在原位', async () => {
    const { gateway } = setup([secret, horizontal, promote], { respond: claimed })
    ruleConflict('保留 B')
    expect(await screen.findByRole('alert')).toHaveTextContent(refused)
    expect(screen.queryByText(/正在被另一次裁决处理/)).toBeNull()
    expect(screen.queryByText('已保留「mock-db-in-tests」')).toBeNull()

    // 另一个标签页的裁决写进视图：这条冲突出了待处理
    act(() => { gateway.setView('pending', view(secret, promote)) })
    expect(screen.queryByRole('button', { name: '保留 B' })).toBeNull()
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent(refused)
    // 留在冲突原来的位置：密钥卡之后、提升候选之前
    const [secretTitle, promoteTitle] = screen.getAllByRole('heading', { level: 3 })
    expect(secretTitle!.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notice.compareDocumentPosition(promoteTitle!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('最后一张卡也没了：提示留在空状态上面', async () => {
    const { gateway } = setup([horizontal], { respond: claimed })
    ruleConflict('保留 A')
    await screen.findByRole('alert')
    act(() => { gateway.setView('pending', view()) })
    expect(screen.getByText('没有要处理的事')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(refused)
  })

  it.each([
    ['提升为全局', 'claimed', '这条适合所有项目'],
    ['留在本项目', 'not-found', '这条适合所有项目'],
    ['不再提醒', 'claimed', '带入的记忆超出上限'],
    ['以文件为准，删除这条', 'not-found', '包管理器和基线矛盾'],
  ] as const)('「%s」回 %s：同样提示，卡消失后还在', async (button, code, title) => {
    const { gateway } = setup([vertical, promote, overflow], {
      respond: command => ({ ok: false, cmd: command.cmd, code, detail: `不存在或已处理：${'decisionId' in command ? command.decisionId : ''}` }),
    })
    if (button === '以文件为准，删除这条') ruleVertical(button)
    else fireEvent.click(screen.getByRole('button', { name: button }))
    const text = `你对「${title}」的选择没有生效：它正在别处处理，或者刚在别处处理完。`
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    act(() => { gateway.setView('pending', view()) })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('可以整理的叉「不再提醒」回 not-found（记忆已在别处删掉）：同样提示，不显示原话', async () => {
    const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 'bl', filePath: '/m/app/bl.md', digest: 'sha1:bl' })] }
    setup([bloat], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found', detail: '不存在或已处理：bl' }) })
    fireEvent.click(screen.getByRole('button', { name: '不再提醒' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('你对「内容过长」的选择没有生效：它正在别处处理，或者刚在别处处理完。')
    expect(screen.queryByText(/不存在或已处理/)).toBeNull()
  })

  it('放错层「提升为全局」回 not-found（别处已提升或删掉）：同样提示，不显示原话', async () => {
    const misplaced: PendingItem = { kind: 'advice', level: 'advice', type: 'misplaced', memories: [memory({ id: 'mu', filePath: '/m/app/mu.md', digest: 'sha1:mu' })] }
    const { gateway } = setup([misplaced], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found', detail: '不存在或已处理：mu' }) })
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    const text = '你对「放错层」的选择没有生效：它正在别处处理，或者刚在别处处理完。'
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.queryByText(/不存在或已处理/)).toBeNull()
    act(() => { gateway.setView('pending', view()) })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('结果卡上的撤销碰上别处正在处理（claimed）：结果卡不动，上面写明没有生效', async () => {
    const respond = (command: MemoryCommand) => command.cmd === 'undo' ? claimed(command) : { ok: true as const, cmd: command.cmd }
    setup([horizontal], { respond })
    ruleConflict('保留 A')
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(refused)
    expect(screen.getByText('已保留「postgres-in-tests」')).toBeInTheDocument()
  })

  it('之后在任一张卡上做成了一件事：提示收起', async () => {
    let calls = 0
    const respond = (command: MemoryCommand) => { calls += 1; return calls === 1 ? claimed(command) : { ok: true as const, cmd: command.cmd } }
    setup([horizontal, promote], { respond })
    ruleConflict('保留 A')
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    await screen.findByText('已提升为全局')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('待处理：跨项目先确认', () => {
  it('服务端拒（cross-workspace）→ 卡片里写明项目、什么都没动；「继续处理」带 allowCrossWorkspace 重发；「取消」不重发', async () => {
    let calls = 0
    const respond = (command: MemoryCommand) => {
      calls += 1
      return calls === 1 || !('allowCrossWorkspace' in command && command.allowCrossWorkspace)
        ? { ok: false as const, cmd: command.cmd, code: 'cross-workspace' as const, rejected: [{ id: 'a', workspacePath: '/w/blog' }] }
        : { ok: true as const, cmd: command.cmd }
    }
    const { commands } = setup([horizontal], { respond })
    ruleConflict('保留 A')
    expect(await screen.findByText('这条记忆属于 blog 项目，不是当前项目。确定在这里处理它吗？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保留 B' })).toHaveAttribute('aria-disabled', 'true')
    // 等确认时卡上其它按钮的提示写在等你确认，不写正在处理
    expect(screen.getByRole('button', { name: '保留 B' })).toHaveAttribute('title', '等你先确认')
    // 确认块里「取消」是幽灵按钮，和「继续处理」分出主次
    expect(screen.getByRole('button', { name: '取消' })).toHaveClass('pm-btn--ghost')
    expect(screen.getByRole('button', { name: '继续处理' })).not.toHaveClass('pm-btn--ghost')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText(/属于 blog 项目/)).toBeNull()
    expect(commands()).toHaveLength(1)

    ruleConflict('保留 A')
    fireEvent.click(await screen.findByRole('button', { name: '继续处理' }))
    await screen.findByText('已保留「postgres-in-tests」')
    expect(commands()).toEqual([
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' },
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' },
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left', allowCrossWorkspace: true },
    ])
  })
})