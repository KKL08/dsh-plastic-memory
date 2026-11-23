import { expect, it } from 'vitest'
import { shortestFailure } from './helpers/random-sequence.ts'

it('缩减会找到最短失败子序列，保留操作的原始标识', async () => {
  const input = [0, 1, 2, 3]
  expect(await shortestFailure(input, async xs => xs.includes(1) && xs.includes(3))).toEqual([1, 3])
})

it('缩减不假设失败具有单调性', async () => {
  expect(await shortestFailure([0, 1, 2], async xs => xs.length === 3 || xs.length === 1 && xs[0] === 2)).toEqual([2])
})

it('相同种子重建完全相同的操作与调度输入', async () => {
  const fc = (await import('fast-check')).default
  const { sequenceCase } = await import('./helpers/random-sequence.ts')
  const arbitrary = fc.array(fc.integer(), { maxLength: 6 })
  expect(sequenceCase(73, arbitrary)).toEqual(sequenceCase(73, arbitrary))
  expect(sequenceCase(73, arbitrary)).not.toEqual(sequenceCase(74, arbitrary))
})

it('失败报告带种子、最短子序列和调度，缩减不改变操作标识', async () => {
  const { checkSequence } = await import('./helpers/random-sequence.ts')
  await expect(checkSequence(73, [0, 1, 2], [1, 0], async xs => {
    if (xs.includes(2)) throw new Error('写入遗漏')
  })).rejects.toThrow('种子：73\n最短失败子序列：[2]\n调度：[1,0]')
})
