import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "./types.ts";
import { AuthSessions } from "./auth.ts";

type LoginInput = {
  userId: string;
  password: string;
};

const loginPage = readFile(new URL("../login.html", import.meta.url), "utf8");
const authSessions = new AuthSessions();

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

async function readLoginInput(
  req: IncomingMessage,
): Promise<LoginInput | undefined> {
  let body = "";
  for await (const chunk of req) body += chunk.toString();

  const input: unknown = JSON.parse(body);
  if (typeof input !== "object" || input === null) return undefined;
  if (!("userId" in input) || typeof input.userId !== "string")
    return undefined;
  if (!("password" in input) || typeof input.password !== "string")
    return undefined;
  return { userId: input.userId, password: input.password };
}

function handleMe(
  ctx: Context,
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
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "只支持 POST 请求" });
    return;
  }

  let input: LoginInput | undefined;
  try {
    input = await readLoginInput(req);
  } catch {
    sendJson(res, 400, { message: "JSON 格式错误" });
    return;
  }

  if (!input) {
    sendJson(res, 400, { message: "请输入用户 ID 和密码" });
    return;
  }

  const user = ctx.team.login(input.userId, input.password);
  if (!user) {
    sendJson(res, 401, { message: "用户名或密码错误" });
    return;
  }

  authSessions.delete(req);

  const token = authSessions.create(user);
  res.setHeader("set-cookie", authSessions.loginCookie(token));

  sendJson(res, 200, {
    message: "登录成功",
    user,
  });
}

async function handleLoginPage(res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
  });
  res.end(await loginPage);
}


function handleSession(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendJson(res, 405, { message: '只支持 GET 请求' })
    return
  }

  const user = authSessions.getUser(req)

  sendJson(res, 200, user
    ? { authenticated: true, user }
    : { authenticated: false })
}

function handleLogout(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: '只支持 POST 请求' })
    return
  }

  authSessions.delete(req)
  res.setHeader('set-cookie', authSessions.logoutCookie())

  sendJson(res, 200, {
    message: '退出成功',
  })
}

/** Register the team platform's HTTP routes and return their disposer. */
export function registerTeamRoutes(ctx: Context): () => void {
  const disposeMe = ctx.webServer.register({
    kind: "exact",
    path: "/team/me",
    handler: (req, res) => {
      handleMe(ctx, req, res);
    },
  });
  const disposeLogin = ctx.webServer.register({
    kind: "exact",
    path: "/team/login",
    handler: (req, res) => handleLogin(ctx, req, res),
  });
  const disposeLoginPage = ctx.webServer.register({
    kind: "exact",
    path: "/team/login.html",
    handler: (_req, res) => handleLoginPage(res),
  });

  const disposeSession = ctx.webServer.register({
    kind: "exact",
    path: "/team/session",
    handler: (req, res) => handleSession(req, res),
  })

  const disposeLogout = ctx.webServer.register({
    kind: "exact",
    path: "/team/logout",
    handler: (req, res) => handleLogout(req, res),
  })

  return () => {
    disposeLoginPage();
    disposeLogin();
    disposeMe();
    disposeSession();
    disposeLogout();
  };
}
