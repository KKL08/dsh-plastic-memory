// 整理工作区：步骤条与选中时的快照。
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { memory, renderInShell } from '../test-utils.tsx'
import { BatchSteps, toBatchItems } from './batch-edit.tsx'

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
