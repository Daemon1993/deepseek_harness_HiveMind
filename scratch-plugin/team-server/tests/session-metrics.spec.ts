import { describe, expect, it } from 'vitest'
import { analyzeSessionEvents, sessionTitle } from '../src/session-metrics.ts'

describe('sessionTitle', () => {
  it('uses the latest durable conversation title', () => {
    expect(sessionTitle([
      { type: 'session/title', data: { title: '旧标题' } },
      { type: 'user/message', data: {} },
      { type: 'session/title', data: { title: '审查 scratch-plugin 代码现状' } },
    ])).toBe('审查 scratch-plugin 代码现状')
  })

  it('uses the fallback without a valid title event', () => {
    expect(sessionTitle([{ type: 'session/title', data: { title: '' } }])).toBe('新会话')
  })
})

describe('analyzeSessionEvents models', () => {
  it('keeps every model used by one Session with its request count', () => {
    const metrics = analyzeSessionEvents([
      { type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
      { type: 'assistant/message', time: 2, data: { usage: { totalTokens: 10 } } },
      { type: 'assistant/message', time: 3, data: { usage: { totalTokens: 20 } } },
      { type: 'request/header', time: 4, data: { header: { config: { provider: 'bailian', model: 'glm-5.2' } } } },
      { type: 'assistant/message', time: 5, data: { usage: { totalTokens: 30 } } },
    ])

    expect(metrics.models).toEqual([
      { model: 'deepseek-official/deepseek-v4-flash', requests: 2, inputTokens: 0, outputTokens: 0, totalTokens: 30 },
      { model: 'bailian/glm-5.2', requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 30 },
    ])
  })
})
