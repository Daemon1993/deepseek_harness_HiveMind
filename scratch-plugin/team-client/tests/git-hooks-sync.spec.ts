import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const run = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  vi.resetModules()
  delete process.env.DSH_HOME
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('command-line Git synchronization', () => {
  // The case runs real Git processes and hooks; use the subprocess-test lane budget on contended Windows hosts.
  it('chains and restores an existing hooksPath', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-git-hooks-'))
    temporaryRoots.push(temporaryRoot)
    const repositoryRoot = join(temporaryRoot, 'repository')
    const dataRoot = join(temporaryRoot, 'data')
    const originalHooks = join(temporaryRoot, 'original-hooks')
    const marker = join(temporaryRoot, 'original-hook-ran')
    await mkdir(repositoryRoot)
    await mkdir(originalHooks)
    await run('git', ['init'], { cwd: repositoryRoot })
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repositoryRoot })
    await run('git', ['config', 'user.name', 'Test'], { cwd: repositoryRoot })
    const originalHook = join(originalHooks, 'post-commit')
    await writeFile(originalHook, `#!/bin/sh\nprintf ran > '${marker.replace(/\\/g, '/')}'\n`)
    await chmod(originalHook, 0o755)
    await run('git', ['config', '--local', 'core.hooksPath', originalHooks.replace(/\\/g, '/')], { cwd: repositoryRoot })
    process.env.DSH_HOME = dataRoot

    const handlers = new Map<string, (req: Readable & { method?: string }, res: { writeHead(status: number): void; end(body: string): void }) => Promise<void> | void>()
    let disposeEffect: (() => Promise<void>) | undefined
    const ctx = {
      credentials: { resolve: async () => undefined },
      webServer: { register: ({ path, handler }: { path: string; handler: typeof handlers extends Map<string, infer T> ? T : never }) => {
        handlers.set(path, handler)
        return () => undefined
      } },
      effect: (factory: () => () => Promise<void>) => { disposeEffect = factory() },
    }
    const { registerGitHooksSync } = await import('../src/git-hooks-sync.ts')
    registerGitHooksSync(ctx as never, 'http://127.0.0.1:1')
    await vi.waitFor(() => expect(handlers.has('/team/git/watch')).toBe(true))

    const request = Object.assign(Readable.from([JSON.stringify({ cwd: repositoryRoot })]), { method: 'POST' })
    let status = 0
    await handlers.get('/team/git/watch')!(request, { writeHead(value) { status = value }, end() {} })
    expect(status).toBe(200)
    const managedHooks = (await run('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repositoryRoot })).stdout.trim()
    expect(managedHooks).not.toBe(originalHooks.replace(/\\/g, '/'))

    await writeFile(join(repositoryRoot, 'file.txt'), 'content')
    await run('git', ['add', 'file.txt'], { cwd: repositoryRoot })
    await run('git', ['commit', '-m', 'test'], { cwd: repositoryRoot })
    expect(await readFile(marker, 'utf8')).toBe('ran')
    expect(await readFile(join(dataRoot, 'team-client', 'git-events.queue'), 'utf8')).toContain('commit|')

    const unwatch = Object.assign(Readable.from([JSON.stringify({ cwd: repositoryRoot })]), { method: 'POST' })
    await handlers.get('/team/git/unwatch')!(unwatch, { writeHead(value) { status = value }, end() {} })
    expect(status).toBe(200)
    expect((await run('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repositoryRoot })).stdout.trim()).toBe(originalHooks.replace(/\\/g, '/'))
    await disposeEffect?.()
  }, 15_000)
})
