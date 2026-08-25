/** A user exposed by the team platform. */
export interface TeamUser {
  id: string
  name: string
  status: 'pending' | 'active' | 'disabled'
}

/** Public operations provided by the team platform service. */
export interface TeamServiceApi {
  bindSessionUser(sessionId: string, user: TeamUser): void
  getSessionUser(sessionId: string): TeamUser | undefined

  registerUser(user: TeamUser): void
  getUser(userId: string): TeamUser | undefined

  login(userId: string, password: string): TeamUser | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    team: TeamServiceApi
  }
}

export {}
