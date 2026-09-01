// git-sync.ts —— 项目导入即抽取全部历史提交，之后按游标周期增量扫描。
// 唯一数据源是 `git log` 命令：不做任何 hook / 工具事件监听（无操作依赖）。
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const COMPANY_TOKEN_REF = credentialRef('TEAM_COMPANY_TOKEN')
const run = promisify(execFile)
/** 增量扫描默认间隔（分钟），可用 TEAM_GIT_SCAN_MINUTES 覆盖。 */
const DEFAULT_SCAN_MINUTES = 5
/** 每次上报的提交批量大小。 */
const UPLOAD_BATCH_SIZE = 100
/** 扫描用 git log 的最大输出缓冲（大仓库历史可远超 execFile 默认 1MB）。 */
const SCAN_MAX_BUFFER = 64 * 1024 * 1024

function gitLog(level: 'info' | 'warn', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [team-client.git] ${message}`
  if (level === 'warn') console.warn(line)
  else console.info(line)
}

interface WatchedRepository {
  root: string
  /** 上次全量扫描的最新提交 hash：下次扫描只取它之后的增量。 */
  lastSyncedHash?: string
}

const dataRoot = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dir = join(dataRoot, 'team-client')
const watchedPath = join(dir, 'watched.json')

async function git(root: string, args: readonly string[]): Promise<string> {
  return (await run('git', ['-C', root, ...args])).stdout.trim()
}

async function gitScan(root: string, args: readonly string[]): Promise<string> {
  return (await run('git', ['-C', root, ...args], { maxBuffer: SCAN_MAX_BUFFER })).stdout.trim()
}

async function optionalGit(root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const value = await git(root, args)
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** 解析 `git log --format=%H%x00%an%x00%ae%x00%B%x00%ct` 输出：hash → 作者/完整 message/时间。 */
export function parseLogMetadata(output: string): Map<string, { authorName: string; authorEmail: string; message: string; time: number }> {
  const records = new Map<string, { authorName: string; authorEmail: string; message: string; time: number }>()
  // 每个记录以 40 位 hash + NUL 开头；message 可含换行，但 git 消息不含 NUL。
  for (const record of output.split(/(?=^[0-9a-f]{40}\x00)/mu)) {
    const [hash, authorName, authorEmail, message, seconds] = record.split('\x00')
    if (hash === undefined || !/^[0-9a-f]{40}$/u.test(hash)) continue
    const time = Number(seconds)
    // 时间戳必须是 10 位 epoch 秒；病态消息（整行 40 位 hex）造成的假边界会被跳过。
    if (!Number.isFinite(time) || time < 1_000_000_000) continue
    records.set(hash, {
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      message: (message ?? '').trimEnd(),
      time: time * 1000,
    })
  }
  return records
}

/** 解析 `git log --format=%H --name-status --no-renames` 输出：hash → 变更文件路径。 */
export function parseNameStatus(output: string): Map<string, string[]> {
  const records = new Map<string, string[]>()
  let current: string | undefined
  for (const line of output.split('\n')) {
    if (/^[0-9a-f]{40}$/u.test(line)) {
      current = line
      records.set(line, [])
      continue
    }
    if (current === undefined || !line.includes('\t')) continue
    const path = line.split('\t').at(-1)
    if (path !== undefined && path !== '') records.get(current)?.push(path)
  }
  return records
}

/** 解析 `git log --format=%H --shortstat` 输出：hash → 文件数/增删行数。 */
export function parseShortStatLog(output: string): Map<string, { files: number; insertions: number; deletions: number }> {
  const records = new Map<string, { files: number; insertions: number; deletions: number }>()
  let current: string | undefined
  for (const line of output.split('\n')) {
    if (/^[0-9a-f]{40}$/u.test(line)) {
      current = line
      continue
    }
    if (current === undefined) continue
    const files = Number(line.match(/(\d+) files? changed/)?.[1] ?? 0)
    if (files === 0 && !line.includes('file')) continue
    records.set(current, {
      files,
      insertions: Number(line.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
      deletions: Number(line.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
    })
  }
  return records
}

interface ScannedCommit {
  commitHash: string
  authorName: string
  authorEmail: string
  subject: string
  message: string
  changedFiles: string[]
  files: number
  insertions: number
  deletions: number
  time: number
}

/** 扫描仓库提交：有游标时只取游标之后（`git log --all --not <cursor>`），否则全量。 */
async function scanCommits(root: string, cursor: string | undefined): Promise<ScannedCommit[]> {
  const range = cursor === undefined ? ['--all'] : ['--all', '--not', cursor]
  const [metadata, nameStatus, shortStat] = await Promise.all([
    gitScan(root, ['log', ...range, '--format=%H%x00%an%x00%ae%x00%B%x00%ct']),
    gitScan(root, ['log', ...range, '--format=%H', '--name-status', '--no-renames']),
    gitScan(root, ['log', ...range, '--format=%H', '--shortstat']),
  ])
  const meta = parseLogMetadata(metadata)
  const paths = parseNameStatus(nameStatus)
  const stats = parseShortStatLog(shortStat)
  return [...meta.entries()].map(([commitHash, record]) => {
    const changedFiles = (paths.get(commitHash) ?? []).slice(0, 200)
    const stat = stats.get(commitHash)
    const subject = record.message.split('\n')[0]?.trim() ?? ''
    return {
      commitHash,
      authorName: record.authorName,
      authorEmail: record.authorEmail,
      subject,
      message: record.message,
      changedFiles,
      files: stat?.files ?? 0,
      insertions: stat?.insertions ?? 0,
      deletions: stat?.deletions ?? 0,
      time: record.time,
    }
  })
}

/** 读取已导入仓库清单（只认 root 与游标，其他历史字段一律忽略）。 */
async function loadWatched(): Promise<Map<string, WatchedRepository>> {
  try {
    const value = JSON.parse(await readFile(watchedPath, 'utf8')) as unknown
    if (!Array.isArray(value)) return new Map()
    const result = new Map<string, WatchedRepository>()
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (typeof record.root !== 'string' || record.root === '') continue
      result.set(record.root, {
        root: record.root,
        ...(typeof record.lastSyncedHash === 'string' ? { lastSyncedHash: record.lastSyncedHash } : {}),
      })
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

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Git metadata upload failed: HTTP ${response.status}${detail === '' ? '' : ` — ${detail.slice(0, 200)}`}`)
  }
}

