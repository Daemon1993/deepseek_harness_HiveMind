/** LAN reverse proxy that exposes only the HiveMind team routes. */
import { createServer, request as requestUpstream, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'

const UPSTREAM = new URL('http://127.0.0.1:3081')
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'authorization', 'content-type', 'cookie', 'if-none-match', 'user-agent'])

/** Configuration for the restricted LAN proxy. */
export interface LanProxyConfig {
  /** One LAN IPv4 address owned by this machine. */
  host: string
  /** TCP port exposed to the LAN. */
  port: number
}

function reject(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${message}\n`)
}

function publicAuthority(config: LanProxyConfig): string {
  return `${config.host}:${String(config.port)}`
}

function isTrustedBrowserRequest(request: IncomingMessage, config: LanProxyConfig): boolean {
  const authority = publicAuthority(config)
  if (request.headers.host !== authority) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  return origin === undefined || origin === `http://${authority}`
}

/** Create a streaming HTTP proxy that rejects every route outside `/team`. */
export function createLanProxy(config: LanProxyConfig): Server {
  if (isIP(config.host) !== 4) throw new Error(`TEAM_SERVER_LAN_HOST must be one IPv4 address, got ${JSON.stringify(config.host)}`)
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error(`TEAM_SERVER_LAN_PORT must be an integer from 1 to 65535, got ${String(config.port)}`)
  }
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', UPSTREAM)
    const startedAt = Date.now()
    response.once('finish', () => {
      if (response.statusCode >= 400) {
        console.warn(`[team-lan-proxy] ${incoming.method ?? 'UNKNOWN'} ${url.pathname} ${String(response.statusCode)} ${String(Date.now() - startedAt)}ms`)
      }
    })
    if (url.pathname !== '/team' && !url.pathname.startsWith('/team/')) {
      reject(response, 404, 'Only /team routes are available')
      return
    }
    if (url.pathname === '/team/workspace') {
      reject(response, 404, 'The DSH workspace is available only on the Server host')
      return
    }
    if (!isTrustedBrowserRequest(incoming, config)) {
      reject(response, 403, 'Untrusted Host or Origin')
      return
    }
    const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => FORWARDED_REQUEST_HEADERS.has(name)))
    headers.host = UPSTREAM.host
    if (headers.origin !== undefined) headers.origin = UPSTREAM.origin
    const forward = (body?: Buffer): void => {
      if (body !== undefined) headers['content-length'] = String(body.byteLength)
      const upstream = requestUpstream(new URL(incoming.url ?? '/', UPSTREAM), {
        method: incoming.method,
        headers,
      }, (upstreamResponse) => {
      const responseHeaders = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) => !HOP_BY_HOP.has(name)))
      const status = upstreamResponse.statusCode ?? 502
      if (status < 400) {
        response.writeHead(status, responseHeaders)
        upstreamResponse.pipe(response)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      upstreamResponse.on('data', (chunk: Buffer) => {
        if (size < 8_192) chunks.push(chunk.subarray(0, 8_192 - size))
        size += chunk.byteLength
      })
      upstreamResponse.on('end', () => {
        const body = Buffer.concat(chunks)
        const detail = body.toString('utf8').replaceAll(/[\r\n]+/gu, ' ').trim()
        console.warn(`[team-lan-proxy] upstream rejected ${incoming.method ?? 'UNKNOWN'} ${url.pathname} status=${String(status)}${detail === '' ? ' empty-body' : ` detail=${detail}`}`)
        response.writeHead(status, { ...responseHeaders, 'content-length': String(body.byteLength) })
        response.end(body)
      })
      })
      upstream.on('error', (error) => {
        if (!response.headersSent) reject(response, 502, `Team Server unavailable: ${error.message}`)
        else response.destroy(error)
      })
      incoming.on('aborted', () => upstream.destroy())
      if (body === undefined) incoming.pipe(upstream)
      else upstream.end(body)
    }
    if (incoming.method === 'POST' && url.pathname === '/team/api/sync/session') {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        const body = Buffer.concat(chunks)
        const requestHeaders = new Headers()
        for (const [name, value] of Object.entries(headers)) {
          if (value !== undefined) requestHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        void fetch(new URL(incoming.url ?? '/', UPSTREAM), { method: 'POST', headers: requestHeaders, body }).then(async upstreamResponse => {
          const responseBody = Buffer.from(await upstreamResponse.arrayBuffer())
          const responseHeaders = Object.fromEntries([...upstreamResponse.headers].filter(([name]) => !HOP_BY_HOP.has(name)))
          response.writeHead(upstreamResponse.status, { ...responseHeaders, 'content-length': String(responseBody.byteLength) })
          response.end(responseBody)
        }).catch((error: unknown) => reject(response, 502, `Team Server unavailable: ${error instanceof Error ? error.message : String(error)}`))
      })
      return
    }
    forward()
  })
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))
  server.on('upgrade', (_request, socket) => socket.destroy())
  return server
}

async function main(): Promise<void> {
  const host = process.env.TEAM_SERVER_LAN_HOST ?? ''
  const port = Number(process.env.TEAM_SERVER_LAN_PORT ?? '3082')
  const server = createLanProxy({ host, port })
  await new Promise<void>((resolve, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(port, host, resolve)
  })
  console.log(`team LAN proxy: http://${publicAuthority({ host, port })}/team/ -> ${UPSTREAM.origin}/team/`)
  const close = (): void => {
    server.close(() => process.exit(0))
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
