import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { slugifyName, isReservedFileName, INDEX_FILE, ARCHIVE_DIR } from '../src/storage/paths.ts'
import { expandQueryTerms, textSimilarity } from '../src/text.ts'
import { apply, Config } from '../src/index.ts'
import { computeDigest, decodeFile } from '../src/storage/frontmatter.ts'
import { isPendingDelegated, type MemoryRecord } from '../src/record-schema.ts'
import { MEMORY_COMMAND_NAME, encodeMemoryCommand, type MemoryCommand } from '../src/gui/contract.ts'
import { createMemoryCommand } from '../src/gui/commands.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'

// Names mixing filesystem-forbidden chars, whitespace and CJK, long enough to
// exercise the 40-char truncation path in slugifyName.
const messyName = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc
    .array(
      fc.constantFrom('a', 'B', '中', '文', '/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ', '\t', '\n', '-', '.'),
      { maxLength: 80 },
    )
    .map(cs => cs.join('')),
)

// Non-empty text over a whitespace-free alphabet, so expandQueryTerms always
// yields at least one term (needed for the Dice self-similarity = 1 property).
const word = fc
  .array(fc.constantFrom(...'abcXYZ中文查询部署0129-._/api'), { minLength: 1, maxLength: 24 })
  .map(cs => cs.join(''))

// One contiguous run of Han chars in slugifyName's CJK range (U+4E00..U+9FFF).
const cjkRun = fc
  .array(
    fc.integer({ min: 0x4e00, max: 0x9fff }).map(c => String.fromCodePoint(c)),
    { minLength: 2, maxLength: 8 },
  )
  .map(cs => cs.join(''))

