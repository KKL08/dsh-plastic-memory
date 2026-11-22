import { PendingDecisionsStore, type PendingTable } from '../../src/governance/decisions.ts'
import { SnapshotStore } from '../../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../../src/governance/advice-ignores.ts'
import { CheckupRecordStore } from '../../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../../src/governance/auto-checkups.ts'
import { type MemorySnapshot, type PendingDecision, type ScanCacheEntry, type AdviceIgnore } from '../../src/governance/schema.ts'
import type { SidecarStore } from '../../src/storage/sidecar.ts'
import { FileTable, type FileTableOptions } from '../../src/storage/file-table.ts'
import { MemoryStore, type MemoryLogger, type MemoryTable } from '../../src/store.ts'

export { sidecarSchemas } from './sidecar-schemas.ts'

type PluginSidecar = SidecarStore<MemorySnapshot, PendingDecision, ScanCacheEntry, AdviceIgnore>

// 插件环境的装配：时钟、锁、宿主服务和视图收集器由调用方各自给。
export function createPluginEnv(sidecar: PluginSidecar, fileOptions: FileTableOptions, options: { log?: MemoryLogger; table?: MemoryTable; pending?: PendingTable; lock?: PluginSidecar['lock'] } = {}) {
  return {
    store: new MemoryStore(options.table ?? new FileTable(fileOptions), options.log, sidecar.recallStats),
    decisions: new PendingDecisionsStore(options.pending ?? sidecar.pending, options.lock ?? sidecar.lock),
    snapshots: new SnapshotStore(sidecar.snapshots),
    ignores: new AdviceIgnoreStore(sidecar.adviceIgnores),
    checkups: new CheckupRecordStore(sidecar.checkups),
    autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups),
    cache: sidecar.scanCache,
  }
}
