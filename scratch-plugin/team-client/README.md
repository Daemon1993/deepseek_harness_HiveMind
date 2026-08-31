# dsh-team-client

员工侧插件（HiveMind 团队 AI 协作与知识沉淀平台的一部分）。提供登录转发、凭证托管、会话/Git 同步与状态 UI。

完整说明见 [../../README.md](../../README.md)（GitHub 首页）。

## 职责

- 登录：`/team/login` 转发到 server，**token 被 Host 拦截存入 credentials，不进浏览器**
- 守卫：`/team/session` 水合恢复登录态；未登录跳登录页
- 模型走网关：patch 替换 llm-deepseek 的 `baseURL` + `apiKeyEnv`（`cordis.patch.yml`）
- 会话同步：通过全局生命周期订阅接收浏览器 Agent 的 `session/flush`、创建和释放事件，不订阅高频 `session/event`。连续 flush 会重置同一 Session 的 3 秒空闲期；同步期间的新触发会在完成后补传最新状态，Session 关闭则立即同步。网络错误、HTTP 408/429/5xx 或凭证暂不可用时保留待同步状态并每 10 秒重试；其他 4xx 停止自动重试，凭证更新或手动同步仍可重新检查。增量上传的 `409 base-mismatch` 和 `400 content-mismatch` 会立即回退全量。启动补传只 flush 一次再把文件同步任务交给调度器，避免重试反向产生新的 flush。上传采用 MD5 字节增量和读取稳定性校验（`src/sync.ts`）
- Git 同步：监听 `tools/post-execute` 提取元数据（`src/git-sync.ts`）
- 终端 Git 同步：用户 watch 仓库后安装不覆盖原 Hook 的仓库专属代理；事件进入本地可靠队列，Client 单飞消费，失败保留重试（`src/git-hooks-sync.ts`）
- UI：同步横幅 / 账号状态（`sidebar.footer.action` Client Slot）
- 手动测试：同步横幅的“手动同步”按钮调用 `/team/sync/now`，立即执行一次启动补传流程
- 同步诊断：`/team/sync/status` 返回最近 flush、同步尝试、成功和错误的时间与 Session ID，用于区分生命周期事件、调度和上传故障

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
