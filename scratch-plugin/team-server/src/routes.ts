import { open, readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname } from 'node:path'
import type {} from "@deepseek-ai/dsh-host-webserver";
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { TeamContext } from "./types.ts";
import { AuthSessions } from "./auth.ts";
import { writeTeamLog } from "./team-log.ts";
import { analyzeSessionEvents } from './session-metrics.ts'
import { reconcileSessions } from './reconcile.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

const MODEL_REQUEST_MAX_BYTES = 50 * 1024 * 1024
const MODEL_FILE_MAX_BYTES = 128 * 1024 * 1024  // DeepSeek 单文件上传上限
const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_API_KEY_REF = credentialRef('DEEPSEEK_API_KEY')

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
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown }
    model = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined
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
    if (upstream.body !== null) {
      for await (const chunk of upstream.body) res.write(chunk)
    }
    res.end()
    await ctx.team.audit({
      level: upstream.ok ? 'info' : 'warn',
      event: 'model.gateway',
      message: `DeepSeek gateway completed status=${upstream.status} duration=${Date.now() - startedAt}ms`,
      requestId,
      userId,
      ...logModel,
      details: { status: upstream.status, durationMs: Date.now() - startedAt },
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
  sendJson(res, 200, {
    users: user.role === 'admin'
      ? users
      : users.map(({ password: _password, ...account }) => account),
  })
}

async function handleAdminSessions(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  sendJson(res, 200, { sessions: await listEnrichedSessionOwners(ctx) })
}

async function listEnrichedSessionOwners(ctx: TeamContext) {
  const owners = await ctx.team.listSyncedSessions()
  // 容错：个别会话文件损坏不应拖垮整个分析端点——list 失败时降级为空列表。
  let listed: Awaited<ReturnType<typeof ctx.sessionController.list>> = { items: [] }
  try {
    listed = await ctx.sessionController.list({}, AbortSignal.timeout(5_000))
  } catch (error) {
    writeTeamLog({ level: 'warn', event: 'analytics.session.list_failed', message: error instanceof Error ? error.message : String(error) })
  }
  const summaries = new Map(listed.items.map(item => [item.sessionId, item]))
  return owners.map(owner => {
    const base = { ...owner, lastActiveAt: owner.updatedAt, cwd: undefined as string | undefined }
    const summary = summaries.get(owner.sessionId)
    if (summary === undefined) return base
    const title = typeof summary.projections?.values.title === 'string'
      ? summary.projections.values.title
      : summary.blank ? '新会话' : summary.cwd === undefined ? undefined : basename(summary.cwd)
    return {
      ...base,
      ...(title === undefined ? {} : { title }),
      ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
      updatedAt: summary.updatedAt,
      blank: summary.blank,
    }
  })
}

async function handleAdminAnalytics(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const requestedDays = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('days') ?? '7')
  if (![1, 7, 30].includes(requestedDays)) { sendJson(res, 400, { message: '统计范围只支持 1、7 或 30 天' }); return }
  const [allUsers, allSessions] = await Promise.all([
    Promise.resolve(ctx.team.listAdminUsers()),
    listEnrichedSessionOwners(ctx),
  ])
  const threshold = Date.now() - requestedDays * 24 * 60 * 60 * 1000
  const activeAt = (session: typeof allSessions[number]): number => {
    const updated = session.updatedAt
    return typeof updated === 'number' ? updated : Date.parse(session.lastActiveAt)
  }
  const rangedSessions = allSessions.filter(session => activeAt(session) >= threshold)
  const activeUserIds = new Set(rangedSessions.map(session => session.userId))
  const directoryPaths = new Set(allSessions.flatMap(session => session.cwd === undefined ? [] : [session.cwd]))
  const users = allUsers.map(user => {
    const owned = allSessions.filter(session => session.userId === user.id)
    const ranged = owned.filter(session => activeAt(session) >= threshold)
    const activeTimes = owned.map(activeAt)
    return {
      userId: user.id,
      userName: user.name,
      ...(user.email === undefined ? {} : { email: user.email }),
      status: user.status,
      role: user.role,
      sessionCount: owned.length,
      recentSessionCount: ranged.length,
      directoryCount: new Set(owned.flatMap(session => session.cwd === undefined ? [] : [session.cwd])).size,
      firstUsedAt: owned.length === 0 ? undefined : new Date(Math.min(...owned.map(session => Date.parse(session.createdAt)))).toISOString(),
      lastUsedAt: activeTimes.length === 0 ? undefined : new Date(Math.max(...activeTimes)).toISOString(),
    }
  }).sort((left, right) => right.recentSessionCount - left.recentSessionCount || right.sessionCount - left.sessionCount)
  const directories = [...allSessions.reduce<Map<string, { path: string; sessionIds: Set<string>; userIds: Set<string>; lastActiveAt: number }>>((groups, session) => {
    if (session.cwd === undefined) return groups
    const group = groups.get(session.cwd) ?? { path: session.cwd, sessionIds: new Set(), userIds: new Set(), lastActiveAt: 0 }
    group.sessionIds.add(session.sessionId)
    group.userIds.add(session.userId)
    group.lastActiveAt = Math.max(group.lastActiveAt, activeAt(session))
    groups.set(session.cwd, group)
    return groups
  }, new Map()).values()].map(group => ({
    path: group.path,
    name: basename(group.path),
    sessionCount: group.sessionIds.size,
    userCount: group.userIds.size,
    lastActiveAt: new Date(group.lastActiveAt).toISOString(),
  })).sort((left, right) => right.sessionCount - left.sessionCount)
  const recentSessions = [...allSessions].sort((left, right) => activeAt(right) - activeAt(left)).slice(0, 10).map(session => ({
    ...session,
    lastActiveAt: new Date(activeAt(session)).toISOString(),
  }))
  sendJson(res, 200, {
    rangeDays: requestedDays,
    generatedAt: new Date().toISOString(),
    summary: {
      totalUsers: allUsers.length,
      activeAccounts: allUsers.filter(user => user.status === 'active').length,
      totalSessions: allSessions.length,
      recentSessions: rangedSessions.length,
      activeUsers: activeUserIds.size,
      directoryCount: directoryPaths.size,
    },
    users,
    directories,
    recentSessions,
  })
}

