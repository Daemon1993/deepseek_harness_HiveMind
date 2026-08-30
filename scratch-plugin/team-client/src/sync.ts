// session-sync.ts —— 把本地 DSH 会话日志文件（session.jsonl.zstd）同步到 Team Server。
// 常规为字节增量（只传新增尾部，md5 校验前缀），重写/异常时全量替换。
// 文件即真相；md5 前缀校验保证追加安全，任何不匹配回退全量（幂等自愈）。
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-controller'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const COMPANY_TOKEN_REF = credentialRef('TEAM_COMPANY_TOKEN')

/** 单次上传上限（全量替换时超过则跳过并告警一次）。 */
const MAX_LOG_BYTES = 50 * 1024 * 1024

function md5Of(bytes: Buffer | Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function syncLog(level: 'warn', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [team-client.sync] ${message}`
  console.warn(line)
}

type SessionState = {
  syncing: boolean
}

/** 订阅本地 Session 生命周期，把每个会话的日志增量/全量同步到 server。 */
export function registerSessionSync(ctx: Context, serverURL: string): void {
  const states = new Map<string, SessionState>()
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    syncLog('warn', message)
  }
  // 同步状态（浏览器端通过 /team/sync/status 轮询展示）
  let inFlight = 0
  let lastSyncAt = 0
  const syncStatus = { syncing: false, lastSyncAt: 0, lastSyncedSession: '' }
  const markSyncing = (active: boolean): void => {
    inFlight = Math.max(0, inFlight + (active ? 1 : -1))
    syncStatus.syncing = inFlight > 0
  }
  ctx.webServer.register({ kind: 'exact', path: '/team/sync/status', handler(_req, res) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(syncStatus))
  } })
  // 手动触发同步：浏览器点"手动同步"时调用，对全部 live 会话触发一次同步。
  ctx.webServer.register({ kind: 'exact', path: '/team/sync/now', async handler(req, res) {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    for (const session of ctx.sessions.list()) void syncSession(session.id, session.header)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
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
  ): Promise<boolean> => {
    const contentMd5 = md5Of(bytes)
    const delta = baseSize === undefined ? bytes : bytes.subarray(baseSize)
    const headers = await authHeaders()
    if (headers === undefined) return false // 未登录：静默，登录后下次触发再传
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
          ...(baseSize === undefined || baseMd5 === undefined ? {} : { baseSize, baseMd5 }),
        }),
      })
      if (response.status === 409) return false // 基准不匹配：调用方回退全量
      if (!response.ok) {
        warnOnce(`${sessionId}:upload`, `session upload failed status=${response.status} session=${sessionId}`)
        return true // 已尝试，标记完成避免无限重试；下次触发再试
      }
      lastSyncAt = Date.now()
      syncStatus.lastSyncAt = lastSyncAt
      syncStatus.lastSyncedSession = sessionId
      return true
    } finally {
      markSyncing(false)
    }
  }

  const uploadFull = async (sessionId: string, header: SessionHeader, bytes: Buffer): Promise<void> => {
    if (bytes.byteLength > MAX_LOG_BYTES) {
      warnOnce(`${sessionId}:too-large`, `session log too large (${bytes.byteLength} bytes), sync skipped: ${sessionId}`)
      return
    }
    await upload(sessionId, header, bytes, undefined, undefined)
  }

  /** 每次同步前从 server 拉取该会话的已存状态（位置+指纹）。 */
  const fetchMarker = async (sessionId: string): Promise<{ fileSize?: number; contentMd5?: string } | undefined> => {
    const headers = await authHeaders()
    if (headers === undefined) return undefined
    try {
      const response = await fetch(`${serverURL}/team/api/sync/session/status?sessionId=${encodeURIComponent(sessionId)}`, { headers })
      if (!response.ok) return undefined
      const data = await response.json() as { has: boolean; fileSize?: number; contentMd5?: string }
      return data.has
        ? { ...(data.fileSize === undefined ? {} : { fileSize: data.fileSize }), ...(data.contentMd5 === undefined ? {} : { contentMd5: data.contentMd5 }) }
        : undefined
    } catch {
      return undefined
    }
  }

  const syncSession = async (sessionId: string, header: SessionHeader): Promise<void> => {
    const state = ensureState(sessionId)
    if (state.syncing) return // 已有同步在途：跳过，下次触发会带上剩余增量
    state.syncing = true
    try {
      const location = ctx.sessionPersistence.locate(header)
      if (location === undefined) return
      const info = await stat(location.path).catch(() => undefined)
      if (info === undefined) return // 文件尚未落盘（首个事件未提交）
      const bytes = await readFile(location.path)
      // 稳定性校验：读取期间文件大小变化（DSH 正在追加/截断）则跳过本轮，
      // 下次 flush 会重试——避免把半写的文件全量上传到 server。
      const after = await stat(location.path).catch(() => undefined)
      if (after !== undefined && after.size !== info.size) return
      const contentMd5 = md5Of(bytes)
      const marker = await fetchMarker(sessionId)
      if (marker !== undefined && marker.fileSize === info.size && marker.contentMd5 === contentMd5) return // 无变化
      // 增量：server 已有同前缀（md5 验证），只补尾部
      if (marker?.fileSize !== undefined && marker.contentMd5 !== undefined
        && marker.fileSize > 0 && marker.fileSize < info.size
        && md5Of(bytes.subarray(0, marker.fileSize)) === marker.contentMd5) {
        const ok = await upload(sessionId, header, bytes, marker.fileSize, marker.contentMd5)
        if (!ok) await uploadFull(sessionId, header, bytes) // 基准不匹配：全量回退
        return
      }
      await uploadFull(sessionId, header, bytes)
    } catch (error) {
      warnOnce(`${sessionId}:read`, `session upload error session=${sessionId}: ${String(error)}`)
    } finally {
      state.syncing = false
    }
  }

  const ensureState = (sessionId: string): SessionState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { syncing: false }
      states.set(sessionId, state)
    }
    return state
  }

  // 官方扩展点。监听器绝不能抛异常：session/created 抛错会让 attach 回滚。
  ctx.on('session/created', (session: Session) => {
    ensureState(session.id)
    void syncSession(session.id, session.header)
  })
  ctx.on('session/flush', (session: Session) => { void syncSession(session.id, session.header) })
  ctx.on('session/disposed', (session: Session) => { void syncSession(session.id, session.header) })

  // 挂载补传：每个会话同步一次（syncSession 内部每次都会拉取最新状态）。
  const backfill = async (): Promise<void> => {
    try {
      for (const session of ctx.sessions.list()) {
        void syncSession(session.id, session.header)
      }
      const listed = await ctx.sessionController.list({}, AbortSignal.timeout(15_000))
      for (const item of listed.items) {
        try {
          const inspected = await ctx.sessionController.inspect(item.sessionId, AbortSignal.timeout(15_000))
          void syncSession(inspected.meta.id, inspected.meta)
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
