import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { reportedTokens, type SemanticLlm } from './semantic-scan.ts'

/** 宿主 llm 服务的结构子集（ctx.get('llm')）。 */
export interface HostLlmService {
  stream?: (req: GenerateOptions) => AsyncIterable<StreamChunk>
}

/** 一次调用用哪个模型：宿主路由名与模型 id。两者都要有才能调。 */
export interface HostModelRoute {
  provider?: string
  model?: string
}

/**
 * 宿主报「模型用不了」的错误码（宿主 0.2.1-rc.2 的模型适配层）：账号路由没登录（ACCOUNT_SIGN_IN_REQUIRED）、
 * 账号的 token 被服务端拒掉（ACCOUNT_TOKEN_INVALID，宿主随即删掉它，之后就是没登录）；API key 路由没有 key（MISSING_CREDENTIAL）、
 * key 格式不对（INVALID_CREDENTIAL）、key 被服务端拒掉（AUTH，401/403，填错或已吊销）。这几类要用户去登录或补凭据，
 * 重试没用，体检记「模型用不了」、不算失败。
 * 其余错误码（限流、超时、额度、上下文超限、网络……）照旧算失败。
 */
export const MODEL_UNAVAILABLE_HOST_CODES = ['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'] as const

export function isModelUnavailableCode(hostCode: string | undefined): boolean {
  return hostCode !== undefined && (MODEL_UNAVAILABLE_HOST_CODES as readonly string[]).includes(hostCode)
}

/**
 * 宿主 llm 服务 → 语义层用的模型调用。provider、model 由调用方解析好（借用会话的模型，或无会话时宿主的默认模型），
 * 缺一个、或宿主没有 llm 服务时为 null。
 *
 * 真机验证确认的宿主 llm 契约（packages/llm/llm）：
 *   1) stream(options: GenerateOptions) 的 provider/model 是必填 string；sessionId 可选，凭据不依赖会话，所以没有会话也能调。
 *   2) StreamChunk 是判别联合，text-delta 和 reasoning-delta 都带 .text——开启推理时不按 type 过滤会把思维链拼进输出，
 *      导致 JSON 解析失败。只累加 type === 'text-delta' 的 chunk。每条流以 finish chunk 收尾：适配器中途抛错会被宿主
 *      折成 finish.reason.kind === 'error'（或 'aborted'），此时即使已收到可解析的文本也按失败处理。
 *   3) 只发一次、不进会话的辅助请求用宿主的 RequestUserInput：只有 role 与 content（ContentBlock[]），
 *      没有 id/source——宿主 0.1.7 起 Auto Review 与 compaction 摘要器同款。请求对象标注为 GenerateOptions，形状由编译器校验。
 */
export function hostSemanticLlm(llm: HostLlmService | undefined, route: HostModelRoute | undefined): SemanticLlm | null {
  const provider = route?.provider
  const model = route?.model
  if (!provider || !model) return null
  const stream = llm?.stream
  if (stream === undefined) return null
  return {
    model,
    async complete({ system, user }, signal, onUsage) {
      // 起步前先看取消：已取消就不发请求，直接抛（signal.reason 通常是 AbortError）。
      signal?.throwIfAborted()
      let out = ''
      // 宿主在 finish 前发 usage 块（StreamChunk 的 'usage'，各项互不重叠），取最后一个；
      // 宿主在出错收尾前报了用量的也计入，所以放在 finally 里报
      let usage: Extract<StreamChunk, { type: 'usage' }> | undefined
      // stream 建立或迭代过程中抛出的错误按 rejected promise 向上传播，
      // 由 runSemanticScan 的调用点捕获降级，这里不吞掉。
      // signal 透传给宿主 GenerateOptions，让在途请求随取消中断。
      const request: GenerateOptions = {
        provider,
        model,
        system,
        signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      }
      try {
        for await (const chunk of stream.call(llm, request)) {
          if (chunk.type === 'text-delta') out += chunk.text
          else if (chunk.type === 'usage') usage = chunk
          else if (chunk.type === 'finish') {
            // error/aborted 带 failure，照 compaction-basic summarizer 的 finishError 一律拒绝；
            // stop、max-tokens 及未来新增的 kind 不算错误，保留已收文本交给解析判定
            // （与 summarizer 不同，截断的 JSON 解析不过会自然走重试）。
            const reason = chunk.reason
            if (reason.kind === 'error') {
              // 宿主错误码挂在抛出的错误的 code 上，内容检查据它分出「模型用不了」
              throw Object.assign(new Error(reason.failure.message), { code: reason.failure.code })
            }
            if (reason.kind === 'aborted') {
              // 宿主报 aborted 时 signal 未必已触发：仍以 AbortError 拒绝，不当成功，也不进重试。
              throw signal?.reason ?? new DOMException(reason.failure.message, 'AbortError')
            }
          }
        }
      } finally {
        const tokens = usage === undefined ? undefined : reportedTokens(usage.usage)
        if (tokens !== undefined) onUsage?.(tokens)
      }
      // 宿主可能在取消时正常结束迭代而不抛——循环收尾再判一次，取消一律抛 AbortError。
      if (signal?.aborted) throw signal.reason ?? new DOMException('memory_scan cancelled', 'AbortError')
      return out
    },
  }
}
