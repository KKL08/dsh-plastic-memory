import { isAbsolute } from 'node:path'
import type { CasKvTable, RefreshableClaim, RefreshableClaimKvTable } from '../kv-table.ts'
import type { CheckupCompletion, CheckupRecord } from '../storage/schema.ts'
import type { ScanCacheEntry } from './schema.ts'
import type { LayerRef } from './layer-health.ts'
import { SCOPE_KEYS, type CheckupCause, type CheckupResult } from '../gui/contract.ts'

/**
 * 体检记录表：每个范围一条，记这个范围最近一次做完的体检（完成记录），即「上次体检」。
 * 体检执行器在一次体检全部写完（缓存、账本、提升候选）之后才写它，这是体检的提交点：中途取消或进程退出时不写，下次照常算没查完。
 * 完成记录按开始时间「不回退」：要写的这次开始得比已有记录早，就保留已有的，开始得早、结束得晚的体检盖不掉更新的结果。
 * 表由接线层注入（storage/sidecar.ts 的 checkups），和缓存、忽略表同一种做法。
 *
 * 按范围认领：界面手动体检和自动体检开跑前认领这些范围（认领文件在记录旁边，跨进程互斥），同一个范围同时只体检一次；
 * 「进行中」不存进记录，就是认领还在、没过期。agent 的 memory_scan 不认领，靠完成记录和缓存的「不回退」兜底。
 */

/** 范围键：全局为 `global`，项目为它的绝对路径。 */
export function checkupKey(layer: LayerRef): string {
  return layer.kind === 'global' ? SCOPE_KEYS.global : layer.path
}

export class CheckupRecordStore {
  private readonly table: CasKvTable<CheckupRecord> & RefreshableClaimKvTable<CheckupRecord>

  constructor(table: CasKvTable<CheckupRecord> & RefreshableClaimKvTable<CheckupRecord>) {
    this.table = table
  }

  /**
   * 认领这些范围：全部认领到才算，返回各自的认领（持有者要定时刷新，见 gui/auto-checkup.ts holdCheckups）；
   * 有一个认领不到就把已认领的立刻放掉，返回那个正在体检的范围。
   */
  async claim(layers: readonly LayerRef[]): Promise<{ claims: RefreshableClaim[] } | { busy: LayerRef }> {
    const claims: RefreshableClaim[] = []
    for (const layer of layers) {
      const claim = await this.table.claimRefreshable(checkupKey(layer))
      if (claim === undefined) {
        for (const held of claims) await held.release()
        return { busy: layer }
      }
      claims.push(claim)
    }
    return { claims }
  }

  /** 这个范围此刻在体检：有体检认领着它，认领没过期。 */
  isInProgress(layer: LayerRef): Promise<boolean> {
    return this.table.isClaimed(checkupKey(layer))
  }

  async list(): Promise<CheckupRecord[]> {
    return (await this.table.list()).map(([, r]) => r)
  }

  /**
   * 提交点：给这些范围各写一条完成记录；已有记录开始得更晚的范围不写。这个范围查完了，自动体检的连续失败和「模型用不了」
   * 一并清掉（手动体检成功后失败计数清零，下次按新的完成记录计时），记录里的其他内容不动。
   */
  async complete(layers: readonly LayerRef[], completion: CheckupCompletion): Promise<void> {
    for (const layer of layers) {
      const key = checkupKey(layer)
      await this.table.update(key, (cur) => {
        if (cur?.completed !== undefined && cur.completed.startedAt > completion.startedAt) return undefined
        const { failure: _failure, modelUnavailable: _modelUnavailable, ...rest } = cur ?? { id: key }
        return { ...rest, id: key, completed: completion }
      })
    }
  }

  /**
   * 自动体检这次没做完（模型调用出错、输出解析不了、体检出错）：连续失败次数加一，记下失败时刻（重试时间在生成体检视图时
   * 按当时的有效频率算，用户之后改频率跟着变）；最近一次尝试不再是「模型用不了」。不写完成记录，不重新计时。持有这个范围的认领时调用。
   */
  async recordFailure(layer: LayerRef, cause: CheckupCause, failedAt: number): Promise<void> {
    const key = checkupKey(layer)
    await this.table.update(key, (cur) => {
      const { modelUnavailable: _modelUnavailable, ...rest } = cur ?? { id: key }
      const count = (cur?.failure?.count ?? 0) + 1
      return { ...rest, id: key, failure: { count, failedAt, cause } }
    })
  }

  /**
   * 自动体检这次碰上模型用不了（没有默认模型、未登录、缺凭据）：记下原因。不算失败：失败次数和重试时间不动，下一次调度检查再试。
   * since 是这轮检查的开始时间：要记的范围是那时读出来的，之后已经有体检做完（完成时间不早于它）的不记，免得给刚查完的范围记上。
   */
  async recordModelUnavailable(layer: LayerRef, cause: CheckupCause, since: number): Promise<void> {
    const key = checkupKey(layer)
    await this.table.update(key, cur => (cur?.completed !== undefined && cur.completed.completedAt >= since ? undefined : { ...cur, id: key, modelUnavailable: cause }))
  }

  /**
   * 界面手动体检、自动体检结束时记下最近一次结果（键 → 结果，见 gui/views.ts checkupResults），换掉这个键上一次的结果，
   * 记录里的其他内容不动。键 all 的那条只有结果：没有完成记录、不参与到期、没有失败计数。持有这些范围的认领时调用。
   */
  async recordResults(results: ReadonlyArray<{ key: string; result: CheckupResult }>): Promise<void> {
    for (const { key, result } of results) await this.table.update(key, cur => ({ ...cur, id: key, lastResult: result }))
  }

  /** 清掉目录已不在的项目的记录（视图生成时调用）；全局、all 等不是项目的键不动。 */
  async removeMissingWorkspaces(workspaces: ReadonlySet<string>): Promise<void> {
    for (const r of await this.list()) {
      if (isAbsolute(r.id) && !workspaces.has(r.id)) await this.table.delete(r.id)
    }
  }
}

/**
 * 一个范围的上次体检：完成记录的完成时间；还没有完成记录（升级前体检过）时暂取内容检查缓存的时间；都没有为 null。
 * 兜底只认升级前的旧缓存：新执行器写的缓存（isTrackedByCheckups）在提交点之前就写了，被中断的体检会留下它。
 */
export function lastCheckupAt(record: CheckupRecord | undefined, cached: Pick<ScanCacheEntry, 'scannedAt' | 'isTrackedByCheckups'> | undefined): number | null {
  const fallback = cached !== undefined && cached.isTrackedByCheckups !== true ? cached.scannedAt : null
  return record?.completed?.completedAt ?? fallback
}