describe('slugifyName', () => {
  // INVARIANT: slugifyName is idempotent — slug(slug(x)) === slug(x). The arbitrary
  // targets the 40-char cut: 39 filler chars, one separator (collapsed to '-') and a
  // non-dash tail, so the cut lands exactly on the collapsed dash.
  const boundaryDash = fc
    .tuple(
      fc.constantFrom('a', 'b', 'x', '9', '中'),
      fc.constantFrom(' ', '  ', '/', '\\', ':', '\t'),
      fc.array(fc.constantFrom(...'abcxyz019中文'), { minLength: 1, maxLength: 6 }).map(cs => cs.join('')),
    )
    .map(([fill, sep, tail]) => fill.repeat(39) + sep + tail)
  it('is idempotent, including at the truncation boundary', () => {
    fc.assert(
      fc.property(boundaryDash, name => {
        expect(slugifyName(slugifyName(name))).toBe(slugifyName(name))
      }),
    )
  })

  // INVARIANT: the slug never contains a filesystem-forbidden char or whitespace,
  // is at most 40 chars, and is never empty (falls back to "memory").
  it('produces only safe chars, bounded length, never empty', () => {
    fc.assert(
      fc.property(messyName, name => {
        const slug = slugifyName(name)
        expect(slug.length).toBeGreaterThan(0)
        expect(slug.length).toBeLessThanOrEqual(40)
        expect(slug).not.toMatch(/[/\\:*?"<>|\s]/)
      }),
    )
  })

  // INVARIANT: the slug never starts with "._" or ".#" — the reader silently skips
  // such files when they fail to parse (macOS AppleDouble files, editor locks), so a
  // generated name must never take that shape. Idempotency must survive the fix-up.
  const companionLike = fc
    .tuple(
      fc.constantFrom('', ' ', '-', '/', ' -/'),
      fc.constantFrom('._', '.#'),
      fc.array(fc.constantFrom(...'ab中._#- /'), { maxLength: 50 }).map(cs => cs.join('')),
    )
    .map(([lead, pair, tail]) => lead + pair + tail)
  it('never yields a name the reader treats as a companion file', () => {
    fc.assert(
      fc.property(fc.oneof(companionLike, messyName), name => {
        const slug = slugifyName(name)
        expect(slug).not.toMatch(/^\.[_#]/)
        expect(slugifyName(slug)).toBe(slug)
      }),
    )
  })

  // Not a contract: slugifyName is case-preserving by design (directory/file names keep
  // the user's casing); case-insensitive comparison lives in the rename path
  // (file-table) and in isReservedFileName, which the next block covers.
})

describe('isReservedFileName', () => {
  // INVARIANT: every case variant of the index file name is always reserved.
  const indexCaseVariant = fc
    .tuple(...[...INDEX_FILE].map(ch => fc.constantFrom(ch.toLowerCase(), ch.toUpperCase())))
    .map(chars => chars.join(''))
  it('flags every case variant of the index file name', () => {
    fc.assert(
      fc.property(indexCaseVariant, name => {
        expect(isReservedFileName(name)).toBe(true)
      }),
    )
  })

  // INVARIANT: a name that differs from the index file by more than case (i.e. is
  // not a case variant of it) is never reported reserved.
  it('never flags a name that is not a case variant of the index file', () => {
    fc.assert(
      fc.property(messyName, name => {
        fc.pre(name.toLowerCase() !== INDEX_FILE.toLowerCase())
        expect(isReservedFileName(name)).toBe(false)
      }),
    )
  })
})

describe('expandQueryTerms', () => {
  // INVARIANT: every emitted term is non-empty.
  it('emits only non-empty terms', () => {
    fc.assert(
      fc.property(messyName, kw => {
        for (const term of expandQueryTerms(kw)) expect(term.length).toBeGreaterThan(0)
      }),
    )
  })

  // INVARIANT: for a contiguous CJK query, every adjacent bigram of the input appears.
  it('covers every adjacent bigram of a contiguous CJK query', () => {
    fc.assert(
      fc.property(cjkRun, run => {
        const terms = new Set(expandQueryTerms(run))
        const chars = [...run]
        for (let i = 0; i < chars.length - 1; i++) {
          expect(terms.has(chars[i] + chars[i + 1])).toBe(true)
        }
      }),
    )
  })
})

describe('textSimilarity (Dice)', () => {
  // INVARIANT: the Dice coefficient is symmetric in its two arguments.
  it('is symmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(textSimilarity(a, b)).toBe(textSimilarity(b, a))
      }),
    )
  })

  // INVARIANT: an identical (non-empty) string scores exactly 1.
  it('scores 1 for two identical non-empty strings', () => {
    fc.assert(
      fc.property(word, a => {
        expect(textSimilarity(a, a)).toBe(1)
      }),
    )
  })

  // INVARIANT: self-similarity is maximal and the score is bounded to [0, 1], so
  // replacing the identical copy with any (unrelated) string cannot raise the score.
  it('is bounded and non-increasing away from an identical string', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const sim = textSimilarity(a, b)
        expect(sim).toBeGreaterThanOrEqual(0)
        expect(sim).toBeLessThanOrEqual(1)
        expect(textSimilarity(a, a)).toBeGreaterThanOrEqual(sim)
      }),
    )
  })
})

/**
 * 记忆生命周期（spec Testing Decisions 末条）：随机操作序列经 apply() 的完整接线跑在真实临时目录上——子会话的保存与改写、
 * 主会话的接受 / 改写 / 删除、用户在记忆页直接改（/memory edit-memory）、主会话拍快照与恢复、维护回写（去掉文件的 digest 行，
 * 由下一次快照冻结时的维护点重写）、子会话越权的接受与删除。每步之后从磁盘读回全部记录（含 .archive/）。
 */
