import type { MemoryRecord } from '../record-schema.ts'
import { SEVERITY_BY_TYPE, type Finding } from './schema.ts'
import { premiseDigest } from '../links.ts'
import { maskSecretSurface } from '../secrets.ts'
import { injectionText } from '../index-line.ts'
import { sha1 } from './changeset.ts'

/**
 * 依据已变：决定记下的前提（premises 里每项的 id 和当时的内容摘要）和被依据的记忆现在的内容摘要（premiseDigest）对不上。
 * 代码直接比，不问模型；只报，不改决定那条记忆。
 */

/**
 * 按 owner 能够着的作用域（项目记忆看本项目和全局，全局记忆只看全局）找前提那条在用的记忆；找不到、不在用、够不着的为 undefined。
 * 由调用方按这次体检读到的记忆给出。
 */
export type PremiseLookup = (owner: MemoryRecord, premiseId: string) => MemoryRecord | undefined

/**
 * 这批记忆里依据已变的前提，每个（决定，前提）一条发现：type premise-changed、layer rule、severity 按 SEVERITY_BY_TYPE，
 * memoryIds 是 [决定的 id, 前提的 id]，summary、suggestedAction 提到记忆时写 name。只看在用的记忆；
 * 前提找不到（lookup 为 undefined）的跳过，不算依据已变。同一条记忆的 premises 里同一个 id 写了几次只报一次。
 */
export function findPremiseChanges(records: readonly MemoryRecord[], lookup: PremiseLookup): Finding[] {
  const findings: Finding[] = []
  for (const record of records) {
    if (record.status !== 'active') continue
    const seen = new Set<string>()
    for (const premise of record.premises ?? []) {
      if (seen.has(premise.id)) continue
      seen.add(premise.id)
      const found = lookup(record, premise.id)
      if (found === undefined || premiseDigest(found) === premise.digest) continue
      const decisionName = injectionText(maskSecretSurface(record, { severity: 'suspected' }).name)
      const premiseName = injectionText(maskSecretSurface(found, { severity: 'suspected' }).name)
      findings.push({
        type: 'premise-changed', layer: 'rule', severity: SEVERITY_BY_TYPE['premise-changed'],
        memoryIds: [record.id, premise.id],
        summary: `「${decisionName}」依据的「${premiseName}」改过了`,
        suggestedAction: `复查「${decisionName}」在「${premiseName}」改动后是否还成立`,
      })
    }
  }
  return findings
}

/**
 * 依据已变挂账用的指纹：决定的 id、前提的 id、前提此刻的内容摘要。用户忽略之后，前提没再变就不再报；前提又改了（摘要变了）就重新报。
 * 决定那条自己改了不影响它。
 */
export function premiseChangeFingerprint(decisionId: string, premiseId: string, currentDigest: string): string {
  return sha1([decisionId, premiseId, currentDigest])
}
