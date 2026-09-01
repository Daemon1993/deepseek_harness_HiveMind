import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from 'node:path'
import type {} from "@deepseek-ai/dsh-host-webserver";
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { TeamCodeChangeInput, TeamContext } from "./types.ts";
import { AuthSessions } from "./auth.ts";
import { writeTeamLog } from "./team-log.ts";
import { analyzeSessionDetail, analyzeSessionEvents, sessionTitle } from './session-metrics.ts'
import { reconcileSessions } from './reconcile.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { classifyCommitType, topChangedDirectories } from './project-analytics.ts'
import { readLimitedJson, RequestBodyTooLargeError } from './request-body.ts'
import {
  buildSessionCandidate,
  publishValidatedSession,
  SessionSyncBaseMismatchError,
  SessionSyncContentMismatchError,
  SessionSyncQueue,
  SessionSyncValidationError,
} from './session-sync-storage.ts'

const MODEL_REQUEST_MAX_BYTES = 50 * 1024 * 1024
const MODEL_FILE_MAX_BYTES = 128 * 1024 * 1024  // DeepSeek 单文件上传上限
const SESSION_SYNC_RAW_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
const SESSION_SYNC_METADATA_MAX_BYTES = 64 * 1024
export const SESSION_SYNC_REQUEST_MAX_BYTES = 4 * Math.ceil(SESSION_SYNC_RAW_UPLOAD_MAX_BYTES / 3)
  + SESSION_SYNC_METADATA_MAX_BYTES
const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_API_KEY_REF = credentialRef('DEEPSEEK_API_KEY')
const sessionSyncQueue = new SessionSyncQueue()
const unavailableSessionWarnings = new Set<string>()
const SESSION_SYNC_LOG_QUIET_MS = 500
/** Git 同步审计合并：userId → 最近一次合并的批次统计。 */
const lastGitSyncAudit = new Map<string, { at: number; count: number; message: string; timer: ReturnType<typeof setTimeout> | undefined }>()

type SessionSyncSuccess = {
  mode: 'full' | 'delta'
  bytes: number
  total: number
  sessionId: string
  userId: string
}

/** Collapse one user's burst of successful Session uploads into its final log line. */
function createSessionSyncSuccessLogger(): {
  record: (success: SessionSyncSuccess) => void
  dispose: () => void
} {
  const pending = new Map<string, { count: number; latest: SessionSyncSuccess; timer: ReturnType<typeof setTimeout> }>()
  const write = (count: number, latest: SessionSyncSuccess): void => {
    writeTeamLog({
      level: 'info',
      event: 'session.sync.completed',
      message: `Session synchronized mode=${latest.mode} bytes=${latest.bytes} total=${latest.total}${count > 1 ? ` batch=${count}` : ''}`,
      sessionId: latest.sessionId,
      userId: latest.userId,
    })
  }
  return {
    record(success) {
      const previous = pending.get(success.userId)
      if (previous !== undefined) clearTimeout(previous.timer)
      const count = (previous?.count ?? 0) + 1
      const timer = setTimeout(() => {
        const current = pending.get(success.userId)
        if (current?.timer !== timer) return
        pending.delete(success.userId)
        write(current.count, current.latest)
      }, SESSION_SYNC_LOG_QUIET_MS)
      pending.set(success.userId, { count, latest: success, timer })
    },
    dispose() {
      for (const { count, latest, timer } of pending.values()) {
        clearTimeout(timer)
        write(count, latest)
      }
      pending.clear()
    },
  }
}

const adminPage = readFile(new URL("../admin.html", import.meta.url), "utf8");
const adminScript = readFile(new URL("./admin.js", import.meta.url));
const loginPage = readFile(new URL("../login.html", import.meta.url), "utf8");
const loginScript = readFile(new URL("./login.js", import.meta.url));

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) body += chunk.toString()
  return JSON.parse(body)
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += value.byteLength
    if (total > limit) return undefined
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function handleClientLogin(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  try {
    const input = await readJson(req)
    if (typeof input !== 'object' || input === null
      || !('userId' in input) || typeof input.userId !== 'string'
      || !('password' in input) || typeof input.password !== 'string') {
      sendJson(res, 400, { message: '请输入用户 ID 和密码' })
      return
    }
    const account = ctx.team.getUser(input.userId)
    if (account !== undefined && account.status !== 'active') {
      sendJson(res, 403, { message: '账号未激活，请联系管理员' })
      return
    }
    const user = await ctx.team.login(input.userId, input.password)
    if (user === undefined) { sendJson(res, 401, { message: '用户名或密码错误' }); return }
    const token = await sessions.startClient(user.id)
    writeTeamLog({ level: 'info', event: 'auth.login', message: 'Company token issued to Local DSH', userId: user.id })
    await ctx.team.audit({ level: 'info', event: 'auth.login', message: 'Local DSH logged in', userId: user.id })
    sendJson(res, 200, { token, expiresIn: 7 * 24 * 60 * 60, user })
  } catch {
    sendJson(res, 400, { message: 'JSON 格式错误' })
  }
}

async function handleClientSession(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  const userId = await sessions.clientUserId(req)
  const user = userId === undefined ? undefined : ctx.team.getUser(userId)
  if (user === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  sendJson(res, 200, { user })
}

async function handleModelGateway(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  const body = await readBody(req, MODEL_REQUEST_MAX_BYTES)
  if (body === undefined) { sendJson(res, 413, { message: '模型请求体过大' }); return }
  // 只读请求体的 model 字段用于日志/审计，其余原样透传。
  let model: string | undefined
  let stream = false
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown; stream?: unknown }
    model = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined
    stream = parsed.stream === true
  } catch { /* 非 JSON 或解析失败：model 记 unknown */ }
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  const logModel = model === undefined ? {} : { model }
  try {
    const credential = await ctx.credentials.resolve(DEEPSEEK_API_KEY_REF)
    if (credential === undefined) throw new Error('Server DSH has no DEEPSEEK_API_KEY credential')
    const apiKey = credential.value
    const baseURL = process.env.DEEPSEEK_BASE_URL?.replace(/\/+$/u, '') ?? DEEPSEEK_PUBLIC_BASE_URL
    const upstream = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        accept: req.headers.accept ?? 'text/event-stream',
        'content-type': req.headers['content-type'] ?? 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'cache-control', 'x-request-id']) {
      const value = upstream.headers.get(name)
      if (value !== null) headers[name] = value
    }
    res.writeHead(upstream.status, headers)
    // 透传响应体：流式按块透传，非流式一次写出；不做 usage 提取。
    if (stream && upstream.body !== null) {
      for await (const chunk of upstream.body) res.write(chunk)
    } else if (!stream) {
      res.write(Buffer.from(await upstream.arrayBuffer()))
    }
    res.end()
    const latencyMs = Date.now() - startedAt
    await ctx.team.audit({
      level: upstream.ok ? 'info' : 'warn',
      event: 'model.gateway',
      message: `DeepSeek gateway completed status=${upstream.status} duration=${latencyMs}ms`,
      requestId,
      userId,
      ...logModel,
      details: { status: upstream.status, durationMs: latencyMs },
    })
  } catch (error) {
    writeTeamLog({ level: 'error', event: 'model.gateway.failed', message: `Model gateway failed duration=${Date.now() - startedAt}ms request=${requestId}: ${String(error)}`, requestId, userId, ...logModel })
    if (!res.headersSent) sendJson(res, 502, { message: '模型服务暂时不可用', requestId })
    else res.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * DeepSeek Files API 透传网关：client 以 files-first 上传图片，网关必须完整
 * 代理 /files 端点（上传/列表/读取/删除），否则 client 每次降级 base64。
 * multipart 不解析——content-type（含 boundary）与原始 body 原样转发。
 */
async function handleModelFilesGateway(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
    sendJson(res, 405, { message: '不支持的请求方法' })
    return
  }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  const credential = await ctx.credentials.resolve(DEEPSEEK_API_KEY_REF)
  if (credential === undefined) { sendJson(res, 500, { message: 'Server DSH has no DEEPSEEK_API_KEY credential' }); return }
  const apiKey = credential.value
  const baseURL = process.env.DEEPSEEK_BASE_URL?.replace(/\/+$/u, '') ?? DEEPSEEK_PUBLIC_BASE_URL
  const url = new URL(req.url ?? '/', 'http://localhost')
  const suffix = url.pathname.startsWith('/team/api/model') ? url.pathname.slice('/team/api/model'.length) : url.pathname
  let body: Buffer | undefined
  if (req.method === 'POST') {
    body = await readBody(req, MODEL_FILE_MAX_BYTES)
    if (body === undefined) { sendJson(res, 413, { message: '文件上传过大' }); return }
  }
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }
    const contentType = req.headers['content-type']
    if (typeof contentType === 'string') headers['content-type'] = contentType
    const upstream = await fetch(`${baseURL}${suffix}${url.search}`, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body: body as unknown as BodyInit } : {}),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
    const responseBody = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(responseBody)
    // 审计失败不影响响应（响应已结束）；异常只记录不抛出。
    try {
      await ctx.team.audit({
        level: upstream.ok ? 'info' : 'warn',
        event: 'model.files',
        message: `Files gateway completed method=${req.method} status=${upstream.status} bytes=${responseBody.byteLength}`,
        requestId,
        userId,
        details: { method: req.method ?? '', path: suffix, status: upstream.status, bytes: responseBody.byteLength },
      })
    } catch (auditError) {
      writeTeamLog({ level: 'warn', event: 'model.files.audit_failed', message: `Files audit failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`, requestId, userId })
    }
  } catch (error) {
    writeTeamLog({ level: 'error', event: 'model.files.failed', message: `Files gateway failed duration=${Date.now() - startedAt}ms request=${requestId}: ${String(error)}`, requestId, userId })
    sendJson(res, 502, { message: '文件网关转发失败' })
  }
}


