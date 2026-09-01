import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const run = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.resetModules()
  delete process.env.DSH_HOME
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('project import Git synchronization', () => {
  // 真实 Git 仓库：导入即全量抽取全部历史提交并批量上报。
  it('imports a repository and uploads its full commit history', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-git-import-'))
    temporaryRoots.push(temporaryRoot)
    const repositoryRoot = join(temporaryRoot, 'repository')
    const dataRoot = join(temporaryRoot, 'data')
    await mkdir(repositoryRoot)
    await run('git', ['init'], { cwd: repositoryRoot })
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repositoryRoot })
    await run('git', ['config', 'user.name', 'Test'], { cwd: repositoryRoot })
    await run('git', ['remote', 'add', 'origin', 'https://example.com/team/repository.git'], { cwd: repositoryRoot })
    await writeFile(join(repositoryRoot, 'a.txt'), 'one')
    await run('git', ['add', 'a.txt'], { cwd: repositoryRoot })
    await run('git', ['commit', '-m', 'first'], { cwd: repositoryRoot })
    await writeFile(join(repositoryRoot, 'b.txt'), 'two')
    await run('git', ['add', 'b.txt'], { cwd: repositoryRoot })
    await run('git', ['commit', '-m', 'fix: second'], { cwd: repositoryRoot })
    process.env.DSH_HOME = dataRoot

    const handlers = new Map<string, (req: Readable & { method?: string }, res: { writeHead(status: number): void; end(body: string): void }) => Promise<void> | void>()
    let disposeEffect: (() => Promise<void>) | undefined
    const requests: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) as unknown })
      return { ok: true }
    }))
    const ctx = {
      credentials: { resolve: async () => ({ value: 'team-token' }) },
      webServer: { register: ({ path, handler }: { path: string; handler: typeof handlers extends Map<string, infer T> ? T : never }) => {
        handlers.set(path, handler)
        return () => undefined
      } },
      effect: (factory: () => () => Promise<void>) => { disposeEffect = factory() },
    }
    const { registerGitSync } = await import('../src/git-sync.ts')
    registerGitSync(ctx as never, 'http://127.0.0.1:1')
    await vi.waitFor(() => expect(handlers.has('/team/git/import')).toBe(true))

    const request = Object.assign(Readable.from([JSON.stringify({ cwd: repositoryRoot })]), { method: 'POST' })
    let status = 0
    await handlers.get('/team/git/import')!(request, { writeHead(value) { status = value }, end() {} })
    expect(status).toBe(200)
    await vi.waitFor(() => expect(requests.some(request => request.url.endsWith('/team/api/git/changes'))).toBe(true), { timeout: 5_000 })
    const changes = requests.find(request => request.url.endsWith('/team/api/git/changes'))?.body as {
      commits: { commitHash: string; gitRemote?: string; authorName?: string; authorEmail?: string; subject?: string; changedFiles?: string[]; insertions?: number }[]
    }
    expect(changes.commits).toHaveLength(2)
    expect(changes.commits[0]).toMatchObject({
      gitRemote: 'https://example.com/team/repository.git',
      authorName: 'Test',
      authorEmail: 'test@example.com',
      subject: 'fix: second',
    })
    expect(changes.commits[1]).toMatchObject({ subject: 'first' })
    // 首次提交（根提交）也要有统计与文件路径。
    expect(changes.commits[1].changedFiles).toContain('a.txt')
    expect(changes.commits[1].insertions).toBeGreaterThan(0)

    // 再次导入同一仓库：游标生效，不重复上报已有提交。
    await vi.waitFor(async () => {
      const statusRequest = Object.assign(Readable.from([]), { method: 'GET' })
      let statusBody = ''
      await handlers.get('/team/git/status')!(statusRequest, { writeHead() {}, end(body) { statusBody = body } })
      const parsed = JSON.parse(statusBody) as { imported: { root: string; hasCursor: boolean }[] }
      const normalizedRoot = (await run('git', ['-C', repositoryRoot, 'rev-parse', '--show-toplevel'])).stdout.trim()
      expect(parsed.imported.find(item => item.root === normalizedRoot)?.hasCursor).toBe(true)
    }, { timeout: 5_000 })
    requests.length = 0
    await handlers.get('/team/git/import')!(Object.assign(Readable.from([JSON.stringify({ cwd: repositoryRoot })]), { method: 'POST' }), { writeHead(value) { status = value }, end() {} })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(requests.filter(request => request.url.endsWith('/team/api/git/changes'))).toHaveLength(0)

    await disposeEffect?.()
  }, 20_000)
})
