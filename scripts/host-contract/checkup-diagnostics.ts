import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkupViewSchema, type CheckupView } from '../../src/gui/contract.ts'
import { checkupRecordSchema, type CheckupRecord } from '../../src/storage/schema.ts'

/** 只读采样体检落盘；未观测到的阶段不等于未执行，完成记录不能代替最近一次结果。 */
export class CheckupDiagnostics {
  readonly stages = {
    scheduleRequested: false, scheduled: false, claimed: false,
    modelStarted: false, modelEnded: false, completed: false,
    resultWritten: false, viewWritten: false, viewResultWritten: false,
  }

  modelFinish: unknown = null
  private lastScope: CheckupView['scopes'][number] | undefined
  private lastRecord: CheckupRecord | undefined
  private readonly readErrors = new Set<string>()
  private readonly recordPath: string
  private readonly claimPath: string
  private readonly viewPath: string
  private readonly workspacePath: string

  constructor(memoriesRoot: string, workspacePath: string) {
    const key = createHash('sha1').update(workspacePath).digest('hex')
    this.recordPath = join(memoriesRoot, '.state', 'checkups', `${key}.json`)
    this.claimPath = join(memoriesRoot, '.state', 'checkups', `${key}.claim`)
    this.viewPath = join(memoriesRoot, '.state', 'gui', 'checkups.json')
    this.workspacePath = workspacePath
  }

  /** 在轮询和模型请求边界采样，保留最后读到的状态及读取、解析错误。 */
  sample(): CheckupView['scopes'][number] | undefined {
    const claim = this.read(this.claimPath, value => value)
    if (claim !== undefined) {
      this.stages.claimed = true
      this.stages.scheduled = true
    }
    const record = this.read(this.recordPath, value => checkupRecordSchema.parse(value))
    if (record !== undefined) {
      this.lastRecord = record
      this.stages.completed ||= record.completed !== undefined
      this.stages.resultWritten ||= record.lastResult !== undefined
    }
    const view = this.read(this.viewPath, value => checkupViewSchema.parse(value))
    const scope = view?.scopes.find(s => s.scope.kind === 'workspace' && s.scope.workspacePath === this.workspacePath)
    if (scope !== undefined) {
      this.lastScope = scope
      this.stages.viewWritten = true
      this.stages.viewResultWritten ||= scope.lastResult !== null
      this.stages.claimed ||= scope.isInProgress
      this.stages.scheduled ||= scope.isInProgress
    }
    return scope
  }

  /** 每项阶段表示曾观测到；同时附上原始持久化状态，区分完成、结果和视图写入。 */
  detail(): string {
    return JSON.stringify({ stages: this.stages, modelFinish: this.modelFinish, lastScope: this.lastScope ?? null, lastRecord: this.lastRecord ?? null, readErrors: [...this.readErrors] })
  }

  private read<T>(path: string, parse: (value: unknown) => T): T | undefined {
    try {
      return parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch (err) {
      // 诊断读取失败不能改变体检的结果；错误保留在报告里，不能伪装成尚未到期。
      this.readErrors.add(`${path}: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }
}
