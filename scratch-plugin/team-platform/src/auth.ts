import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type RedisClientType } from 'redis'
import { readTeamConfig } from './config.ts'
import { writeTeamLog } from './team-log.ts'

const COOKIE_NAME = 'team_session'
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60

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
