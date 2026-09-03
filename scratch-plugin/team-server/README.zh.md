# dsh-team-server

[English](README.md) | 中文

服务器侧插件（HiveMind 团队 AI 研发平台的一部分）。负责认证、模型网关、Session 副本、Git 记录与管理后台。

完整平台说明见[仓库 README](../../README.zh.md)。

## 职责

- 认证：PostgreSQL 账号以及 Redis 支持的 Cookie、Bearer 与 SSO ticket 会话
- 模型网关：通过 `/team/api/model/chat/completions` 和 `/team/api/model/files*` 原样转发，并使用 Server 凭据；响应透传，不提取 usage
- Session 副本：DSH 原生工件、PostgreSQL 归属索引、完整字节校验与事务发布；每会话持久化一份轻量的纯聚合分析投影（事件级明细保留在原始 Session）
- Git 提交：`/team/api/git/changes` 存储作者身份、subject、完整 message、变更文件路径与增删统计；幂等键为 `(git_remote, commit_hash)`；管理员把 Git 邮箱绑定到平台用户，提交通过 `project_id` 归入稳定的 `team_projects` 实体
- 管理后台：`/team/admin`——总览（研发价值 KPI、本周期研发动态、提交/Session/开发者趋势、成员与项目研发活动、最近 AI 协作）、用户、项目（提交趋势、作者归并、热目录、提交类型）、账号与权限（角色、Git 邮箱映射、Session 同步与对账）
- 工作台入口：只有 Server 本机的管理员能打开 `/team/workspace`；该入口会用团队登录态换取本机 DSH 浏览器令牌。
- 每日工作洞察：每天 Asia/Shanghai 17:20，系统用 Server 端 LLM 根据活跃用户的 Session 与 Git 证据生成并覆盖当天记录；管理员可在“账号与权限”中查看或手动重算。启用前复制 `.env.example` 为 `.env`，并只在 Server 中设置 `TEAM_INSIGHT_API_KEY`。

## 构建与打包

```powershell
pnpm install --ignore-workspace
pnpm run build
pnpm pack
```

在 Server 主机上通过 `dsh plugin --profile web add <tarball>` 安装 tarball。

## 配置

设置 `TEAM_ROLE=server`、`DB_URL`、`REDIS_URL` 和 `DEEPSEEK_API_KEY`，示例见 `.env.server.example`。`TEAM_SESSIONS_ROOT` 指定 Server 专用的 Session 根目录；未设置时使用 `$DSH_HOME/team-server-sessions`，绝不与 Client 的 `$DSH_HOME/sessions` 共用。

Session 同步把上传内容视为 Server 副本的候选版本。编码请求上限容纳一个 50 MiB 二进制上传经过 Base64 膨胀后的内容以及 64 KiB JSON 元数据；更大的请求会在 JSON 解析前返回 HTTP 413。对于增量上传，Server 在把已有副本流式复制到临时文件时校验基准 MD5 并计算完整 MD5，再追加上传字节，不构造完整的内存缓冲区。当前 Session persistence provider 解析临时候选后才确认上传；校验失败会恢复已有副本。同一 Session 的上传按顺序处理，不同 Session 可并行。

同一用户短时间内连续成功发布时只输出最后一条 `session.sync.completed` 运行日志，可选的 `batch` 数量表示该日志合并的成功次数；日志不记录 Session 内容。

PostgreSQL 的 `BIGINT` Session 文件大小会在查询时转换为整数，再进入 HTTP 状态接口；传输协议中的 `fileSize` 始终为 JSON 数字。

后台会话列表使用 Session 日志中最新的 `session/title` 作为对话名称，Session ID 作为副信息，并列出该会话实际使用过的 provider/model 与请求次数。管理响应与页面不返回 Client 本地目录；存在 Git remote 时才关联项目，并显示远程仓库地址。

统计快照带有投影版本；Server 首次读取旧版快照时从 Session 副本重算一次，后续请求继续直接读取 SQL。

发布完成后，Server 把不含内容的 Session 分析快照写入 PostgreSQL。Client 通过 Git 获取仓库根目录和可选的 `remote.origin.url`；普通工作区没有项目字段，也不会进入项目统计。快照包含项目名称、Git 字段、标题、活动时间、计数、耗时、工具聚合与模型用量，不包含工作区路径、对话内容、工具参数、命令输出或文件内容。

Client 通过 `git log` 独立上传提交历史。Server 存储 hash、作者、subject、message、origin remote、变更文件路径、时间和增删统计。总览、用户和项目页面按用户 ID 或 Git remote 分别聚合 Session 快照与 Git 行，不声称某条 commit 属于某个 Session。只有 Git 提交的项目仍会显示；没有 origin 的提交只进入用户统计。管理员首次查看缺少快照的历史 Session 时，Server 会补建快照；单个 Session 时间线仍按需读取原生 Session 工件。

`pnpm start:local` 和 `pnpm start:lan` 会同时启动 loopback Server 与限制路由的 LAN 代理。`pnpm start:loopback` 只启动监听 `127.0.0.1:3081` 的 Server。loopback launcher 会停止占用 3081 端口的现有源码启动 DSH Web 进程，拒绝停止无关的端口占用进程，并且绝不向 LAN 暴露通用 DSH Web listener。

将 `TEAM_SERVER_LAN_HOST` 设置为 Server 机器持有的一个 IPv4 地址，并可选设置 `TEAM_SERVER_LAN_PORT`（默认 `3082`），然后运行 `pnpm start:local`。LAN listener 只接受 `/team` 和 `/team/*`，拒绝外部 Host/Origin 值及跨站浏览器请求，并把通过校验的流量转发到 `127.0.0.1:3081`。员工侧 Client 把 `TEAM_SERVER_URL` 设为这个 LAN origin，不要直连 loopback 的 `127.0.0.1:3081`。在 Windows 防火墙中放行配置的 LAN 端口；不要向局域网开放 3081 端口。

通过 `pnpm test` 运行聚焦回归测试。
