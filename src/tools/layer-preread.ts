import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { KvTable } from '../kv-table.ts'
import type { ScanCacheEntry } from '../governance/schema.ts'
import type { LayerPreread } from '../governance/layer-health.ts'
import type { QuarantineEntry } from '../storage/table.ts'

/**
 * memory_health 与 memory_scan 共用的预读：两个工具从同一个函数取评分输入，对同一层永远同分。
 * 预读范围：记录取全部状态（active + superseded + deleted）——规则扫描要分辨取代链引用，
 * 缓存过滤要核对跨层记录是否存活；现阶段不按层收窄（取代链与跨层 finding 可指向其他层，
 * 如提升到 global 后 global 记录的 supersedes 指向 workspace 旧条），按范围读取留给票 09。
 * 隔离清单与记录出自同一次读取；另取待决账本全量、语义缓存全部条目。
 */
export async function prereadLayers(deps: {
  store: MemoryStore
  decisions: PendingDecisionsStore
  cache: KvTable<ScanCacheEntry>
  /** 过渡的测试桩：给了就覆盖本次读取到的隔离清单（InMemoryTable 没有隔离文件）；票 09 执行器切换时删除。 */
  getQuarantined?: () => readonly QuarantineEntry[]
}): Promise<LayerPreread> {
  const { records, quarantined } = await deps.store.readAll()
  return {
    byId: new Map(records.map(r => [r.id, r])),
    pending: await deps.decisions.list(),
    cache: new Map(await deps.cache.list()),
    quarantined: deps.getQuarantined?.() ?? quarantined,
  }
}
