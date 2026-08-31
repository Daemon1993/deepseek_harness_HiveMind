import type { Service } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionMetrics } from './session-metrics.ts'

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

/** One structured, non-sensitive team-server audit record. */
export interface TeamAuditLogInput {
  level: 'info' | 'warn' | 'error'
  event: string
  message?: string
  requestId?: string
  userId?: string
  sessionId?: string
  model?: string
  details?: Record<string, string | number | boolean | null>
}

/** Fully rendered operational record written to stdout and audit storage. */
export interface TeamLogRecord extends TeamAuditLogInput {
  timestamp: string
  service: 'team-server'
  source: string
  message: string
}

/** Minimal official Session Controller face used by the team gateway. */
export interface TeamSessionController {
  list(request: Record<never, never>, signal: AbortSignal): Promise<{
    items: readonly {
      sessionId: string
      updatedAt: number
      blank: boolean
      cwd?: string
      projections?: { values: Record<string, unknown> }
    }[]
  }>
  inspect(sessionId: string, signal?: AbortSignal): Promise<{
    meta: SessionHeader
    events: readonly SessionEvent[]
  }>
}

/** One Session row synced to the team server, as returned to its owner. */
export interface TeamSyncedSession {
  sessionId: string
  contentMd5?: string
  fileSize?: number
  createdAt: string
  updatedAt: string
}

/** One synced Session ownership row with its owning user, as served to administrators. */
export interface TeamSyncedSessionDetail {
  sessionId: string
  userId: string
  userName: string
  email?: string
  createdAt: string
  updatedAt: string
}

/** One synced Session's sync state, as served to administrators. */
export interface TeamSessionSyncState {
  sessionId: string
  userId: string
  userName: string
  updatedAt: string
}

/** SQL-backed, content-free analytics snapshot for one synced Session. */
export interface TeamSessionAnalytics {
  sessionId: string
  projectName?: string
  projectRoot?: string
  gitRemote?: string
  title: string
  lastActiveAt: number
  metrics: SessionMetrics
}

/** One Git operation record uploaded by a Local DSH. */
export interface TeamGitOpInput {
  action: string
  cwd?: string
  time?: number
  failed?: boolean
}

/** One code-change summary uploaded by a Local DSH. */
export interface TeamCodeChangeInput {
  commitHash: string
  cwd?: string
  files: number
  insertions: number
  deletions: number
  time?: number
}

/** Public operations provided by the team platform service. */
export interface TeamServiceApi {
  getUser(userId: string): TeamUser | undefined

  login(userId: string, password: string): Promise<TeamUser | undefined>
  applyForAccess(email: string, name: string): Promise<TeamUser | undefined>
  listAdminUsers(): readonly TeamAdminUser[]
  updateUser(id: string, patch: Pick<TeamUser, 'name' | 'status' | 'role'>, password?: string): Promise<TeamUser | undefined>
  deleteUser(id: string): Promise<boolean>
  ensureSessionOwner(sessionId: string, userId: string): Promise<'ok' | 'conflict'>
  readSessionMarker(sessionId: string): Promise<{ userId: string; contentMd5: string | null; fileSize: number | null; projectRoot?: string; gitRemote?: string } | undefined>
  markSessionSynced(sessionId: string, contentMd5: string, fileSize: number): Promise<void>
  clearSessionMarker(sessionId: string): Promise<void>
  deleteSyncedSession(sessionId: string): Promise<boolean>
  recordGitOps(userId: string, sessionId: string | undefined, ops: readonly TeamGitOpInput[]): Promise<void>
  recordCodeChanges(userId: string, sessionId: string | undefined, commits: readonly TeamCodeChangeInput[]): Promise<void>
  listOwnSessions(userId: string): Promise<readonly TeamSyncedSession[]>
  listSyncedSessions(): Promise<readonly TeamSyncedSessionDetail[]>
  listSyncStatus(): Promise<readonly TeamSessionSyncState[]>
  saveSessionAnalytics(snapshot: TeamSessionAnalytics): Promise<void>
  listSessionAnalytics(): Promise<readonly TeamSessionAnalytics[]>
  audit(entry: TeamAuditLogInput): Promise<void>
}

/** Cordis context capabilities required by the team-server Host plugin. */
export type TeamContext = ConstructorParameters<typeof Service>[0] & {
  team: TeamServiceApi
  webServer: WebServer
  connection: HostConnectionHandle
  credentials: CredentialProvider
  sessionController: TeamSessionController
  sessionPersistence: SessionPersistence
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    team: TeamServiceApi
  }
}

export {}