describe('子 agent 记忆的生命周期', () => {
  type Who = 1 | 2
  type Op =
    | { kind: 'child-save'; who: Who }
    | { kind: 'child-update' | 'child-accept' | 'child-forget'; who: Who; target: number }
    | { kind: 'main-accept' | 'main-update' | 'main-forget' | 'user-edit' | 'maintain'; target: number }
    | { kind: 'snapshot' }
    | { kind: 'restore'; snap: number; overwrite: boolean }
  type Disk = Map<string, { record: MemoryRecord; path: string }>
  /** 没有主会话或用户参与的操作：子会话自己的动作、框架的维护回写。 */
  const isUnattended = (op: Op) => op.kind.startsWith('child-') || op.kind === 'maintain'

  const who = fc.constantFrom<Who>(1, 2)
  const target = fc.nat({ max: 7 })
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    { weight: 4, arbitrary: who.map(w => ({ kind: 'child-save' as const, who: w })) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('child-update' as const), who, target }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom('child-accept' as const, 'child-forget' as const), who, target }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constantFrom('main-accept' as const, 'main-update' as const, 'main-forget' as const, 'user-edit' as const, 'maintain' as const), target }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'snapshot' as const }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('restore' as const), snap: fc.nat({ max: 3 }), overwrite: fc.boolean() }) },
  )
  const ops = fc.array(opArb, { minLength: 1, maxLength: 8 })

  /** 一套全新的插件实例、临时记忆根目录与项目目录；三个会话：主会话、第 1 层子会话、它派出的第 2 层子会话。 */
  async function boot() {
    const memoryRoot = await realpath(await mkdtemp(join(tmpdir(), 'plastic-memory-lifecycle-')))
    const ws = await realpath(await mkdtemp(join(tmpdir(), 'plastic-memory-lifecycle-ws-')))
    type Def = { name: string; execute(args: unknown, exec: ToolRunContext): Promise<unknown> }
    const defs = new Map<string, Def>()
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    // 根会话解析经 sessionQuery 读祖先 header（宿主 SessionRecord 形状）
    const headers = [{ id: 'sess-main' }, { id: 'sess-c1', delegationDepth: 1, parentSession: 'sess-main' }]
    const sessionQuery = {
      filterSessions: async (filters: Array<{ kind: string; values: string[] }>) => headers
        .filter(h => filters.some(f => f.kind === 'id' && f.values.includes(h.id)))
        .map(h => ({ header: { version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, ...h }, live: true, persisted: false })),
    }
    const ctx = {
      tools: { register: (def: Def) => { defs.set(def.name, def); return () => { defs.delete(def.name) } } },
      on: (event: string, fn: (...args: unknown[]) => unknown) => { listeners.set(event, fn); return () => {} },
      get: (name: string) => (name === 'sessionQuery' ? sessionQuery : undefined),
      // commands 服务不给：插件内的视图写入器按文件节流（两次替换至少隔 150ms），每次写入都等它会把 400 条序列拖到半分钟
      inject: () => () => {},
      logger: { info() {}, warn() {}, error() {} },
    }
    await apply(ctx as never, new Config({ memoryRoot } as never))
    // 记忆页的「直接改」：同一记忆根目录上另一个宿主进程里的 /memory 命令（磁盘是唯一真相，多进程共用一份），借主会话、视图不写
    const sidecar = new SidecarStore({ root: memoryRoot, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
    const command = createMemoryCommand({
      memoryRoot, store: new MemoryStore(new FileTable({ root: memoryRoot, stats: sidecar.recallStats }), undefined, sidecar.recallStats),
      decisions: new PendingDecisionsStore(sidecar.pending), snapshots: new SnapshotStore(sidecar.snapshots), cache: sidecar.scanCache,
      checkups: new CheckupRecordStore(sidecar.checkups), autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups), ignores: new AdviceIgnoreStore(sidecar.adviceIgnores),
      registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), agentsMd: createAgentsMdWriter(join(memoryRoot, 'AGENTS.md')),
      views: { request: async () => undefined, rewriteAll: async () => undefined, collectViews: async () => { throw new Error('不收集视图') }, requestCheckups: async () => {} },
      resolveContext: async () => ({ workspacePath: ws, delegationDepth: 0, session: { id: 'sess-main' } }),
      getLlm: () => null, getBaseline: () => null,
    })
    const session = (id: string, header: { delegationDepth?: number; parentSession?: string } = {}) =>
      Session.create(id as SessionId, [], { version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: 0, isSeeded: false, cwd: ws, ...header as object })
    const main = session('sess-main')
    const children: Record<Who, Session> = { 1: session('sess-c1', { delegationDepth: 1, parentSession: 'sess-main' }), 2: session('sess-c2', { delegationDepth: 2, parentSession: 'sess-c1' }) }
    const call = async (s: Session, tool: string, args: unknown) =>
      await defs.get(tool)!.execute(args, { signal: new AbortController().signal, agent: { session: s, options: {} } } as unknown as ToolRunContext) as { kind: string; snapshotId?: string; record?: { id: string } }
    const editMemory = async (c: MemoryCommand) =>
      await command.handler({ rawInput: encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length), agent: {} })
    let fresh = 0
    /** 新会话走第 2 步的 pre-step：快照第一次冻结，冻结链路对 global 与当前项目各做一次维护。 */
    const freeze = async () => {
      const s = session(`sess-fresh-${fresh++}`)
      s.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
      await listeners.get('agent/pre-step')!({ agent: { session: s }, messages: [], turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    }
    /** 从磁盘读回全部记录（各项目目录与 global，含 .archive/）。 */
    const readAll = async (): Promise<Disk> => {
      const out: Disk = new Map()
      for (const dir of await readdir(memoryRoot)) {
        if (dir.startsWith('.')) continue
        for (const sub of [join(memoryRoot, dir), join(memoryRoot, dir, ARCHIVE_DIR)]) {
          for (const file of await readdir(sub).catch(() => [] as string[])) {
            if (!file.endsWith('.md') || file === INDEX_FILE) continue
            const path = join(sub, file)
            const decoded = decodeFile(await readFile(path, 'utf8'), { path, loc: dir === 'global' ? { scope: 'global' } : { scope: 'workspace', workspacePath: ws } })
            if (decoded.ok) out.set(decoded.record.id, { record: decoded.record, path })
          }
        }
      }
      return out
    }
    const cleanup = async () => {
      await Promise.all([memoryRoot, ws].map(d => rm(d, { recursive: true, force: true })))
    }
    return { ws, main, children, call, editMemory, freeze, readAll, cleanup }
  }

  /**
   * 跑一条操作序列；每步之后把操作与前后的磁盘状态交给 check。目标按序号在已建记录里取模挑。
   * outcomes 收集「操作:结果」：断言之外再确认随机序列真的走到了每种结果（升档、改写、恢复等都发生过），不变量不是空转。
   */
  async function runSequence(sequence: Op[], outcomes: Set<string>, check: (op: Op, before: Disk, after: Disk) => void) {
    const h = await boot()
    try {
      const ids: string[] = []
      const snaps: string[] = []
      const childArgs = { type: 'knowledge', scope: 'workspace', sourceMode: 'environment-observed', tags: [] }
      const mainArgs = { type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', tags: [], force: true }
      let before = await h.readAll()
      for (const [k, op] of sequence.entries()) {
        const id = 'target' in op && ids.length > 0 ? ids[op.target % ids.length] : undefined
        const cur = id === undefined ? undefined : before.get(id)
        const child = 'who' in op ? h.children[op.who] : h.main
        let outcome: string | undefined
        switch (op.kind) {
          case 'child-save': {
            // 引号短语是实体：各条互不撞重复
            const r = await h.call(child, 'memory_save', { action: 'create', name: `观察${k}`, summary: `观察${k}`, content: `子会话看到「词${k}」`, ...childArgs })
            if (r.record) ids.push(r.record.id)
            outcome = r.kind
            break
          }
          case 'child-update':
            if (id) outcome = (await h.call(child, 'memory_save', { action: 'update', id, name: `子改${k}`, summary: `子改${k}`, content: `子会话改成「词${k}」`, ...childArgs })).kind
            break
          case 'child-accept':
            if (id) outcome = (await h.call(child, 'memory_confirm', { action: 'accept-subagent', memoryId: id })).kind
            break
          case 'child-forget':
            if (id) outcome = (await h.call(child, 'memory_forget', { ids: [id], reason: '子会话想删' })).kind
            break
          case 'main-accept':
            if (id) outcome = (await h.call(h.main, 'memory_confirm', { action: 'accept-subagent', memoryId: id })).kind
            break
          case 'main-update':
            if (id) outcome = (await h.call(h.main, 'memory_save', { action: 'update', id, name: `主改${k}`, summary: `主改${k}`, content: `主会话改成「词${k}」`, ...mainArgs })).kind
            break
          case 'main-forget':
            if (id) outcome = String((await h.call(h.main, 'memory_forget', { ids: [id], reason: '主会话删掉' }) as { ok?: boolean }).ok)
            break
          case 'user-edit':
            if (cur) {
              const r = await h.editMemory({
                cmd: 'edit-memory', memoryId: cur.record.id, layer: { kind: 'workspace', workspacePath: h.ws },
                base: { updatedAt: cur.record.updatedAt, digest: computeDigest(cur.record.name, cur.record.summary, cur.record.content) },
                content: `用户改成「词${k}」`, name: `用户改${k}`, summary: `用户改${k}`, tags: [],
              })
              outcome = r.kind
            }
            break
          case 'maintain':
            // 去掉 digest 行，维护点重新编码整份文件写回（只有顶层文件参与冻结时的维护）
            if (cur) {
              await writeFile(cur.path, (await readFile(cur.path, 'utf8')).replace(/^digest: .*\n/m, ''), 'utf8')
              await h.freeze()
              outcome = /^digest: /m.test(await readFile(cur.path, 'utf8').catch(() => '')) ? 'rewritten' : 'untouched'
            }
            break
          case 'snapshot': {
            const r = await h.call(h.main, 'memory_snapshot', { action: 'create', description: `快照${k}` })
            if (r.snapshotId) snaps.push(r.snapshotId)
            outcome = r.kind
            break
          }
          case 'restore':
            if (snaps.length > 0) {
              const r = await h.call(h.main, 'memory_snapshot', { action: 'restore', snapshotId: snaps[op.snap % snaps.length], overwriteChanged: op.overwrite }) as { kind: string; restored?: string[] }
              outcome = `${r.kind}-${(r.restored ?? []).length > 0}`
            }
            break
        }
        if (outcome !== undefined) outcomes.add(`${op.kind}:${outcome}`)
        const after = await h.readAll()
        check(op, before, after)
        before = after
      }
    } finally {
      await h.cleanup()
    }
  }

  /** 随机序列至少走到过的结果：子会话存入与改写自己的、主会话接受 / 改写 / 删除、用户直接改、维护回写、快照恢复真的写回了记录。 */
  const REACHED = [
    'child-save:saved', 'child-update:updated', 'child-accept:rejected', 'child-forget:rejected',
    'main-accept:accepted', 'main-update:updated', 'main-forget:true', 'user-edit:success', 'maintain:rewritten', 'restore:restored-true',
  ]

  // INVARIANT：没有主会话或用户参与的操作，不会让任何记录从待确认变成主档——操作后已升档的子 agent 记录，操作前就已升档、升档信息不变。
  it('无人参与的操作不会把待确认记录升成主档', async () => {
    const outcomes = new Set<string>()
    await fc.assert(fc.asyncProperty(ops, async sequence => {
      await runSequence(sequence, outcomes, (op, before, after) => {
        if (!isUnattended(op)) return
        for (const [id, { record }] of after) {
          if (record.delegation === undefined || isPendingDelegated(record)) continue
          expect(before.get(id)?.record.delegation?.reviewed, `${op.kind} 让 ${id} 升了档`).toEqual(record.delegation.reviewed)
        }
      })
    }), { numRuns: 200 })
    expect([...outcomes]).toEqual(expect.arrayContaining(REACHED))
  }, 120_000)

  // INVARIANT：delegation 的创建者四个字段一旦写入，此后每一步读回都在且不变（升档只加 reviewed）。
  it('创建者四个字段写入后不变', async () => {
    const outcomes = new Set<string>()
    const creatorOf = (r: MemoryRecord) => r.delegation && {
      sessionId: r.delegation.sessionId, depth: r.delegation.depth, parentSessionId: r.delegation.parentSessionId, rootSessionId: r.delegation.rootSessionId,
    }
    await fc.assert(fc.asyncProperty(ops, async sequence => {
      const creators = new Map<string, unknown>()
      await runSequence(sequence, outcomes, (op, _before, after) => {
        for (const [id, { record }] of after) {
          if (!creators.has(id)) {
            if (record.delegation !== undefined) creators.set(id, creatorOf(record))
            continue
          }
          expect(creatorOf(record), `${op.kind} 改了 ${id} 的创建者`).toEqual(creators.get(id))
        }
      })
    }), { numRuns: 200 })
    expect([...outcomes]).toEqual(expect.arrayContaining(REACHED))
  }, 120_000)
})
