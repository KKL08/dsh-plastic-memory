/**
 * 厂商形状的假密钥在运行时拼接，源码里不出现完整字面量。GitHub 等平台的密钥扫描只看形状，
 * 曾把 Google key 形状的样本当泄露报警；拼接后扫描器不命中，检测器看到的值不变。
 * TESTONLY 片段保证一眼可辨是假的。
 */
const fill = (body: string, len: number, ch = '0'): string => body.padEnd(len, ch)

export const FAKE_SECRET = {
  /** sk- 系列（OpenAI/Anthropic 形状）：sk- + 24 位 */
  sk: 'sk-' + fill('TESTONLY', 24, 'a'),
  /** sk-proj- 形状：sk-proj- + 24 位 */
  skProj: 'sk-proj-' + fill('TESTONLY', 24),
  /** GitHub token：ghp_ + 30 位 */
  github: 'ghp_' + fill('TESTONLY', 30),
  /** AWS Access Key：AKIA + 16 位大写/数字 */
  aws: 'AKIA' + fill('TESTONLY', 16),
  /** PEM 私钥块头 */
  pem: ['-----BEGIN', 'TESTONLY PRIVATE', 'KEY-----'].join(' '),
  /** Slack bot token */
  slack: 'xoxb-' + 'TESTONLY-00000000',
  /** Google API Key：AIza + 35 位 */
  google: 'AIza' + fill('TESTONLY', 35),
} as const
