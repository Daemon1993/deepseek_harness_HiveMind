import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { TeamContext } from "./types.ts";
import { AuthSessions } from "./auth.ts";

const adminPage = readFile(new URL("../admin.html", import.meta.url), "utf8");
const adminScript = readFile(new URL("./admin.js", import.meta.url));

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
  if (!await requireAdmin(ctx, sessions, req, res)) return
  if (req.method !== 'GET') { sendJson(res, 405, { message: '只支持 GET 请求' }); return }
  sendJson(res, 200, { users: ctx.team.listAdminUsers() })
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
  const disposers = [ctx.webServer.register({
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
  ctx.webServer.register({ kind: 'exact', path: '/team/admin', handler: handleAdminPage }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin.js', handler: handleAdminScript }),
  ctx.webServer.register({ kind: 'exact', path: '/team/admin/users', handler: (req, res) => handleAdminUsers(ctx, sessions, req, res) }),
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
