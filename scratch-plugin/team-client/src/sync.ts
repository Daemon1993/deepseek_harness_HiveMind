// session-sync.ts —— 把本地 DSH 会话日志文件（session.jsonl.zstd）同步到 Team Server。
// 常规为字节增量（只传新增尾部，md5 校验前缀），重写/异常时全量替换。
// 文件即真相；md5 前缀校验保证追加安全，任何不匹配回退全量（幂等自愈）。
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-controller'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { SessionSyncScheduler } from './session-sync-scheduler.ts'

const COMPANY_TOKEN_REF = credentialRef('TEAM_COMPANY_TOKEN')

/** 单次上传上限（全量替换时超过则跳过并告警一次）。 */
const MAX_LOG_BYTES = 50 * 1024 * 1024
const SYNC_DEBOUNCE_MS = 3_000
const SYNC_RETRY_MS = 10_000

function md5Of(bytes: Buffer | Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

type GitProject = { root: string; remote?: string }
const gitProjects = new Map<string, Promise<GitProject | undefined>>()
const execFileAsync = promisify(execFile)

/** Ask Git for the repository root and optional origin URL of one workspace. */
function findGitProject(cwd: string | undefined): Promise<GitProject | undefined> {
  if (cwd === undefined) return Promise.resolve(undefined)
  const cached = gitProjects.get(cwd)
  if (cached !== undefined) return cached
  const pending = (async (): Promise<GitProject | undefined> => {
    const root = (await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).stdout.trim()
    if (root === '') return undefined
    const remote = await execFileAsync('git', ['-C', root, 'config', '--get', 'remote.origin.url'])
      .then(result => result.stdout.trim())
      .catch(() => '')
    return { root, ...(remote === '' ? {} : { remote }) }
  })().catch(() => undefined)
  gitProjects.set(cwd, pending)
  return pending
}

function syncLog(level: 'info' | 'warn', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [team-client.sync] ${message}`
  if (level === 'warn') console.warn(line)
  else console.info(line)
}

/** 订阅本地 Session 生命周期，把每个会话的日志增量/全量同步到 server。 */
export function registerSessionSync(ctx: Context, serverURL: string): void {
  const scheduler = new SessionSyncScheduler(SYNC_DEBOUNCE_MS, SYNC_RETRY_MS)
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    syncLog('warn', message)
  }
  const reportedSync = new Set<string>()
  // 同步状态（浏览器端通过 /team/sync/status 轮询展示）
  let inFlight = 0
  let lastSyncAt = 0
  const syncStatus = {
    syncing: false,
    lastSyncAt: 0,
    lastSyncedSession: '',
    flushEvents: 0,
    lastFlushAt: 0,
    lastFlushSession: '',
    syncAttempts: 0,
    lastAttemptAt: 0,
    lastAttemptSession: '',
    lastErrorAt: 0,
    lastError: '',
  }
  const markError = (message: string): void => {
    syncStatus.lastErrorAt = Date.now()
    syncStatus.lastError = message
  }
  const markSyncing = (active: boolean): void => {
    inFlight = Math.max(0, inFlight + (active ? 1 : -1))
    syncStatus.syncing = inFlight > 0
  }
  ctx.webServer.register({ kind: 'exact', path: '/team/sync/status', handler(_req, res) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(syncStatus))
  } })
  ctx.webServer.register({ kind: 'exact', path: '/team/sync/now', handler(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    void backfill()
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
  } })
  const authHeaders = async (): Promise<Record<string, string> | undefined> => {
    const credential = await ctx.credentials.resolve(COMPANY_TOKEN_REF)
    if (credential === undefined) return undefined
    return { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' }
  }

  const upload = async (
    sessionId: string,
    header: SessionHeader,
    bytes: Buffer,
    baseSize: number | undefined,
    baseMd5: string | undefined,
  ): Promise<'synced' | 'conflict' | 'retry' | 'failed'> => {
    const contentMd5 = md5Of(bytes)
    const delta = baseSize === undefined ? bytes : bytes.subarray(baseSize)
    const headers = await authHeaders()
    if (headers === undefined) {
      markError('TEAM_COMPANY_TOKEN is unavailable')
      return 'retry'
    }
    const gitProject = await findGitProject(header.cwd)
    markSyncing(true)
    try {
      const response = await fetch(`${serverURL}/team/api/sync/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId,
          header,
          log: delta.toString('base64'),
          contentMd5,
          totalSize: bytes.byteLength,
          ...(gitProject === undefined ? {} : { projectRoot: gitProject.root }),
          ...(gitProject?.remote === undefined ? {} : { gitRemote: gitProject.remote }),
          ...(baseSize === undefined || baseMd5 === undefined ? {} : { baseSize, baseMd5 }),
        }),
      })
      if (response.status === 409) return 'conflict'
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        let reason: unknown
        try {
          reason = (JSON.parse(detail) as { reason?: unknown }).reason
        } catch {
          reason = undefined
        }
        if (response.status === 400 && reason === 'content-mismatch'
          && baseSize !== undefined && baseMd5 !== undefined) return 'conflict'
        const message = `session upload failed status=${response.status} session=${sessionId}${detail === '' ? '' : `: ${detail}`}`
        markError(message)
        warnOnce(`${sessionId}:upload`, message)
        return response.status === 408 || response.status === 429 || response.status >= 500 ? 'retry' : 'failed'
      }
      lastSyncAt = Date.now()
      syncStatus.lastSyncAt = lastSyncAt
      syncStatus.lastSyncedSession = sessionId
      syncStatus.lastErrorAt = 0
      syncStatus.lastError = ''
      warned.delete(`${sessionId}:upload`)
      warned.delete(`${sessionId}:read`)
      if (!reportedSync.has(sessionId)) {
        reportedSync.add(sessionId)
        syncLog('info', `session synced sid=${sessionId.slice(0, 8)} mode=${baseSize === undefined ? 'full' : 'delta'}`)
      }
      return 'synced'
    } catch (error) {
      const message = `session upload failed session=${sessionId}: ${String(error)}`
      markError(message)
      warnOnce(`${sessionId}:upload`, message)
      return 'retry'
    } finally {
      markSyncing(false)
    }
  }

  const uploadFull = async (sessionId: string, header: SessionHeader, bytes: Buffer): Promise<boolean> => {
    if (bytes.byteLength > MAX_LOG_BYTES) {
      warnOnce(`${sessionId}:too-large`, `session log too large (${bytes.byteLength} bytes), sync skipped: ${sessionId}`)
      return true
    }
    const result = await upload(sessionId, header, bytes, undefined, undefined)
    return result === 'synced' || result === 'failed'
  }

  /** 每次同步前从 server 拉取该会话的已存状态（位置+指纹）。 */
  const fetchMarker = async (sessionId: string): Promise<{ fileSize?: number; contentMd5?: string; projectRoot?: string; gitRemote?: string } | undefined> => {
    const headers = await authHeaders()
    if (headers === undefined) return undefined
    try {
      const response = await fetch(`${serverURL}/team/api/sync/session/status?sessionId=${encodeURIComponent(sessionId)}`, { headers })
      if (!response.ok) return undefined
      const data = await response.json() as { has: boolean; fileSize?: unknown; contentMd5?: string; projectRoot?: string; gitRemote?: string }
      const parsedFileSize = typeof data.fileSize === 'number'
        ? data.fileSize
        : typeof data.fileSize === 'string' && /^\d+$/u.test(data.fileSize)
          ? Number(data.fileSize)
          : undefined
      const fileSize = parsedFileSize !== undefined && Number.isSafeInteger(parsedFileSize)
        ? parsedFileSize
        : undefined
      return data.has
        ? { ...(fileSize === undefined ? {} : { fileSize }), ...(data.contentMd5 === undefined ? {} : { contentMd5: data.contentMd5 }), ...(data.projectRoot === undefined ? {} : { projectRoot: data.projectRoot }), ...(data.gitRemote === undefined ? {} : { gitRemote: data.gitRemote }) }
        : undefined
    } catch {
      return undefined
    }
  }

  const syncSession = async (sessionId: string, header: SessionHeader): Promise<boolean> => {
    syncStatus.syncAttempts += 1
    syncStatus.lastAttemptAt = Date.now()
    syncStatus.lastAttemptSession = sessionId
    try {
      const location = ctx.sessionPersistence.locate(header)
      if (location === undefined) return true
      const info = await stat(location.path).catch(() => undefined)
      if (info === undefined) return true // 文件尚未落盘（首个事件未提交）
      const bytes = await readFile(location.path)
      // 稳定性校验：读取期间文件大小变化（DSH 正在追加/截断）则跳过本轮，
      // 下次 flush 会重试——避免把半写的文件全量上传到 server。
      const after = await stat(location.path).catch(() => undefined)
      if (after !== undefined && after.size !== info.size) return false
      const contentMd5 = md5Of(bytes)
      const marker = await fetchMarker(sessionId)
      const gitProject = await findGitProject(header.cwd)
      if (marker !== undefined && marker.fileSize === info.size && marker.contentMd5 === contentMd5
        && marker.projectRoot === gitProject?.root && marker.gitRemote === gitProject?.remote) return true // 内容与 Git 归属均无变化
      // 增量：server 已有同前缀（md5 验证），只补尾部
      if (marker?.fileSize !== undefined && marker.contentMd5 !== undefined
        && marker.fileSize > 0 && marker.fileSize < info.size
        && md5Of(bytes.subarray(0, marker.fileSize)) === marker.contentMd5) {
        const result = await upload(sessionId, header, bytes, marker.fileSize, marker.contentMd5)
        if (result === 'conflict') return await uploadFull(sessionId, header, bytes)
        return result === 'synced' || result === 'failed'
      }
      return await uploadFull(sessionId, header, bytes)
    } catch (error) {
      const message = `session upload error session=${sessionId}: ${String(error)}`
      markError(message)
      warnOnce(`${sessionId}:read`, message)
      return false
    }
  }

  const flushThenSchedule = async (session: Session): Promise<void> => {
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      const message = `session flush before upload failed session=${session.id}: ${String(error)}`
      markError(message)
      warnOnce(`${session.id}:flush`, message)
      return
    }
    scheduler.runNow(session.id, () => syncSession(session.id, session.header))
  }

  // 官方扩展点。监听器绝不能抛异常：session/created 抛错会让 attach 回滚。
  // Browser agents run in child scopes that are siblings of this Host plugin.
  // Subscribe at the root so their carrier-scoped lifecycle events reach sync.
  const lifecycleDisposers = [
    ctx.on('session/created', (session: Session) => {
      scheduler.schedule(session.id, () => syncSession(session.id, session.header))
    }, { global: true }),
    ctx.on('session/flush', (session: Session) => {
      syncStatus.flushEvents += 1
      syncStatus.lastFlushAt = Date.now()
      syncStatus.lastFlushSession = session.id
      scheduler.schedule(session.id, () => syncSession(session.id, session.header))
    }, { global: true }),
    ctx.on('session/disposed', (session: Session) => {
      scheduler.runNow(session.id, () => syncSession(session.id, session.header))
    }, { global: true }),
  ]
  ctx.effect(() => async () => {
    for (const dispose of lifecycleDisposers.reverse()) dispose()
    await scheduler.dispose()
  }, 'team-client.session-sync')

  // 挂载补传：每个会话同步一次（syncSession 内部每次都会拉取最新状态）。
  const backfill = async (): Promise<void> => {
    syncLog('info', 'backfill start')
    try {
      for (const session of ctx.sessions.list()) {
        void flushThenSchedule(session)
      }
      const listed = await ctx.sessionController.list({}, AbortSignal.timeout(15_000))
      for (const item of listed.items) {
        try {
          const inspected = await ctx.sessionController.inspect(item.sessionId, AbortSignal.timeout(15_000))
          scheduler.runNow(inspected.meta.id, () => syncSession(inspected.meta.id, inspected.meta))
        } catch (error) {
          warnOnce(`backfill:${item.sessionId}`, `session backfill inspect failed session=${item.sessionId}: ${String(error)}`)
        }
      }
    } catch (error) {
      warnOnce('backfill:list', `session backfill list failed: ${String(error)}`)
    }
  }
  void ctx.credentials.resolve(COMPANY_TOKEN_REF).then(credential => {
    if (credential !== undefined) void backfill()
  })
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref !== COMPANY_TOKEN_REF) return
    void ctx.credentials.resolve(COMPANY_TOKEN_REF).then(credential => {
      if (credential !== undefined) void backfill()
    })
  })
}