async function authenticatedUser(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage) {
  const userId = await sessions.userId(req)
  return userId ? ctx.team.getUser(userId) : undefined
}

async function requireAdmin(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if ((await authenticatedUser(ctx, sessions, req))?.role === 'admin') return true
  sendJson(res, 403, { message: '需要管理员权限' })
  return false
}

async function handleAdminUsers(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  const user = await authenticatedUser(ctx, sessions, req)
  if (user === undefined) { sendJson(res, 401, { message: '请先登录' }); return }
  const users = ctx.team.listAdminUsers()
  sendJson(res, 200, { users })
}

async function handleAdminSessions(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const sessionRows = (await listEnrichedSessionOwners(ctx)).map(({ projectRoot: _projectRoot, ...session }) => session)
  sendJson(res, 200, { sessions: sessionRows })
}

type EnrichedSessionOwner = Omit<Awaited<ReturnType<TeamContext['team']['listSyncedSessions']>>[number], 'updatedAt'> & {
  lastActiveAt: string
  title?: string
  projectName?: string
  projectRoot?: string
  gitRemote?: string
  updatedAt: string | number
  blank?: boolean
}

async function listEnrichedSessionOwners(ctx: TeamContext): Promise<EnrichedSessionOwner[]> {
  const owners = await ctx.team.listSyncedSessions()
  const analytics = new Map((await ctx.team.listSessionAnalytics()).map(snapshot => [snapshot.sessionId, snapshot]))
  await Promise.all(owners.map(async (owner) => {
    const existing = analytics.get(owner.sessionId)
    if ((existing?.metrics as { version?: number } | undefined)?.version === 2) return
    try {
      const inspected = await ctx.sessionController.inspect(owner.sessionId, AbortSignal.timeout(5_000))
      const snapshot = {
        ...existing,
        sessionId: owner.sessionId,
        title: sessionTitle(inspected.events),
        lastActiveAt: inspected.events.at(-1)?.time ?? inspected.meta.createdAt,
        metrics: analyzeSessionEvents(inspected.events),
      }
      await ctx.team.saveSessionAnalytics(snapshot)
      analytics.set(owner.sessionId, snapshot)
      unavailableSessionWarnings.delete(owner.sessionId)
    } catch (error) {
      if (!unavailableSessionWarnings.has(owner.sessionId)) {
        unavailableSessionWarnings.add(owner.sessionId)
        writeTeamLog({
          level: 'warn',
          event: 'analytics.session.inspect_failed',
          message: error instanceof Error ? error.message : String(error),
          sessionId: owner.sessionId,
        })
      }
    }
  }))
  return owners.map((owner) => {
    const base: EnrichedSessionOwner = { ...owner, lastActiveAt: owner.updatedAt }
    const snapshot = analytics.get(owner.sessionId)
    if (snapshot === undefined) return base
    return {
      ...base,
      title: snapshot.title,
      ...(snapshot.projectName === undefined ? {} : { projectName: snapshot.projectName }),
      ...(snapshot.projectRoot === undefined ? {} : { projectRoot: snapshot.projectRoot }),
      ...(snapshot.gitRemote === undefined ? {} : { gitRemote: snapshot.gitRemote }),
      updatedAt: snapshot.lastActiveAt,
      blank: snapshot.metrics.stepCount === 0 && snapshot.metrics.userMessages === 0 && snapshot.metrics.toolCalls === 0,
    }
  })
}

function requestedDays(req: IncomingMessage): 1 | 7 | 30 | undefined {
  const days = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('days') ?? '7')
  return days === 1 || days === 7 || days === 30 ? days : undefined
}

async function inspectOwnedSessions(ctx: TeamContext, owners: Awaited<ReturnType<typeof listEnrichedSessionOwners>>) {
  const analytics = new Map((await ctx.team.listSessionAnalytics()).map(snapshot => [snapshot.sessionId, snapshot.metrics]))
  return owners.map(owner => ({ owner, metrics: analytics.get(owner.sessionId) ?? analyzeSessionEvents([]) }))
}

type AggregateModel = { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }
type AggregateTool = { name: string; calls: number; failures: number }
type AggregateCommit = Awaited<ReturnType<TeamContext['team']['listCodeChanges']>>[number]

type UserAggregate = {
  userId: string
  userName: string
  sessions: number
  projects: Set<string>
  messages: number
  toolCalls: number
  toolFailures: number
  modelRequests: number
  totalTokens: number
  durationMs: number
  errors: number
  lastActiveAt: number
  models: Map<string, AggregateModel>
  tools: Map<string, AggregateTool>
  commits: AggregateCommit[]
  insertions: number
  deletions: number
  lastCommitAt: number
}

type ProjectAggregate = {
  id: string
  name: string
  gitRemote: string
  sessions: number
  users: Map<string, string>
  messages: number
  toolCalls: number
  toolFailures: number
  modelRequests: number
  totalTokens: number
  durationMs: number
  errors: number
  lastActiveAt: number
  models: Map<string, AggregateModel>
  tools: Map<string, AggregateTool>
  commits: AggregateCommit[]
  insertions: number
  deletions: number
  lastCommitAt: number
}

