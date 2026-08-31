import { describe, expect, it } from 'vitest'
import { readLimitedJson, RequestBodyTooLargeError } from '../src/request-body.ts'

async function* chunks(...values: string[]): AsyncIterable<Buffer> {
  for (const value of values) yield Buffer.from(value)
}

describe('limited JSON request bodies', () => {
  it('parses a body exactly at the byte limit', async () => {
    const body = '{"ok":true}'
    await expect(readLimitedJson(chunks('{"ok":', 'true}'), Buffer.byteLength(body)))
      .resolves.toEqual({ ok: true })
  })

  it('discards the remaining stream after accumulated bytes exceed the limit', async () => {
    let consumed = 0
    async function* source(): AsyncIterable<Buffer> {
      consumed += 1
      yield Buffer.from('1234')
      consumed += 1
      yield Buffer.from('5')
      consumed += 1
      yield Buffer.from('unreachable')
    }

    await expect(readLimitedJson(source(), 4)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(consumed).toBe(3)
  })

  it('keeps malformed JSON distinct from a size rejection', async () => {
    await expect(readLimitedJson(chunks('{'), 1)).rejects.toBeInstanceOf(SyntaxError)
  })
})
