# DSH Team Server

Server-side DeepSeek Harness bundle for the Team Platform. It owns authentication, PostgreSQL persistence, Redis login sessions, management routes, administration UI, and Session analytics.

The package owns its Host implementation, unified operational logging, authentication, database access, routes, analytics, and static administration/login sources. Its tarball does not declare `dsh.client` and has no runtime or build-time dependency on the old plugin package.

The ignored local `.env` is never included in tarballs. Deployed servers must provide `DB_URL` and `REDIS_URL` through their environment or a separately managed local file.

## Build and package

```powershell
pnpm install --ignore-workspace
pnpm run build
pnpm pack
```

Install the resulting tarball into the server Web profile with `dsh plugin --profile web add <tarball>`.