function addModels(target: Map<string, AggregateModel>, models: readonly AggregateModel[]): void {
  for (const model of models) {
    const row = target.get(model.model) ?? { model: model.model, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    row.requests += model.requests
    row.inputTokens += model.inputTokens
    row.outputTokens += model.outputTokens
    row.totalTokens += model.totalTokens
    target.set(model.model, row)
  }
}

function addTools(target: Map<string, AggregateTool>, tools: readonly AggregateTool[]): void {
  for (const tool of tools) {
    const row = target.get(tool.name) ?? { name: tool.name, calls: 0, failures: 0 }
    row.calls += tool.calls
    row.failures += tool.failures
    target.set(tool.name, row)
  }
}

function projectName(gitRemote: string): string {
  return gitRemote.replace(/[/\\]$/, '').split(/[/\\:]/).at(-1)?.replace(/\.git$/, '') || gitRemote
}

async function handleAdminGitEmails(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!await requireAdmin(ctx, sessions, req, res)) return
  if (req.method === 'GET') {
    sendJson(res, 200, { bindings: await ctx.team.listGitEmailBindings() })
    return
  }
  if (req.method === 'POST') {
    try {
      const input = await readJson(req)
      if (typeof input !== 'object' || input === null
        || !('userId' in input) || typeof input.userId !== 'string' || input.userId === ''
        || !('email' in input) || typeof input.email !== 'string'
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.email)) {
        sendJson(res, 400, { message: '请输入有效的用户 ID 和 Git 邮箱' }); return
      }
      const bound = await ctx.team.bindGitEmail(input.userId, input.email.trim().toLowerCase())
      sendJson(res, bound ? 200 : 404, bound ? { ok: true } : { message: '用户不存在' })
    } catch { sendJson(res, 400, { message: '请求格式错误' }) }
    return
  }
  if (req.method === 'DELETE') {
    const email = decodeURIComponent(new URL(req.url ?? '', 'http://localhost').pathname.split('/').at(-1) ?? '')
    sendJson(res, await ctx.team.unbindGitEmail(email) ? 204 : 404, {})
    return
  }
  sendJson(res, 405, { message: '只支持 GET、POST 或 DELETE 请求' })
}

