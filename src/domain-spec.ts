import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { memoryRecordSchema, type MemoryRecord } from './record-schema.ts'

export const memoryDomainSpec = defineDomain({
  name: 'plastic_memory', // 域名正则不允许连字符（UNIT_NAME_RE），用下划线
  version: 1, // 数字，非字符串
  tables: {
    memories: domainTable<string, MemoryRecord>(memoryRecordSchema),
  },
})
