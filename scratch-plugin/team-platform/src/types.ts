import type { Service } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** Roles used by the team platform. */
export type TeamRole = 'admin' | 'developer' | 'reviewer' | 'user'

/** A user exposed by the team platform. */
export interface TeamUser {
  id: string
  email?: string
  name: string
  status: 'pending' | 'active' | 'rejected' | 'disabled'
  role: TeamRole
}

/** A user record exposed only through administrator-authorized operations. */
export interface TeamAdminUser extends TeamUser {
  password: string
}

/** Public operations provided by the team platform service. */
export interface TeamServiceApi {
  getUser(userId: string): TeamUser | undefined

  login(userId: string, password: string): Promise<TeamUser | undefined>
  applyForAccess(email: string, name: string): Promise<TeamUser | undefined>
  listAdminUsers(): readonly TeamAdminUser[]
  updateUser(id: string, patch: Pick<TeamUser, 'name' | 'status' | 'role'>, password?: string): Promise<TeamUser | undefined>
  deleteUser(id: string): Promise<boolean>
}

/** Cordis context capabilities required by the team-platform host plugin. */
export type TeamContext = ConstructorParameters<typeof Service>[0] & {
  team: TeamServiceApi
  webServer: WebServer
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    team: TeamServiceApi
  }
}

export {}
