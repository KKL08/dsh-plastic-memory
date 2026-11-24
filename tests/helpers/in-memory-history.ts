import { byVersionEnd, freeVersionId, type HistoryLayer, type HistoryVersion, type VersionHistory } from '../../src/storage/history.ts'

/** 没有磁盘的实现（内存表配它）：语义同磁盘上的实现。 */
export class InMemoryVersionHistory implements VersionHistory {
  private readonly versions = new Map<string, HistoryVersion[]>()
  private key(layer: Pick<HistoryLayer, 'dir'>, memoryId: string): string {
    if (memoryId === '') throw new Error('历史版本要有记忆 id，空 id 不收')   // 同磁盘那份
    return `${layer.dir}\n${memoryId}`
  }

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

  async removeAll(dir: string, memoryId: string): Promise<void> {
    this.versions.delete(this.key({ dir }, memoryId))
  }

  async move(fromDir: string, toDir: string, memoryId: string): Promise<void> {
    const from = this.key({ dir: fromDir }, memoryId)
    const to = this.key({ dir: toDir }, memoryId)
    const moving = this.versions.get(from)
    if (from === to || moving === undefined) return
    const kept = this.versions.get(to) ?? []
    for (const version of moving) {
      const same = kept.find(v => v.versionId === version.versionId)
      if (same !== undefined && JSON.stringify(same) === JSON.stringify(version)) continue
      kept.push({ ...version, versionId: freeVersionId(version.versionId, kept.map(v => v.versionId)) })
    }
    this.versions.set(to, kept)
    this.versions.delete(from)
  }

  async memoryIds(dir: string): Promise<string[]> {
    return [...this.versions].filter(([key, list]) => key.startsWith(`${dir}\n`) && list.length > 0).map(([key]) => key.slice(dir.length + 1))
  }
}
