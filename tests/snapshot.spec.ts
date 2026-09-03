import { describe, expect, it, vi } from 'vitest'
import { assembleSnapshot, estimateTokens, COLD_START_TEXT } from '../src/snapshot.ts'
import { EVIDENCE_GUIDANCE } from '../src/evidence-guidance.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { DAY } from './helpers/clock.ts'
import { STALENESS_NOTE } from '../src/record-freshness.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

// 本文件默认时间戳为 0。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: 0, updatedAt: 0, lastConfirmedAt: 0, ...partial })

describe('assembleSnapshot', () => {
  const base = { registry, workspacePath: undefined, budget: 4000, now: 10 * DAY }

  it('记忆库为空输出冷启动文案，coreIds 为空数组', () => {
    const store = new MemoryStore(new InMemoryTable())
    expect(assembleSnapshot({ ...base, store })).toEqual({ text: COLD_START_TEXT, coreIds: [] })
  })

  it('core 类型正文出现在 core 区（带 id），且不在索引区重复；passive 只显示 name', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_core', name: 'mock 禁令', type: 'preference', content: '不要 mock 数据库', summary: '测试不 mock 数据库' }))
    await store.put(record({ id: 'mem_ref', name: '看板', type: 'reference', content: '看板在 https://x.dev', summary: '团队看板的地址' }))
    const { text } = assembleSnapshot({ ...base, store })
    expect(text).toContain('不要 mock 数据库')
    expect(text).toMatch(/\[mem_core\]【记忆·[^】]+】不要 mock 数据库/) // ⑤+id：core 区带 id 与归属前缀
    expect(text.match(/mem_core/g)?.length).toBe(1)                    // core 只出现一次（索引区不重复）
    expect(text).not.toContain('测试不 mock 数据库')                     // core 摘要不出现（正文已给）
    expect(text).toContain('[mem_ref] 看板')                            // 非 core 仍在索引区
    expect(text).not.toContain('团队看板的地址')
  })

  it('⑧ 磁盘路径只透 global + 当前项目，不透其他 workspace（跨项目隔离）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_core', type: 'preference', content: '不要 mock 数据库' }))
    // 无 workspace（global-only）：只透 global，不指向任何项目目录、不说"各 workspace 子目录"
    const globalOnly = assembleSnapshot({ ...base, store, memoryRoot: '/home/.dsh/memories' })
    expect(globalOnly.text).toContain('/home/.dsh/memories/global/')
    expect(globalOnly.text).not.toContain('各 workspace 子目录')
    // 有 workspace：透 global + 当前项目目录（workspaceDirName），并叮嘱别读其他 workspace
    const withWs = assembleSnapshot({ ...base, store, workspacePath: '/repo/myproj', memoryRoot: '/home/.dsh/memories' })
    expect(withWs.text).toContain('/home/.dsh/memories/global/')
    expect(withWs.text).toContain(`/home/.dsh/memories/${workspaceDirName('/repo/myproj')}/`)
    expect(withWs.text).toMatch(/其他项目|别的 workspace|不要.*读/)
    // 未提供 memoryRoot：无路径行
    const withoutRoot = assembleSnapshot({ ...base, store })
    expect(withoutRoot.text).not.toContain('记忆文件在磁盘')
  })

  it('超过衰减期未确认的记忆，注入行尾带陈旧度标注；期内不带', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_p', type: 'project', lastConfirmedAt: 0, summary: '冻结到三月' }))          // project 衰减 7 天，now=10 天 → 超期
    await store.put(record({ id: 'mem_fresh', type: 'project', lastConfirmedAt: 9 * DAY, summary: '新决定' }))    // 1 天前确认 → 期内
    await store.put(record({ id: 'mem_core', type: 'preference', lastConfirmedAt: 0, content: '偏好内容' }))       // decayDays=null 永不标注
    const { text } = assembleSnapshot({ ...base, store })
    const lineOf = (id: string) => text.split('\n').find(l => l.includes(id))!
    expect(lineOf('mem_p')).toContain(STALENESS_NOTE(10))
    // 任何天数的陈旧标注都不该出现在期内记录上：正则由模板常量派生，文案改了也跟着改
    expect(lineOf('mem_fresh')).not.toMatch(new RegExp(STALENESS_NOTE(0).replace('0', '\\d+')))
    expect(text).not.toMatch(/偏好内容.*未确认/)
  })

  it('validTo 已过期的记忆不进注入（治理扫描仍可见）；未过期的照常', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_dead', validTo: 9 * DAY, summary: '已失效约定' }))
    await store.put(record({ id: 'mem_alive', validTo: 11 * DAY, summary: '仍有效约定' }))
    const { text } = assembleSnapshot({ ...base, store })
    expect(text).not.toContain('mem_dead')
    expect(text).toContain('mem_alive')
  })

  it('库里只剩 validTo 过期记忆时不误报冷启动', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_dead', validTo: 9 * DAY }))
    const { text } = assembleSnapshot({ ...base, store })
    expect(text).not.toBe(COLD_START_TEXT)
  })

  it('超预算时丢弃低优先级组并注明剩余数量', async () => {
    const store = new MemoryStore(new InMemoryTable())
    for (let i = 0; i < 200; i++) {
      await store.put(record({ id: `mem_k${i}`, type: 'knowledge', summary: `知识条目${i}`.repeat(8) }))
      await store.put(record({ id: `mem_r${i}`, type: 'reference' }))
    }
    const { text } = assembleSnapshot({ ...base, store, budget: 800 })
    expect(text).toMatch(/另有 \d+ 条/)
  })

  it('返回 coreIds 为进入 core 区的记忆 id，且不产生 markRecalled 副作用（纯函数）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const spy = vi.spyOn(store, 'markRecalled')
    await store.put(record({ id: 'mem_core', name: 'mock 禁令', type: 'preference', content: '不要 mock 数据库', summary: '测试不 mock 数据库' }))
    await store.put(record({ id: 'mem_ref', name: '看板', type: 'reference', content: '看板在 https://x.dev', summary: '团队看板的地址' }))
    const { coreIds } = assembleSnapshot({ ...base, store })
    expect(coreIds).toEqual(['mem_core'])
    expect(spy).not.toHaveBeenCalled()
  })

  it('evidenceLookup 给出时拼对应档位文案；缺省与空库不拼', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_1' }))
    for (const level of ['off', 'strict', 'active'] as const) {
      const { text } = assembleSnapshot({ ...base, store, evidenceLookup: level })
      expect(text).toContain(EVIDENCE_GUIDANCE[level])
    }
    // 三档行为差异靠关键词粗验：strict 有硬信号限定、active 有低置信路标、off 不列举回查条件
    expect(EVIDENCE_GUIDANCE.strict).toContain('严重矛盾')
    expect(EVIDENCE_GUIDANCE.active).toContain('模型推断，未经确认')
    expect(EVIDENCE_GUIDANCE.off).not.toContain('矛盾')
    // 缺省（纯测试场景）不拼
    expect(assembleSnapshot({ ...base, store }).text).not.toContain('memory_source')
    // 空库冷启动路径不拼（没有记忆就没有锚）
    const empty = new MemoryStore(new InMemoryTable())
    expect(assembleSnapshot({ ...base, store: empty, evidenceLookup: 'active' }).text).toBe(COLD_START_TEXT)
  })

  it('三段档位文案各自自包含：不引用其他档位名（运行时只有一段在场，跨段引用是悬空的）', () => {
    for (const [level, text] of Object.entries(EVIDENCE_GUIDANCE)) {
      for (const other of ['off', 'strict', 'active']) {
        if (other !== level) expect(text).not.toContain(other)
      }
      expect(text).toContain('memory_source') // 每段都要能独立指路到回查工具
    }
  })

  it('体积相近时按 governancePriority 方向丢弃：只丢 low 组，保留 high 组', async () => {
    // 上一个用例两组都远超预算、必然都被丢弃，排序方向写反也能过，是弱信号。
    // 这里让两组体积严格相等（内容仅"高/低"一字之差），预算精确卡在"刚好放得下 high 组，
    // 放不下再加 low 组"的临界点——如果排序方向写反（先丢 high 组），断言会失败。
    const store = new MemoryStore(new InMemoryTable())
    const priorityRegistry = buildTypeRegistry({
      template: 'coding',
      customTypes: {
        ztypeh: { label: '高优先级组', description: '', whenToSave: '', recall: 'search', decayDays: null, governancePriority: 'high' },
        ztypel: { label: '低优先级组', description: '', whenToSave: '', recall: 'search', decayDays: null, governancePriority: 'low' },
      },
    })
    const highRec = record({ id: 'mem_h01', type: 'ztypeh', name: '高优先级条目', summary: '高优先级组摘要内容占位文本' })
    const lowRec = record({ id: 'mem_l01', type: 'ztypel', name: '低优先级条目', summary: '低优先级组摘要内容占位文本' })
    await store.put(highRec)
    await store.put(lowRec)

    const now = 10 * DAY
    const highDef = priorityRegistry.get('ztypeh')
    // 逐条估算：预算 = 顶头 + high 组头 + high 单条行，恰好放下 high 组、放不下 low 组头。
    const headerCost = estimateTokens('# 长期记忆')
    const budget = headerCost
      + estimateTokens(`\n## ${highDef.label}（ztypeh）`)
      + estimateTokens(`- [${highRec.id}] ${highRec.name}（${highRec.summary}）`)

    const { text } = assembleSnapshot({ registry: priorityRegistry, workspacePath: undefined, budget, now, store })

    expect(text).toContain('高优先级条目')
    expect(text).not.toContain('低优先级条目')
    expect(text).toMatch(/另有 1 条 ztypel 记忆/)
  })

  it('预算只够 high 组前几条：high 组部分装入并注明剩余，low 组整组进尾注', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const priorityRegistry = buildTypeRegistry({
      template: 'coding',
      customTypes: {
        ztypeh: { label: '高优先级组', description: '', whenToSave: '', recall: 'search', decayDays: null, governancePriority: 'high' },
        ztypel: { label: '低优先级组', description: '', whenToSave: '', recall: 'search', decayDays: null, governancePriority: 'low' },
      },
    })
    // high 5 条、low 4 条，每条行体积一致（summary 等长）；置信度递减让装入顺序确定。
    const highRecs = Array.from({ length: 5 }, (_, i) =>
      record({ id: `mem_h${i}`, type: 'ztypeh', name: `高条目${i}`, summary: '高优先级组摘要占位文本', confidence: 0.9 - i * 0.1 }))
    for (const r of highRecs) await store.put(r)
    for (let i = 0; i < 4; i++) await store.put(record({ id: `mem_l${i}`, type: 'ztypel', name: `低条目${i}`, summary: '低优先级组摘要占位文本' }))

    const now = 10 * DAY
    // 预算 = 顶头 + high 组头 + 2 条 high 行，恰好装 2 条。
    const budget = estimateTokens('# 长期记忆')
      + estimateTokens(`\n## ${priorityRegistry.get('ztypeh').label}（ztypeh）`)
      + 2 * estimateTokens(`- [mem_h0] ${highRecs[0].name}（${highRecs[0].summary}）`)

    const { text } = assembleSnapshot({ registry: priorityRegistry, workspacePath: undefined, budget, now, store })

    // high 组装入前 2 条（置信度最高的 mem_h0、mem_h1），其余进尾注
    expect(text).toContain('[mem_h0]')
    expect(text).toContain('[mem_h1]')
    expect(text).not.toContain('[mem_h2]')
    expect(text).toMatch(/另有 3 条 ztypeh 记忆/)   // 5 - 2 = 3
    // low 组整组进尾注，一条都不出现在索引区
    expect(text).not.toContain('低条目')
    expect(text).toMatch(/另有 4 条 ztypel 记忆/)
  })

  it('组内装入顺序按 confidence 降序（与 core 区一致）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const priorityRegistry = buildTypeRegistry({
      template: 'coding',
      customTypes: {
        ztypeh: { label: '高优先级组', description: '', whenToSave: '', recall: 'search', decayDays: null, governancePriority: 'high' },
      },
    })
    await store.put(record({ id: 'mem_lo', type: 'ztypeh', name: '低置信', summary: 'x', confidence: 0.4 }))
    await store.put(record({ id: 'mem_hi', type: 'ztypeh', name: '高置信', summary: 'x', confidence: 0.95 }))
    await store.put(record({ id: 'mem_mid', type: 'ztypeh', name: '中置信', summary: 'x', confidence: 0.7 }))

    const { text } = assembleSnapshot({ registry: priorityRegistry, workspacePath: undefined, budget: 4000, now: 10 * DAY, store })

    expect(text.indexOf('mem_hi')).toBeLessThan(text.indexOf('mem_mid'))
    expect(text.indexOf('mem_mid')).toBeLessThan(text.indexOf('mem_lo'))
  })
})
