# dsh-team-client

English | [中文](README.zh.md)

The employee-side plugin for the HiveMind team AI collaboration and knowledge-retention platform. It provides login forwarding, credential storage, Session and Git synchronization, and status UI.

See the [repository README](../../README.md) for the complete platform description.

## Responsibilities

- Login: `/team/login` forwards to the Server; the Host intercepts the token and stores it in credentials, so it never enters the browser.
- Guard: `/team/session` restores authenticated state; unauthenticated users are redirected to the login page.
- Model gateway: the patch replaces the `llm-deepseek` `baseURL` and `apiKeyEnv` in `cordis.patch.yml`.
- Session synchronization: global lifecycle subscriptions receive browser Agent `session/flush`, creation, and disposal events without subscribing to high-frequency `session/event` traffic. Repeated flushes restart one Session's three-second idle period. A trigger received during synchronization schedules the latest state afterward, while Session disposal synchronizes immediately. Network failures, HTTP 408/429/5xx responses, and temporarily unavailable credentials keep the pending state and retry every ten seconds. Other 4xx responses stop automatic retries until credentials change or a user requests synchronization. Incremental-upload `409 base-mismatch` and `400 content-mismatch` responses immediately retry as complete uploads. Startup flushes once and gives file synchronization to the scheduler. Uploads use MD5 byte increments and stable-read checks in `src/sync.ts`.
- Git synchronization (`src/git-sync.ts`): importing a project (`POST /team/git/import` with a directory path) runs `git log` to extract its full commit history and uploads it in batches. The Client re-scans all imported repositories on startup and every `TEAM_GIT_SCAN_MINUTES` (default 10), uploading only commits after the last-synced hash (a per-repository cursor persisted in `watched.json`; the Server deduplicates by `(git_remote, commit_hash)`). No hooks or tool-event listeners are installed: `git log` is the only data source.
- UI: synchronization banner and account state through the `sidebar.footer.action` Client Slot.
- Manual synchronization: the banner action calls `/team/sync/now` and immediately runs the startup synchronization path.
- Diagnostics: `/team/sync/status` returns the latest flush, attempt, success, and error timestamps and Session ids.

## Build and package

```powershell
pnpm install
pnpm run build
pnpm pack
```

Install the employee bundle with `dsh plugin --profile web add <tarball>`.

## Configuration

Set `TEAM_ROLE=client` and `TEAM_SERVER_URL=http://127.0.0.1:3081`; see `.env.client.example`.

Start the local Client with `./start-local.ps1`; it listens on port 3080 by default.
