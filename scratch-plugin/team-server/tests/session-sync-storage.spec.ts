import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSessionCandidate,
  publishValidatedSession,
  sessionContentMd5,
  SessionSyncBaseMismatchError,
  SessionSyncContentMismatchError,
  SessionSyncQueue,
  SessionSyncValidationError,
} from '../src/session-sync-storage.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-session-sync-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Session sync storage', () => {
  it('builds a delta only from the byte-exact stored base', async () => {
    const root = await tempRoot()
    const path = join(root, 'session.jsonl.zstd')
    const base = Buffer.from('base')
    const delta = Buffer.from('-delta')
    const complete = Buffer.concat([base, delta])
    await writeFile(path, base)

    const candidate = await buildSessionCandidate(
      path,
      delta,
      complete.byteLength,
      sessionContentMd5(complete),
      { size: base.byteLength, md5: sessionContentMd5(base) },
    )
    await expect(readFile(candidate.path)).resolves.toEqual(complete)
    await rm(candidate.path)

    await expect(buildSessionCandidate(
      path,
      delta,
      complete.byteLength,
      sessionContentMd5(complete),
      { size: base.byteLength, md5: sessionContentMd5(Buffer.from('other')) },
    )).rejects.toBeInstanceOf(SessionSyncBaseMismatchError)
  })

  it('rejects a complete candidate whose declared digest is false', async () => {
    const bytes = Buffer.from('candidate')
    await expect(buildSessionCandidate(
      'unused',
      bytes,
      bytes.byteLength,
      sessionContentMd5(Buffer.from('other')),
    )).rejects.toBeInstanceOf(SessionSyncContentMismatchError)
  })

  it('restores the previous replica when parser validation rejects', async () => {
    const root = await tempRoot()
    const path = join(root, 'session.jsonl.zstd')
    const previous = Buffer.from('previous')
    await writeFile(path, previous)

    const candidate = await buildSessionCandidate(
      path,
      Buffer.from('invalid'),
      Buffer.byteLength('invalid'),
      sessionContentMd5(Buffer.from('invalid')),
    )
    await expect(publishValidatedSession(path, candidate, async () => {
      throw new Error('invalid Session artifact')
    })).rejects.toBeInstanceOf(SessionSyncValidationError)

    await expect(readFile(path)).resolves.toEqual(previous)
    await expect(readdir(root)).resolves.toEqual(['session.jsonl.zstd'])
  })

  it('publishes a validated candidate and removes transaction files', async () => {
    const root = await tempRoot()
    const path = join(root, 'session.jsonl.zstd')
    const candidateBytes = Buffer.from('candidate')
    await writeFile(path, 'previous')
    const candidate = await buildSessionCandidate(
      path,
      candidateBytes,
      candidateBytes.byteLength,
      sessionContentMd5(candidateBytes),
    )

    await publishValidatedSession(path, candidate, async () => {
      await expect(readFile(path)).resolves.toEqual(candidateBytes)
    })

    await expect(readFile(path)).resolves.toEqual(candidateBytes)
    await expect(readdir(root)).resolves.toEqual(['session.jsonl.zstd'])
  })

  it('serializes one Session without blocking an unrelated Session', async () => {
    const queue = new SessionSyncQueue()
    const order: string[] = []
    let releaseFirst!: () => void
    let markStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = queue.run('same', async () => {
      order.push('first:start')
      markStarted()
      await firstGate
      order.push('first:end')
    })
    await firstStarted
    const second = queue.run('same', async () => { order.push('second') })
    const unrelated = queue.run('other', async () => { order.push('other') })

    await unrelated
    expect(order).toEqual(['first:start', 'other'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second'])
  })
})
