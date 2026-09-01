import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import type { TeamAuditLogRow, TeamCodeChange, TeamCodeChangeInput, TeamGitEmailBinding, TeamLogRecord, TeamProjectAuthor, TeamRole, TeamSessionAnalytics, TeamSyncedSession, TeamSyncedSessionDetail, TeamSessionSyncState, TeamUser } from './types.ts'
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
  password_hash: string
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
    // 建表幂等：旧表残留需在外部一次性清理，connect 不做破坏性操作。
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_users (
        id TEXT PRIMARY KEY,
        email TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'disabled')),
        role TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'reviewer', 'user')),
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // 旧部署的 password 列改名为 password_hash；存量明文由服务启动时哈希后回写。
    await this.pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'team_users' AND column_name = 'password'
        ) THEN
          ALTER TABLE team_users RENAME COLUMN password TO password_hash;
        END IF;
      END $$;
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
        message TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `)
    // 已建表的部署缺少 message 列，读审计日志会整条查询失败。
    await this.pool.query('ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS message TEXT')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_audit_logs_occurred_at_idx ON team_audit_logs (occurred_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_audit_logs_user_id_idx ON team_audit_logs (user_id, occurred_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_audit_logs_session_id_idx ON team_audit_logs (session_id, occurred_at DESC)')
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
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_session_analytics_project_idx ON team_session_analytics (git_remote, project_root, last_active_at DESC)')
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_git_ops (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
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
        cwd TEXT,
        git_remote TEXT NOT NULL DEFAULT '',
        commit_hash TEXT,
        author_name TEXT,
        author_email TEXT,
        subject TEXT,
        message TEXT,
        changed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
        files_changed INT,
        insertions INT,
        deletions INT,
        commit_time BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query('CREATE UNIQUE INDEX IF NOT EXISTS team_code_changes_project_hash_idx ON team_code_changes (git_remote, commit_hash)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_code_changes_author_idx ON team_code_changes (author_email, commit_time DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_code_changes_cwd_idx ON team_code_changes (cwd, created_at DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS team_code_changes_project_idx ON team_code_changes (git_remote, commit_time DESC)')
    // 归属改为作者邮箱：旧部署残留的 user_id 列不再使用，删列回收。
    await this.pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'team_code_changes' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE team_code_changes DROP COLUMN user_id;
        END IF;
      END $$;
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        git_remote TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // 为 Commit 增加稳定 Project 实体关联；git_remote 仍保留作为 Git 原始信息。
    await this.pool.query('ALTER TABLE team_code_changes ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES team_projects(id) ON DELETE SET NULL')
    await this.pool.query('ALTER TABLE team_session_analytics ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES team_projects(id) ON DELETE SET NULL')
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_git_emails (
        email TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // 为既有 git_remote 建立 Project 并回填 project_id；幂等，可安全重复。
    await this.backfillProjects()
  }

  async close(): Promise<void> {
    await this.pool?.end()
  }

  /** Derive a display name for a project from its git remote. */
  private deriveProjectName(gitRemote: string): string {
    return gitRemote.replace(/[/\\]$/u, '').split(/[/\\:]/u).at(-1)?.replace(/\.git$/u, '') || gitRemote
  }

  /**
   * Resolve the stable Project id for a git remote, creating the Project row on
   * first sight. Empty git_remote yields no project (null).
   */
  async ensureProject(gitRemote: string): Promise<string | null> {
    if (gitRemote === '') return null
    const existing = await this.client().query<{ id: string }>('SELECT id FROM team_projects WHERE git_remote = $1', [gitRemote])
    if (existing.rowCount === 1) return existing.rows[0]!.id
    const id = randomUUID()
    await this.client().query(
      'INSERT INTO team_projects (id, name, git_remote) VALUES ($1, $2, $3) ON CONFLICT (git_remote) DO NOTHING',
      [id, this.deriveProjectName(gitRemote), gitRemote],
    )
    const after = await this.client().query<{ id: string }>('SELECT id FROM team_projects WHERE git_remote = $1', [gitRemote])
    return after.rowCount === 1 ? after.rows[0]!.id : null
  }

  /**
   * Backfill Project rows and project_id for all git remotes already persisted
   * in commits and session analytics. Runs once at startup; idempotent.
   */
  private async backfillProjects(): Promise<void> {
    const remotes = await this.client().query<{ git_remote: string }>(`
      SELECT DISTINCT git_remote FROM team_code_changes WHERE git_remote <> ''
      UNION
      SELECT DISTINCT git_remote FROM team_session_analytics WHERE git_remote <> ''
    `)
    for (const { git_remote } of remotes.rows) {
      const projectId = await this.ensureProject(git_remote)
      if (projectId === null) continue
      await this.client().query('UPDATE team_code_changes SET project_id = $1 WHERE git_remote = $2', [projectId, git_remote])
      await this.client().query('UPDATE team_session_analytics SET project_id = $1 WHERE git_remote = $2', [projectId, git_remote])
    }
  }

  async loadAccounts(): Promise<TeamAccount[]> {
    const result = await this.client().query<AccountRow>('SELECT id, email, name, status, role, password_hash FROM team_users ORDER BY created_at')
    return result.rows.map(row => {
      const { email, password_hash, ...account } = row
      const base = { ...account, password: password_hash }
      return email === null ? base : { ...base, email }
    })
  }

  async saveAccount(account: TeamAccount): Promise<void> {
    await this.client().query(
      `INSERT INTO team_users (id, email, name, status, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         role = EXCLUDED.role,
         password_hash = EXCLUDED.password_hash,
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
      `INSERT INTO team_audit_logs (level, event, source, request_id, user_id, session_id, message, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        entry.level,
        entry.event,
        entry.source,
        entry.requestId ?? null,
        entry.userId ?? null,
        entry.sessionId ?? null,
        entry.message,
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
    const projectId = snapshot.gitRemote === undefined ? null : await this.ensureProject(snapshot.gitRemote)
    await this.client().query(
      `INSERT INTO team_session_analytics (session_id, project_id, project_name, project_root, git_remote, title, last_active_at, metrics)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET
         project_id = COALESCE(team_session_analytics.project_id, EXCLUDED.project_id),
         project_name = EXCLUDED.project_name,
         project_root = EXCLUDED.project_root,
         git_remote = EXCLUDED.git_remote,
         title = EXCLUDED.title,
         last_active_at = EXCLUDED.last_active_at,
         metrics = EXCLUDED.metrics,
         updated_at = NOW()`,
      [snapshot.sessionId, projectId, snapshot.projectName ?? null, snapshot.projectRoot ?? null, snapshot.gitRemote ?? null, snapshot.title, snapshot.lastActiveAt, JSON.stringify(snapshot.metrics)],
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
  async recordGitOps(userId: string, ops: readonly { action: string; cwd?: string; failed?: boolean }[]): Promise<void> {
    for (const op of ops) {
      await this.client().query(
        `INSERT INTO team_git_ops (user_id, action, cwd, failed) VALUES ($1, $2, $3, $4)`,
        [userId, op.action, op.cwd ?? null, op.failed ?? false],
      )
    }
  }

  /** Record one batch of code-change summaries; (git_remote, commit_hash) is the idempotency key. */
  async recordCodeChanges(commits: readonly TeamCodeChangeInput[]): Promise<void> {
    if (commits.length === 0) return
    // 按唯一 git_remote 解析稳定 Project 实体，为整批写入统一的 project_id。
    const projectByRemote = new Map<string, string | null>()
    for (const commit of commits) {
      const remote = commit.gitRemote ?? ''
      if (!projectByRemote.has(remote)) projectByRemote.set(remote, await this.ensureProject(remote))
    }
    // 批量插入：一次网络往返写入整批，避免逐条 INSERT 跨网络延迟放大。
    await this.client().query(
      `INSERT INTO team_code_changes (
         project_id, cwd, git_remote, commit_hash, author_name, author_email,
         subject, message, changed_files, files_changed, insertions, deletions, commit_time
       )
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::text[], $8::text[], $9::jsonb[], $10::int[], $11::int[], $12::int[], $13::bigint[]
       )
       ON CONFLICT (git_remote, commit_hash) DO UPDATE SET
         project_id = COALESCE(team_code_changes.project_id, EXCLUDED.project_id),
         cwd = COALESCE(team_code_changes.cwd, EXCLUDED.cwd),
         author_name = COALESCE(team_code_changes.author_name, EXCLUDED.author_name),
         author_email = COALESCE(team_code_changes.author_email, EXCLUDED.author_email),
         subject = COALESCE(team_code_changes.subject, EXCLUDED.subject),
         message = COALESCE(team_code_changes.message, EXCLUDED.message),
         changed_files = CASE WHEN team_code_changes.changed_files = '[]'::jsonb THEN EXCLUDED.changed_files ELSE team_code_changes.changed_files END,
         commit_time = COALESCE(team_code_changes.commit_time, EXCLUDED.commit_time)`,
      [
        commits.map(commit => projectByRemote.get(commit.gitRemote ?? '') ?? null),
        commits.map(commit => commit.cwd ?? null),
        commits.map(commit => commit.gitRemote ?? ''),
        commits.map(commit => commit.commitHash),
        commits.map(commit => commit.authorName ?? null),
        commits.map(commit => commit.authorEmail ?? null),
        commits.map(commit => commit.subject ?? null),
        commits.map(commit => commit.message ?? null),
        commits.map(commit => JSON.stringify(commit.changedFiles ?? [])),
        commits.map(commit => commit.files),
        commits.map(commit => commit.insertions),
        commits.map(commit => commit.deletions),
        commits.map(commit => commit.time ?? Date.now()),
      ],
    )
  }

  /** Read commit summaries in the requested time range, newest first. */
  async listCodeChanges(since: number): Promise<TeamCodeChange[]> {
    const result = await this.client().query<{
      user_id: string | null
      user_name: string | null
      commit_hash: string
      git_remote: string | null
      author_name: string | null
      author_email: string | null
      subject: string | null
      message: string | null
      changed_files: string[]
      files_changed: number | null
      insertions: number | null
      deletions: number | null
      commit_time: string | null
      created_at: Date
    }>(
      `SELECT changes.commit_hash, NULLIF(changes.git_remote, '') AS git_remote,
              changes.author_name, changes.author_email, changes.subject,
              changes.message, changes.changed_files, changes.files_changed,
              changes.insertions, changes.deletions, changes.commit_time,
              changes.created_at, bindings.user_id, users.name AS user_name
       FROM team_code_changes AS changes
       LEFT JOIN team_git_emails AS bindings ON bindings.email = changes.author_email
       LEFT JOIN team_users AS users ON users.id = bindings.user_id
       WHERE COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) >= $1
       ORDER BY COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) DESC`,
      [since],
    )
    return result.rows.map(row => ({
      ...(row.user_id === null ? {} : { userId: row.user_id }),
      ...(row.user_name === null ? {} : { userName: row.user_name }),
      commitHash: row.commit_hash,
      ...(row.git_remote === null ? {} : { gitRemote: row.git_remote }),
      ...(row.author_name === null ? {} : { authorName: row.author_name }),
      ...(row.author_email === null ? {} : { authorEmail: row.author_email }),
      ...(row.subject === null ? {} : { subject: row.subject }),
      ...(row.message === null ? {} : { message: row.message }),
      changedFiles: row.changed_files,
      files: row.files_changed ?? 0,
      insertions: row.insertions ?? 0,
      deletions: row.deletions ?? 0,
      time: row.commit_time === null ? row.created_at.getTime() : Number(row.commit_time),
    }))
  }

  /** One project's commit rows in the requested window, newest first. */
  async listCommitsByProject(gitRemote: string, since: number): Promise<TeamCodeChange[]> {
    const result = await this.client().query<{
      user_id: string | null
      user_name: string | null
      commit_hash: string
      author_name: string | null
      author_email: string | null
      subject: string | null
      message: string | null
      changed_files: string[]
      files_changed: number | null
      insertions: number | null
      deletions: number | null
      commit_time: string | null
      created_at: Date
    }>(
      `SELECT changes.commit_hash, NULLIF(changes.git_remote, '') AS git_remote,
              changes.author_name, changes.author_email, changes.subject,
              changes.message, changes.changed_files, changes.files_changed,
              changes.insertions, changes.deletions, changes.commit_time,
              changes.created_at, bindings.user_id, users.name AS user_name
       FROM team_code_changes AS changes
       LEFT JOIN team_git_emails AS bindings ON bindings.email = changes.author_email
       LEFT JOIN team_users AS users ON users.id = bindings.user_id
       WHERE changes.git_remote = $1
         AND COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) >= $2
       ORDER BY COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) DESC`,
      [gitRemote, since],
    )
    return result.rows.map(row => ({
      ...(row.user_id === null ? {} : { userId: row.user_id }),
      ...(row.user_name === null ? {} : { userName: row.user_name }),
      commitHash: row.commit_hash,
      ...(row.author_name === null ? {} : { authorName: row.author_name }),
      ...(row.author_email === null ? {} : { authorEmail: row.author_email }),
      ...(row.subject === null ? {} : { subject: row.subject }),
      ...(row.message === null ? {} : { message: row.message }),
      changedFiles: row.changed_files,
      files: row.files_changed ?? 0,
      insertions: row.insertions ?? 0,
      deletions: row.deletions ?? 0,
      time: row.commit_time === null ? row.created_at.getTime() : Number(row.commit_time),
    }))
  }

  /** Daily commit buckets for one project, oldest first. */
  async projectCommitTrend(gitRemote: string, since: number): Promise<{ day: string; commits: number; insertions: number; deletions: number }[]> {
    const result = await this.client().query<{ day: Date; commits: string; insertions: string; deletions: string }>(
      `SELECT to_timestamp(COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) / 1000)::date AS day,
              count(*) AS commits, COALESCE(sum(changes.insertions), 0) AS insertions,
              COALESCE(sum(changes.deletions), 0) AS deletions
       FROM team_code_changes AS changes
       WHERE changes.git_remote = $1
         AND COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) >= $2
       GROUP BY day ORDER BY day`,
      [gitRemote, since],
    )
    return result.rows.map(row => ({ day: row.day.toISOString().slice(0, 10), commits: Number(row.commits), insertions: Number(row.insertions), deletions: Number(row.deletions) }))
  }

  /**
   * Per-contributor commit aggregates for one project, most commits first.
   * Git emails bound via team_git_emails are merged into their platform user;
   * unbound authors stay as independent Git authors.
   */
  async projectAuthorStats(gitRemote: string, since: number): Promise<TeamProjectAuthor[]> {
    const result = await this.client().query<{
      user_id: string | null
      user_name: string | null
      author_email: string
      author_name: string | null
      emails: string[]
      commits: string
      insertions: string
      deletions: string
    }>(
      `SELECT bindings.user_id, users.name AS user_name,
              min(changes.author_email) AS author_email,
              COALESCE(users.name, min(changes.author_name)) AS author_name,
              array_agg(DISTINCT changes.author_email) AS emails,
              count(*) AS commits,
              COALESCE(sum(changes.insertions), 0) AS insertions,
              COALESCE(sum(changes.deletions), 0) AS deletions
       FROM team_code_changes AS changes
       LEFT JOIN team_git_emails AS bindings ON bindings.email = changes.author_email
       LEFT JOIN team_users AS users ON users.id = bindings.user_id
       WHERE changes.git_remote = $1
         AND COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) >= $2
         AND changes.author_email IS NOT NULL
       GROUP BY COALESCE(bindings.user_id, changes.author_email), bindings.user_id, users.name
       ORDER BY commits DESC`,
      [gitRemote, since],
    )
    return result.rows.map(row => ({
      ...(row.user_id === null ? {} : { userId: row.user_id, userName: row.user_name ?? row.user_id }),
      authorEmail: row.author_email,
      authorName: row.author_name ?? row.author_email,
      emails: row.emails.filter(email => email !== null && email !== ''),
      commits: Number(row.commits),
      insertions: Number(row.insertions),
      deletions: Number(row.deletions),
    }))
  }

  /** All changed file paths for one project in the window (deduplicated). */
  async projectChangedFiles(gitRemote: string, since: number): Promise<string[]> {
    const result = await this.client().query<{ path: string }>(
      `SELECT DISTINCT path
       FROM team_code_changes AS changes, jsonb_array_elements_text(changes.changed_files) AS path
       WHERE changes.git_remote = $1
         AND COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) >= $2`,
      [gitRemote, since],
    )
    return result.rows.map(row => row.path)
  }

  /** One user's commit rows in the requested window, newest first. */
  async listCommitsByUser(userId: string, since: number): Promise<TeamCodeChange[]> {
    const result = await this.client().query<{
      commit_hash: string
      git_remote: string | null
      author_name: string | null
      author_email: string | null
      subject: string | null
      message: string | null
      changed_files: string[]
      files_changed: number | null
      insertions: number | null
      deletions: number | null
      commit_time: string | null
      created_at: Date
    }>(
      `SELECT changes.commit_hash, NULLIF(changes.git_remote, '') AS git_remote,
              changes.author_name, changes.author_email, changes.subject,
              changes.message, changes.changed_files, changes.files_changed,
              changes.insertions, changes.deletions, changes.commit_time,
              changes.created_at
       FROM team_code_changes AS changes
       WHERE changes.author_email IN (SELECT email FROM team_git_emails WHERE user_id = $1)
         AND COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) >= $2
       ORDER BY COALESCE(changes.commit_time, EXTRACT(EPOCH FROM changes.created_at) * 1000) DESC`,
      [userId, since],
    )
    return result.rows.map(row => ({
      userId,
      commitHash: row.commit_hash,
      ...(row.git_remote === null ? {} : { gitRemote: row.git_remote }),
      ...(row.author_name === null ? {} : { authorName: row.author_name }),
      ...(row.author_email === null ? {} : { authorEmail: row.author_email }),
      ...(row.subject === null ? {} : { subject: row.subject }),
      ...(row.message === null ? {} : { message: row.message }),
      changedFiles: row.changed_files,
      files: row.files_changed ?? 0,
      insertions: row.insertions ?? 0,
      deletions: row.deletions ?? 0,
      time: row.commit_time === null ? row.created_at.getTime() : Number(row.commit_time),
    }))
  }

  /** One user's session analytics snapshots, newest activity first. */
  async listAnalyticsByUser(userId: string): Promise<TeamSessionAnalytics[]> {
    const result = await this.client().query<{ session_id: string; project_name: string | null; git_remote: string | null; title: string; last_active_at: string; metrics: TeamSessionAnalytics['metrics'] }>(
      `SELECT analytics.session_id, analytics.project_name, analytics.git_remote,
              analytics.title, analytics.last_active_at, analytics.metrics
       FROM team_session_analytics AS analytics
       JOIN team_session_log AS log ON log.session_id = analytics.session_id
       WHERE log.user_id = $1
       ORDER BY analytics.last_active_at DESC`,
      [userId],
    )
    return result.rows.map(row => ({
      sessionId: row.session_id,
      ...(row.project_name === null ? {} : { projectName: row.project_name }),
      ...(row.git_remote === null ? {} : { gitRemote: row.git_remote }),
      title: row.title,
      lastActiveAt: Number(row.last_active_at),
      metrics: row.metrics,
    }))
  }

  /** One project's session analytics snapshots, newest activity first. */
  async listAnalyticsByProject(gitRemote: string): Promise<TeamSessionAnalytics[]> {
    const result = await this.client().query<{ session_id: string; project_name: string | null; git_remote: string | null; title: string; last_active_at: string; metrics: TeamSessionAnalytics['metrics'] }>(
      `SELECT session_id, project_name, git_remote, title, last_active_at, metrics
       FROM team_session_analytics
       WHERE git_remote = $1
       ORDER BY last_active_at DESC`,
      [gitRemote],
    )
    return result.rows.map(row => ({
      sessionId: row.session_id,
      ...(row.project_name === null ? {} : { projectName: row.project_name }),
      ...(row.git_remote === null ? {} : { gitRemote: row.git_remote }),
      title: row.title,
      lastActiveAt: Number(row.last_active_at),
      metrics: row.metrics,
    }))
  }

  /** List Git-email → platform-user bindings for author attribution. */
  async listGitEmailBindings(): Promise<TeamGitEmailBinding[]> {

    const result = await this.client().query<{ email: string; user_id: string; user_name: string }>(
      `SELECT bindings.email, bindings.user_id, users.name AS user_name
       FROM team_git_emails AS bindings
       JOIN team_users AS users ON users.id = bindings.user_id
       ORDER BY bindings.email`,
    )
    return result.rows.map(row => ({ email: row.email, userId: row.user_id, userName: row.user_name }))
  }

  /** Bind one Git email to a platform user; false when the user does not exist. */
  async bindGitEmail(userId: string, email: string): Promise<boolean> {
    const user = await this.client().query('SELECT 1 FROM team_users WHERE id = $1', [userId])
    if (user.rowCount !== 1) return false
    await this.client().query(
      `INSERT INTO team_git_emails (email, user_id) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [email, userId],
    )
    return true
  }

  /** Remove one Git-email binding. */
  async unbindGitEmail(email: string): Promise<boolean> {
    const result = await this.client().query('DELETE FROM team_git_emails WHERE email = $1', [email])
    return result.rowCount === 1
  }

  /** Read recent audit rows, newest first, optionally filtered by event. */
  async listAuditLogs(options: { since: number; events?: readonly string[]; limit: number }): Promise<TeamAuditLogRow[]> {
    const result = await this.client().query<{ occurred_at: Date; event: string; level: TeamAuditLogRow['level']; user_id: string | null; message: string }>(
      `SELECT occurred_at, event, level, user_id, COALESCE(message, event) AS message
       FROM team_audit_logs
       WHERE occurred_at >= to_timestamp($1 / 1000.0)
         AND (cardinality($2::text[]) = 0 OR event = ANY($2::text[]))
       ORDER BY occurred_at DESC
       LIMIT $3`,
      [options.since, options.events ?? [], options.limit],
    )
    return result.rows.map(row => ({
      occurredAt: row.occurred_at.toISOString(),
      event: row.event,
      level: row.level,
      userId: row.user_id,
      message: row.message,
    }))
  }

  private client(): Pool {
    if (!this.pool) throw new Error('team-server: database is not connected')
    return this.pool
  }
}