async function handleAdminProjectDetail(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const gitRemote = decodeURIComponent(new URL(req.url ?? '', 'http://localhost').pathname.split('/').at(-1) ?? '')
  if (gitRemote === '') { sendJson(res, 400, { message: '缺少项目标识' }); return }
  const daysParam = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('days') ?? '30')
  const days = daysParam === 7 || daysParam === 30 || daysParam === 90 ? daysParam : 30
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const [commits, trend, authors, changedFiles, analytics] = await Promise.all([
    ctx.team.listCommitsByProject(gitRemote, since),
    ctx.team.projectCommitTrend(gitRemote, since),
    ctx.team.projectAuthorStats(gitRemote, since),
    ctx.team.projectChangedFiles(gitRemote, since),
    ctx.team.listAnalyticsByProject(gitRemote),
  ])
  const analyticsInWindow = analytics.filter(snapshot => snapshot.lastActiveAt >= since)
  const models = new Map<string, { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }>()
  for (const snapshot of analyticsInWindow) {
    for (const metric of snapshot.metrics.models) {
      const model = models.get(metric.model) ?? { model: metric.model, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      model.requests += metric.requests
      model.inputTokens += metric.inputTokens
      model.outputTokens += metric.outputTokens
      model.totalTokens += metric.totalTokens
      models.set(metric.model, model)
    }
  }
  const tools = new Map<string, { name: string; calls: number; failures: number }>()
  for (const snapshot of analyticsInWindow) {
    for (const tool of snapshot.metrics.tools) {
      const entry = tools.get(tool.name) ?? { name: tool.name, calls: 0, failures: 0 }
      entry.calls += tool.calls
      entry.failures += tool.failures
      tools.set(tool.name, entry)
    }
  }
  const typeBuckets = new Map<string, number>()
  for (const commit of commits) {
    const type = classifyCommitType(commit.subject)
    typeBuckets.set(type, (typeBuckets.get(type) ?? 0) + 1)
  }
  const activeDays = new Set(trend.map(item => item.day)).size
  const projectName = gitRemote.replace(/[/\\]$/u, '').split(/[/\\:]/u).at(-1)?.replace(/\.git$/u, '') || gitRemote
  // 已绑定 Git Email 已归并到平台 User，未绑定作者保持独立；两者之和即活跃开发者数。
  const activeDevelopers = authors.length
  sendJson(res, 200, {
    gitRemote,
    projectName,
    rangeDays: days,
    generatedAt: new Date().toISOString(),
    summary: {
      commits: commits.length,
      activeDevelopers,
      activeDays,
      insertions: commits.reduce((sum, commit) => sum + commit.insertions, 0),
      deletions: commits.reduce((sum, commit) => sum + commit.deletions, 0),
      lastCommitAt: commits[0]?.time ?? 0,
      topChangedFiles: changedFiles.length,
      sessions: analyticsInWindow.length,
      toolCalls: analyticsInWindow.reduce((sum, snapshot) => sum + snapshot.metrics.toolCalls, 0),
      toolFailures: analyticsInWindow.reduce((sum, snapshot) => sum + snapshot.metrics.toolFailures, 0),
      modelRequests: analyticsInWindow.reduce((sum, snapshot) => sum + snapshot.metrics.models.reduce((s, m) => s + m.requests, 0), 0),
      totalTokens: analyticsInWindow.reduce((sum, snapshot) => sum + snapshot.metrics.models.reduce((s, m) => s + m.totalTokens, 0), 0),
      lastSessionAt: analyticsInWindow[0]?.lastActiveAt ?? 0,
    },
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    trend,
    authors: authors.map(author => {
      // 按已归并的全部 Git Email 匹配提交，保证绑定多邮箱的开发者的提交不丢失。
      const emailSet = new Set(author.emails.map(email => email.toLowerCase()))
      const recentCommits = commits
        .filter(commit => commit.authorEmail !== undefined && emailSet.has(commit.authorEmail.toLowerCase()))
        .slice(0, 10)
        .map(commit => ({ ...commit, type: classifyCommitType(commit.subject) }))
      return {
        ...author,
        recentCommits,
      }
    }),
    commitTypes: [...typeBuckets.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    hotDirectories: topChangedDirectories(changedFiles),
    commits: commits.slice(0, 100).map(commit => ({ ...commit, type: classifyCommitType(commit.subject) })),
  })
}

async function handleAdminUserDetail(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const userId = decodeURIComponent(new URL(req.url ?? '', 'http://localhost').pathname.split('/').at(-1) ?? '')
  const user = ctx.team.getUser(userId)
  if (user === undefined) { sendJson(res, 404, { message: '用户不存在' }); return }
  const daysParam = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('days') ?? '30')
  const days = daysParam === 7 || daysParam === 30 || daysParam === 90 ? daysParam : 30
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const [commits, analytics] = await Promise.all([
    ctx.team.listCommitsByUser(userId, since),
    ctx.team.listAnalyticsByUser(userId),
  ])
  const projectCommits = new Map<string, number>()
  for (const commit of commits) {
    if (commit.gitRemote === undefined) continue
    projectCommits.set(commit.gitRemote, (projectCommits.get(commit.gitRemote) ?? 0) + 1)
  }
  const analyticsWindows = analytics.filter(snapshot => snapshot.lastActiveAt >= since)
  const sessionProjects = new Set(analytics.flatMap(snapshot => snapshot.gitRemote === undefined ? [] : [snapshot.gitRemote]))
  const activeDays = new Set(commits.map(commit => new Date(commit.time).toISOString().slice(0, 10))).size
  const commitTypes = new Map<string, number>()
  for (const commit of commits) {
    const type = classifyCommitType(commit.subject)
    commitTypes.set(type, (commitTypes.get(type) ?? 0) + 1)
  }
  const commitTrend = new Map<string, { day: string; commits: number; insertions: number; deletions: number }>()
  for (const commit of commits) {
    const day = new Date(commit.time).toISOString().slice(0, 10)
    const bucket = commitTrend.get(day) ?? { day, commits: 0, insertions: 0, deletions: 0 }
    bucket.commits++
    bucket.insertions += commit.insertions
    bucket.deletions += commit.deletions
    commitTrend.set(day, bucket)
  }
  const projectSessionCounts = new Map<string, { sessions: number; lastActiveAt: number }>()
  for (const snapshot of analyticsWindows) {
    if (snapshot.gitRemote === undefined) continue
    const entry = projectSessionCounts.get(snapshot.gitRemote) ?? { sessions: 0, lastActiveAt: 0 }
    entry.sessions++
    entry.lastActiveAt = Math.max(entry.lastActiveAt, snapshot.lastActiveAt)
    projectSessionCounts.set(snapshot.gitRemote, entry)
  }
  const toolCalls = analyticsWindows.reduce((sum, snapshot) => sum + snapshot.metrics.toolCalls, 0)
  const toolFailures = analyticsWindows.reduce((sum, snapshot) => sum + snapshot.metrics.toolFailures, 0)
  const turnCount = analyticsWindows.reduce((sum, snapshot) => sum + snapshot.metrics.turnCount, 0)
  sendJson(res, 200, {
    userId,
    userName: user.name,
    role: user.role,
    status: user.status,
    rangeDays: days,
    generatedAt: new Date().toISOString(),
    summary: {
      commits: commits.length,
      insertions: commits.reduce((sum, commit) => sum + commit.insertions, 0),
      deletions: commits.reduce((sum, commit) => sum + commit.deletions, 0),
      activeDays,
      activeProjects: projectCommits.size,
      sessions: analyticsWindows.length,
      toolCalls,
      toolFailures,
      toolSuccessRate: toolCalls === 0 ? 0 : Math.round((toolCalls - toolFailures) / toolCalls * 1000) / 10,
      avgTurns: analyticsWindows.length === 0 ? 0 : Math.round(turnCount / analyticsWindows.length * 10) / 10,
      lastActiveAt: Math.max(commits[0]?.time ?? 0, analyticsWindows[0]?.lastActiveAt ?? 0),
    },
    projects: [...projectCommits.entries()]
      .map(([gitRemote, count]) => ({
        gitRemote,
        projectName: projectName(gitRemote),
        commits: count,
        hasSessions: sessionProjects.has(gitRemote),
        sessions: projectSessionCounts.get(gitRemote)?.sessions ?? 0,
        lastActiveAt: Math.max(projectSessionCounts.get(gitRemote)?.lastActiveAt ?? 0, commits.find(c => c.gitRemote === gitRemote)?.time ?? 0),
      }))
      .sort((a, b) => b.commits - a.commits),
    commitTypes: [...commitTypes.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    commitTrend: [...commitTrend.values()].sort((a, b) => a.day.localeCompare(b.day)),
    commits: commits.slice(0, 100).map(commit => ({ ...commit, type: classifyCommitType(commit.subject) })),
    recentSessions: analyticsWindows.slice(0, 50).map(snapshot => ({
      sessionId: snapshot.sessionId,
      title: snapshot.title,
      lastActiveAt: snapshot.lastActiveAt,
      toolCalls: snapshot.metrics.toolCalls,
      toolFailures: snapshot.metrics.toolFailures,
      ...(snapshot.gitRemote === undefined ? {} : { gitRemote: snapshot.gitRemote }),
    })),
  })
}

async function handleAdminGitSyncLog(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const days = requestedDays(req)
  if (days === undefined) { sendJson(res, 400, { message: '统计范围只支持 1、7 或 30 天' }); return }
  const result = await ctx.team.listAuditLogs({
    since: Date.now() - days * 24 * 60 * 60 * 1000,
    events: ['git.sync'],
    limit: 200,
  })
  const rows = result.map(row => ({
    occurredAt: row.occurredAt,
    userId: row.userId ?? '—',
    message: row.message,
    level: row.level,
  }))
  sendJson(res, 200, {
    rangeDays: days,
    generatedAt: new Date().toISOString(),
    summary: {
      syncedBatches: rows.length,
      commits: rows.reduce((sum, row) => sum + Number(/\d+/.exec(row.message)?.[0] ?? 0), 0),
      lastSyncAt: rows[0]?.occurredAt ?? null,
    },
    rows,
  })
}

async function handleAdminOverview(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const days = requestedDays(req)
  if (days === undefined) { sendJson(res, 400, { message: '统计范围只支持 1、7 或 30 天' }); return }
  const owners = await listEnrichedSessionOwners(ctx)
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000
  const [inspected, codeChanges] = await Promise.all([
    inspectOwnedSessions(ctx, owners),
    ctx.team.listCodeChanges(threshold),
  ])

  const users = new Map<string, UserAggregate>()
  const directories = new Map<string, ProjectAggregate>()
  const tools = new Map<string, { name: string; calls: number; failures: number; users: Set<string> }>()
  const models = new Map<string, { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }>()
  const trends = new Map<string, { date: string; sessions: number; activeUsers: Set<string>; toolCalls: number; modelRequests: number; totalTokens: number; commits: number }>()

  let totalSessions = 0, totalUserMessages = 0, totalAssistantMessages = 0, totalToolCalls = 0, totalToolFailures = 0
  let totalModelRequests = 0, totalInputTokens = 0, totalOutputTokens = 0, totalTokens = 0, totalActiveMs = 0, totalDurationMs = 0, totalErrors = 0
  const recentSessions: { sessionId: string; title: string; userId: string; userName: string; gitRemote?: string; models: { model: string; requests: number }[]; lastActiveAt: number; toolCalls: number; durationMs: number; errorCount: number }[] = []

  for (const { owner, metrics } of inspected) {
    if (metrics.lastTime < threshold) continue
    totalSessions++
    totalUserMessages += metrics.userMessages; totalAssistantMessages += metrics.assistantMessages
    totalToolCalls += metrics.toolCalls; totalToolFailures += metrics.toolFailures
    totalModelRequests += metrics.models.reduce((s, m) => s + m.requests, 0)
    totalInputTokens += metrics.models.reduce((s, m) => s + m.inputTokens, 0)
    totalOutputTokens += metrics.models.reduce((s, m) => s + m.outputTokens, 0)
    totalTokens += metrics.models.reduce((s, m) => s + m.totalTokens, 0)
    totalActiveMs += metrics.activeDurationMs; totalDurationMs += metrics.durationMs; totalErrors += metrics.errorCount

    const user = users.get(owner.userId) ?? {
      userId: owner.userId, userName: owner.userName, sessions: 0, projects: new Set(),
      messages: 0, toolCalls: 0, toolFailures: 0, modelRequests: 0, totalTokens: 0,
      durationMs: 0, errors: 0, lastActiveAt: 0, models: new Map(), tools: new Map(),
      commits: [] as AggregateCommit[], insertions: 0, deletions: 0, lastCommitAt: 0,
    }
    user.sessions++; user.toolCalls += metrics.toolCalls; user.toolFailures += metrics.toolFailures
    user.messages += metrics.userMessages + metrics.assistantMessages; user.errors += metrics.errorCount
    user.modelRequests += metrics.models.reduce((s, m) => s + m.requests, 0)
    user.totalTokens += metrics.models.reduce((s, m) => s + m.totalTokens, 0)
    user.durationMs += metrics.activeDurationMs; user.lastActiveAt = Math.max(user.lastActiveAt, metrics.lastTime)
    if (owner.gitRemote !== undefined) user.projects.add(owner.gitRemote)
    addModels(user.models, metrics.models)
    addTools(user.tools, metrics.tools)
    users.set(owner.userId, user)

    if (owner.gitRemote !== undefined) {
      const projectId = owner.gitRemote
      const dir = directories.get(projectId) ?? {
        id: projectId, name: owner.projectName ?? projectName(owner.gitRemote), gitRemote: owner.gitRemote,
        sessions: 0, users: new Map(), messages: 0, toolCalls: 0, toolFailures: 0,
        modelRequests: 0, totalTokens: 0, durationMs: 0, errors: 0, lastActiveAt: 0,
        models: new Map(), tools: new Map(), commits: [] as AggregateCommit[], insertions: 0, deletions: 0, lastCommitAt: 0,
      }
      dir.sessions++; dir.users.set(owner.userId, owner.userName)
      dir.messages += metrics.userMessages + metrics.assistantMessages; dir.toolCalls += metrics.toolCalls; dir.toolFailures += metrics.toolFailures
      dir.modelRequests += metrics.models.reduce((s, m) => s + m.requests, 0)
      dir.totalTokens += metrics.models.reduce((s, m) => s + m.totalTokens, 0)
      dir.durationMs += metrics.activeDurationMs; dir.errors += metrics.errorCount; dir.lastActiveAt = Math.max(dir.lastActiveAt, metrics.lastTime)
      addModels(dir.models, metrics.models)
      addTools(dir.tools, metrics.tools)
      directories.set(projectId, dir)
    }

    for (const tool of metrics.tools) {
      const row = tools.get(tool.name) ?? { name: tool.name, calls: 0, failures: 0, users: new Set() }
      row.calls += tool.calls; row.failures += tool.failures; row.users.add(owner.userId)
      tools.set(tool.name, row)
    }
    addModels(models, metrics.models)

    const date = new Date(metrics.lastTime).toISOString().slice(0, 10)
    const trend = trends.get(date) ?? { date, sessions: 0, activeUsers: new Set(), toolCalls: 0, modelRequests: 0, totalTokens: 0, commits: 0 }
    trend.sessions++; trend.activeUsers.add(owner.userId)
    trend.toolCalls += metrics.toolCalls; trend.modelRequests += metrics.models.reduce((s, m) => s + m.requests, 0)
    trend.totalTokens += metrics.models.reduce((s, m) => s + m.totalTokens, 0)
    trends.set(date, trend)

    recentSessions.push({
      sessionId: owner.sessionId, title: (owner as { title?: string }).title ?? '新会话', userId: owner.userId, userName: owner.userName,
      ...(owner.gitRemote === undefined ? {} : { gitRemote: owner.gitRemote }),
      models: metrics.models.map(({ model, requests }) => ({ model, requests })),
      lastActiveAt: metrics.lastTime, toolCalls: metrics.toolCalls, durationMs: metrics.activeDurationMs, errorCount: metrics.errorCount,
    })
  }

  for (const commit of codeChanges) {
    // 提交计入按日研发活动趋势（与 Session 趋势同键）。
    const date = new Date(commit.time).toISOString().slice(0, 10)
    const trend = trends.get(date) ?? { date, sessions: 0, activeUsers: new Set(), toolCalls: 0, modelRequests: 0, totalTokens: 0, commits: 0 }
    trend.commits++
    trends.set(date, trend)
    // 归属按作者邮箱解析到平台用户；未绑定邮箱的提交不计入任一用户，但计入项目提交统计。
    if (commit.userId !== undefined) {
      const user = users.get(commit.userId) ?? {
        userId: commit.userId, userName: commit.userName ?? '', sessions: 0, projects: new Set(),
        messages: 0, toolCalls: 0, toolFailures: 0, modelRequests: 0, totalTokens: 0,
        durationMs: 0, errors: 0, lastActiveAt: 0, models: new Map(), tools: new Map(),
        commits: [] as AggregateCommit[], insertions: 0, deletions: 0, lastCommitAt: 0,
      }
      user.commits.push(commit)
      user.insertions += commit.insertions
      user.deletions += commit.deletions
      user.lastCommitAt = Math.max(user.lastCommitAt, commit.time)
      if (commit.gitRemote !== undefined) user.projects.add(commit.gitRemote)
      users.set(commit.userId, user)
    }

    if (commit.gitRemote === undefined) continue
    const directory = directories.get(commit.gitRemote) ?? {
      id: commit.gitRemote, name: projectName(commit.gitRemote), gitRemote: commit.gitRemote,
      sessions: 0, users: new Map(), messages: 0, toolCalls: 0, toolFailures: 0,
      modelRequests: 0, totalTokens: 0, durationMs: 0, errors: 0, lastActiveAt: 0,
      models: new Map(), tools: new Map(), commits: [] as AggregateCommit[], insertions: 0, deletions: 0, lastCommitAt: 0,
    }
    if (commit.userId !== undefined && commit.userName !== undefined) directory.users.set(commit.userId, commit.userName)
    directory.commits.push(commit)
    directory.insertions += commit.insertions
    directory.deletions += commit.deletions
    directory.lastCommitAt = Math.max(directory.lastCommitAt, commit.time)
    directories.set(commit.gitRemote, directory)
  }

  recentSessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  sendJson(res, 200, {
    rangeDays: days,
    generatedAt: new Date().toISOString(),
    summary: {
      sessions: totalSessions,
      activeUsers: users.size,
      projects: directories.size,
      userMessages: totalUserMessages,
      assistantMessages: totalAssistantMessages,
      toolCalls: totalToolCalls,
      toolFailures: totalToolFailures,
      toolFailureRate: totalToolCalls === 0 ? 0 : Math.round(totalToolFailures / totalToolCalls * 1000) / 10,
      modelRequests: totalModelRequests,
      inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens,
      activeDurationMs: totalActiveMs, durationMs: totalDurationMs, errors: totalErrors,
      commits: codeChanges.length,
      insertions: codeChanges.reduce((sum, commit) => sum + commit.insertions, 0),
      deletions: codeChanges.reduce((sum, commit) => sum + commit.deletions, 0),
    },
    trends: [...trends.values()].map(({ activeUsers, ...t }) => ({ ...t, activeUsers: activeUsers.size })).sort((a, b) => a.date.localeCompare(b.date)),
    users: [...users.values()].map(({ projects, models: userModels, tools: userTools, ...user }) => ({
      ...user,
      projects: projects.size,
      lastActiveAt: Math.max(user.lastActiveAt, user.lastCommitAt),
      models: [...userModels.values()].sort((left, right) => right.totalTokens - left.totalTokens),
      tools: [...userTools.values()].sort((left, right) => right.calls - left.calls),
    })).sort((a, b) => b.totalTokens - a.totalTokens || b.commits.length - a.commits.length),
    directories: [...directories.values()].map(({ users: members, models: projectModels, tools: projectTools, ...directory }) => ({
      ...directory,
      users: members.size,
      lastActiveAt: Math.max(directory.lastActiveAt, directory.lastCommitAt),
      members: [...members].map(([userId, userName]) => ({ userId, userName })),
      models: [...projectModels.values()].sort((left, right) => right.totalTokens - left.totalTokens),
      tools: [...projectTools.values()].sort((left, right) => right.calls - left.calls),
    })).sort((a, b) => b.sessions - a.sessions || b.commits.length - a.commits.length),
    tools: [...tools.values()].map(({ users: u, ...t }) => ({ ...t, users: u.size })).sort((a, b) => b.calls - a.calls),
    models: [...models.values()].sort((a, b) => b.requests - a.requests),
    recentSessions,
  })
}

async function handleAdminSessionTimeline(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const sessionId = decodeURIComponent(new URL(req.url ?? '', 'http://localhost').pathname.split('/').at(-1) ?? '')
  const owner = (await listEnrichedSessionOwners(ctx)).find(item => item.sessionId === sessionId)
  if (owner === undefined) { sendJson(res, 404, { message: '未找到会话归属记录' }); return }
  try {
    const inspected = await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(5_000))
    const metrics = analyzeSessionDetail(inspected.events)
    const { projectRoot: _projectRoot, ...publicOwner } = owner
    sendJson(res, 200, { session: publicOwner, metrics, timeline: metrics.timeline })
  } catch {
    sendJson(res, 404, { message: '会话记录不可用' })
  }
}

