# dsh-team-server

English | [中文](README.zh.md)

The Server plugin for the HiveMind team AI collaboration and knowledge-retention platform. It owns authentication, the model gateway, Session replicas, Git records, and the administration console.

See the [repository README](../../README.md) for the complete platform description.

## Responsibilities

- Authentication: PostgreSQL accounts plus Redis-backed Cookie, Bearer, and SSO-ticket sessions
- Model gateway: raw forwarding through `/team/api/model/chat/completions` and `/team/api/model/files*` with the Server credential
- Session replicas: DSH-native artifacts plus a PostgreSQL ownership index, complete-byte validation, and transactional publication
- Git and code changes: `/team/api/git/ops` and `/team/api/git/changes`
- Administration console: `/team/admin` for overview, user and project analytics, accounts, Sessions, sync status, and reconciliation
- Root routing: `/` redirects to administration; only an administrator can reach `/team/workspace`

## Build and package

```powershell
pnpm install --ignore-workspace
pnpm run build
pnpm pack
```

Install the tarball on the Server host with `dsh plugin --profile web add <tarball>`.

## Configuration

Set `TEAM_ROLE=server`, `DB_URL`, `REDIS_URL`, and `DEEPSEEK_API_KEY`; see `.env.server.example`. `TEAM_SESSIONS_ROOT` selects the Server-only Session root. When it is absent, the Server uses `$DSH_HOME/team-server-sessions` and never shares the Client's `$DSH_HOME/sessions`.

Session sync treats uploaded content as a candidate Server replica. The encoded request limit accommodates one 50 MiB binary upload after Base64 expansion plus 64 KiB of JSON metadata; a larger request returns HTTP 413 before JSON parsing. For a delta, the Server streams the stored replica into a temporary file while verifying the base MD5 and calculating the complete MD5, then appends the uploaded bytes without constructing a complete in-memory buffer. The active Session persistence provider parses the temporary candidate before confirmation. Failed validation restores the previous replica. Uploads for one Session run in order, while different Sessions can proceed concurrently.

After publication, the Server stores a content-free Session analytics snapshot in PostgreSQL. The Client asks Git for the repository root and optional `remote.origin.url`; a plain workspace has no project fields and does not enter project analytics. The snapshot contains the project name, Git fields, title, activity timestamps, counts, durations, tool aggregates, and model usage; it excludes the workspace path, messages, tool arguments, command output, and file content. Overview, user, and project pages aggregate these snapshots without reopening every Session file. The Server backfills a missing snapshot when an administrator first loads analytics for an older Session; a Session timeline still reads the native Session artifact and its workspace path on demand.

Start the local Server with `./start-local.ps1`; it listens on port 3081 by default.

Run the focused regression tests with `pnpm test`.
