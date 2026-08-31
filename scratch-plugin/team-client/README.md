# dsh-team-client

员工侧插件（HiveMind 团队平台的一部分）。提供登录转发、凭证托管、会话/Git 同步与状态 UI。

完整说明见 [../../README.md](../../README.md)（GitHub 首页）。

## 职责

- 登录：`/team/login` 转发到 server，**token 被 Host 拦截存入 credentials，不进浏览器**
- 守卫：`/team/session` 水合恢复登录态；未登录跳登录页
- 模型走网关：patch 替换 llm-deepseek 的 `baseURL` + `apiKeyEnv`（`cordis.patch.yml`）
- 会话同步：`session/flush` 触发，md5 字节增量 + 读稳定性校验（`src/sync.ts`）
- Git 同步：监听 `tools/post-execute` 提取元数据（`src/git-sync.ts`）
- UI：同步横幅 / 账号状态（`sidebar.footer.action` Client Slot）

## 构建与打包

```powershell
pnpm install
pnpm run build
pnpm pack
```

安装：`dsh plugin --profile web add <tarball>`（员工机器）。

## 配置

`TEAM_ROLE=client` + `TEAM_SERVER_URL=http://127.0.0.1:3081`（见 `.env.client.example`）。

启动：`./start-local.ps1`（默认 3080 端口）。
