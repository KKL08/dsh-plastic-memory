import type { ResolvedLlm } from '../governance/background-llm.ts'
import { isAbort } from '../governance/semantic-scan.ts'
import { scopeKey } from '../scope.ts'
import type { DreamsStep } from './dreams-run.ts'
import { runScan, ScanStopped, type ScanCoreDeps } from './scan.ts'

/**
 * 记忆梦境里的增量体检：一次运行里查一遍这个范围的内容，新写下的矛盾挂进账本，同一次运行里处理矛盾那一步接着处理。
 * 用的是体检核心的增量模式（成员和判断上下文都没变的批不再问模型），不做到期刷新；不写体检完成记录、不约下次。
 */

/** 梦境里的体检要的：体检核心的依赖（不带体检记录）、体检用的模型。 */
export interface CheckupStepDeps {
  scan: Omit<ScanCoreDeps, 'checkups'>
  /** 体检选的模型，没选或选的用不了时是宿主默认模型（同手动、自动体检）。 */
  resolveLlm: () => Promise<ResolvedLlm>
}

/**
 * 运行计划里的体检一步（排在合并零碎记忆之后、下钻补全之前）。每次都做（不看有没有新变化）：没变的批命中库里的结论，不调模型。
 * 梦境整次运行占着这个范围的体检认领，手动、自动体检这期间拿不到认领；这里直接调体检核心，不另认领。
 * 没做成不中止这次运行，记一条跳过（kind checkup），后面的步骤照常处理账本里已有的发现：取模型出错、体检出错记 failed，
 * 拿不到模型记 model-unavailable，体检核心报错记 error，这一轮收尾不是 complete 的记收尾码（capped、failed、model-unavailable 等）。
 * 范围里没有要查的内容（没有轮）算做完。用量按每次模型调用记进这次运行；token 上限照体检的配置排批。
 * 让路、认领被接手时体检核心在写入检查点停下（抛 ScanStopped），这一步正常返回，由运行按让路收；
 * 其余 AbortError 只在这次运行确实在停（让路、取消、认领被接手）时同样处理，不然照出错记 failed。
 */
export const checkupStep = (deps: CheckupStepDeps): DreamsStep => ({
  name: 'checkup',
  needsChanges: false,
  async run(ctx) {
    const log = deps.scan.log ?? console
    const skip = (reason: string) => ctx.skip({ kind: 'checkup', target: scopeKey(ctx.scope), reason })
    let llm: ResolvedLlm['llm']
    try {
      llm = (await deps.resolveLlm()).llm
    } catch (err) {
      log.warn('[plastic-memory] 记忆梦境里的体检取不到模型，这次跳过', err)
      skip('failed')
      return
    }
    if (llm === null) { skip('model-unavailable'); return }
    const usage: Array<Promise<void>> = []
    try {
      const result = await runScan({
        target: { kind: 'scope', scope: ctx.scope }, llm, isRefreshSkipped: true, shouldStop: ctx.shouldStop,
        onUsage: (tokens) => { usage.push(ctx.addUsage(tokens)) },
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      }, deps.scan)
      if (result.kind === 'error') { skip('error'); return }
      const closing = result.rounds?.[0]?.closing
      if (closing !== undefined && closing !== 'complete') skip(closing)
    } catch (err) {
      if (err instanceof ScanStopped || (isAbort(err, ctx.signal) && ctx.shouldStop())) return
      log.warn('[plastic-memory] 记忆梦境里的体检出错，这次跳过', err)
      skip('failed')
    } finally {
      await Promise.all(usage)
    }
  },
})
