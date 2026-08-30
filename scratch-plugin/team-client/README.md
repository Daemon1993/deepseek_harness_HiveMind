# DSH Team Client

Employee-side DeepSeek Harness plugin for the Team Platform. It contributes the account state and sign-out controls through the official `sidebar.footer.action` Client Slot.

The Local DSH owns its login surface: `/team/login-page` serves the plugin's own login page, `/team/login` validates against the team server and keeps the issued token in Host credentials, and `/team/session` reports the in-memory state (rehydrated from the server after a Host restart). `/team/admin` redirects to the server's admin console. Session headers and events are pushed to the server's `/team/api/sync/*` endpoints through the official `session/created` / `session/event` extension points.

When no team server routes are installed, the sidebar reports `服务未连接` instead of redirecting. This allows the Client Module discovery and rendering to be verified independently.

## Build and package

```powershell
pnpm install
pnpm run build
pnpm pack
```

Install the resulting tarball into the Web profile with `dsh plugin --profile web add <tarball>`.
