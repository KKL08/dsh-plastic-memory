import { isAbsolute } from 'node:path'
import type { CasKvTable } from '../kv-table.ts'
import type { CheckupCompletion, CheckupRecord } from '../storage/schema.ts'
import type { LayerRef } from './layer-health.ts'

/**
 * 体检记录表：每个范围一条，记这个范围最近一次做完的体检（完成记录），即「上次体检」。
 * 体检执行器在一次体检全部写完（缓存、账本、提升候选）之后才写它，这是体检的提交点：中途取消或进程退出时不写，下次照常算没查完。
 * 完成记录按开始时间「不回退」：要写的这次开始得比已有记录早，就保留已有的，开始得早、结束得晚的体检盖不掉更新的结果。
 * 表由接线层注入（storage/sidecar.ts 的 checkups），和缓存、忽略表同一种做法。
 */

const GLOBAL_KEY = 'global'

/** 范围键：全局为 `global`，项目为它的绝对路径。 */
export function checkupKey(layer: LayerRef): string {
  return layer.kind === 'global' ? GLOBAL_KEY : layer.path
}

export class CheckupRecordStore {
  private readonly table: CasKvTable<CheckupRecord>

  constructor(table: CasKvTable<CheckupRecord>) {
    this.table = table
  }

  async list(): Promise<CheckupRecord[]> {
    return (await this.table.list()).map(([, r]) => r)
  }

  /** 提交点：给这些范围各写一条完成记录，记录里的其他内容不动；已有记录开始得更晚的范围不写。 */
  async complete(layers: readonly LayerRef[], completion: CheckupCompletion): Promise<void> {
    for (const layer of layers) {
      const key = checkupKey(layer)
      await this.table.update(key, cur => cur?.completed !== undefined && cur.completed.startedAt > completion.startedAt
        ? undefined
        : { ...cur, id: key, completed: completion })
    }
  }

  /** 清掉目录已不在的项目的记录（视图生成时调用）；全局等不是项目的键不动。 */
  async removeMissingWorkspaces(workspaces: ReadonlySet<string>): Promise<void> {
    for (const r of await this.list()) {
      if (isAbsolute(r.id) && !workspaces.has(r.id)) await this.table.delete(r.id)
    }
  }
}

/**
 * 一个范围的上次体检：完成记录的完成时间；还没有完成记录（升级前体检过）时暂取内容检查缓存的时间；都没有为 null。
 */
export function lastCheckupAt(record: CheckupRecord | undefined, cachedAt: number | undefined): number | null {
  return record?.completed?.completedAt ?? cachedAt ?? null
}
