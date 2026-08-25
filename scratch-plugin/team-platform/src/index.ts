import { Service, type Context } from "@deepseek-ai/cordis";
import type { TeamServiceApi, TeamUser } from "./types.ts";
import type {} from "@deepseek-ai/dsh-session";

import users from "./users.json" with { type: "json" };

import type {} from "@deepseek-ai/dsh-host-webserver";
import { registerTeamRoutes } from "./routes.ts";

export const name = "team-platform";

type TeamAccount = TeamUser & {
  password: string;
};

/** Team Platform 对外提供的 Service。 */
export class TeamService extends Service implements TeamServiceApi {
  private users = new Map<string, TeamAccount>(
    users.map((user) => [user.id, user as TeamAccount]),
  );
  registerUser(user: TeamUser) {
    console.log(`[team-platform] register user ${user.id}`);
  }
  login(userId: string, password: string): TeamUser | undefined {
    const user = this.users.get(userId);
    if (!user || user.password !== password) return undefined;
    return this.getUser(userId);
  }

  getUser(userId: string): TeamUser | undefined {
    const user = this.users.get(userId);
    if (!user) return undefined;

    const { password: _password, ...teamUser } = user;
    return teamUser;
  }

  private sessionUsers = new Map<string, TeamUser>();
  bindSessionUser(sessionId: string, user: TeamUser) {
    if (this.sessionUsers.has(sessionId)) {
      return;
    }
    this.sessionUsers.set(sessionId, user);
    console.log(`[team-platform] bind session ${sessionId} -> ${user.id}`);
  }
  getSessionUser(sessionId: string): TeamUser | undefined {
    return this.sessionUsers.get(sessionId);
  }

  constructor(ctx: Context) {
    super(ctx, "team");

    ctx.on("session/event", (session, event) => {
      let user = this.getSessionUser(session.id);
      if (!user) {
        user = {
          id: "unknown",
          name: "unknown",
          status: "active",
        };
      }

      console.log("[team-platform][session/event]", {
        sessionId: session.id,
        eventType: event.type,
        userId: user.id,
        userName: user.name,
      });
    });
  }
}



export function apply(ctx: Context) {
  console.log("[team-platform] loaded");
  ctx.plugin(TeamService);

  ctx.inject(["webServer", "team"], (ctx) => {
    console.log("[team-platform] webServer ready");
    ctx.effect(() => registerTeamRoutes(ctx));
  });
}