/** 抽取一个仓库的全部/增量提交并批量上报；成功更新扫描游标并持久化。 */
async function backfillRepository(serverURL: string, headers: Record<string, string>, repository: WatchedRepository, save: () => Promise<void>): Promise<void> {
  const gitRemote = await optionalGit(repository.root, ['remote', 'get-url', 'origin'])
  let commits: ScannedCommit[]
  try {
    commits = await scanCommits(repository.root, repository.lastSyncedHash)
  } catch {
    // 游标 hash 已失效（仓库被重新克隆/重写）时回退全量扫描。
    delete repository.lastSyncedHash
    commits = await scanCommits(repository.root, undefined)
  }
  if (commits.length === 0) return
  gitLog('info', `scan ${commits.length} commit(s) root=${repository.root} range=${repository.lastSyncedHash === undefined ? 'full' : 'incremental'}`)
  for (let offset = 0; offset < commits.length; offset += UPLOAD_BATCH_SIZE) {
    const batch = commits.slice(offset, offset + UPLOAD_BATCH_SIZE).map(commit => ({
      commitHash: commit.commitHash,
      cwd: repository.root,
      ...(gitRemote === undefined ? {} : { gitRemote }),
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      subject: commit.subject,
      message: commit.message,
      changedFiles: commit.changedFiles,
      files: commit.files,
      insertions: commit.insertions,
      deletions: commit.deletions,
      time: commit.time,
    }))
    await postJson(`${serverURL}/team/api/git/changes`, headers, { commits: batch })
  }
  // 全部批次成功后推进游标：下次只扫最新提交之后的新增。
  repository.lastSyncedHash = commits[0]!.commitHash
  await save()
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

/** 注册 Git 提交同步：导入项目即全量抽取，之后周期增量扫描。 */
export function registerGitSync(ctx: Context, serverURL: string): void {
  const authHeaders = async (): Promise<Record<string, string> | undefined> => {
    const credential = await ctx.credentials.resolve(COMPANY_TOKEN_REF)
    return credential === undefined
      ? undefined
      : { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' }
  }
  let watched = new Map<string, WatchedRepository>()
  let stopped = false
  let backfilling = false
  const scanMinutes = Number(process.env.TEAM_GIT_SCAN_MINUTES ?? String(DEFAULT_SCAN_MINUTES))
  const scanIntervalMs = Number.isFinite(scanMinutes) && scanMinutes >= 1 ? scanMinutes * 60 * 1000 : DEFAULT_SCAN_MINUTES * 60 * 1000

  /** 依次扫描全部已导入仓库（全量首扫 + 游标增量），失败不影响其他仓库。 */
  const backfillAll = async (): Promise<void> => {
    if (backfilling || stopped) return
    backfilling = true
    try {
      const headers = await authHeaders()
      if (headers === undefined) return
      for (const repository of watched.values()) {
        try {
          await backfillRepository(serverURL, headers, repository, () => saveWatched(watched))
        } catch (error) {
          gitLog('warn', `backfill failed root=${repository.root}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      backfilling = false
    }
  }

  const routes = [
    ctx.webServer.register({ kind: 'exact', path: '/team/git/import', async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { message: '只支持 POST 请求' }); return }
      const body = await readJsonBody(req)
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      const root = cwd === '' ? undefined : await optionalGit(cwd, ['rev-parse', '--show-toplevel'])
      if (root === undefined) { json(res, 400, { message: '不是 git 仓库' }); return }
      // 已导入则保留游标（增量续扫）；首次导入无游标 → 全量抽取。
      const existing = watched.get(root)
      if (existing === undefined) watched.set(root, { root })
      await saveWatched(watched)
      json(res, 200, { ok: true, root })
      // 导入即全量抽取该仓库全部历史提交。
      void backfillRepository(serverURL, (await authHeaders()) ?? {}, watched.get(root)!, () => saveWatched(watched)).catch(error => {
        gitLog('warn', `import backfill failed root=${root}: ${error instanceof Error ? error.message : String(error)}`)
      })
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/git/remove', async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { message: '只支持 POST 请求' }); return }
      const body = await readJsonBody(req)
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      const root = cwd === '' ? undefined : await optionalGit(cwd, ['rev-parse', '--show-toplevel'])
      if (root === undefined || !watched.has(root)) { json(res, 404, { message: '项目未导入' }); return }
      watched.delete(root)
      await saveWatched(watched)
      json(res, 200, { ok: true })
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/git/status', handler(_req, res) {
      json(res, 200, { imported: [...watched.values()].map(repository => ({ root: repository.root, hasCursor: repository.lastSyncedHash !== undefined })) })
    } }),
  ]

  const start = async (): Promise<void> => {
    await mkdir(dir, { recursive: true })
    watched = await loadWatched()
    // 启动即补传全部已导入仓库的历史提交（有游标的仓库只扫增量）。
    void backfillAll()
  }
  void start()
  // 周期增量扫描：按 TEAM_GIT_SCAN_MINUTES 轮询 git log，补齐新提交。
  const scanTimer = setInterval(() => { void backfillAll() }, scanIntervalMs)
  ctx.effect(() => async () => {
    stopped = true
    clearInterval(scanTimer)
    for (const dispose of routes.reverse()) dispose()
  }, 'team-client.git-sync')
}
