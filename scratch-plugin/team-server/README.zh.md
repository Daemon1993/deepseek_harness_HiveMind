# dsh-team-server

[English](README.md) | 中文

服务器侧插件（HiveMind 团队 AI 协作与知识沉淀平台的一部分）。负责认证、模型网关、Session 副本、Git 记录与管理后台。

完整平台说明见[仓库 README](../../README.zh.md)。

## 职责

- 认证：PostgreSQL 账号以及 Redis 支持的 Cookie、Bearer 与 SSO ticket 会话
- 模型网关：通过 `/team/api/model/chat/completions` 和 `/team/api/model/files*` 原样转发，并使用 Server 凭据
- Session 副本：DSH 原生工件、PostgreSQL 归属索引、完整字节校验与事务发布
- Git 与代码变更：`/team/api/git/ops` 和 `/team/api/git/changes`
- 管理后台：`/team/admin` 提供总览、用户与项目分析、账号、Session、同步状态与对账
- 根路径：`/` 重定向到管理后台，只有管理员能访问 `/team/workspace`

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

发布完成后，Server 把不含内容的 Session 分析快照写入 PostgreSQL。Client 通过 Git 获取仓库根目录和可选的 `remote.origin.url`；普通工作区没有项目字段，也不会进入项目统计。快照包含项目名称、Git 字段、标题、活动时间、计数、耗时、工具聚合与模型用量，不包含工作区路径、消息、工具参数、命令输出或文件内容。总览、用户和项目页面直接聚合这些快照，不会重新打开每个 Session 文件。管理员首次查看缺少快照的历史 Session 时，Server 会补建快照；单个 Session 时间线仍按需读取原生 Session 工件及其工作区路径。

通过 `./start-local.ps1` 启动本地 Server，默认监听 3081 端口。

通过 `pnpm test` 运行聚焦回归测试。
