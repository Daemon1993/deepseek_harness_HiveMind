import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { registerSessionSync } from './sync.ts'
import { registerGitSync } from './git-sync.ts'
import { registerGitHooksSync } from './git-hooks-sync.ts'

/** Host face required for DSH package discovery and lifecycle ownership. */
export const name = 'team-client'

export const inject = ['connection', 'credentials', 'webServer', 'sessions', 'sessionController', 'sessionPersistence']

const COMPANY_TOKEN_REF = credentialRef('TEAM_COMPANY_TOKEN')

const loginPage = readFile(new URL('../login.html', import.meta.url), 'utf8')
const loginScript = readFile(new URL('./login.js', import.meta.url), 'utf8')

/** Login guard injected into the Local DSH index.html: hide the page until the
 * local /team/session endpoint confirms an authenticated employee, then redirect
 * to the login page instead of flashing the app. */
const teamAuthBootstrap = `<style id="team-auth-guard">html{visibility:hidden}</style><script>(async()=>{try{const response=await fetch('/team/session',{credentials:'same-origin',cache:'no-store'});const data=await response.json();if(response.ok&&data.authenticated===true){document.documentElement.style.visibility='visible';document.getElementById('team-auth-guard')?.remove();return}}catch{}location.replace('/team/login-page')})()</script>`

function injectTeamAuthGuard(html: string): string {
  return html.replace(/<\/head>/i, `${teamAuthBootstrap}</head>`)
}

