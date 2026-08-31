/** Request body exceeded the route-owned byte limit before parsing. */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * Read and parse one JSON body while bounding bytes retained in memory.
 * @param source - request byte stream.
 * @param limit - maximum encoded request bytes.
 * @returns parsed JSON value.
 */
export async function readLimitedJson(
  source: AsyncIterable<Buffer | string | Uint8Array>,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  let tooLarge = false
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > limit) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    if (tooLarge) continue
    chunks.push(bytes)
  }
  if (tooLarge) throw new RequestBodyTooLargeError(limit)
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
}
