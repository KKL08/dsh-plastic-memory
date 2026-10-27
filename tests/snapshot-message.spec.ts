import { describe, expect, it } from 'vitest'
import { Session, SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SNAPSHOT_SOURCE_KIND, SNAPSHOT_SUPERSEDE_NOTE, lastVisibleSnapshot, shouldSendSnapshot, snapshotMessageBody, snapshotTextOf,
} from '../src/snapshot-message.ts'

const TEXT = '# 长期记忆\n\n- [mem_a]【记忆·偏好】测试里不要 mock 数据库'
const userSaid = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

describe('快照消息的形状', () => {
  it('content 是取代句、空行、快照正文；source 是本插件的 snapshot 形态，一节正文等于快照文本', () => {
    const body = snapshotMessageBody(TEXT)
    expect(body.content).toEqual([{ type: 'text', text: `${SNAPSHOT_SUPERSEDE_NOTE}\n\n${TEXT}` }])
    expect(body.source).toEqual({ kind: SNAPSHOT_SOURCE_KIND, form: 'snapshot', sections: [{ name: SNAPSHOT_SOURCE_KIND, text: TEXT }] })
    expect(SNAPSHOT_SOURCE_KIND).toBe('plastic-memory')
  })

  it('取文本只读 sections 里的正文：取回原文，不带取代句', () => {
    expect(snapshotTextOf(createUserMessage(snapshotMessageBody(TEXT)))).toBe(TEXT)
  })

  it('别的来源、别的形态、sections 不成形的消息取回 undefined', () => {
    const sections = [{ name: SNAPSHOT_SOURCE_KIND, text: TEXT }]
    expect(snapshotTextOf(userSaid(TEXT))).toBeUndefined()
    expect(snapshotTextOf({ source: { kind: 'compaction', form: 'snapshot', sections } } as never)).toBeUndefined()
    expect(snapshotTextOf({ source: { kind: SNAPSHOT_SOURCE_KIND, form: 'notice', summary: 'x' } } as never)).toBeUndefined()
    expect(snapshotTextOf({ source: { kind: SNAPSHOT_SOURCE_KIND, form: 'snapshot', sections: [] } } as never)).toBeUndefined()
    expect(snapshotTextOf({ source: { kind: SNAPSHOT_SOURCE_KIND, form: 'snapshot', sections: [{ name: 'x', text: 1 }] } } as never)).toBeUndefined()
  })

  it('写进宿主真 Session 再派生出来，取回的仍是原文', () => {
    const session = Session.create('sess-shape' as SessionId, [], { version: SESSION_FORMAT_VERSION, id: 'sess-shape' as SessionId, createdAt: 0, isSeeded: false })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示词') }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage(snapshotMessageBody(TEXT)), { surfaceOp: 'append' })
    expect(lastVisibleSnapshot(session.deriveMessages())).toBe(TEXT)
  })
})

describe('最后一份可见快照', () => {
  it('从尾部往前找第一条本插件快照；没有回 undefined', () => {
    const older = createUserMessage(snapshotMessageBody('旧快照'))
    const newer = createUserMessage(snapshotMessageBody('新快照'))
    expect(lastVisibleSnapshot([])).toBeUndefined()
    expect(lastVisibleSnapshot([userSaid('你好')])).toBeUndefined()
    expect(lastVisibleSnapshot([older, userSaid('你好'), newer, userSaid('继续')])).toBe('新快照')
  })
})

describe('这次要不要发', () => {
  it('看不到快照就发；看到的与本次不同就发；相同不发', () => {
    expect(shouldSendSnapshot(TEXT, undefined)).toBe(true)
    expect(shouldSendSnapshot(TEXT, '旧快照')).toBe(true)
    expect(shouldSendSnapshot(TEXT, TEXT)).toBe(false)
  })

  it('组装失败（undefined）或空串不发：空串会发出一条只有取代句的消息，等于宣布记忆全部作废', () => {
    expect(shouldSendSnapshot(undefined, undefined)).toBe(false)
    expect(shouldSendSnapshot(undefined, TEXT)).toBe(false)
    expect(shouldSendSnapshot('', undefined)).toBe(false)
    expect(shouldSendSnapshot('', TEXT)).toBe(false)
  })
})