function requestedDays(req: IncomingMessage): 1 | 7 | 30 | undefined {
  const days = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('days') ?? '7')
  return days === 1 || days === 7 || days === 30 ? days : undefined
}

async function inspectOwnedSessions(ctx: TeamContext, owners: Awaited<ReturnType<typeof listEnrichedSessionOwners>>) {
  return Promise.all(owners.map(async owner => {
    try {
      const inspected = await ctx.sessionController.inspect(owner.sessionId, AbortSignal.timeout(5_000))
      return { owner, metrics: analyzeSessionEvents(inspected.events) }
    } catch (error) {
      writeTeamLog({ level: 'warn', event: 'analytics.session.inspect_failed', sessionId: owner.sessionId, message: error instanceof Error ? error.message : String(error) })
      return { owner, metrics: analyzeSessionEvents([]) }
    }
  }))
}

async function handleAdminInsights(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const days = requestedDays(req)
  if (days === undefined) { sendJson(res, 400, { message: '统计范围只支持 1、7 或 30 天' }); return }
  const owners = await listEnrichedSessionOwners(ctx)
  const inspected = await inspectOwnedSessions(ctx, owners)
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000
  const tools = new Map<string, { name: string; calls: number; failures: number; userIds: Set<string>; directories: Set<string> }>()
  const models = new Map<string, { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }>()
  const users = new Map<string, { userId: string; userName: string; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number }>()
  const trends = new Map<string, { date: string; activeUsers: Set<string>; newSessions: number; toolCalls: number; modelRequests: number }>()
  const rangeOwners = owners.filter(owner => Date.parse(owner.createdAt) >= threshold)
  for (const owner of rangeOwners) {
    const date = owner.createdAt.slice(0, 10)
    const trend = trends.get(date) ?? { date, activeUsers: new Set(), newSessions: 0, toolCalls: 0, modelRequests: 0 }
    trend.newSessions += 1; trends.set(date, trend)
  }
  for (const { owner, metrics } of inspected) {
    const user = users.get(owner.userId) ?? { userId: owner.userId, userName: owner.userName, toolCalls: 0, toolFailures: 0, modelRequests: 0, totalTokens: 0 }
    for (const item of metrics.timeline) {
      if (item.time < threshold) continue
      const date = new Date(item.time).toISOString().slice(0, 10)
      const trend = trends.get(date) ?? { date, activeUsers: new Set(), newSessions: 0, toolCalls: 0, modelRequests: 0 }
      trend.activeUsers.add(owner.userId)
      if (item.kind === 'tool') trend.toolCalls += 1
      if (item.kind === 'model') trend.modelRequests += 1
      trends.set(date, trend)
    }
    const inRange = (time: number): boolean => time >= threshold
    const visibleTools = metrics.toolEvents.filter(item => inRange(item.time)).length
    const visibleFailures = metrics.toolEvents.filter(item => inRange(item.time) && item.failed).length
    user.toolCalls += visibleTools; user.toolFailures += visibleFailures
    for (const model of metrics.modelEvents.filter(item => inRange(item.time))) {
      const aggregate = models.get(model.model) ?? { ...model, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      aggregate.requests += 1; aggregate.inputTokens += model.inputTokens; aggregate.outputTokens += model.outputTokens; aggregate.totalTokens += model.totalTokens
      models.set(model.model, aggregate)
      user.modelRequests += 1; user.totalTokens += model.totalTokens
    }
    users.set(owner.userId, user)
  }
  // Tool rows need session-level source context, so accumulate them in a second pass.
  for (const { owner, metrics } of inspected) for (const metric of metrics.toolEvents.filter(item => item.time >= threshold)) {
    const row = tools.get(metric.name) ?? { name: metric.name, calls: 0, failures: 0, userIds: new Set(), directories: new Set() }
    row.calls += 1; row.failures += metric.failed ? 1 : 0; row.userIds.add(owner.userId)
    if (owner.cwd !== undefined) row.directories.add(owner.cwd)
    tools.set(metric.name, row)
  }
  sendJson(res, 200, {
    rangeDays: days,
    generatedAt: new Date().toISOString(),
    summary: {
      toolCalls: [...tools.values()].reduce((total, tool) => total + tool.calls, 0),
      toolFailures: [...tools.values()].reduce((total, tool) => total + tool.failures, 0),
      modelRequests: [...models.values()].reduce((total, model) => total + model.requests, 0),
      inputTokens: [...models.values()].reduce((total, model) => total + model.inputTokens, 0),
      outputTokens: [...models.values()].reduce((total, model) => total + model.outputTokens, 0),
      totalTokens: [...models.values()].reduce((total, model) => total + model.totalTokens, 0),
    },
    tools: [...tools.values()].map(({ userIds, directories, ...tool }) => ({ ...tool, userCount: userIds.size, projectCount: directories.size })).sort((left, right) => right.calls - left.calls),
    models: [...models.values()].sort((left, right) => right.requests - left.requests),
    users: [...users.values()].sort((left, right) => right.totalTokens - left.totalTokens),
    trends: [...trends.values()].map(({ activeUsers, ...trend }) => ({ ...trend, activeUsers: activeUsers.size })).sort((left, right) => left.date.localeCompare(right.date)),
  })
}

async function handleAdminOverview(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const days = requestedDays(req)
  if (days === undefined) { sendJson(res, 400, { message: '统计范围只支持 1、7 或 30 天' }); return }
  const owners = await listEnrichedSessionOwners(ctx)
  const inspected = await inspectOwnedSessions(ctx, owners)
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000

  const users = new Map<string, { userId: string; userName: string; sessions: number; toolCalls: number; toolFailures: number; modelRequests: number; totalTokens: number; durationMs: number }>()
  const directories = new Map<string, { path: string; name: string; sessions: number; users: Set<string>; toolCalls: number; modelRequests: number; totalTokens: number; lastActiveAt: number }>()
  const tools = new Map<string, { name: string; calls: number; failures: number; users: Set<string> }>()
  const models = new Map<string, { model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }>()
  const trends = new Map<string, { date: string; sessions: number; activeUsers: Set<string>; toolCalls: number; modelRequests: number; totalTokens: number }>()

  let totalSessions = 0, totalUserMessages = 0, totalAssistantMessages = 0, totalToolCalls = 0, totalToolFailures = 0
  let totalModelRequests = 0, totalInputTokens = 0, totalOutputTokens = 0, totalTokens = 0, totalActiveMs = 0, totalDurationMs = 0, totalErrors = 0
  const recentSessions: { sessionId: string; title: string; userName: string; cwd?: string; lastActiveAt: number; toolCalls: number; durationMs: number; errorCount: number }[] = []

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

    const user = users.get(owner.userId) ?? { userId: owner.userId, userName: owner.userName, sessions: 0, toolCalls: 0, toolFailures: 0, modelRequests: 0, totalTokens: 0, durationMs: 0 }
    user.sessions++; user.toolCalls += metrics.toolCalls; user.toolFailures += metrics.toolFailures
    user.modelRequests += metrics.models.reduce((s, m) => s + m.requests, 0)
    user.totalTokens += metrics.models.reduce((s, m) => s + m.totalTokens, 0)
    user.durationMs += metrics.activeDurationMs
    users.set(owner.userId, user)

    if (owner.cwd !== undefined) {
      const dir = directories.get(owner.cwd) ?? { path: owner.cwd, name: basename(owner.cwd), sessions: 0, users: new Set(), toolCalls: 0, modelRequests: 0, totalTokens: 0, lastActiveAt: 0 }
      dir.sessions++; dir.users.add(owner.userId)
      dir.toolCalls += metrics.toolCalls; dir.modelRequests += metrics.models.reduce((s, m) => s + m.requests, 0)
      dir.totalTokens += metrics.models.reduce((s, m) => s + m.totalTokens, 0)
      dir.lastActiveAt = Math.max(dir.lastActiveAt, metrics.lastTime)
      directories.set(owner.cwd, dir)
    }

    for (const tool of metrics.tools) {
      const row = tools.get(tool.name) ?? { name: tool.name, calls: 0, failures: 0, users: new Set() }
      row.calls += tool.calls; row.failures += tool.failures; row.users.add(owner.userId)
      tools.set(tool.name, row)
    }
    for (const model of metrics.models) {
      const row = models.get(model.model) ?? { ...model }
      row.requests += model.requests; row.inputTokens += model.inputTokens; row.outputTokens += model.outputTokens; row.totalTokens += model.totalTokens
      models.set(model.model, row)
    }

    const date = new Date(metrics.lastTime).toISOString().slice(0, 10)
    const trend = trends.get(date) ?? { date, sessions: 0, activeUsers: new Set(), toolCalls: 0, modelRequests: 0, totalTokens: 0 }
    trend.sessions++; trend.activeUsers.add(owner.userId)
    trend.toolCalls += metrics.toolCalls; trend.modelRequests += metrics.models.reduce((s, m) => s + m.requests, 0)
    trend.totalTokens += metrics.models.reduce((s, m) => s + m.totalTokens, 0)
    trends.set(date, trend)

    recentSessions.push({
      sessionId: owner.sessionId, title: (owner as { title?: string }).title ?? '新会话', userName: owner.userName,
      ...(owner.cwd === undefined ? {} : { cwd: owner.cwd }),
      lastActiveAt: metrics.lastTime, toolCalls: metrics.toolCalls, durationMs: metrics.activeDurationMs, errorCount: metrics.errorCount,
    })
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
    },
    trends: [...trends.values()].map(({ activeUsers, ...t }) => ({ ...t, activeUsers: activeUsers.size })).sort((a, b) => a.date.localeCompare(b.date)),
    users: [...users.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    directories: [...directories.values()].map(({ users: u, ...d }) => ({ ...d, users: u.size })).sort((a, b) => b.sessions - a.sessions),
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
    const metrics = analyzeSessionEvents(inspected.events)
    sendJson(res, 200, { session: owner, metrics, timeline: metrics.timeline })
  } catch {
    sendJson(res, 404, { message: '会话记录不可用' })
  }
}

