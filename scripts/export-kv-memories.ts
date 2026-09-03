/**
 * KV → 文件一次性导出脚本（P1.5 Task 10）。
 *
 * 背景：P0/P1 记忆落在 storage-json 的单文件 KV 库（`~/.dsh/storages/plastic_memory.json`），
 * P1.5 起改为「一条记录一个 Markdown 文件」（见 src/storage/file-table.ts）。本脚本把旧 KV 库
 * 里的 `memories` 表迁移成新格式的文件树，只用一次，用完即弃。
 *
 * 旧 KV 文件顶层结构（真机验证过、内嵌于本脚本，不 import dsh 包）：
 *   { unit: {...}, global: null | {...}, tables: { memories: { <id>: <MemoryRecord>, ... }, ... } }
 * 其中 tables.memories 的每条记录已经是 memoryRecordSchema 形状（createdAt/updatedAt 等已是
 * epoch ms），无需额外字段变换——需要变换的只是外层信封（拆出 tables.memories）。
 *
 * ⚠️ 数据安全前提（Task 9 评审 Important 1，storage-json 源码已证实）：
 *   ① 本脚本必须只读 JSON 文件本身，绝不经 storageDomain / ctx.storage 打开旧库——新 spec 打开
 *      旧库不报错，但新 build 的任意一次写（含 load 期 sweep 触发的 stats 写）会把 storageDomain
 *      新 build 里未声明的 `memories` 表永久抹掉（serialize() 只写 state.tables）。
 *   ② 真机上执行导出，必须发生在新 build 首次运行之前。
 *   ③ 已做备份：`~/.dsh/storages/plastic_memory.json.pre-p15`（2026-08-20）。--from 默认指向
 *      现役文件，也可显式指向该备份。
 *
 * 用法：
 *   node scripts/export-kv-memories.ts [--from <kv.json 路径>] [--to <目标 memories 根目录>]
 *   （Node ≥23.6 原生执行 .ts，无需 tsx；本机 v24 已实测：4 条真实记录导出成功）
 *   默认 --from = ~/.dsh/storages/plastic_memory.json
 *   默认 --to   = resolveMemoryRoot('')（即 $DSH_HOME/memories，缺省 ~/.dsh/memories）
 *   ⚠️ 插件配置里设过 memoryRoot 的用户必须显式传 --to——脚本不读插件配置。
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { memoryRecordSchema } from '../src/record-schema.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName, slugifyName, resolveMemoryRoot, isReservedFileName } from '../src/storage/paths.ts'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 核心可测函数：把旧 KV JSON 的 tables.memories 逐条导出成 root 下的 Markdown 文件。
 * 单条记录 schema 校验失败不中断整体导出，累进 skipped（带原因）。
 */
export async function exportMemories(kvJson: unknown, root: string): Promise<{ exported: number; skipped: string[] }> {
  if (!isPlainObject(kvJson)) throw new Error('KV JSON 顶层必须是对象')
  const tables = kvJson.tables
  if (!isPlainObject(tables)) throw new Error('KV JSON 缺少 tables 字段')
  const memories = tables.memories
  if (!isPlainObject(memories)) throw new Error('KV JSON 缺少 tables.memories 字段')

  let exported = 0
  const skipped: string[] = []
  const usedNames = new Map<string, Set<string>>() // dir -> 已占用的文件名
  const markedWsDirs = new Set<string>()

  for (const [id, raw] of Object.entries(memories)) {
    const parsed = memoryRecordSchema.safeParse(raw)
    if (!parsed.success) {
      skipped.push(`${id}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')}`)
      continue
    }
    const record = parsed.data
    if (record.scope === 'workspace' && !record.workspacePath) {
      skipped.push(`${id}: scope 为 workspace 但缺少 workspacePath`)
      continue
    }

    const dir = record.scope === 'global' ? join(root, GLOBAL_DIR) : join(root, workspaceDirName(record.workspacePath!))
    await mkdir(dir, { recursive: true })
    if (record.scope === 'workspace' && !markedWsDirs.has(dir)) {
      await writeFile(join(dir, WORKSPACE_MARKER), record.workspacePath! + '\n', 'utf8')
      markedWsDirs.add(dir)
    }

    const taken = usedNames.get(dir) ?? new Set<string>()
    const base = slugifyName(record.name)
    const altName = `${base}-${record.id.slice(-6)}.md`
    let fileName = `${base}.md`
    // 保留名避让（memory.md ≈ MEMORY.md，大小写不敏感 FS 上会互相覆盖）+ 同目录内 slug 撞名兜底
    if (isReservedFileName(fileName) || taken.has(fileName)) fileName = altName
    // 目标目录可能已有新系统写入的文件（硬约束②被违反的场景）：同 id 覆盖=幂等重跑，
    // 不同 id 或读不出 id 的一律不覆盖——迁移脚本自己制造数据丢失是最不可接受的失败。
    const onDisk = await readExistingId(join(dir, fileName))
    if (onDisk !== null && onDisk !== record.id) {
      if (fileName !== altName) {
        const onDiskAlt = await readExistingId(join(dir, altName))
        if (onDiskAlt === null || onDiskAlt === record.id) {
          fileName = altName
        } else {
          skipped.push(`${id}: 目标 ${fileName} 与 ${altName} 均已被其他记录占用，未写入`)
          continue
        }
      } else {
        skipped.push(`${id}: 目标 ${fileName} 已被其他记录占用，未写入`)
        continue
      }
    }
    taken.add(fileName)
    usedNames.set(dir, taken)

    await writeFile(join(dir, fileName), encodeRecord(record, {}), 'utf8')
    exported++
  }
  return { exported, skipped }
}

/**
 * 读盘上已有文件的 frontmatter id。返回 null=文件不存在（可写）；返回 id 字符串=已被该记录
 * 占用（同 id 可覆盖=幂等重跑）；返回 'unreadable'=存在但读不出 id（一律不覆盖）。
 */
async function readExistingId(path: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return 'unreadable'
  }
  const frontmatter = text.startsWith('---\n') ? text.slice(4).split('\n---')[0] ?? '' : ''
  const m = /^id:\s*(\S+)\s*$/m.exec(frontmatter)
  return m ? m[1] : 'unreadable'
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} 缺少取值`)
    return value
  }
  const from = flag('--from') ?? join(homedir(), '.dsh', 'storages', 'plastic_memory.json')
  const to = flag('--to') ?? resolveMemoryRoot('')

  const raw = await readFile(from, 'utf8')
  const kvJson = JSON.parse(raw)
  const { exported, skipped } = await exportMemories(kvJson, to)

  console.log(`导出完成：from=${from} to=${to}`)
  console.log(`已导出 ${exported} 条，跳过 ${skipped.length} 条`)
  for (const reason of skipped) console.warn(`  跳过：${reason}`)
  if (skipped.length > 0) {
    console.warn(`⚠️ ${skipped.length} 条未导出——处理完之前不要启动新 build（首次写入会永久抹掉旧库 memories 表）`)
    process.exitCode = 1
  }
}

if (isMainModule()) {
  main().catch(err => {
    console.error('[export-kv-memories] 导出失败：', err)
    process.exitCode = 1
  })
}
