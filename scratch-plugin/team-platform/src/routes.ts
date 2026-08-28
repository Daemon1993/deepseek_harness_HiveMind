import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from 'node:path'
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { TeamContext, TeamSessionCreateRequest } from "./types.ts";
import { AuthSessions } from "./auth.ts";
import { writeTeamLog } from "./team-log.ts";
import { analyzeSessionEvents } from './session-metrics.ts'

const adminPage = readFile(new URL("../admin.html", import.meta.url), "utf8");
const adminScript = readFile(new URL("./admin.js", import.meta.url));
const loginPage = readFile(new URL("../login.html", import.meta.url), "utf8");
const loginScript = readFile(new URL("./login.js", import.meta.url));

const teamAuthBootstrap = `<style id="team-auth-guard">html{visibility:hidden}</style><script>(async()=>{try{const response=await fetch('/team/session',{credentials:'same-origin',cache:'no-store'});const data=await response.json();if(response.ok&&data.authenticated===true){document.documentElement.style.visibility='visible';document.getElementById('team-auth-guard')?.remove();return}}catch{}location.replace('/team/login-page')})()</script>`

function injectTeamAuthGuard(html: string): string {
  return html.replace(/<\/head>/i, `${teamAuthBootstrap}</head>`)
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

type RpcCreateRequest = {
  rpcId: string
  request: TeamSessionCreateRequest
}

function sendRpcResult(res: ServerResponse, rpcId: string, result: unknown): void {
  sendJson(res, 200, { type: 'server-response', rpcId, result })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) body += chunk.toString()
  return JSON.parse(body)
}

function readSessionCreateRequest(value: unknown): RpcCreateRequest | undefined {
  if (typeof value !== 'object' || value === null
    || !('type' in value) || value.type !== 'client-request'
    || !('rpcId' in value) || typeof value.rpcId !== 'string'
    || !('method' in value) || value.method !== 'session/create'
    || !('payload' in value) || typeof value.payload !== 'object' || value.payload === null) return undefined
  const payload = value.payload
  if (!('args' in payload) || typeof payload.args !== 'object' || payload.args === null) return undefined
  const args = payload.args
  if (!('request' in args) || typeof args.request !== 'object' || args.request === null) return undefined
  const request = args.request
  if (('workspaceId' in request && typeof request.workspaceId !== 'string')
    || ('cwd' in request && typeof request.cwd !== 'string')
    || ('sessionId' in request && typeof request.sessionId !== 'string')
    || ('agentPreset' in request && typeof request.agentPreset !== 'string')) return undefined
  return { rpcId: value.rpcId, request: request as TeamSessionCreateRequest }
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
  const [owners, listed] = await Promise.all([
    ctx.team.listSessionOwners(),
    ctx.sessionController.list({}, AbortSignal.timeout(5_000)),
  ])
  const summaries = new Map(listed.items.map(item => [item.sessionId, item]))
  return owners.map(owner => {
    const summary = summaries.get(owner.sessionId)
    if (summary === undefined) return owner
    const title = typeof summary.projections?.values.title === 'string'
      ? summary.projections.values.title
      : summary.blank ? '新会话' : summary.cwd === undefined ? undefined : basename(summary.cwd)
    return {
      ...owner,
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
  const activeAt = (session: typeof allSessions[number]): number => session.updatedAt ?? Date.parse(session.lastActiveAt)
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

async function handleAdminSessionTimeline(ctx: TeamContext, sessions: AuthSessions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  if (!await requireAdmin(ctx, sessions, req, res)) return
  const sessionId = decodeURIComponent(new URL(req.url ?? '', 'http://localhost').pathname.split('/').at(-1) ?? '')
  const owner = (await listEnrichedSessionOwners(ctx)).find(item => item.sessionId === sessionId)
  if (owner === undefined) { sendJson(res, 404, { message: '未找到会话归属记录' }); return }
  try {
    const inspected = await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(5_000))
    sendJson(res, 200, { session: owner, timeline: analyzeSessionEvents(inspected.events).timeline })
  } catch {
    sendJson(res, 404, { message: '会话记录不可用' })
  }
}

async function handleSessionCreate(
  ctx: TeamContext,
  sessions: AuthSessions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  writeTeamLog('Session create request received')
  if (req.method !== 'POST') { sendJson(res, 405, { message: '只支持 POST 请求' }); return }
  let request: RpcCreateRequest | undefined
  try {
    request = readSessionCreateRequest(await readJson(req))
  } catch {
    sendJson(res, 400, { message: '请求格式错误' })
    return
  }
  if (request === undefined) { sendJson(res, 400, { message: '无效的 session.create 请求' }); return }
  const user = await authenticatedUser(ctx, sessions, req)
  if (user === undefined) {
    await ctx.team.audit({ level: 'warn', event: 'session.create.rejected', requestId: request.rpcId, details: { reason: 'unauthenticated' } })
    sendRpcResult(res, request.rpcId, { ok: false, error: { code: 'unauthorized', message: '请先登录', details: {} } })
    return
  }
  try {
    const value = await ctx.sessionController.create(request.request)
    if (!await ctx.team.bindSessionOwner(value.sessionId, user.id)) {
      throw new Error(`session ${value.sessionId} already belongs to another user`)
    }
    await ctx.team.audit({
      level: 'info',
      event: 'session.create',
      requestId: request.rpcId,
      userId: user.id,
      sessionId: value.sessionId,
    })
    sendRpcResult(res, request.rpcId, { ok: true, value })
  } catch (error) {
    const failure = typeof error === 'object' && error !== null
      && 'failure' in error && typeof error.failure === 'object' && error.failure !== null
      ? error.failure
      : { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} }
    await ctx.team.audit({ level: 'error', event: 'session.create.failed', requestId: request.rpcId, userId: user.id, details: { code: failure.code } })
    sendRpcResult(res, request.rpcId, { ok: false, error: failure })
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
  const host = req.headers.host
  if (host === undefined) {
    sendJson(res, 400, { message: '请求缺少 Host' })
    return
  }
  const forwardedProtocol = req.headers['x-forwarded-proto']
  const protocolValue = Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol
  const protocol = protocolValue?.split(',')[0]?.trim() === 'https' ? 'https' : 'http'
  res.writeHead(302, { location: ctx.connection.authenticatedUrl(`${protocol}://${host}`) })
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
  const disposers = [ctx.webServer.tapIndex(injectTeamAuthGuard), ctx.webServer.register({
    kind: "exact",
    path: "/team/me",
    handler: (req, res) => handleMe(ctx, req, res),
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
  ctx.webServer.register({ kind: 'exact', path: '/api/session/create', handler: (req, res) => handleSessionCreate(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin', handler: handleAdminPage }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin.js', handler: handleAdminScript }),
  ctx.webServer.register({ kind: 'exact', path: '/team/login-page', handler: handleLoginPage }),
  ctx.webServer.register({ kind: 'exact', path: '/team/login.js', handler: handleLoginScript }),
  ctx.webServer.register({ kind: 'exact', path: '/team/enter', handler: (req, res) => handleEnter(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/users', handler: (req, res) => handleAdminUsers(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/sessions', handler: (req, res) => handleAdminSessions(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/analytics', handler: (req, res) => handleAdminAnalytics(ctx, sessions, req, res) }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/insights', handler: (req, res) => handleAdminInsights(ctx, sessions, req, res) }),
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
