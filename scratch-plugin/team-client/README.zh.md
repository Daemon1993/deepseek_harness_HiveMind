# dsh-team-client

[English](README.md) | 中文

员工侧插件（HiveMind 团队 AI 协作与知识沉淀平台的一部分）。提供登录转发、凭证托管、Session 和 Git 同步与状态 UI。

完整说明见[仓库 README](../../README.zh.md)。

## 职责

- 登录：`/team/login` 转发到 Server；Host 拦截 token 并存入 credentials，token 不进入浏览器。
- 守卫：`/team/session` 恢复登录态；未登录用户跳转到登录页。
- 模型网关：patch 在 `cordis.patch.yml` 中替换 `llm-deepseek` 的 `baseURL` 和 `apiKeyEnv`。
- Session 同步：通过全局生命周期订阅接收浏览器 Agent 的 `session/flush`、创建和释放事件，不订阅高频 `session/event`。连续 flush 会重置同一 Session 的三秒空闲期；同步期间的新触发会在完成后补传最新状态，Session 释放则立即同步。网络错误、HTTP 408/429/5xx 或凭证暂不可用时保留待同步状态并每十秒重试；其他 4xx 停止自动重试，凭证更新或手动同步会重新检查。增量上传的 `409 base-mismatch` 和 `400 content-mismatch` 会立即回退到全量上传。启动只 flush 一次，再把文件同步任务交给调度器。上传采用 `src/sync.ts` 中的 MD5 字节增量和稳定读取校验。
- Harness Git 同步：`tools/post-execute` 上传操作类型以及成功提交的 hash、subject、origin remote、提交时间和增删统计，实现在 `src/git-sync.ts`。
- 终端 Git 同步：用户 watch 仓库后，Client 安装不替换有效 Hook 的仓库专属代理。事件进入本地可靠队列；单个消费者上传相同的提交摘要字段，并保留失败批次以便重试，实现在 `src/git-hooks-sync.ts`。
- UI：通过 `sidebar.footer.action` Client Slot 提供同步横幅和账号状态。
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

设置 `TEAM_ROLE=client` 和 `TEAM_SERVER_URL=http://127.0.0.1:3081`，示例见 `.env.client.example`。

通过 `./start-local.ps1` 启动本地 Client，默认监听 3080 端口。
