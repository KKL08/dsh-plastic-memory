/**
 * 密钥模式集（参考 isla scan.py）。severity 分两级：
 * - critical：有明确厂商前缀/格式，几乎不误报 → 写入时直接拦截（pipeline reject，不落盘）。
 * - suspected：无厂商特征、正则较宽、可能误报 → 仅警告，照常落盘（宁可放过不误伤）。
 */
export type SecretSeverity = 'critical' | 'suspected'
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp; severity: SecretSeverity }> = [
  { name: 'sk- 系列密钥（OpenAI/Anthropic 等）', re: /\bsk-[A-Za-z0-9_-]{16,}\b/, severity: 'critical' },
  { name: 'GitHub token（ghp_/gho_ 等）', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, severity: 'critical' },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical' },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, severity: 'critical' },
  { name: 'PEM 私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, severity: 'critical' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/, severity: 'critical' },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'critical' },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/, severity: 'critical' },
  // 以下两条无厂商特征、正则较宽，归 suspected（仅警告不拦截，避免误伤）。
  // \S{6,} 对中文文本会把任意 6 个非空白字符当密码——中文记忆没有空格，普通句子如
  // "密码:公司统一走单点登录" 也会命中。约束取值必须像凭证（同时含数字与字母）且不含中日韩字符，
  // 排除自然语言描述、保留真正贴出来的口令。
  { name: '硬编码密码', re: /(?:password|passwd|pwd|密码)\s*[:=＝：]\s*(?=\S*[0-9])(?=\S*[A-Za-z])[^\s㐀-鿿]{6,}/i, severity: 'suspected' },
  // 引号改为可选：记忆内容是散文而非代码，"api_key: 1234567890abcdef" 这种写法不该被漏检。
  { name: '通用 api_key/token/secret 赋值', re: /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/i, severity: 'suspected' },
]

export function detectSecrets(text: string): Array<{ name: string; severity: SecretSeverity }> {
  return SECRET_PATTERNS.filter(p => p.re.test(text)).map(p => ({ name: p.name, severity: p.severity }))
}
