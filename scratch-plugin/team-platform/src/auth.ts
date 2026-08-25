import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { TeamUser } from './types.ts'

const COOKIE_NAME = 'team_session'
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export class AuthSessions {
  private readonly users = new Map<string, TeamUser>()

  create(user: TeamUser): string {
    const token = randomUUID()
    this.users.set(token, user)
    return token
  }

  getUser(req: IncomingMessage): TeamUser | undefined {
    const token = this.readCookie(req)
    return token ? this.users.get(token) : undefined
  }

  delete(req: IncomingMessage): void {
    const token = this.readCookie(req)
    if (token) this.users.delete(token)
  }

  loginCookie(token: string): string {
    return [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${MAX_AGE_SECONDS}`,
    ].join('; ')
  }

  logoutCookie(): string {
    return [
      `${COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ].join('; ')
  }

  private readCookie(req: IncomingMessage): string | undefined {
    const cookies = req.headers.cookie?.split(';') ?? []

    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split('=', 2)
      if (name === COOKIE_NAME) return value
    }

    return undefined
  }
}