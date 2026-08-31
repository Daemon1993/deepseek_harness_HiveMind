import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Calculate the byte-exact digest used by the Session sync protocol.
 * @param bytes - complete artifact bytes.
 * @returns lowercase hexadecimal MD5.
 */
export function sessionContentMd5(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex')
}

/**
 * Read an existing replica and prove that it matches the client's append base.
 * @param path - Server-owned replica path.
 * @param uploaded - complete artifact or delta bytes from the request.
 * @param expectedSize - declared complete artifact size.
 * @param expectedMd5 - declared complete artifact digest.
 * @param base - optional append base that the existing replica must match.
 * @returns detached complete candidate bytes.
 */
export type SessionSyncCandidate = {
  path: string
}

export async function buildSessionCandidate(
  path: string,
  uploaded: Buffer,
  expectedSize: number,
  expectedMd5: string,
  base?: { size: number; md5: string },
): Promise<SessionSyncCandidate> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.sync-tmp`
  const handle = await open(temporary, 'wx', 0o600)
  const completeHash = createHash('md5')
  let completeSize = 0
  try {
    if (base !== undefined) {
      const baseHash = createHash('md5')
      try {
        for await (const chunk of createReadStream(path)) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          baseHash.update(bytes)
          completeHash.update(bytes)
          completeSize += bytes.byteLength
          await writeAll(handle, bytes)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionSyncBaseMismatchError()
        throw error
      }
      if (completeSize !== base.size || baseHash.digest('hex') !== base.md5) {
        throw new SessionSyncBaseMismatchError()
      }
    }
    completeHash.update(uploaded)
    completeSize += uploaded.byteLength
    await writeAll(handle, uploaded)
    if (completeSize !== expectedSize || completeHash.digest('hex') !== expectedMd5) {
      throw new SessionSyncContentMismatchError()
    }
    await handle.close()
    return { path: temporary }
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten === 0) throw new Error('session sync temporary file write made no progress')
    offset += bytesWritten
  }
}

/** The server replica differs from the append base claimed by the client. */
export class SessionSyncBaseMismatchError extends Error {
  constructor() {
    super('session sync base does not match the stored replica')
    this.name = 'SessionSyncBaseMismatchError'
  }
}

/** The uploaded bytes differ from the declared complete-file size or digest. */
export class SessionSyncContentMismatchError extends Error {
  constructor() {
    super('session sync content does not match its declared size or digest')
    this.name = 'SessionSyncContentMismatchError'
  }
}

/** The candidate was published for persistence parsing and rejected without replacing the previous replica. */
export class SessionSyncValidationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'SessionSyncValidationError'
  }
}

/**
 * Publish one candidate for parser validation while preserving the previous
 * replica until validation succeeds. A failed validation restores the previous
 * file; a failed restoration retains the uniquely named backup for recovery.
 * @param path - Server-owned replica path.
 * @param candidate - complete temporary file already checked against the wire declaration.
 * @param validate - parser validation against the temporarily published candidate.
 */
export async function publishValidatedSession(
  path: string,
  candidate: SessionSyncCandidate,
  validate: () => Promise<void>,
): Promise<void> {
  const nonce = randomUUID()
  const backup = `${path}.${nonce}.sync-backup`
  let hasBackup = false
  let published = false
  try {
    try {
      await rename(path, backup)
      hasBackup = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(candidate.path, path)
    published = true
    try {
      await validate()
    } catch (error) {
      await rm(path, { force: true })
      published = false
      if (hasBackup) {
        await rename(backup, path)
        hasBackup = false
      }
      throw new SessionSyncValidationError(error)
    }
    if (hasBackup) {
      await rm(backup, { force: true })
      hasBackup = false
    }
  } catch (error) {
    if (!published && hasBackup) {
      try {
        await rename(backup, path)
        hasBackup = false
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `session sync failed and backup remains at ${backup}`)
      }
    }
    throw error
  } finally {
    await rm(candidate.path, { force: true })
  }
}

/** Serialize uploads for one Session while allowing unrelated Sessions to proceed. */
export class SessionSyncQueue {
  private tails = new Map<string, Promise<void>>()

  /**
   * Run after earlier operations for the same Session while retaining cross-Session concurrency.
   * @param sessionId - queue ownership key.
   * @param operation - asynchronous transaction holding that Session's turn.
   * @returns the operation result.
   */
  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => turn)
    this.tails.set(sessionId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    }
  }
}
