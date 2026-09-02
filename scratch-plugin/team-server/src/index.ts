import { Service } from "@deepseek-ai/cordis";
import type { TeamAdminUser, TeamAuditLogInput, TeamAuditLogRow, TeamCodeChange, TeamCodeChangeInput, TeamContext, TeamGitEmailBinding, TeamGitOpInput, TeamProjectAuthor, TeamProjectTrend, TeamServiceApi, TeamSessionAnalytics, TeamSyncedSession, TeamSyncedSessionDetail, TeamSessionSyncState, TeamUser } from "./types.ts";

import users from "./users.json" with { type: "json" };

import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-credentials";
import { registerTeamRoutes } from "./routes.ts";
import { reconcileSessions } from './reconcile.ts'
import { TeamDatabase, type TeamAccount } from './database.ts'
import { dailyEvidence, summarizeDailyEvidence } from './daily-insights.ts'
import { hashPassword, isPasswordHash, verifyPassword } from './passwords.ts'
import { writeTeamLog } from './team-log.ts'

export const name = "team-server";

/** Team Platform 对外提供的 Service。 */
export class TeamService extends Service implements TeamServiceApi {
  private users = new Map<string, TeamAccount>();
  private readonly database = new TeamDatabase()
  async login(userId: string, password: string): Promise<TeamUser | undefined> {
    const user = this.users.get(userId);
    if (!user || user.status !== 'active' || !await verifyPassword(password, user.password)) return undefined;
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
    return [...this.users.values()].map(({ password, ...user }) => ({ ...user, role: user.role ?? 'user', hasPassword: password.length > 0 }))
  }

