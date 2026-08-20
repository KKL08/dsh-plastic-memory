import type { MemoryRecord } from '../record-schema.ts'
import { SEVERITY_BY_TYPE, type Finding } from './schema.ts'

export const BLOAT_THRESHOLD = 2000

/** 参考 isla scan.py 的密钥正则集，取适配我们记忆内容的初值。 */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'sk- 系列密钥（OpenAI/Anthropic 等）', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'GitHub token（ghp_/gho_ 等）', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'PEM 私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // \S{6,} 对中文文本会把任意 6 个非空白字符当密码——中文记忆没有空格，普通句子如
  // "密码:公司统一走单点登录" 也会命中。约束取值必须像凭证（同时含数字与字母）且不含中日韩字符，
  // 排除自然语言描述、保留真正贴出来的口令。
  { name: '硬编码密码', re: /(?:password|passwd|pwd|密码)\s*[:=＝：]\s*(?=\S*[0-9])(?=\S*[A-Za-z])[^\s㐀-鿿]{6,}/i },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  // 引号改为可选：记忆内容是散文而非代码，"api_key: 1234567890abcdef" 这种写法不该被漏检。
  { name: '通用 api_key/token/secret 赋值', re: /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/i },
]

export function detectSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(p => p.re.test(text)).map(p => p.name)
}

/**
 * 规则层四类检测（secret/expired/bloat/orphan）。纯函数、免费、memory_health 每次实时算。
 * lookup 用于 orphan 检测按 id 直查（含 deleted 记录），records 传入的应是 active/stale 集合。
 */
export function runRuleScan(
  records: MemoryRecord[],
  lookup: (id: string) => MemoryRecord | undefined,
  now: number,
): Finding[] {
  const findings: Finding[] = []
  for (const r of records) {
    const hits = detectSecrets(r.content)
    if (hits.length > 0) {
      findings.push({
        type: 'secret', layer: 'rule', severity: SEVERITY_BY_TYPE.secret,
        memoryIds: [r.id],
        summary: `疑似密钥泄漏（${hits.join('、')}）`,
        suggestedAction: '确认后用 memory_forget 删除，并轮换泄漏的凭证',
      })
    }
    if (r.validTo !== undefined && r.validTo < now) {
      findings.push({
        type: 'expired', layer: 'rule', severity: SEVERITY_BY_TYPE.expired,
        memoryIds: [r.id],
        summary: `已过有效期（validTo=${r.validTo}）`,
        suggestedAction: '确认后用 memory_forget 删除，或用 memory_save 更新有效期',
      })
    }
    if (r.content.length > BLOAT_THRESHOLD) {
      findings.push({
        type: 'bloat', layer: 'rule', severity: SEVERITY_BY_TYPE.bloat,
        memoryIds: [r.id],
        summary: `内容超长（${r.content.length} 字符 > ${BLOAT_THRESHOLD}）`,
        suggestedAction: '用 memory_save 精简内容，保留可执行要点',
      })
    }
    const orphanRefs = (r.supersedes ?? []).filter(id => {
      const target = lookup(id)
      return !target || target.status === 'deleted'
    })
    if (orphanRefs.length > 0) {
      findings.push({
        type: 'orphan', layer: 'rule', severity: SEVERITY_BY_TYPE.orphan,
        memoryIds: [r.id],
        summary: `supersedes 指向已删/不存在的记录：${orphanRefs.join('、')}`,
        suggestedAction: '用 memory_save 更新该记忆，移除失效的 supersedes 引用',
      })
    }
  }
  return findings
}

/**
 * 隔离区（FileTable.quarantined，解析失败被隔离的记忆文件）→ malformed finding。
 * 无解析成功的记录，memoryIds 留空；路径与错误信息进 summary。
 */
export function buildMalformedFindings(quarantined: readonly { path: string; error: string }[]): Finding[] {
  return quarantined.map(({ path, error }) => ({
    type: 'malformed', layer: 'rule', severity: SEVERITY_BY_TYPE.malformed,
    memoryIds: [],
    summary: `记忆文件无法解析：${path}（${error}）`,
    suggestedAction: '手工修复该文件的 frontmatter，或删除后用 memory_save 重建',
  }))
}