async function handleSyncSession(
  ctx: TeamContext,
  sessions: AuthSessions,
  logSuccess: (success: SessionSyncSuccess) => void,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  let input: unknown
  try {
    input = await readLimitedJson(req, SESSION_SYNC_REQUEST_MAX_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { message: 'Session 同步请求体过大' })
      return
    }
    sendJson(res, 400, { message: '请求格式错误' })
    return
  }
  if (typeof input !== 'object' || input === null
    || !('sessionId' in input) || typeof input.sessionId !== 'string' || input.sessionId === ''
    || !('header' in input) || typeof input.header !== 'object' || input.header === null
    || !('log' in input) || typeof input.log !== 'string' || input.log.length === 0
    || !('contentMd5' in input) || typeof input.contentMd5 !== 'string' || !/^[a-f0-9]{32}$/u.test(input.contentMd5)
    || !('totalSize' in input) || typeof input.totalSize !== 'number'
    || !Number.isSafeInteger(input.totalSize) || input.totalSize <= 0
    || ('projectRoot' in input && typeof input.projectRoot !== 'string')
    || ('gitRemote' in input && typeof input.gitRemote !== 'string')) {
    sendJson(res, 400, { message: '无效的 Session 同步请求' }); return
  }
  const sessionId = input.sessionId
  const contentMd5 = input.contentMd5
  const totalSize = input.totalSize
  const header = input.header as SessionHeader
  const projectRoot = 'projectRoot' in input && typeof input.projectRoot === 'string' && input.projectRoot !== '' ? input.projectRoot : undefined
  const gitRemote = 'gitRemote' in input && typeof input.gitRemote === 'string' && input.gitRemote !== '' ? input.gitRemote : undefined
  if (header.id !== sessionId) {
    sendJson(res, 400, { ok: false, message: 'Session header id 与 sessionId 不一致' })
    return
  }
  if (header.version !== SESSION_FORMAT_VERSION) {
    writeTeamLog({ level: 'warn', event: 'session.sync.version_mismatch', message: `Session format version mismatch got=${String(header.version)} expected=${SESSION_FORMAT_VERSION}`, sessionId, userId })
    sendJson(res, 415, { ok: false, message: `会话格式版本不兼容（client=${String(header.version)}, server=${SESSION_FORMAT_VERSION}），请升级 Server` })
    return
  }
  const result = await ctx.team.ensureSessionOwner(sessionId, userId)
  if (result === 'conflict') { sendJson(res, 409, { message: '会话已属于其他用户' }); return }
  const delta = input as { baseSize?: unknown; baseMd5?: unknown }
  const baseSize = typeof delta.baseSize === 'number' ? delta.baseSize : undefined
  const baseMd5 = typeof delta.baseMd5 === 'string' ? delta.baseMd5 : undefined
  if ((baseSize === undefined) !== (baseMd5 === undefined)) {
    sendJson(res, 400, { ok: false, message: 'baseSize 与 baseMd5 必须同时提供' })
    return
  }
  const logBytes = Buffer.from(input.log, 'base64')
  if (logBytes.byteLength === 0) { sendJson(res, 400, { ok: false, message: '日志内容为空' }); return }
  await sessionSyncQueue.run(sessionId, async () => {
    try {
      const location = ctx.sessionPersistence.locate(header)
      if (location === undefined) { sendJson(res, 500, { ok: false, message: '会话持久化不可用' }); return }
      let base: { size: number; md5: string } | undefined
      if (baseSize !== undefined && baseMd5 !== undefined) {
        const marker = await ctx.team.readSessionMarker(sessionId)
        if (marker === undefined || marker.userId !== userId
          || marker.contentMd5 !== baseMd5 || marker.fileSize !== baseSize) {
          writeTeamLog({ level: 'warn', event: 'session.sync.base_mismatch', message: 'Session delta base mismatch', sessionId, userId })
          sendJson(res, 409, { ok: false, reason: 'base-mismatch', message: '增量基准不匹配，请全量同步' })
          return
        }
        base = { size: baseSize, md5: baseMd5 }
      }
      const candidate = await buildSessionCandidate(
        location.path,
        logBytes,
        totalSize,
        contentMd5,
        base,
      )
      await publishValidatedSession(location.path, candidate, async () => {
        await ctx.sessionPersistence.inspect(sessionId as SessionId)
      })
      await ctx.team.markSessionSynced(sessionId, contentMd5, totalSize)
      try {
        const inspected = await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(5_000))
        await ctx.team.saveSessionAnalytics({
          sessionId,
          ...(projectRoot === undefined ? {} : { projectName: basename(projectRoot) }),
          ...(projectRoot === undefined ? {} : { projectRoot }),
          ...(gitRemote === undefined ? {} : { gitRemote }),
          title: sessionTitle(inspected.events),
          lastActiveAt: inspected.events.at(-1)?.time ?? inspected.meta.createdAt,
          metrics: analyzeSessionEvents(inspected.events),
        })
      } catch (error) {
        writeTeamLog({ level: 'warn', event: 'session.analytics.persist_failed', message: error instanceof Error ? error.message : String(error), sessionId, userId })
      }
      logSuccess({
        mode: base === undefined ? 'full' : 'delta',
        bytes: logBytes.byteLength,
        total: totalSize,
        sessionId,
        userId,
      })
      sendJson(res, 200, { ok: true, contentMd5 })
    } catch (error) {
      if (error instanceof SessionSyncBaseMismatchError) {
        writeTeamLog({ level: 'warn', event: 'session.sync.base_mismatch', message: error.message, sessionId, userId })
        sendJson(res, 409, { ok: false, reason: 'base-mismatch', message: '增量基准不匹配，请全量同步' })
        return
      }
      if (error instanceof SessionSyncContentMismatchError) {
        writeTeamLog({ level: 'warn', event: 'session.sync.content_mismatch', message: error.message, sessionId, userId })
        sendJson(res, 400, { ok: false, reason: 'content-mismatch', message: '会话日志大小或摘要不匹配' })
        return
      }
      if (error instanceof SessionSyncValidationError) {
        writeTeamLog({ level: 'warn', event: 'session.sync.invalid_log', message: error.message, sessionId, userId })
        sendJson(res, 400, { ok: false, reason: 'invalid-log', message: '会话日志格式无效，Server 已保留原文件' })
        return
      }
      writeTeamLog({ level: 'error', event: 'session.sync.failed', message: error instanceof Error ? error.message : String(error), sessionId, userId })
      sendJson(res, 500, { ok: false, message: '会话日志写入失败，Server 已保留原文件' })
    }
  })
}