  async updateUser(id: string, patch: Pick<TeamUser, 'name' | 'status' | 'role'>, password?: string): Promise<TeamUser | undefined> {
    const user = this.users.get(id)
    if (user === undefined) return undefined
    user.name = patch.name.trim()
    user.status = patch.status
    user.role = patch.role
    if (password !== undefined) user.password = await hashPassword(password)
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

  async readSessionMarker(sessionId: string): Promise<{ userId: string; contentMd5: string | null; fileSize: number | null; projectRoot?: string; gitRemote?: string } | undefined> {
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

  async recordGitOps(userId: string, ops: readonly TeamGitOpInput[]): Promise<void> {
    return this.database.recordGitOps(userId, ops)
  }

  async recordCodeChanges(commits: readonly TeamCodeChangeInput[]): Promise<void> {
    return this.database.recordCodeChanges(commits)
  }

  async listGitEmailBindings(): Promise<readonly TeamGitEmailBinding[]> {
    return this.database.listGitEmailBindings()
  }

  async bindGitEmail(userId: string, email: string): Promise<boolean> {
    return this.database.bindGitEmail(userId, email)
  }

  async unbindGitEmail(email: string): Promise<boolean> {
    return this.database.unbindGitEmail(email)
  }

  async listCommitsByProject(gitRemote: string, since: number): Promise<readonly TeamCodeChange[]> {
    return this.database.listCommitsByProject(gitRemote, since)
  }

  async projectCommitTrend(gitRemote: string, since: number): Promise<readonly TeamProjectTrend[]> {
    return this.database.projectCommitTrend(gitRemote, since)
  }

  async projectAuthorStats(gitRemote: string, since: number): Promise<readonly TeamProjectAuthor[]> {
    return this.database.projectAuthorStats(gitRemote, since)
  }

  async projectChangedFiles(gitRemote: string, since: number): Promise<readonly string[]> {
    return this.database.projectChangedFiles(gitRemote, since)
  }

  async listCommitsByUser(userId: string, since: number): Promise<readonly TeamCodeChange[]> {
    return this.database.listCommitsByUser(userId, since)
  }

  async listAnalyticsByUser(userId: string): Promise<readonly TeamSessionAnalytics[]> {
    return this.database.listAnalyticsByUser(userId)
  }

  async listAnalyticsByProject(gitRemote: string): Promise<readonly TeamSessionAnalytics[]> {
    return this.database.listAnalyticsByProject(gitRemote)
  }

  async listCodeChanges(since: number) {
    return this.database.listCodeChanges(since)
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

  async saveSessionAnalytics(snapshot: TeamSessionAnalytics): Promise<void> {
    return this.database.saveSessionAnalytics(snapshot)
  }

  async listSessionAnalytics(): Promise<readonly TeamSessionAnalytics[]> {
    return this.database.listSessionAnalytics()
  }

  async getDailyInsight(userId: string, workDate: string) {
    return this.database.getDailyInsight(userId, workDate)
  }

  async generateDailyInsight(userId: string, workDate: string) {
    const user = this.getUser(userId)
    if (user === undefined) throw new Error(`unknown user ${userId}`)
    const start = new Date(`${workDate}T00:00:00+08:00`).getTime()
    if (!Number.isFinite(start)) throw new Error('workDate must use YYYY-MM-DD')
    const evidence = dailyEvidence(await this.listAnalyticsByUser(userId), await this.listCommitsByUser(userId, start), start, start + 86_400_000)
    const generated = await summarizeDailyEvidence(user, workDate, evidence)
    const insight = { userId, workDate, evidence, ...generated, generatedAt: new Date().toISOString() }
    await this.database.saveDailyInsight(insight)
    await this.audit({ level: 'info', event: 'daily-insight.generated', userId, model: generated.model, message: `Daily work insight generated for ${workDate}` })
    return insight
  }

  async generateDailyInsights(workDate: string): Promise<number> {
    const users = this.listAdminUsers().filter(user => user.status === 'active')
    await Promise.all(users.map(user => this.generateDailyInsight(user.id, workDate)))
    return users.length
  }

  async listAuditLogs(options: { since: number; events?: readonly string[]; limit: number }): Promise<readonly TeamAuditLogRow[]> {
    return this.database.listAuditLogs(options)
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
    // 首次播种或升级遗留明文：任何非哈希的已设置密码都先哈希再落库，
    // 数据库与内存中的账号此后只保存哈希。种子账号不携带密码，
    // 落库前统一补为空哨兵（未设置），由管理员激活后分配密码。
    const accounts = [...stored]
    const storedIds = new Set(stored.map(account => account.id))
    for (const seed of users as Omit<TeamAccount, 'password'>[]) {
      if (storedIds.has(seed.id)) continue
      const account = { ...seed, password: '' }
      await this.database.saveAccount(account)
      accounts.push(account)
    }
    for (const account of accounts) {
      if (account.password.length === 0 || isPasswordHash(account.password)) continue
      account.password = await hashPassword(account.password)
      await this.database.saveAccount(account)
    }
    this.users = new Map(accounts.map(account => [account.id, { ...account }]))
    this.ctx.effect(() => async () => this.database.close(), 'team-server.database')
  }
}



export function apply(ctx: TeamContext) {
  writeTeamLog('Plugin loaded')
  ctx.plugin(TeamService);

  ctx.inject(["webServer", "connection", "credentials", "team", "sessionController", "sessionPersistence"], (ctx) => {
    writeTeamLog('Web server ready')
    ctx.effect(() => registerTeamRoutes(ctx as TeamContext));
    let scheduledDate: string | undefined
    const runScheduledInsights = (): void => {
      const now = new Date()
      const workDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
      if (now.getHours() !== 17 || now.getMinutes() !== 20 || scheduledDate === workDate) return
      scheduledDate = workDate
      void ctx.team.generateDailyInsights(workDate).then(count => ctx.team.audit({ level: 'info', event: 'daily-insight.scheduled', message: `Daily insights generated users=${String(count)}` })).catch(error => ctx.team.audit({ level: 'error', event: 'daily-insight.failed', message: error instanceof Error ? error.message : String(error) }))
    }
    const schedule = setInterval(runScheduledInsights, 30_000)
    ctx.effect(() => () => clearInterval(schedule), 'team-server.daily-insights-schedule')
    // 启动对账：以文件为权威修正 PG 归属/标记漂移。
    void reconcileSessions(ctx as TeamContext).catch(error => {
      writeTeamLog({ level: 'warn', event: 'session.reconcile.failed', message: error instanceof Error ? error.message : String(error) })
    });
  });
}
