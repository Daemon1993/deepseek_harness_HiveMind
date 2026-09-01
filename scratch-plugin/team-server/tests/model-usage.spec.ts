import { describe, expect, it } from 'vitest'
import { costOf, usageFromObject, usageFromSseText } from '../src/model-usage.ts'

describe('usageFromObject', () => {
  it('extracts DeepSeek-style prompt/completion tokens', () => {
    expect(usageFromObject({ prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }))
      .toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  it('accepts OpenAI-style input/output tokens', () => {
    expect(usageFromObject({ input_tokens: 5, output_tokens: 7 }))
      .toEqual({ inputTokens: 5, outputTokens: 7 })
  })

  it('returns undefined for missing or non-numeric fields', () => {
    expect(usageFromObject(undefined)).toBeUndefined()
    expect(usageFromObject({ prompt_tokens: 'x', completion_tokens: 1 })).toBeUndefined()
    expect(usageFromObject({})).toBeUndefined()
  })
})

describe('usageFromSseText', () => {
  it('returns the last usage chunk of a streamed response', () => {
    const sse = [
      'data: {"id":"a","choices":[{"delta":{"content":"hi"}}]}',
      'data: {"id":"a","choices":[{"delta":{"content":" there"}}]}',
      'data: {"id":"a","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    expect(usageFromSseText(sse)).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('recovers usage when the line is split across chunk boundaries', () => {
    const partial = 'data: {"id":"a","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":'
    const rest = '9,"total_tokens":12}}'
    expect(usageFromSseText(partial + rest)).toEqual({ inputTokens: 3, outputTokens: 9 })
  })

  it('returns undefined when no usage appears', () => {
    expect(usageFromSseText('data: {"choices":[]}\n\ndata: [DONE]')).toBeUndefined()
    expect(usageFromSseText('')).toBeUndefined()
  })
})

describe('costOf', () => {
  it('prices known DeepSeek models with the official CNY table', async () => {
    // deepseek-chat: input ¥2/M, output ¥8/M
    expect(await costOf('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(10)
    // deepseek-reasoner: input ¥4/M, output ¥16/M
    expect(await costOf('deepseek-reasoner', 500_000, 250_000)).toBeCloseTo(4 + 2)
  })

  it('falls back to deepseek-chat pricing for unknown models', async () => {
    expect(await costOf('unknown-model', 1_000_000, 0)).toBeCloseTo(2)
  })
})