async function handleSyncSession(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  const userId = await sessions.clientUserId(req)
  if (userId === undefined) { sendJson(res, 401, { message: '客户端 Token 无效或已过期' }); return }
  let input: unknown
  try { input = await readJson(req) } catch { sendJson(res, 400, { message: '请求格式错误' }); return }
  if (typeof input !== 'object' || input === null
    || !('sessionId' in input) || typeof input.sessionId !== 'string' || input.sessionId === ''
    || !('header' in input) || typeof input.header !== 'object' || input.header === null
    || !('log' in input) || typeof input.log !== 'string' || input.log.length === 0
    || !('contentMd5' in input) || typeof input.contentMd5 !== 'string'
    || !('totalSize' in input) || typeof input.totalSize !== 'number') {
    sendJson(res, 400, { message: '无效的 Session 同步请求' }); return
  }
  const header = input.header as SessionHeader
  if (header.version !== SESSION_FORMAT_VERSION) {
    writeTeamLog({ level: 'warn', event: 'session.sync.version_mismatch', message: `Session format version mismatch got=${String(header.version)} expected=${SESSION_FORMAT_VERSION}`, sessionId: input.sessionId, userId })
    sendJson(res, 415, { ok: false, message: `会话格式版本不兼容（client=${String(header.version)}, server=${SESSION_FORMAT_VERSION}），请升级 Server` })
    return
  }
  const result = await ctx.team.ensureSessionOwner(input.sessionId, userId)
  if (result === 'conflict') { sendJson(res, 409, { message: '会话已属于其他用户' }); return }
  const delta = input as { baseSize?: unknown; baseMd5?: unknown }
  const baseSize = typeof delta.baseSize === 'number' ? delta.baseSize : undefined
  const baseMd5 = typeof delta.baseMd5 === 'string' ? delta.baseMd5 : undefined
  const logBytes = Buffer.from(input.log, 'base64')
  if (logBytes.byteLength === 0) { sendJson(res, 400, { ok: false, message: '日志内容为空' }); return }
  try {
    const location = ctx.sessionPersistence.locate(header)
    if (location === undefined) { sendJson(res, 500, { ok: false, message: '会话持久化不可用' }); return }
    // 增量追加：要求 client 证明前缀与 server 已存一致（baseSize+baseMd5 匹配）。
    if (baseSize !== undefined && baseMd5 !== undefined) {
      const marker = await ctx.team.readSessionMarker(input.sessionId)
      if (marker === undefined || marker.userId !== userId
        || marker.contentMd5 !== baseMd5 || marker.fileSize !== baseSize) {
        writeTeamLog({ level: 'warn', event: 'session.sync.base_mismatch', message: `Session delta base mismatch`, sessionId: input.sessionId, userId })
        sendJson(res, 409, { ok: false, reason: 'base-mismatch', message: '增量基准不匹配，请全量同步' })
        return
      }
      // 增量前：目标文件必须已存在（全量建立过）；文件缺失时增量会重建出无头文件。
      const existing = await stat(location.path).catch(() => undefined)
      if (existing === undefined) {
        writeTeamLog({ level: 'warn', event: 'session.sync.file_missing', message: 'Session file missing for delta; full sync required', sessionId: input.sessionId, userId })
        sendJson(res, 409, { ok: false, reason: 'base-mismatch', message: '会话文件不存在，请全量同步' })
        return
      }
      await mkdir(dirname(location.path), { recursive: true })
      const handle = await open(location.path, 'a')
      try { await handle.write(logBytes) } finally { await handle.close() }
      // 追加后校验：文件大小必须等于声明的 totalSize，否则增量有误，要求全量重建。
      const after = await stat(location.path)
      if (after.size !== input.totalSize) {
        writeTeamLog({ level: 'warn', event: 'session.sync.size_mismatch', message: `Session delta size mismatch got=${after.size} expected=${input.totalSize}`, sessionId: input.sessionId, userId })
        sendJson(res, 409, { ok: false, reason: 'base-mismatch', message: '增量追加结果与声明大小不符，请全量同步' })
        return
      }
    } else {
      // 全量替换：原子写入（tmp + rename）。
      await mkdir(dirname(location.path), { recursive: true })
      const tmp = `${location.path}.sync-tmp`
      await writeFile(tmp, logBytes)
      await rename(tmp, location.path)
      // 校验：日志首帧必须是合法会话头（防无头文件入库导致启动/列表崩溃）。
      try {
        await ctx.sessionPersistence.inspect(input.sessionId as SessionId)
      } catch (validationError) {
        await rm(location.path, { force: true })
        // 清标记：拒绝后不留"有标记无文件"的分歧，下次同步重新全量上传。
        await ctx.team.clearSessionMarker(input.sessionId)
        writeTeamLog({ level: 'warn', event: 'session.sync.invalid_log', message: `Session log rejected: ${validationError instanceof Error ? validationError.message : String(validationError)} bytes=${logBytes.byteLength}`, sessionId: input.sessionId, userId })
        sendJson(res, 400, { ok: false, reason: 'invalid-log', message: '会话日志首帧不是合法会话头，已拒绝' })
        return
      }
    }
    await ctx.team.markSessionSynced(input.sessionId, input.contentMd5, input.totalSize)
    sendJson(res, 200, { ok: true, contentMd5: input.contentMd5 })
  } catch (error) {
    writeTeamLog({ level: 'error', event: 'session.sync.failed', message: error instanceof Error ? error.message : String(error), sessionId: input.sessionId, userId })
    sendJson(res, 500, { ok: false, message: '会话日志写入失败' })
  }
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
  const sessionId = typeof (input as { sessionId?: unknown }).sessionId === 'string' ? (input as { sessionId?: unknown }).sessionId as string : undefined
  await ctx.team.recordGitOps(userId, sessionId, input.ops as { action: string; cwd?: string; failed?: boolean }[])
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
      && typeof c.files === 'number' && typeof c.insertions === 'number' && typeof c.deletions === 'number')) {
    sendJson(res, 400, { message: '无效的代码变更记录' }); return
  }
  const sessionId = typeof (input as { sessionId?: unknown }).sessionId === 'string' ? (input as { sessionId?: unknown }).sessionId as string : undefined
  await ctx.team.recordCodeChanges(userId, sessionId, input.commits as { commitHash: string; cwd?: string; files: number; insertions: number; deletions: number }[])
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
  const users = new Map<string, {
    userId: string
    userName: string
    sessions: { sessionId: string; updatedAt: string }[]
    lastSyncAt: string | undefined
  }>()
  for (const row of rows) {
    const user = users.get(row.userId) ?? {
      userId: row.userId,
      userName: row.userName,
      sessions: [],
      lastSyncAt: undefined,
    }
    user.sessions.push({ sessionId: row.sessionId, updatedAt: row.updatedAt })
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
  ctx.webServer.register({ kind: 'exact', path: '/team/api/sync/session', handler: (req, res) => handleSyncSession(ctx, sessions, req, res) }),
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
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/analytics', handler: (req, res) => handleAdminAnalytics(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/insights', handler: (req, res) => handleAdminInsights(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/overview', handler: (req, res) => handleAdminOverview(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'prefix', path: '/team/admin/insights/sessions', handler: (req, res) => handleAdminSessionTimeline(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'prefix', path: '/team/admin/users', handler: (req, res) => handleAdminUser(ctx, sessions, req, res) }),
  ctx.webServer.register({
    kind: "exact",
    path: "/team/logout",
    handler: (req, res) => handleLogout(sessions, req, res),
  })]

  return async () => {
    for (const dispose of disposers.reverse()) dispose()
    await sessions.close()
  }
}
