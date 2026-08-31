# dsh-team-server

服务器侧插件（HiveMind 团队 AI 协作与知识沉淀平台的一部分）。负责认证、模型网关、会话归档、Git 记录与管理后台。

完整说明见 [../../README.md](../../README.md)（GitHub 首页）。

## 职责

- 认证：PG 账号 + Redis 会话（Cookie / Bearer / SSO ticket 三套分治）
- 模型网关：`/team/api/model/chat/completions` + `/team/api/model/files*`（raw 透传、换真 key）
- 会话归档：DSH 原生文件 + PG 索引，全量后首帧校验，拒绝清标记
- Git/代码变更：`/team/api/git/ops` `/changes`
- 管理后台：`/team/admin`（总览/账号/会话/同步状态/对账）
- 根路径 `/` 重定向到后台，工作台仅 admin 可达（`/team/workspace`）

## 构建与打包

```powershell
pnpm install --ignore-workspace
pnpm run build
pnpm pack
```

安装：`dsh plugin --profile web add <tarball>`（服务器机器）。

## 配置

`TEAM_ROLE=server` + `DB_URL` / `REDIS_URL` / `TEAM_SESSIONS_ROOT` / `DEEPSEEK_API_KEY`（见 `.env.server.example`）。

启动：`./start-local.ps1`（默认 3081 端口）。
