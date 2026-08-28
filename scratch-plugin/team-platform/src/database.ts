import { Pool } from 'pg'
import type { TeamRole, TeamUser } from './types.ts'
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

  private client(): Pool {
    if (!this.pool) throw new Error('team-platform: database is not connected')
    return this.pool
  }
}