async function handleSyncSessionStatus(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  const sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') { sendJson(res, 400, { message: '缺少 sessionId' }); return }
  const marker = await ctx.team.readSessionMarker(sessionId)
  if (marker === undefined || marker.userId !== userId) { sendJson(res, 200, { has: false }); return }
  sendJson(res, 200, {
    has: true,
    ...(marker.contentMd5 === null ? {} : { contentMd5: marker.contentMd5 }),
    ...(marker.fileSize === null ? {} : { fileSize: marker.fileSize }),
    ...(marker.projectRoot === undefined ? {} : { projectRoot: marker.projectRoot }),
    ...(marker.gitRemote === undefined ? {} : { gitRemote: marker.gitRemote }),
  })
}

async function handleGitOps(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  let input: unknown
  try { input = await readJson(req) } catch { sendJson(res, 400, { message: '请求格式错误' }); return }
  if (typeof input !== 'object' || input === null
    || !('ops' in input) || !Array.isArray(input.ops) || input.ops.length === 0
    || !input.ops.every(op => typeof op === 'object' && op !== null && 'action' in op && typeof op.action === 'string')) {
    sendJson(res, 400, { message: '无效的 Git 操作记录' }); return
  }
  await ctx.team.recordGitOps(userId, input.ops as { action: string; cwd?: string; failed?: boolean }[])
  sendJson(res, 200, { ok: true })
}

