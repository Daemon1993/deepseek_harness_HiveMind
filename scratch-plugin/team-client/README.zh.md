# dsh-team-client

[English](README.md) | 中文

员工侧插件（HiveMind 团队 AI 研发平台的一部分）。提供登录转发、凭证托管、Session 和 Git 同步与状态 UI。

完整说明见[仓库 README](../../README.zh.md)。

## 职责

- 登录：`/team/login` 转发到 Server；Host 拦截 token 并存入 credentials，token 不进入浏览器。
- 守卫：`/team/session` 恢复登录态；未登录用户跳转到登录页。
- 模型网关：patch 在 `cordis.patch.yml` 中替换 `llm-deepseek` 的 `baseURL` 和 `apiKeyEnv`。
- Session 同步：通过全局生命周期订阅接收浏览器 Agent 的 `session/flush`、创建和释放事件，不订阅高频 `session/event`。连续 flush 会重置同一 Session 的三秒空闲期；同步期间的新触发会在完成后补传最新状态，Session 释放则立即同步。网络错误、HTTP 408/429/5xx 或凭证暂不可用时保留待同步状态并每十秒重试；其他 4xx 停止自动重试，凭证更新或手动同步会重新检查。增量上传的 `409 base-mismatch` 和 `400 content-mismatch` 会立即回退到全量上传。启动只 flush 一次，再把文件同步任务交给调度器。上传采用 `src/sync.ts` 中的 MD5 字节增量和稳定读取校验。
- Git 同步（`src/git-sync.ts`）：导入项目（`POST /team/git/import`，传入目录路径）后运行 `git log`，按每批 100 条上传作者、subject、完整 message、变更文件路径和增删统计。启动时以及每隔 `TEAM_GIT_SCAN_MINUTES`（默认 5）会重新扫描全部已导入仓库，只上传相对上次已同步分支/远端 tip 的新提交（`watched.json` 的 `syncedTips`；重启后仍走增量；Server 按 `(git_remote, commit_hash)` 去重）。`POST /team/git/remove` 取消导入。`GET /team/git/status` 报告扫描进度。不安装 Hook，也不监听工具事件：唯一数据源是 `git log`。
- UI：通过 `sidebar.footer.action` Client Slot 提供账号状态以及 Session/Git 同步胶囊。
- 手动同步：横幅操作调用 `/team/sync/now`，立即执行一次启动同步流程。
- 同步诊断：`/team/sync/status` 返回最近 flush、同步尝试、成功和错误的时间及 Session ID。

## 构建与打包

```powershell
pnpm install
pnpm run build
pnpm pack
```

通过 `dsh plugin --profile web add <tarball>` 安装员工侧 bundle。

## 配置

设置 `TEAM_ROLE=client`，并把 `TEAM_SERVER_URL` 设为 Team LAN 代理 origin（`http://<TEAM_SERVER_LAN_HOST>:<TEAM_SERVER_LAN_PORT>`，端口默认 3082），示例见 `.env.client.example`。不要指向 loopback 的 `127.0.0.1:3081`。可选的 `TEAM_GIT_SCAN_MINUTES` 覆盖 Git 增量扫描间隔（默认 5）。

通过 `./start-local.ps1` 启动本地 Client，默认监听 3080 端口。
