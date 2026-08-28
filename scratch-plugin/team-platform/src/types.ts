import type { Service } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

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

/** One structured, non-sensitive team-platform audit record. */
export interface TeamAuditLogInput {
  level: 'info' | 'warn' | 'error'
  event: string
  message?: string
  requestId?: string
  userId?: string
  sessionId?: string
  details?: Record<string, string | number | boolean | null>
}

/** Fully rendered operational record written to stdout and audit storage. */
export interface TeamLogRecord extends TeamAuditLogInput {
  timestamp: string
  service: 'team-platform'
  source: string
  message: string
}

/** Session-create fields accepted from the DSH browser RPC. */
export interface TeamSessionCreateRequest {
  workspaceId?: string
  cwd?: string
  sessionId?: string
  agentPreset?: string
}

/** Session-create value returned to the DSH browser RPC. */
export interface TeamSessionCreateValue {
  sessionId: string
  agentPreset?: string
}

/** One persisted Session ownership row shown to administrators. */
export interface TeamSessionOwner {
  sessionId: string
  userId: string
  userName: string
  email?: string
  createdAt: string
  lastActiveAt: string
  title?: string
  cwd?: string
  updatedAt?: number
  blank?: boolean
}

/** Minimal official Session Controller face used by the team gateway. */
export interface TeamSessionController {
  create(request: TeamSessionCreateRequest): Promise<TeamSessionCreateValue>
  list(request: Record<never, never>, signal: AbortSignal): Promise<{
    items: readonly {
      sessionId: string
      updatedAt: number
      blank: boolean
      cwd?: string
      projections?: { values: Record<string, unknown> }
    }[]
  }>
  inspect(sessionId: string, signal?: AbortSignal): Promise<{ events: readonly unknown[] }>
}

/** Public operations provided by the team platform service. */
export interface TeamServiceApi {
  getUser(userId: string): TeamUser | undefined

  login(userId: string, password: string): Promise<TeamUser | undefined>
  applyForAccess(email: string, name: string): Promise<TeamUser | undefined>
  listAdminUsers(): readonly TeamAdminUser[]
  updateUser(id: string, patch: Pick<TeamUser, 'name' | 'status' | 'role'>, password?: string): Promise<TeamUser | undefined>
  deleteUser(id: string): Promise<boolean>
  bindSessionOwner(sessionId: string, userId: string): Promise<boolean>
  listSessionOwners(): Promise<readonly TeamSessionOwner[]>
  audit(entry: TeamAuditLogInput): Promise<void>
}

/** Cordis context capabilities required by the team-platform host plugin. */
export type TeamContext = ConstructorParameters<typeof Service>[0] & {
  team: TeamServiceApi
  webServer: WebServer
  connection: HostConnectionHandle
  sessionController: TeamSessionController
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    team: TeamServiceApi
  }
}

export {}
