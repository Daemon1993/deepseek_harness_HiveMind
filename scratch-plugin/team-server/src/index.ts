import { Service } from "@deepseek-ai/cordis";
import type { TeamAdminUser, TeamAuditLogInput, TeamCodeChangeInput, TeamContext, TeamGitOpInput, TeamServiceApi, TeamSyncedSession, TeamSyncedSessionDetail, TeamSessionSyncState, TeamUser } from "./types.ts";

import users from "./users.json" with { type: "json" };

import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-credentials";
import { registerTeamRoutes } from "./routes.ts";
import { reconcileSessions } from './reconcile.ts'
import { TeamDatabase, type TeamAccount } from './database.ts'
import { writeTeamLog } from './team-log.ts'

export const name = "team-server";

/** Team Platform 对外提供的 Service。 */
export class TeamService extends Service implements TeamServiceApi {
  private users = new Map<string, TeamAccount>();
  private readonly database = new TeamDatabase()
  async login(userId: string, password: string): Promise<TeamUser | undefined> {
    const user = this.users.get(userId);
    if (!user || user.status !== 'active' || user.password !== password) return undefined;
    return this.getUser(userId);
  }

  async applyForAccess(email: string, name: string): Promise<TeamUser | undefined> {
    const normalizedEmail = email.trim().toLowerCase()
    const normalizedName = name.trim()
    if (!normalizedEmail || !normalizedName || this.users.has(normalizedEmail)) return undefined
    const user: TeamAccount = {
      id: normalizedEmail,
      name: normalizedName,
      status: 'pending',
      role: 'user',
      password: '',
      email: normalizedEmail,
    }
    await this.database.saveAccount(user)
    this.users.set(user.id, user)
    return this.getUser(user.id)
  }

  listAdminUsers(): readonly TeamAdminUser[] {
    return [...this.users.values()].map(user => ({ ...user, role: user.role ?? 'user' }))
  }

  async updateUser(id: string, patch: Pick<TeamUser, 'name' | 'status' | 'role'>, password?: string): Promise<TeamUser | undefined> {
    const user = this.users.get(id)
    if (user === undefined) return undefined
    user.name = patch.name.trim()
    user.status = patch.status
    user.role = patch.role
    if (password !== undefined) user.password = password
    await this.database.saveAccount(user)
    return this.getUser(id)
  }

  async deleteUser(id: string): Promise<boolean> {
    const deleted = await this.database.deleteAccount(id)
    if (deleted) this.users.delete(id)
    return deleted
  }

  async ensureSessionOwner(sessionId: string, userId: string): Promise<'ok' | 'conflict'> {
    return this.database.ensureSessionOwner(sessionId, userId)
  }

  async readSessionMarker(sessionId: string): Promise<{ userId: string; contentMd5: string | null; fileSize: number | null } | undefined> {
    return this.database.readSessionMarker(sessionId)
  }

  async markSessionSynced(sessionId: string, contentMd5: string, fileSize: number): Promise<void> {
    return this.database.markSessionSynced(sessionId, contentMd5, fileSize)
  }

  async clearSessionMarker(sessionId: string): Promise<void> {
    return this.database.clearSessionMarker(sessionId)
  }

  async deleteSyncedSession(sessionId: string): Promise<boolean> {
    return this.database.deleteSyncedSession(sessionId)
  }

  async recordGitOps(userId: string, sessionId: string | undefined, ops: readonly TeamGitOpInput[]): Promise<void> {
    return this.database.recordGitOps(userId, sessionId, ops)
  }

  async recordCodeChanges(userId: string, sessionId: string | undefined, commits: readonly TeamCodeChangeInput[]): Promise<void> {
    return this.database.recordCodeChanges(userId, sessionId, commits)
  }

  async listOwnSessions(userId: string): Promise<readonly TeamSyncedSession[]> {
    return this.database.listOwnSessions(userId)
  }

  async listSyncedSessions(): Promise<readonly TeamSyncedSessionDetail[]> {
    return this.database.listSyncedSessions()
  }

  async listSyncStatus(): Promise<readonly TeamSessionSyncState[]> {
    return this.database.listSyncStatus()
  }

  async audit(entry: TeamAuditLogInput): Promise<void> {
    const record = writeTeamLog(entry)
    try {
      await this.database.recordAuditLog(record)
    } catch (error) {
      writeTeamLog({
        level: 'error',
        event: 'audit.persist.failed',
        details: { message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  getUser(userId: string): TeamUser | undefined {
    const user = this.users.get(userId);
    if (!user) return undefined;

    const { password: _password, ...teamUser } = user;
    return { ...teamUser, role: teamUser.role ?? 'user' };
  }

  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, "team");
  }

  async [Service.init](): Promise<void> {
    await this.database.connect()
    const stored = await this.database.loadAccounts()
    if (stored.length === 0) {
      for (const account of users as TeamAccount[]) await this.database.saveAccount(account)
      this.users = new Map((users as TeamAccount[]).map(account => [account.id, { ...account }]))
    } else {
      this.users = new Map(stored.map(account => [account.id, account]))
    }
    this.ctx.effect(() => async () => this.database.close(), 'team-server.database')
  }
}



export function apply(ctx: TeamContext) {
  writeTeamLog('Plugin loaded')
  ctx.plugin(TeamService);

  ctx.inject(["webServer", "connection", "credentials", "team", "sessionController", "sessionPersistence"], (ctx) => {
    writeTeamLog('Web server ready')
    ctx.effect(() => registerTeamRoutes(ctx as TeamContext));
    // 启动对账：以文件为权威修正 PG 归属/标记漂移。
    void reconcileSessions(ctx as TeamContext).catch(error => {
      writeTeamLog({ level: 'warn', event: 'session.reconcile.failed', message: error instanceof Error ? error.message : String(error) })
    });
  });
}
