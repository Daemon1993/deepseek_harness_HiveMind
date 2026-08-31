import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const COMPANY_TOKEN_REF = credentialRef('TEAM_COMPANY_TOKEN')
const run = promisify(execFile)
const POLL_MS = 2_000

interface WatchedRepository {
  root: string
  managedHooksPath: string
  previousHooksPath?: string
  previousPostCommit?: string
  previousPostMerge?: string
}

interface GitRecord {
  action: 'commit' | 'merge'
  repositoryId: string
  baseHash?: string
  commitHash: string
}

const dataRoot = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dir = join(dataRoot, 'team-client')
const hooksRoot = join(dir, 'hooks')
const queuePath = join(dir, 'git-events.queue')
const pendingPath = join(dir, 'git-events.pending')
const watchedPath = join(dir, 'watched.json')

function repositoryId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 24)
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function git(root: string, args: readonly string[]): Promise<string> {
  return (await run('git', ['-C', root, ...args])).stdout.trim()
}

async function optionalGit(root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const value = await git(root, args)
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

async function effectiveHook(root: string, name: string): Promise<string | undefined> {
  return optionalGit(root, ['rev-parse', '--path-format=absolute', '--git-path', `hooks/${name}`])
}

function hookScript(action: GitRecord['action'], id: string, previousHook: string | undefined): string {
  const invokePrevious = previousHook === undefined
    ? ''
    : `if [ -x ${shQuote(previousHook)} ]; then ${shQuote(previousHook)} "$@"; previous_status=$?; fi\n`
  const base = action === 'merge'
    ? 'base=$(git rev-parse ORIG_HEAD 2>/dev/null || true)'
    : 'base=$(git rev-parse HEAD^ 2>/dev/null || true)'
  return `#!/bin/sh
previous_status=0
${invokePrevious}${base}
head=$(git rev-parse HEAD 2>/dev/null || true)
printf '%s|%s|%s|%s|%s\\n' ${shQuote(action)} ${shQuote(id)} "$base" "$head" "$(date +%s)" >> ${shQuote(queuePath.replace(/\\/g, '/'))} || true
exit "$previous_status"
`
}

async function writeManagedHooks(repository: WatchedRepository): Promise<void> {
  const id = repositoryId(repository.root)
  await mkdir(repository.managedHooksPath, { recursive: true })
  await writeFile(join(repository.managedHooksPath, 'post-commit'), hookScript('commit', id, repository.previousPostCommit), { mode: 0o755 })
  await writeFile(join(repository.managedHooksPath, 'post-merge'), hookScript('merge', id, repository.previousPostMerge), { mode: 0o755 })
}

async function installRepository(root: string): Promise<WatchedRepository> {
  const gitDirectory = await git(root, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const commonDirectory = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (gitDirectory.replace(/\\/g, '/') !== commonDirectory.replace(/\\/g, '/')) {
    throw new Error('Linked worktrees require worktree-scoped hook configuration')
  }
  const id = repositoryId(root)
  const managedHooksPath = join(hooksRoot, id)
  const configuredHooksPath = await optionalGit(root, ['config', '--local', '--get', 'core.hooksPath'])
  const ownsLegacyHooks = configuredHooksPath?.replace(/\\/g, '/') === hooksRoot.replace(/\\/g, '/')
  const previousHooksPath = ownsLegacyHooks ? undefined : configuredHooksPath
  const previousPostCommit = ownsLegacyHooks ? undefined : await effectiveHook(root, 'post-commit')
  const previousPostMerge = ownsLegacyHooks ? undefined : await effectiveHook(root, 'post-merge')
  const repository = {
    root,
    managedHooksPath,
    ...(previousHooksPath === undefined ? {} : { previousHooksPath }),
    ...(previousPostCommit === undefined ? {} : { previousPostCommit }),
    ...(previousPostMerge === undefined ? {} : { previousPostMerge }),
  }
  await writeManagedHooks(repository)
  await git(root, ['config', '--local', 'core.hooksPath', managedHooksPath.replace(/\\/g, '/')])
  return repository
}

async function uninstallRepository(repository: WatchedRepository): Promise<void> {
  const current = await optionalGit(repository.root, ['config', '--local', '--get', 'core.hooksPath'])
  if (current?.replace(/\\/g, '/') !== repository.managedHooksPath.replace(/\\/g, '/')) return
  if (repository.previousHooksPath === undefined) {
    try {
      await git(repository.root, ['config', '--local', '--unset', 'core.hooksPath'])
    } catch {
      // The owned setting may already have been removed.
    }
  } else {
    await git(repository.root, ['config', '--local', 'core.hooksPath', repository.previousHooksPath])
  }
}

async function loadWatched(): Promise<Map<string, WatchedRepository>> {
  try {
    const value = JSON.parse(await readFile(watchedPath, 'utf8')) as unknown
    if (!Array.isArray(value)) return new Map()
    const records = value.filter((item): item is WatchedRepository => {
      if (typeof item !== 'object' || item === null) return false
      const record = item as Partial<WatchedRepository>
      return typeof record.root === 'string' && typeof record.managedHooksPath === 'string'
    })
    const result = new Map(records.map(record => [record.root, record]))
    for (const item of value) {
      if (typeof item !== 'string' || result.has(item)) continue
      try {
        result.set(item, await installRepository(item))
      } catch {
        // A legacy watched repository may have moved or been deleted.
      }
    }
    return result
  } catch {
    return new Map()
  }
}

async function saveWatched(watched: Map<string, WatchedRepository>): Promise<void> {
  const temporary = `${watchedPath}.tmp`
  await writeFile(temporary, JSON.stringify([...watched.values()], null, 2))
  await rename(temporary, watchedPath)
}

async function shortStat(root: string, commitHash: string): Promise<{ files: number; insertions: number; deletions: number }> {
  const output = await git(root, ['diff-tree', '-r', '--shortstat', commitHash])
  return {
    files: Number(output.match(/(\d+) files? changed/)?.[1] ?? 0),
    insertions: Number(output.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
    deletions: Number(output.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
  }
}

async function commitMetadata(root: string, commitHash: string): Promise<{ subject?: string; time: number }> {
  const output = await git(root, ['show', '-s', '--format=%s%x00%ct', commitHash])
  const [subject, seconds] = output.split('\0')
  const parsed = Number(seconds)
  return {
    ...(subject === undefined || subject === '' ? {} : { subject }),
    time: Number.isFinite(parsed) ? parsed * 1000 : Date.now(),
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`Git metadata upload failed: HTTP ${response.status}`)
}

async function changedCommits(repository: WatchedRepository, record: GitRecord): Promise<string[]> {
  if (record.action === 'commit' || record.baseHash === undefined) return [record.commitHash]
  const output = await git(repository.root, ['rev-list', '--reverse', `${record.baseHash}..${record.commitHash}`])
  return output.split('\n').filter(Boolean)
}

async function uploadRecord(serverURL: string, headers: Record<string, string>, repository: WatchedRepository, record: GitRecord): Promise<void> {
  const hashes = await changedCommits(repository, record)
  const gitRemote = await optionalGit(repository.root, ['remote', 'get-url', 'origin'])
  const commits = await Promise.all(hashes.map(async commitHash => ({
    commitHash,
    cwd: repository.root,
    ...(gitRemote === undefined ? {} : { gitRemote }),
    ...await commitMetadata(repository.root, commitHash),
    ...await shortStat(repository.root, commitHash),
  })))
  if (commits.length > 0) await postJson(`${serverURL}/team/api/git/changes`, headers, { commits })
  await postJson(`${serverURL}/team/api/git/ops`, headers, { ops: [{ action: record.action, cwd: repository.root, time: Date.now() }] })
}

function parseRecord(line: string): GitRecord | undefined {
  const [action, id, baseHash, commitHash] = line.split('|')
  if ((action !== 'commit' && action !== 'merge') || id === undefined || commitHash === undefined || commitHash === '') return undefined
  return { action, repositoryId: id, ...(baseHash === undefined || baseHash === '' ? {} : { baseHash }), commitHash }
}

async function rotateQueue(): Promise<void> {
  try {
    await rename(queuePath, pendingPath)
  } catch {
    // No queue exists, or Git is appending on Windows. The next poll retries.
  }
}

async function consumeQueue(serverURL: string, headers: Record<string, string>, watched: Map<string, WatchedRepository>): Promise<void> {
  try {
    await readFile(pendingPath)
  } catch {
    await rotateQueue()
  }
  let content: string
  try {
    content = await readFile(pendingPath, 'utf8')
  } catch {
    return
  }
  const lines = content.split('\n').filter(Boolean)
  for (let index = 0; index < lines.length; index += 1) {
    const record = parseRecord(lines[index]!)
    const repository = record === undefined
      ? undefined
      : [...watched.values()].find(candidate => repositoryId(candidate.root) === record.repositoryId)
    if (record !== undefined && repository !== undefined) {
      try {
        await uploadRecord(serverURL, headers, repository, record)
      } catch {
        await writeFile(pendingPath, `${lines.slice(index).join('\n')}\n`)
        return
      }
    }
  }
  await unlink(pendingPath)
}

async function readJsonBody(req: IncomingMessage): Promise<{ cwd?: unknown } | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.byteLength
    if (size > 64 * 1024) return undefined
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { cwd?: unknown }
  } catch {
    return undefined
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Register command-line Git synchronization owned by team-client. */
export function registerGitHooksSync(ctx: Context, serverURL: string): void {
  const authHeaders = async (): Promise<Record<string, string> | undefined> => {
    const credential = await ctx.credentials.resolve(COMPANY_TOKEN_REF)
    return credential === undefined
      ? undefined
      : { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' }
  }
  let watched = new Map<string, WatchedRepository>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let currentPoll = Promise.resolve()

  const poll = (): void => {
    if (stopped) return
    currentPoll = authHeaders()
      .then(headers => headers === undefined ? undefined : consumeQueue(serverURL, headers, watched))
      .catch(() => undefined)
      .finally(() => { if (!stopped) timer = setTimeout(poll, POLL_MS) })
  }
  const start = async (): Promise<void> => {
    await mkdir(dir, { recursive: true })
    watched = await loadWatched()
    for (const repository of watched.values()) {
      try {
        await writeManagedHooks(repository)
      } catch {
        // A watched repository can remain listed while its storage is temporarily unavailable.
      }
    }
    await saveWatched(watched)
  }
  const routes = [
    ctx.webServer.register({ kind: 'exact', path: '/team/git/watch', async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { message: '只支持 POST 请求' }); return }
      const body = await readJsonBody(req)
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      const root = cwd === '' ? undefined : await optionalGit(cwd, ['rev-parse', '--show-toplevel'])
      if (root === undefined) { json(res, 400, { message: '不是 git 仓库' }); return }
      try {
        const existing = watched.get(root)
        const currentHooksPath = await optionalGit(root, ['config', '--local', '--get', 'core.hooksPath'])
        const stillInstalled = existing !== undefined
          && currentHooksPath?.replace(/\\/g, '/') === existing.managedHooksPath.replace(/\\/g, '/')
        const repository = stillInstalled ? existing : await installRepository(root)
        watched.set(root, repository)
        await saveWatched(watched)
        json(res, 200, { ok: true, root })
      } catch {
        json(res, 500, { message: '安装 Git Hook 失败' })
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/git/unwatch', async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { message: '只支持 POST 请求' }); return }
      const body = await readJsonBody(req)
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      const root = cwd === '' ? undefined : await optionalGit(cwd, ['rev-parse', '--show-toplevel'])
      const repository = root === undefined ? undefined : watched.get(root)
      if (root === undefined || repository === undefined) { json(res, 404, { message: '仓库未监听' }); return }
      try {
        await uninstallRepository(repository)
        watched.delete(root)
        await saveWatched(watched)
        json(res, 200, { ok: true })
      } catch {
        json(res, 500, { message: '卸载 Git Hook 失败' })
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/git/status', handler(_req, res) {
      json(res, 200, { watched: [...watched.keys()] })
    } }),
  ]

  currentPoll = start()
  void currentPoll.then(poll)
  ctx.effect(() => async () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    await currentPoll
    for (const dispose of routes.reverse()) dispose()
  }, 'team-client.git-hooks-sync')
}