function clientLog(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [team-client] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

interface ClientLoginResponse {
  token: string
  user: { id: string; name: string }
  message?: string
}

interface RemoteClientState {
  token?: string
  user?: ClientLoginResponse['user']
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.byteLength
    if (size > 1024 * 1024) return undefined
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Mount Local DSH login routes when TEAM_SERVER_URL selects remote-client mode. */
export function apply(ctx: Context): void {
  const configured = process.env.TEAM_SERVER_URL
  if (configured === undefined || configured.trim() === '') return
  const serverURL = configured.replace(/\/+$/u, '')
  const state: RemoteClientState = {}
  clientLog('info', `Connected to team server: ${serverURL}`)
  clientLog('info', `Login proxy target: ${serverURL}/team/api/login`)
  clientLog('info', `Model gateway target: ${serverURL}/team/api/model/chat/completions`)

  // Restore the persisted company token into in-memory state after a Host
  // restart, so the login guard does not force a re-login for a still-valid
  // token; a rejected token is cleared so the model adapter stops using it.
  let restoring: Promise<void> | undefined
  const restoreRemoteUser = async (): Promise<void> => {
    if (state.user !== undefined) return
    restoring ??= (async () => {
      try {
        const credential = await ctx.credentials.resolve(COMPANY_TOKEN_REF)
        if (credential === undefined) return
        const response = await fetch(`${serverURL}/team/api/session`, {
          headers: { authorization: `Bearer ${credential.value}` },
        })
        const data = await response.json() as { user?: ClientLoginResponse['user'] }
        if (!response.ok || data.user === undefined) {
          await ctx.credentials.unset(COMPANY_TOKEN_REF)
          return
        }
        state.token = credential.value
        state.user = data.user
        clientLog('info', `Team session restored for user ${data.user.id}`)
      } catch (error) {
        clientLog('warn', `Team session restore failed: ${String(error)}`)
      } finally {
        restoring = undefined
      }
    })()
    await restoring
  }

  const routes = [
    ctx.webServer.tapIndex(injectTeamAuthGuard),
    ctx.webServer.register({ kind: 'exact', path: '/team/session', async handler(_req, res) {
      await restoreRemoteUser()
      json(res, 200, state.user === undefined
        ? { authenticated: false }
        : { authenticated: true, user: state.user })
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/login', async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { message: '只支持 POST 请求' }); return }
      const requestBody = await body(req)
      if (requestBody === undefined) { json(res, 413, { message: '登录请求过大' }); return }
      clientLog('info', `Forwarding login to ${serverURL}/team/api/login`)
      try {
        const response = await fetch(`${serverURL}/team/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody as unknown as BodyInit,
        })
        const result = await response.json() as Partial<ClientLoginResponse>
        if (!response.ok || typeof result.token !== 'string' || result.user === undefined) {
          clientLog('warn', `Team server rejected login with status ${response.status}`)
          json(res, response.status, { message: result.message ?? '登录失败' })
          return
        }
        await ctx.credentials.set(COMPANY_TOKEN_REF, result.token)
        state.token = result.token
        state.user = result.user
        clientLog('info', `Team login completed for user ${result.user.id}`)
        json(res, 200, { message: '登录成功', user: result.user })
      } catch (error) {
        clientLog('error', `Team server login request failed: ${String(error)}`)
        json(res, 502, { message: '无法连接团队服务器' })
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/logout', async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { message: '只支持 POST 请求' }); return }
      await ctx.credentials.unset(COMPANY_TOKEN_REF)
      delete state.token
      delete state.user
      clientLog('info', 'Team client logged out')
      json(res, 200, { message: '退出成功' })
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/enter', handler(req, res) {
      if (req.method !== 'GET') { json(res, 405, { message: '只支持 GET 请求' }); return }
      if (state.user === undefined) {
        res.writeHead(302, { location: '/team/login-page' })
        res.end()
        return
      }
      const host = req.headers.host
      if (host === undefined) { json(res, 400, { message: '请求缺少 Host' }); return }
      const forwarded = req.headers['x-forwarded-proto']
      const protocolValue = Array.isArray(forwarded) ? forwarded[0] : forwarded
      const protocol = protocolValue?.split(',')[0]?.trim() === 'https' ? 'https' : 'http'
      res.writeHead(302, { location: ctx.connection.authenticatedUrl(`${protocol}://${host}`) })
      res.end()
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/admin', async handler(req, res) {
      if (req.method !== 'GET') { json(res, 405, { message: '只支持 GET 请求' }); return }
      // 用 Host 持有的 token 换一次性管理入口 code，浏览器再跳 server 消费。
      const credential = await ctx.credentials.resolve(COMPANY_TOKEN_REF)
      if (credential === undefined) {
        res.writeHead(302, { location: '/team/login-page' })
        res.end()
        return
      }
      try {
        const response = await fetch(`${serverURL}/team/api/admin-ticket`, {
          method: 'POST',
          headers: { authorization: `Bearer ${credential.value}` },
        })
        const data = await response.json() as { code?: string }
        if (!response.ok || typeof data.code !== 'string') {
          res.writeHead(302, { location: '/team/login-page' })
          res.end()
          return
        }
        res.writeHead(302, { location: `${serverURL}/team/admin/consume?code=${encodeURIComponent(data.code)}` })
        res.end()
      } catch {
        res.writeHead(302, { location: '/team/login-page' })
        res.end()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/apply', async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { message: '只支持 POST 请求' }); return }
      const requestBody = await body(req)
      if (requestBody === undefined) { json(res, 413, { message: '申请请求过大' }); return }
      try {
        const response = await fetch(`${serverURL}/team/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody as unknown as BodyInit,
        })
        const result = await response.json() as { message?: string }
        json(res, response.status, result)
      } catch {
        json(res, 502, { message: '无法连接团队服务器' })
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/login-page', async handler(_req, res) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(await loginPage)
    } }),
    ctx.webServer.register({ kind: 'exact', path: '/team/login.js', async handler(_req, res) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(await loginScript)
    } }),
  ]
  ctx.effect(() => () => {
    for (const dispose of routes.reverse()) dispose()
  }, 'team-client.remote-routes')

  // 会话同步：官方扩展点，把本地 Session Header/Event 上传到 Team Server。
  registerSessionSync(ctx, serverURL)
  // Git 操作/代码变更同步：监听工具执行，提取元数据上传。
  registerGitSync(ctx, serverURL)
  // 命令行外 git 操作监听：core.hooksPath + 事件队列 + 轮询消费，复用同一上报端点。
  registerGitHooksSync(ctx, serverURL)
}