async function handleGitChanges(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  let input: unknown
  try { input = await readJson(req) } catch { sendJson(res, 400, { message: '请求格式错误' }); return }
  if (typeof input !== 'object' || input === null
    || !('commits' in input) || !Array.isArray(input.commits) || input.commits.length === 0
    || !input.commits.every(c => typeof c === 'object' && c !== null
      && typeof c.commitHash === 'string' && c.commitHash !== ''
      && (!('gitRemote' in c) || typeof c.gitRemote === 'string')
      && (!('authorName' in c) || typeof c.authorName === 'string')
      && (!('authorEmail' in c) || typeof c.authorEmail === 'string')
      && (!('subject' in c) || typeof c.subject === 'string')
      && (!('message' in c) || typeof c.message === 'string')
      && (!('changedFiles' in c) || Array.isArray(c.changedFiles) && c.changedFiles.every((path: unknown) => typeof path === 'string') && c.changedFiles.length <= 500)
      && (!('time' in c) || typeof c.time === 'number' && Number.isFinite(c.time) && c.time >= 0)
      && typeof c.files === 'number' && Number.isInteger(c.files) && c.files >= 0
      && typeof c.insertions === 'number' && Number.isInteger(c.insertions) && c.insertions >= 0
      && typeof c.deletions === 'number' && Number.isInteger(c.deletions) && c.deletions >= 0)) {
    sendJson(res, 400, { message: '无效的代码变更记录' }); return
  }
  try {
    await ctx.team.recordCodeChanges(input.commits as TeamCodeChangeInput[])
  } catch (error) {
    writeTeamLog({ level: 'error', event: 'git.changes.record_failed', message: error instanceof Error ? error.message : String(error), userId })
    await ctx.team.audit({ level: 'error', event: 'git.sync', message: 'Git 提交入库失败', userId, details: { error: error instanceof Error ? error.message.slice(0, 300) : String(error) } }).catch(() => undefined)
    sendJson(res, 500, { message: '提交记录入库失败' })
    return
  }
  // Git 同步审计：相邻 500ms 内的批量上报合并为一行，避免整仓导入刷屏。
  const now = Date.now()
  const latest = lastGitSyncAudit.get(userId)
  if (latest !== undefined && now - latest.at < 500) {
    latest.count += input.commits.length
    latest.message = `Git 同步 ${latest.count} 条提交`
    clearTimeout(latest.timer)
  } else {
    const entry = { at: now, count: input.commits.length, message: `Git 同步 ${input.commits.length} 条提交`, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    lastGitSyncAudit.set(userId, entry)
    entry.timer = setTimeout(() => {
      void ctx.team.audit({ level: 'info', event: 'git.sync', message: entry.message, userId }).catch(() => undefined)
      lastGitSyncAudit.delete(userId)
    }, 500)
  }
  sendJson(res, 200, { ok: true })
}

async function handleSyncSessions(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  const synced = await ctx.team.listOwnSessions(userId)
  sendJson(res, 200, { sessions: synced })
}

async function handleAdminTicket(sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  const code = await sessions.issueAdminTicket(userId)
  writeTeamLog({ level: 'info', event: 'admin.ticket.issued', message: 'Admin entry code issued', userId })
  sendJson(res, 200, { code })
}

async function handleAdminConsume(sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  const code = new URL(req.url ?? '', 'http://localhost').searchParams.get('code')
  const userId = code === null ? undefined : await sessions.consumeAdminTicket(code)
  if (userId === undefined) {
    res.writeHead(302, { location: '/team/login-page' })
    res.end()
    return
  }
  await sessions.start(req, res, userId)
  writeTeamLog({ level: 'info', event: 'admin.ticket.consumed', message: 'Admin browser session started from entry code', userId })
  res.writeHead(302, { location: '/team/admin' })
  res.end()
}

async function handleAdminSyncStatus(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const rows = await ctx.team.listSyncStatus()
  const titles = new Map((await listEnrichedSessionOwners(ctx)).map(row => [row.sessionId, row.title]))
  const users = new Map<string, {
    userId: string
    userName: string
    sessions: { sessionId: string; updatedAt: string; title?: string }[]
    lastSyncAt: string | undefined
  }>()
  for (const row of rows) {
    const user = users.get(row.userId) ?? {
      userId: row.userId,
      userName: row.userName,
      sessions: [],
      lastSyncAt: undefined,
    }
    const title = titles.get(row.sessionId)
    user.sessions.push({ sessionId: row.sessionId, updatedAt: row.updatedAt, ...(title === undefined ? {} : { title }) })
    user.lastSyncAt = user.lastSyncAt === undefined || row.updatedAt > user.lastSyncAt ? row.updatedAt : user.lastSyncAt
    users.set(row.userId, user)
  }
  const userList = [...users.values()].map(user => ({
    ...user,
    lastSyncAt: user.lastSyncAt ?? null,
  })).sort((left, right) => (right.lastSyncAt ?? '').localeCompare(left.lastSyncAt ?? ''))
  const lastSyncAt = userList.find(user => user.lastSyncAt !== null)?.lastSyncAt ?? null
  sendJson(res, 200, {
    generatedAt: new Date().toISOString(),
    summary: {
      totalUsers: userList.length,
      totalSessions: rows.length,
      lastSyncAt,
    },
    users: userList,
  })
}

async function handleAdminSyncReconcile(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  try {
    const result = await reconcileSessions(ctx)
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    writeTeamLog({ level: 'error', event: 'session.reconcile.failed', message: error instanceof Error ? error.message : String(error) })
    sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

async function handleAdminUser(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const id = decodeURIComponent(new URL(req.url ?? '', 'http://localhost').pathname.split('/').at(-1) ?? '')
  if (id === 'hahame' && req.method === 'DELETE') { sendJson(res, 400, { message: '不能删除当前管理员' }); return }
  if (req.method === 'DELETE') { sendJson(res, await ctx.team.deleteUser(id) ? 204 : 404, {}); return }
  if (req.method !== 'PATCH') { sendJson(res, 405, { message: '只支持 PATCH 或 DELETE 请求' }); return }
  try {
    const input = await readJson(req)
    if (typeof input !== 'object' || input === null || !('name' in input) || !('status' in input) || !('role' in input)
      || typeof input.name !== 'string' || !['pending', 'active', 'rejected', 'disabled'].includes(String(input.status))
      || !['admin', 'developer', 'reviewer', 'user'].includes(String(input.role))
      || ('password' in input && typeof input.password !== 'string')) {
      sendJson(res, 400, { message: '用户字段无效' }); return
    }
    const password = 'password' in input && typeof input.password === 'string'
      ? input.password
      : undefined
    if (password !== undefined && password !== '' && password.length < 6) {
      sendJson(res, 400, { message: '密码至少需要 6 位' }); return
    }
    const user = await ctx.team.updateUser(
      id,
      { name: input.name, status: input.status as never, role: input.role as never },
      password === '' ? undefined : password,
    )
    sendJson(res, user === undefined ? 404 : 200, user ?? { message: '账号不存在' })
  } catch { sendJson(res, 400, { message: '请求格式错误' }) }
}

async function handleAdminPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(await adminPage)
}

async function handleAdminScript(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(await adminScript)
}

async function handleLoginPage(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(await loginPage)
}

async function handleLoginScript(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
  res.end(await loginScript)
}

/** Admin console guard injected into the Server DSH index.html: by default the
 * workspace homepage redirects (authenticated → /team/admin, else → login).
 * A URL with ?workspace=1 (the admin console's "打开工作台" entry) bypasses
 * the guard so the operator can stay in the DSH workspace for model testing. */
const adminAuthBootstrap = `<style id="team-auth-guard">html{visibility:hidden}</style><script>(async()=>{
try{var r=await fetch('/team/session',{credentials:'same-origin',cache:'no-store'});var d=await r.json();if(r.ok&&d.authenticated===true&&d.user&&d.user.role==='admin'){document.documentElement.style.visibility='visible';document.getElementById('team-auth-guard').remove();return}}catch(e){}
location.replace('/team/admin')
})()</script>`

function injectAdminAuthGuard(html: string): string {
  return html.replace(/<\/head>/i, `${adminAuthBootstrap}</head>`)
}

/**
 * Root entry: the Server DSH workspace is operator-only. A bare / redirects to
 * the admin console (or the login page); /?workspace=1 additionally requires an
 * admin session and lands on /team/workspace — the only path that serves the
 * workspace UI (everything else bounces back to the admin console).
 */
async function handleRootEntry(
  ctx: TeamContext,
  sessions: AuthSessions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { message: '只支持 GET 请求' })
    return
  }
  const user = await authenticatedUser(ctx, sessions, req)
  const wantsWorkspace = new URL(req.url ?? '/', 'http://localhost').searchParams.has('workspace')
  if (wantsWorkspace) {
    res.writeHead(302, { location: user?.role === 'admin' ? '/team/workspace' : '/team/admin' })
    res.end()
    return
  }
  res.writeHead(302, { location: user !== undefined ? '/team/admin' : '/team/login-page' })
  res.end()
}

