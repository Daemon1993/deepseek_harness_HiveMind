import { Service } from "@deepseek-ai/cordis";
import type { TeamAdminUser, TeamContext, TeamServiceApi, TeamUser } from "./types.ts";

import users from "./users.json" with { type: "json" };

import type {} from "@deepseek-ai/dsh-host-webserver";
import { registerTeamRoutes } from "./routes.ts";
import { TeamDatabase, type TeamAccount } from './database.ts'

export const name = "team-platform";

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
    this.ctx.effect(() => async () => this.database.close(), 'team-platform.database')
  }
}



export function apply(ctx: TeamContext) {
  console.log("[team-platform] loaded");
  ctx.plugin(TeamService);

  ctx.inject(["webServer", "team"], (ctx) => {
    console.log("[team-platform] webServer ready");
    ctx.effect(() => registerTeamRoutes(ctx));
  });
}
