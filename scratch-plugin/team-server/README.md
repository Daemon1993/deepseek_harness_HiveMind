# dsh-team-server

English | [中文](README.zh.md)

The Server plugin for HiveMind, a team AI workbench for multiple employees: unified accounts and model gateway, Session archiving, Git commit collection, and the administration console where usage and development-trajectory data become observable.

See the [repository README](../../README.md) for the complete platform description.

## Responsibilities

- Authentication: PostgreSQL accounts plus Redis-backed Cookie, Bearer, and SSO-ticket sessions
- Model gateway: raw forwarding through `/team/api/model/chat/completions` and `/team/api/model/files*` with the Server credential; responses are passed through without extracting usage
- Session replicas: DSH-native artifacts plus a PostgreSQL ownership index, complete-byte validation, and transactional publication; a lightweight aggregate-only analytics projection is persisted per session (event-level detail stays in the raw Session)
- Git commits: `/team/api/git/changes` stores author identity, subject, full message, changed-file paths, and line stats; the idempotency key is `(git_remote, commit_hash)`; administrators bind Git emails to platform users, and commits are grouped into a stable `team_projects` entity via `project_id`
- Administration console: `/team/admin` — Overview (team pulse: active projects/developers, AI collaboration, health, per-member/per-project/per-tool/per-model rankings), Users (per-member projects, activity and AI cost), Projects (per-remote trend, per-author commit groups, hot directories, commit-type buckets), and Accounts (roles, Git-email bindings, Session sync and reconcile), plus a capabilities/roadmap page
- Root entry: `/` redirects to the administration console, or to the login page when no team session exists. The Server runs the team platform only, so its own DSH workspace UI is not a destination and `/index.html` redirects to the console as well.
- Daily work insights: at 17:20 Asia/Shanghai, active users' Session and Git evidence is summarized by a Server-only LLM and replaces that user's record for the day. Administrators can view or regenerate it from Accounts. Copy `.env.example` to `.env` and set `TEAM_INSIGHT_API_KEY` before enabling generation.

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

Successful publications from one user within a short burst emit only the final `session.sync.completed` operational log. The optional `batch` count reports how many successes it represents; Session content is never logged.

PostgreSQL `BIGINT` Session file sizes are cast to integers at query time before they cross the HTTP status API; the wire protocol always exposes `fileSize` as a JSON number.

Administration Session lists use the latest durable `session/title` as the conversation name, retain the Session id as secondary text, and list every provider/model used by that Session with its request count. Administration responses and pages omit Client-local directories; a Session belongs to a project only when it has a Git remote, which is the displayed project address.

Analytics snapshots carry a projection version. The Server recalculates an older snapshot from its Session replica once, then subsequent administration requests continue reading SQL directly.

After publication, the Server stores a content-free Session analytics snapshot in PostgreSQL. The Client asks Git for the repository root and optional `remote.origin.url`; a plain workspace has no project fields and does not enter project analytics. The snapshot contains the project name, Git fields, title, activity timestamps, counts, durations, tool aggregates, and model usage; it excludes the workspace path, conversation content, tool arguments, command output, and file content.

The Client uploads commit history independently through `git log`. The Server stores hash, author, subject, message, origin remote, changed-file paths, timestamps, and change counts. Overview, User, and Project pages aggregate Session snapshots and Git rows by user id or Git remote without claiming that a commit belongs to a Session. Git-only projects remain visible; commits without an origin contribute only to User analytics. The Server backfills a missing snapshot when an administrator first loads analytics for an older Session; a Session timeline still reads the native Session artifact on demand.

`pnpm start:local` starts both the loopback Server and the route-restricted LAN proxy. `pnpm start:loopback` starts only the Server on `127.0.0.1:3081`. The loopback launcher stops an existing source-launched DSH Web process on port 3081, refuses to stop an unrelated port owner, and never exposes the general DSH Web listener to the LAN.

Set `TEAM_SERVER_LAN_HOST` to one IPv4 address owned by the Server machine and optionally set `TEAM_SERVER_LAN_PORT` (default `3082`), then run `pnpm start:local`. The LAN listener accepts only `/team` and `/team/*`, rejects foreign Host/Origin values and cross-site browser requests, and forwards accepted traffic to `127.0.0.1:3081`. Employee Clients set `TEAM_SERVER_URL` to this LAN origin; they must not call loopback `127.0.0.1:3081`. Allow the configured LAN port through Windows Firewall; keep port 3081 closed to the LAN.

Run the focused regression tests with `pnpm test`.