async function handleEnter(
  ctx: TeamContext,
  sessions: AuthSessions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { message: '只支持 GET 请求' })
    return
  }
  if (await authenticatedUser(ctx, sessions, req) === undefined) {
    res.writeHead(302, { location: '/team/login-page' })
    res.end()
    return
  }
  res.writeHead(302, { location: '/team/admin' })
  res.end()
}

function handleMe(
  ctx: TeamContext,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const user = ctx.team.getUser(url.searchParams.get("userId") ?? "");
  sendJson(res, 200, {
    message: "success",
    userName: user?.name ?? "unknown",
  });
}

async function handleLogin(
  ctx: TeamContext,
  sessions: AuthSessions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "只支持 POST 请求" });
    return;
  }

  try {
    const input = await readJson(req)
    if (typeof input !== 'object' || input === null
      || !('userId' in input) || typeof input.userId !== 'string'
      || !('password' in input) || typeof input.password !== 'string') {
      sendJson(res, 400, { message: '请输入用户 ID 和密码' })
      return
    }

    const account = ctx.team.getUser(input.userId)
    if (account !== undefined && account.status !== 'active') {
      sendJson(res, 403, { message: '账号未激活，请联系管理员' })
      return
    }

    const user = await ctx.team.login(input.userId, input.password)
    if (!user) {
      sendJson(res, 401, { message: '用户名或密码错误' })
      return
    }

    await sessions.start(req, res, user.id)
    sendJson(res, 200, { message: '登录成功', user })
  } catch {
    sendJson(res, 400, { message: 'JSON 格式错误' })
  }
}

async function handleSession(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { message: '只支持 GET 请求' })
    return
  }

  const user = await authenticatedUser(ctx, sessions, req)

  sendJson(res, 200, user
    ? { authenticated: true, user }
    : { authenticated: false })
}

async function handleApplication(ctx: TeamContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { message: "只支持 POST 请求" }); return }
  try {
    const input = await readJson(req)
    if (typeof input !== 'object' || input === null
      || !('email' in input) || typeof input.email !== 'string'
      || !('name' in input) || typeof input.name !== 'string'
      || input.email.trim() === '' || input.name.trim() === '') {
      sendJson(res, 400, { message: "请输入邮箱和真实姓名" }); return
    }
    const user = await ctx.team.applyForAccess(input.email, input.name)
    if (!user) { sendJson(res, 409, { message: "该邮箱已提交过申请" }); return }
    sendJson(res, 201, { message: "申请已提交，请等待管理员审核" })
  } catch { sendJson(res, 400, { message: "请求格式错误" }) }
}

async function handleLogout(sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: '只支持 POST 请求' })
    return
  }

  await sessions.end(req, res)

  sendJson(res, 200, {
    message: '退出成功',
  })
}

/** Register the team platform's HTTP routes and return their disposer. */
export async function registerTeamRoutes(ctx: TeamContext): Promise<() => Promise<void>> {
  const sessions = await AuthSessions.connect()
  const syncSuccessLogger = createSessionSyncSuccessLogger()
  const disposers = [ctx.webServer.tapIndex(injectAdminAuthGuard), ctx.webServer.register({
    kind: "exact",
    path: "/team/me",
    handler: (req, res) => handleMe(ctx, req, res),
  }), ctx.webServer.register({
    kind: 'exact',
    path: '/team/api/login',
    handler: (req, res) => handleClientLogin(ctx, sessions, req, res),
  }), ctx.webServer.register({
    kind: 'exact',
    path: '/team/api/session',
    handler: (req, res) => handleClientSession(ctx, sessions, req, res),
  }), ctx.webServer.register({
    kind: 'exact',
    path: '/team/api/model/chat/completions',
    handler: (req, res) => handleModelGateway(ctx, sessions, req, res),
  }), ctx.webServer.register({
    kind: 'exact',
    path: '/team/api/model/files',
    handler: (req, res) => handleModelFilesGateway(ctx, sessions, req, res),
  }), ctx.webServer.register({
    kind: 'prefix',
    path: '/team/api/model/files/',
    handler: (req, res) => handleModelFilesGateway(ctx, sessions, req, res),
  }), ctx.webServer.register({
    kind: "exact",
    path: "/team/login",
    handler: (req, res) => handleLogin(ctx, sessions, req, res),
  }), ctx.webServer.register({
    kind: "exact",
    path: "/team/apply",
    handler: (req, res) => handleApplication(ctx, req, res),
  }), ctx.webServer.register({
    kind: "exact",
    path: "/team/session",
    handler: (req, res) => handleSession(ctx, sessions, req, res),
  }),
  ctx.webServer.register({ kind: 'exact', path: '/team/api/admin-ticket', handler: (req, res) => handleAdminTicket(sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/consume', handler: (req, res) => handleAdminConsume(sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/api/sync/session', handler: (req, res) => handleSyncSession(ctx, sessions, syncSuccessLogger.record, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/api/sync/session/status', handler: (req, res) => handleSyncSessionStatus(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/api/sync/sessions', handler: (req, res) => handleSyncSessions(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/api/git/ops', handler: (req, res) => handleGitOps(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/api/git/changes', handler: (req, res) => handleGitChanges(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin', handler: handleAdminPage }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin.js', handler: handleAdminScript }),
  ctx.webServer.register({ kind: 'exact', path: '/team/login-page', handler: handleLoginPage }),
  ctx.webServer.register({ kind: 'exact', path: '/team/login.js', handler: handleLoginScript }),
  ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => handleRootEntry(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/enter', handler: (req, res) => handleEnter(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/users', handler: (req, res) => handleAdminUsers(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/sessions', handler: (req, res) => handleAdminSessions(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/sync-status', handler: (req, res) => handleAdminSyncStatus(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/sync/reconcile', handler: (req, res) => handleAdminSyncReconcile(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/overview', handler: (req, res) => handleAdminOverview(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/git-sync-log', handler: (req, res) => handleAdminGitSyncLog(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'prefix', path: '/team/admin/git-emails', handler: (req, res) => handleAdminGitEmails(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'prefix', path: '/team/admin/projects', handler: (req, res) => handleAdminProjectDetail(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'prefix', path: '/team/admin/user-detail', handler: (req, res) => handleAdminUserDetail(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'prefix', path: '/team/admin/insights/sessions', handler: (req, res) => handleAdminSessionTimeline(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'prefix', path: '/team/admin/users', handler: (req, res) => handleAdminUser(ctx, sessions, req, res) }),
  ctx.webServer.register({
    kind: "exact",
    path: "/team/logout",
    handler: (req, res) => handleLogout(sessions, req, res),
  })]

  return async () => {
    for (const dispose of disposers.reverse()) dispose()
    syncSuccessLogger.dispose()
    await sessions.close()
  }
}
