import { Pool } from 'pg'
import type { TeamCodeChange, TeamCodeChangeInput, TeamLogRecord, TeamRole, TeamSessionAnalytics, TeamSyncedSession, TeamSyncedSessionDetail, TeamSessionSyncState, TeamUser } from './types.ts'
import { readTeamConfig } from './config.ts'

export type TeamAccount = TeamUser & { password: string }

type TeamSyncStatusRow = {
  session_id: string
  user_id: string
  user_name: string
  updated_at: Date
}

type AccountRow = {
  id: string
  email: string | null
  name: string
  status: TeamUser['status']
  role: TeamRole
  password: string
}

type SyncedSessionRow = {
  session_id: string
  user_id: string
  user_name: string
  email: string | null
  created_at: Date
  updated_at: Date
}

/** PostgreSQL persistence for team-server accounts. */
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
    // 旧归属表（/api/session/create 路径）已废弃：统一到 team_session_log，清理残留。
    await this.pool.query('DROP TABLE IF EXISTS team_session_owners')
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_session_log (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
        content_md5 TEXT,
        file_size BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query('ALTER TABLE team_session_log ADD COLUMN IF NOT EXISTS content_md5 TEXT')
    await this.pool.query('ALTER TABLE team_session_log ADD COLUMN IF NOT EXISTS file_size BIGINT')
    await this.pool.query('ALTER TABLE team_session_log DROP COLUMN IF EXISTS next_seq')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_session_log_user_id_idx ON team_session_log (user_id, updated_at DESC)')
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_session_analytics (
        session_id TEXT PRIMARY KEY REFERENCES team_session_log(session_id) ON DELETE CASCADE,
        project_name TEXT,
        project_root TEXT,
        git_remote TEXT,
        title TEXT NOT NULL,
        last_active_at BIGINT NOT NULL,
        metrics JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query('ALTER TABLE team_session_analytics ADD COLUMN IF NOT EXISTS project_root TEXT')
    await this.pool.query('ALTER TABLE team_session_analytics ADD COLUMN IF NOT EXISTS git_remote TEXT')
    await this.pool.query('ALTER TABLE team_session_analytics ADD COLUMN IF NOT EXISTS project_name TEXT')
    await this.pool.query('ALTER TABLE team_session_analytics DROP COLUMN IF EXISTS cwd')
    await this.pool.query('DROP INDEX IF EXISTS team_session_analytics_cwd_idx')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_session_analytics_project_idx ON team_session_analytics (git_remote, project_root, last_active_at DESC)')
    // 旧的事件行存储废弃：事件本体改为 server 自己的 DSH 原生会话文件，
    // 这里只保留归属；client 重启后会全量补传，旧数据不需要迁移。
    await this.pool.query('DROP TABLE IF EXISTS team_session_events')
    await this.pool.query('DROP TABLE IF EXISTS team_sessions')
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_git_ops (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
        session_id TEXT,
        cwd TEXT,
        action TEXT NOT NULL,
        failed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_git_ops_user_idx ON team_git_ops (user_id, created_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_git_ops_cwd_idx ON team_git_ops (cwd, created_at DESC)')
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_code_changes (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
        session_id TEXT,
        cwd TEXT,
        git_remote TEXT,
        commit_hash TEXT UNIQUE,
        subject TEXT,
        files_changed INT,
        insertions INT,
        deletions INT,
        commit_time BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query('ALTER TABLE team_code_changes ADD COLUMN IF NOT EXISTS git_remote TEXT')
    await this.pool.query('ALTER TABLE team_code_changes ADD COLUMN IF NOT EXISTS subject TEXT')
    await this.pool.query('ALTER TABLE team_code_changes ADD COLUMN IF NOT EXISTS commit_time BIGINT')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_code_changes_cwd_idx ON team_code_changes (cwd, created_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_code_changes_user_idx ON team_code_changes (user_id, created_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_code_changes_project_idx ON team_code_changes (git_remote, commit_time DESC)')
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

  /** Record one synced Session's owner; idempotent, and rejects a Session already
   * owned by a different user. The event log itself lives in DSH-native files. */
  async ensureSessionOwner(sessionId: string, userId: string): Promise<'ok' | 'conflict'> {
    const result = await this.client().query(
      `INSERT INTO team_session_log (session_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET updated_at = NOW()
       WHERE team_session_log.user_id = EXCLUDED.user_id
       RETURNING session_id`,
      [sessionId, userId],
    )
    return result.rowCount === 1 ? 'ok' : 'conflict'
  }

  /** Record one uploaded Session's content hash and size; also refreshes the last-sync time. */
  async markSessionSynced(sessionId: string, contentMd5: string, fileSize: number): Promise<void> {
    await this.client().query(
      'UPDATE team_session_log SET content_md5 = $2, file_size = $3, updated_at = NOW() WHERE session_id = $1',
      [sessionId, contentMd5, fileSize],
    )
  }

  /** 清空同步标记（如拒绝入库时），避免"有标记无文件"的分歧。 */
  async clearSessionMarker(sessionId: string): Promise<void> {
    await this.client().query(
      'UPDATE team_session_log SET content_md5 = NULL, file_size = NULL, updated_at = NOW() WHERE session_id = $1',
      [sessionId],
    )
  }

  /** List Session rows visible to one authenticated user, newest activity first. */
  async listOwnSessions(userId: string): Promise<TeamSyncedSession[]> {
    const result = await this.client().query<{ session_id: string; content_md5: string | null; file_size: number | null; created_at: Date; updated_at: Date }>(
      `SELECT session_id, content_md5, file_size::integer AS file_size, created_at, updated_at FROM team_session_log
       WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    )
    return result.rows.map(row => ({
      sessionId: row.session_id,
      ...(row.content_md5 === null ? {} : { contentMd5: row.content_md5 }),
      ...(row.file_size === null ? {} : { fileSize: row.file_size }),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }))
  }

  /** Delete one synced Session ownership row (file no longer exists). */
  async deleteSyncedSession(sessionId: string): Promise<boolean> {
    const result = await this.client().query('DELETE FROM team_session_log WHERE session_id = $1', [sessionId])
    return result.rowCount === 1
  }

  /** Read one synced Session's ownership and stored file marker. */
  async readSessionMarker(sessionId: string): Promise<{ userId: string; contentMd5: string | null; fileSize: number | null; projectRoot?: string; gitRemote?: string } | undefined> {
    const result = await this.client().query<{ user_id: string; content_md5: string | null; file_size: number | null; project_root: string | null; git_remote: string | null }>(
      `SELECT log.user_id, log.content_md5, log.file_size::integer AS file_size, analytics.project_root, analytics.git_remote
       FROM team_session_log AS log LEFT JOIN team_session_analytics AS analytics USING (session_id)
       WHERE log.session_id = $1`,
      [sessionId],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return { userId: row.user_id, contentMd5: row.content_md5, fileSize: row.file_size, ...(row.project_root === null ? {} : { projectRoot: row.project_root }), ...(row.git_remote === null ? {} : { gitRemote: row.git_remote }) }
  }

  /** All synced Session ownership rows with their owning user, newest activity first. */
  async listSyncedSessions(): Promise<TeamSyncedSessionDetail[]> {
    const result = await this.client().query<SyncedSessionRow>(
      `SELECT sessions.session_id, sessions.user_id, users.name AS user_name, users.email,
              sessions.created_at, sessions.updated_at
       FROM team_session_log AS sessions
       JOIN team_users AS users ON users.id = sessions.user_id
       ORDER BY sessions.updated_at DESC`,
    )
    return result.rows.map(row => ({
      sessionId: row.session_id,
      userId: row.user_id,
      userName: row.user_name,
      ...(row.email === null ? {} : { email: row.email }),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }))
  }

  /** All synced Sessions with their owner and sync cursor, newest activity first. */
  async listSyncStatus(): Promise<TeamSessionSyncState[]> {
    const result = await this.client().query<TeamSyncStatusRow>(
      `SELECT sessions.session_id, sessions.user_id, users.name AS user_name,
              sessions.updated_at
       FROM team_session_log AS sessions
       JOIN team_users AS users ON users.id = sessions.user_id
       ORDER BY users.name, sessions.updated_at DESC`,
    )
    return result.rows.map(row => ({
      sessionId: row.session_id,
      userId: row.user_id,
      userName: row.user_name,
      updatedAt: row.updated_at.toISOString(),
    }))
  }

  /** Upsert the content-free analytics projection produced after a successful sync. */
  async saveSessionAnalytics(snapshot: TeamSessionAnalytics): Promise<void> {
    await this.client().query(
      `INSERT INTO team_session_analytics (session_id, project_name, project_root, git_remote, title, last_active_at, metrics)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET
         project_name = EXCLUDED.project_name,
         project_root = EXCLUDED.project_root,
         git_remote = EXCLUDED.git_remote,
         title = EXCLUDED.title,
         last_active_at = EXCLUDED.last_active_at,
         metrics = EXCLUDED.metrics,
         updated_at = NOW()`,
      [snapshot.sessionId, snapshot.projectName ?? null, snapshot.projectRoot ?? null, snapshot.gitRemote ?? null, snapshot.title, snapshot.lastActiveAt, JSON.stringify(snapshot.metrics)],
    )
  }

  /** Read all persisted analytics snapshots without opening Session files. */
  async listSessionAnalytics(): Promise<TeamSessionAnalytics[]> {
    const result = await this.client().query<{ session_id: string; project_name: string | null; project_root: string | null; git_remote: string | null; title: string; last_active_at: string; metrics: TeamSessionAnalytics['metrics'] }>(
      'SELECT session_id, project_name, project_root, git_remote, title, last_active_at, metrics FROM team_session_analytics ORDER BY last_active_at DESC',
    )
    return result.rows.map(row => ({
      sessionId: row.session_id,
      ...(row.project_name === null ? {} : { projectName: row.project_name }),
      ...(row.project_root === null ? {} : { projectRoot: row.project_root }),
      ...(row.git_remote === null ? {} : { gitRemote: row.git_remote }),
      title: row.title,
      lastActiveAt: Number(row.last_active_at),
      metrics: row.metrics,
    }))
  }

  /** Record one batch of Git operation metadata. */
  async recordGitOps(userId: string, sessionId: string | undefined, ops: readonly { action: string; cwd?: string; failed?: boolean }[]): Promise<void> {
    for (const op of ops) {
      await this.client().query(
        `INSERT INTO team_git_ops (user_id, session_id, action, cwd, failed) VALUES ($1, $2, $3, $4, $5)`,
        [userId, sessionId ?? null, op.action, op.cwd ?? null, op.failed ?? false],
      )
    }
  }

  /** Record one batch of code-change summaries; commit hash is the idempotency key. */
  async recordCodeChanges(userId: string, sessionId: string | undefined, commits: readonly TeamCodeChangeInput[]): Promise<void> {
    for (const commit of commits) {
      await this.client().query(
        `INSERT INTO team_code_changes (
           user_id, session_id, cwd, git_remote, commit_hash, subject,
           files_changed, insertions, deletions, commit_time
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (commit_hash) DO UPDATE SET
           session_id = COALESCE(team_code_changes.session_id, EXCLUDED.session_id),
           cwd = COALESCE(team_code_changes.cwd, EXCLUDED.cwd),
           git_remote = COALESCE(team_code_changes.git_remote, EXCLUDED.git_remote),
           subject = COALESCE(team_code_changes.subject, EXCLUDED.subject),
           commit_time = COALESCE(team_code_changes.commit_time, EXCLUDED.commit_time)`,
        [
          userId,
          sessionId ?? null,
          commit.cwd ?? null,
          commit.gitRemote ?? null,
          commit.commitHash,
          commit.subject ?? null,
          commit.files,
          commit.insertions,
          commit.deletions,
          commit.time ?? Date.now(),
        ],
      )
    }
  }

  /** Read commit summaries in the requested time range, newest first. */
  async listCodeChanges(since: number): Promise<TeamCodeChange[]> {
    const result = await this.client().query<{
      user_id: string
      user_name: string
      commit_hash: string
      git_remote: string | null
      subject: string | null
      files_changed: number | null
      insertions: number | null
      deletions: number | null
      commit_time: string | null
      created_at: Date
    }>(
      `SELECT changes.user_id, users.name AS user_name, changes.commit_hash,
              changes.git_remote, changes.subject, changes.files_changed,
              changes.insertions, changes.deletions, changes.commit_time,
              changes.created_at
       FROM team_code_changes AS changes
       JOIN team_users AS users ON users.id = changes.user_id
       WHERE COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) >= $1
       ORDER BY COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) DESC`,
      [since],
    )
    return result.rows.map(row => ({
      userId: row.user_id,
      userName: row.user_name,
      commitHash: row.commit_hash,
      ...(row.git_remote === null ? {} : { gitRemote: row.git_remote }),
      ...(row.subject === null ? {} : { subject: row.subject }),
      files: row.files_changed ?? 0,
      insertions: row.insertions ?? 0,
      deletions: row.deletions ?? 0,
      time: row.commit_time === null ? row.created_at.getTime() : Number(row.commit_time),
    }))
  }

  private client(): Pool {
    if (!this.pool) throw new Error('team-server: database is not connected')
    return this.pool
  }
}
