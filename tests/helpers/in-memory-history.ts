import { byVersionEnd, type HistoryLayer, type HistoryVersion, type VersionHistory } from '../../src/storage/history.ts'

/** 没有磁盘的实现（内存表配它）：语义同磁盘上的实现。 */
export class InMemoryVersionHistory implements VersionHistory {
  private readonly versions = new Map<string, HistoryVersion[]>()
  private key(layer: HistoryLayer, memoryId: string): string { return `${layer.dir}\n${memoryId}` }

  async list(layer: HistoryLayer, memoryId: string): Promise<HistoryVersion[]> {
    return structuredClone(this.versions.get(this.key(layer, memoryId)) ?? []).sort(byVersionEnd)
  }

  async write(layer: HistoryLayer, version: HistoryVersion): Promise<void> {
    const key = this.key(layer, version.record.id)
    const rest = (this.versions.get(key) ?? []).filter(v => v.versionId !== version.versionId)
    this.versions.set(key, [...rest, structuredClone(version)])
  }

  async remove(layer: HistoryLayer, memoryId: string, versionId: string): Promise<void> {
    const key = this.key(layer, memoryId)
    this.versions.set(key, (this.versions.get(key) ?? []).filter(v => v.versionId !== versionId))
  }
}
