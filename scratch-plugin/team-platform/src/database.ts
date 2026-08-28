import { Pool } from 'pg'
import type { TeamLogRecord, TeamRole, TeamSessionOwner, TeamUser } from './types.ts'
import { readTeamConfig } from './config.ts'

export type TeamAccount = TeamUser & { password: string }

type AccountRow = {
  id: string
  email: string | null
  name: string
  status: TeamUser['status']
  role: TeamRole
  password: string
}

type SessionOwnerRow = {
  session_id: string
  user_id: string
  user_name: string
  email: string | null
  created_at: Date
  last_active_at: Date
}

/** PostgreSQL persistence for team-platform accounts. */
export class TeamDatabase {
  private pool: Pool | undefined

  async connect(): Promise<void> {
    this.pool = new Pool({ connectionString: await readTeamConfig('DB_URL') })
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_users (
        id TEXT PRIMARY KEY,
        email TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'disabled')),
        role TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'reviewer', 'user')),
        password TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
        event TEXT NOT NULL,
        source TEXT NOT NULL,
        request_id TEXT,
        user_id TEXT,
        session_id TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `)
    await this.pool.query("ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unknown'")
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_session_owners (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query(`
      INSERT INTO team_session_owners (session_id, user_id, created_at, last_active_at)
      SELECT session_id, user_id, MIN(occurred_at), MAX(occurred_at)
      FROM team_audit_logs
      WHERE event = 'session.create' AND session_id IS NOT NULL AND user_id IS NOT NULL
      GROUP BY session_id, user_id
      ON CONFLICT (session_id) DO NOTHING
    `)
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_audit_logs_occurred_at_idx ON team_audit_logs (occurred_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_audit_logs_user_id_idx ON team_audit_logs (user_id, occurred_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_audit_logs_session_id_idx ON team_audit_logs (session_id, occurred_at DESC)')
  }

  async close(): Promise<void> {
    await this.pool?.end()
  }

  async loadAccounts(): Promise<TeamAccount[]> {
    const result = await this.client().query<AccountRow>('SELECT id, email, name, status, role, password FROM team_users ORDER BY created_at')
    return result.rows.map(row => {
      const { email, ...account } = row
      return email === null ? account : { ...account, email }
    })
  }

  async saveAccount(account: TeamAccount): Promise<void> {
    await this.client().query(
      `INSERT INTO team_users (id, email, name, status, role, password)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         role = EXCLUDED.role,
         password = EXCLUDED.password,
         updated_at = NOW()`,
      [account.id, account.email ?? null, account.name, account.status, account.role, account.password],
    )
  }

  async deleteAccount(id: string): Promise<boolean> {
    const result = await this.client().query('DELETE FROM team_users WHERE id = $1', [id])
    return result.rowCount === 1
  }

  async recordAuditLog(entry: TeamLogRecord): Promise<void> {
    await this.client().query(
      `INSERT INTO team_audit_logs (level, event, source, request_id, user_id, session_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        entry.level,
        entry.event,
        entry.source,
        entry.requestId ?? null,
        entry.userId ?? null,
        entry.sessionId ?? null,
        JSON.stringify(entry.details ?? {}),
      ],
    )
  }

  async bindSessionOwner(sessionId: string, userId: string): Promise<boolean> {
    const result = await this.client().query(
      `INSERT INTO team_session_owners (session_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET last_active_at = NOW()
       WHERE team_session_owners.user_id = EXCLUDED.user_id
       RETURNING session_id`,
      [sessionId, userId],
    )
    return result.rowCount === 1
  }

  async listSessionOwners(): Promise<TeamSessionOwner[]> {
    const result = await this.client().query<SessionOwnerRow>(
      `SELECT owners.session_id, owners.user_id, users.name AS user_name, users.email,
              owners.created_at, owners.last_active_at
       FROM team_session_owners AS owners
       JOIN team_users AS users ON users.id = owners.user_id
       ORDER BY users.name, owners.last_active_at DESC`,
    )
    return result.rows.map(row => ({
      sessionId: row.session_id,
      userId: row.user_id,
      userName: row.user_name,
      ...(row.email === null ? {} : { email: row.email }),
      createdAt: row.created_at.toISOString(),
      lastActiveAt: row.last_active_at.toISOString(),
    }))
  }

  private client(): Pool {
    if (!this.pool) throw new Error('team-platform: database is not connected')
    return this.pool
  }
}
