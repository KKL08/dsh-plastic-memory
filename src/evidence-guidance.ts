import type { SearchSource } from './contract-codes.ts'

export type EvidenceLookupLevel = 'off' | 'strict' | 'active'

/**
 * 证据下钻引导：按 evidenceLookup 档位选一段拼进注入快照。
 * 铁规矩：三段文案各自自包含、禁止互相引用——运行时只有一段在场，跨段引用是悬空的。
 * 这一套用在记忆带原话关着时。
 */
export const EVIDENCE_GUIDANCE: Record<EvidenceLookupLevel, string> = {
  off: [
    '每条记忆都带有来源锚（产生它的会话与位置）。日常直接使用记忆即可，不必回查原始轨迹；',
    '仅当用户明确要求核对某条记忆的来源时，才用 memory_source 填记忆 id 回查。',
  ].join(''),
  strict: [
    '每条记忆都带有来源锚（产生它的会话与位置），可用 memory_source 填记忆 id 回查它的原始出处。',
    '默认直接使用记忆。仅在以下情况回查：① 记忆与用户当前说法存在严重矛盾；',
    '② 两条记忆互相存在明确矛盾；③ 你将基于某条记忆做高代价或不可逆的动作，',
    '对项目结果有重大影响，且这条记忆是最核心的决定性依据。其余情况不要回查。',
  ].join(''),
  active: [
    '每条记忆都带有来源锚（产生它的会话与位置），可用 memory_source 填记忆 id 回查它的原始出处。',
    '默认直接使用记忆；判断需要更多背景时可回查，典型情况：① 记忆与用户当前说法矛盾；',
    '② 记忆之间互相矛盾；③ 将基于某条记忆做高代价或不可逆的动作；',
    '④ 记忆摘要不足以支撑当前动作，需要当时的约束、原因或具体细节；',
    '⑤ 标注「模型推断，未经确认」的低置信记忆将影响你的行动；⑥ 用户问起某条记忆的来龙去脉。',
    '纯好奇、与当前任务无关、或只是复述记忆内容时，不要回查。',
  ].join(''),
}

/** 两套共用的开头：出处原话随检索结果附带，以及原话不够时的去处。 */
const QUOTES_ATTACHED = '每条记忆都带有来源锚（产生它的会话与位置）。memory_search 返回记忆条目时，排在前面的几条下面可能附有出处那一轮的原话（用户的话和助手的回答）。'
const QUOTES_NOT_ENOUGH = '附带的原话不够时（没附原话、要更前后的上下文或工具输出），再用 memory_source 填记忆 id 回查。'

/** 记忆带原话开着时的三段：先看检索结果里附带的原话，不够再回查。同样各自自包含。 */
export const EVIDENCE_GUIDANCE_WITH_QUOTES: Record<EvidenceLookupLevel, string> = {
  off: [
    QUOTES_ATTACHED,
    '日常直接使用记忆和附带的原话。用户明确要求核对某条记忆的来源、而附带的原话不够时（没附原话、要更前后的上下文或工具输出），',
    '用 memory_source 填记忆 id 回查。',
  ].join(''),
  strict: [
    QUOTES_ATTACHED,
    '默认直接使用记忆。以下情况先看附带的原话核对：① 记忆与用户当前说法存在严重矛盾；',
    '② 两条记忆互相存在明确矛盾；③ 你将基于某条记忆做高代价或不可逆的动作，',
    '对项目结果有重大影响，且这条记忆是最核心的决定性依据。',
    QUOTES_NOT_ENOUGH,
    '其余情况直接使用记忆。',
  ].join(''),
  active: [
    QUOTES_ATTACHED,
    '默认直接使用记忆；判断需要更多背景时先看附带的原话，典型情况：① 记忆与用户当前说法矛盾；',
    '② 记忆之间互相矛盾；③ 将基于某条记忆做高代价或不可逆的动作；',
    '④ 记忆摘要不足以支撑当前动作，需要当时的约束、原因或具体细节；',
    '⑤ 标注「模型推断，未经确认」的低置信记忆将影响你的行动；⑥ 用户问起某条记忆的来龙去脉。',
    QUOTES_NOT_ENOUGH,
    '回查只用在和当前任务相关的记忆上；只是复述记忆内容时，直接使用记忆。',
  ].join(''),
}

/** 按引用看消息有长度上限：提醒留意截断提示，别以为看到的就是整条。 */
const TRUNCATION_HINT = '返回的内容有长度上限，留意其中的截断提示。'
/**
 * 检索结果里会出现消息引用时（来源含原话，或记忆带原话开着）每段末尾补的一句：什么时候拿引用看这条消息的更多内容。
 * 按档位各一句，接在同档那段后面，自己说清什么时候查，不指代前面的条目。
 */
export const MESSAGE_REF_GUIDANCE: Record<EvidenceLookupLevel, string> = {
  off: `检索结果里的原话只给了某条消息的节选、而用户明确要求看这条消息的更多内容时，用 memory_source 带上这条消息的引用查看。${TRUNCATION_HINT}`,
  strict: `检索结果里的原话只给了某条消息的节选，而你要靠这条消息判断说法之间的矛盾、要据此做高代价或不可逆的动作，或用户明确要求看原话时，用 memory_source 带上这条消息的引用查看更多内容。${TRUNCATION_HINT}`,
  active: `检索结果里的原话只给了某条消息的节选、需要这条消息的更多内容时，用 memory_source 带上这条消息的引用查看。${TRUNCATION_HINT}`,
}

/** 检索来源含原话：配置的 search.source 是 dialogue 或 both。引导在快照里，冻结时只看配置，不看单次检索的参数。 */
export function hasDialogueSource(source: SearchSource): boolean {
  return source !== 'memory'
}

/** 拼进快照的那段引导：记忆带原话决定用哪套三段；来源含原话或记忆带原话开着（结果里都会有消息引用）时补引用那句。 */
export function evidenceGuidance(level: EvidenceLookupLevel, opts: { memoryQuotes: boolean; searchSource: SearchSource }): string {
  const base = (opts.memoryQuotes ? EVIDENCE_GUIDANCE_WITH_QUOTES : EVIDENCE_GUIDANCE)[level]
  return hasDialogueSource(opts.searchSource) || opts.memoryQuotes ? base + MESSAGE_REF_GUIDANCE[level] : base
}
