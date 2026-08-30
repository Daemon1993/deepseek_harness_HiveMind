import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type RedisClientType } from 'redis'
import { readTeamConfig } from './config.ts'
import { writeTeamLog } from './team-log.ts'

const COOKIE_NAME = 'team_session'
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const CLIENT_TOKEN_PREFIX = 'team:client-token:'
const ADMIN_TICKET_PREFIX = 'team:admin-ticket:'
const ADMIN_TICKET_TTL_SECONDS = 30

type SessionRecord = {
  userId: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export class AuthSessions {
  private constructor(private readonly client: RedisClientType<{}, {}, {}, 2>) {}

  static async connect(): Promise<AuthSessions> {
    const client = createClient({ url: await readTeamConfig('REDIS_URL'), RESP: 2 })
    client.on('error', error => {
      writeTeamLog({
        level: 'error',
        event: 'redis.connection.failed',
        details: { message: error instanceof Error ? error.message : String(error) },
      })
    })
    await client.connect()
    writeTeamLog('Redis connected')
    return new AuthSessions(client)
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close()
  }

  async start(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
    await this.remove(req)
    const token = randomUUID()
    const now = new Date()
    const session: SessionRecord = {
      userId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MAX_AGE_SECONDS * 1000).toISOString(),
    }
    await this.client.set(this.key(token), JSON.stringify(session), { EX: MAX_AGE_SECONDS })
    res.setHeader('set-cookie', this.cookie(token, MAX_AGE_SECONDS))
  }

  async userId(req: IncomingMessage): Promise<string | undefined> {
    const token = this.readCookie(req)
    if (!token) return undefined
    const key = this.key(token)
    if (await this.client.type(key) !== 'string') return undefined
    const value = await this.client.get(key)
    if (!value) return undefined

    const session: unknown = JSON.parse(value)
    if (typeof session !== 'object' || session === null
      || !('userId' in session) || typeof session.userId !== 'string'
      || !('createdAt' in session) || typeof session.createdAt !== 'string'
      || !('expiresAt' in session) || typeof session.expiresAt !== 'string') return undefined

    const remainingSeconds = Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000)
    if (remainingSeconds <= 0) {
      await this.client.del(key)
      return undefined
    }

    const updated: SessionRecord = {
      userId: session.userId,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      expiresAt: session.expiresAt,
    }
    await this.client.set(key, JSON.stringify(updated), { EX: remainingSeconds })
    return session.userId
  }

  async end(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.remove(req)
    res.setHeader('set-cookie', this.cookie('', 0))
  }

  /** Create a bearer token used by one Local DSH Host. */
  async startClient(userId: string): Promise<string> {
    const token = randomUUID()
    const now = new Date()
    const session: SessionRecord = {
      userId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MAX_AGE_SECONDS * 1000).toISOString(),
    }
    await this.client.set(`${CLIENT_TOKEN_PREFIX}${token}`, JSON.stringify(session), { EX: MAX_AGE_SECONDS })
    return token
  }

  /** Resolve the authenticated Local DSH user from its bearer token. */
  async clientUserId(req: IncomingMessage): Promise<string | undefined> {
    const authorization = req.headers.authorization
    if (authorization === undefined || !authorization.startsWith('Bearer ')) return undefined
    const token = authorization.slice('Bearer '.length).trim()
    if (token.length === 0) return undefined
    const key = `${CLIENT_TOKEN_PREFIX}${token}`
    const value = await this.client.get(key)
    if (value === null) return undefined
    const session: unknown = JSON.parse(value)
    if (typeof session !== 'object' || session === null
      || !('userId' in session) || typeof session.userId !== 'string'
      || !('expiresAt' in session) || typeof session.expiresAt !== 'string') return undefined
    const remainingSeconds = Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000)
    if (remainingSeconds <= 0) {
      await this.client.del(key)
      return undefined
    }
    return session.userId
  }

  /** Create a one-time admin console entry code bound to the given user. */
  async issueAdminTicket(userId: string): Promise<string> {
    const code = randomUUID()
    const record = {
      userId,
      expiresAt: new Date(Date.now() + ADMIN_TICKET_TTL_SECONDS * 1000).toISOString(),
    }
    await this.client.set(`${ADMIN_TICKET_PREFIX}${code}`, JSON.stringify(record), { EX: ADMIN_TICKET_TTL_SECONDS })
    return code
  }

  /** Redeem one admin entry code exactly once; returns the bound user or undefined. */
  async consumeAdminTicket(code: string): Promise<string | undefined> {
    const key = `${ADMIN_TICKET_PREFIX}${code}`
    const value = await this.client.get(key)
    if (value === null) return undefined
    await this.client.del(key)
    const record: unknown = JSON.parse(value)
    if (typeof record !== 'object' || record === null
      || !('userId' in record) || typeof record.userId !== 'string'
      || !('expiresAt' in record) || typeof record.expiresAt !== 'string') return undefined
    if (Date.parse(record.expiresAt) <= Date.now()) return undefined
    return record.userId
  }

  private cookie(token: string, maxAge: number): string {
    return [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ].join('; ')
  }

  private async remove(req: IncomingMessage): Promise<void> {
    const token = this.readCookie(req)
    if (token) await this.client.del(this.key(token))
  }

  private readCookie(req: IncomingMessage): string | undefined {
    const cookies = req.headers.cookie?.split(';') ?? []

    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split('=', 2)
      if (name === COOKIE_NAME) return value
    }

    return undefined
  }

  private key(token: string): string {
    return `team:session:${token}`
  }

}
