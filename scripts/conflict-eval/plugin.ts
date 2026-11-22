import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { hostSemanticLlm, type HostLlmService, type HostModelRoute } from '../../src/governance/host-llm.ts'
import { saveEvaluation } from '../eval-conflict.ts'

export const name = 'memory-conflict-eval'
export const inject = ['llm', 'agentDefaultModel']

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (!exit) throw new Error('Evaluation requires an application exit service')
  void (async () => {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('Missing evaluation credential')
    const route = (ctx.get('agentDefaultModel') as { currentSelection(): HostModelRoute }).currentSelection()
    const llm = hostSemanticLlm(ctx.get('llm') as HostLlmService, { ...route, sessionId: `conflict-eval-${randomUUID()}` })
    if (!llm) throw new Error('No default model available')
    exit(await saveEvaluation(llm))
  })().catch(() => {
    // Do not echo host errors, which may contain credentials.
    console.error('Conflict evaluation could not finish; check credentials and host availability.')
    exit(1)
  })
}
