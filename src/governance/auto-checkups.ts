import { isAbsolute } from 'node:path'
import type { KvTable } from '../kv-table.ts'
import type { AutoCheckupSetting } from '../storage/schema.ts'
import { AUTO_CHECKUP_FOLLOW, scopeKey, type AutoCheckupFrequency, type ScopeRef } from '../gui/contract.ts'

/**
 * 自动体检的设置表和到期计算。
 *
 * 设置表：每个范围最多一条（`all` 是「全部」的默认值）。选具体值写条目，和默认值相同也写；「跟随」删条目。
 * 继承解析在契约（gui/contract.ts resolveAutoCheckup），这里只管读写。表由接线层注入（storage/sidecar.ts 的 autoCheckups）。
 * 不放配置文件：设置要被桌面版、`dsh web`、命令行几个进程共用，各 profile 的配置文件做不到（见 spec「设置存放」）。
 */
export class AutoCheckupSettingStore {
  private readonly table: KvTable<AutoCheckupSetting>

  constructor(table: KvTable<AutoCheckupSetting>) {
    this.table = table
  }

  /** 设置表的内容：范围键 → 设了的频率。 */
  async read(): Promise<Map<string, AutoCheckupFrequency>> {
    return new Map((await this.table.list()).map(([, s]) => [s.id, s.frequency]))
  }

  /** 写一个范围的设置；follow 删掉它（本来就没有也算成功）。 */
  async set(scope: ScopeRef, frequency: AutoCheckupFrequency | typeof AUTO_CHECKUP_FOLLOW): Promise<void> {
    const key = scopeKey(scope)
    if (frequency === AUTO_CHECKUP_FOLLOW) await this.table.delete(key)
    else await this.table.put(key, { id: key, frequency })
  }

  /** 清掉目录已不在的项目的设置（视图生成时调用）；「全部」和全局不动。 */
  async removeMissingWorkspaces(workspaces: ReadonlySet<string>): Promise<void> {
    for (const key of (await this.read()).keys()) {
      if (isAbsolute(key) && !workspaces.has(key)) await this.table.delete(key)
    }
  }
}

const DAY_MS = 86_400_000

/**
 * 到期计算：有效频率是每 N 天时，上次体检之后满 N × 24 小时到期，下次自动体检是上次加 N 天；错过几个周期也只是到期，不往后推。
 * 从没体检过的一开自动体检就到期（没有下次时间）。仅手动从不到期。
 */
export function autoCheckupDue(frequency: AutoCheckupFrequency, lastCheckupAt: number | null, now: number): { nextCheckupAt: number | null; isDue: boolean } {
  if (frequency === 'manual') return { nextCheckupAt: null, isDue: false }
  if (lastCheckupAt === null) return { nextCheckupAt: null, isDue: true }
  const nextCheckupAt = lastCheckupAt + frequency * DAY_MS
  return { nextCheckupAt, isDue: now >= nextCheckupAt }
}

/** 自动体检没做完后，同一范围隔这么久再试。 */
export const AUTO_CHECKUP_RETRY_MS = 3_600_000
/** 连续没做完这么多次后，不再 1 小时一试，等到下一个周期。 */
export const AUTO_CHECKUP_MAX_FAILURES = 3

/** 连续失败到了上限（第 3、6、9…… 次）：这次之后等到下一个周期。 */
export function isRetryLimitReached(failures: number): boolean {
  return failures % AUTO_CHECKUP_MAX_FAILURES === 0
}

/**
 * 自动体检第 failures 次连续没做完之后的重试时间：没到上限 1 小时后，到了上限等一个周期（失败时刻加有效频率的天数）。
 * 下一个周期又没做完，照样 1 小时一试、试满 3 次再等下一个周期。失败不写完成记录，不重新计时。
 */
export function autoCheckupRetryAt(failures: number, failedAt: number, frequencyDays: number): number {
  return failedAt + (isRetryLimitReached(failures) ? frequencyDays * DAY_MS : AUTO_CHECKUP_RETRY_MS)
}
