# Agent Note: 团队 Session 分析快照

Status: implemented

[English](2026-08-31-team-session-analytics-snapshots.md) | 中文

## Problem

管理后台需要用户维度和项目维度的使用视图。如果每次请求都打开并解析全部原生 Session 工件，页面延迟和内存工作量会随保留日志总量增长。

## Decision

每次 Session 成功发布后，Team Server 都会向 PostgreSQL 写入一份不含内容的分析快照。Client 通过 Git 获取仓库根目录和可选的 `remote.origin.url`；普通工作区会把项目字段留空，并从项目统计中排除。快照以 Session ID 为键，保存项目名称和 Git 字段，同时保存标题、最后活动时间以及 `analyzeSessionEvents()` 的聚合结果。快照不保存工作区路径。

分析请求读取 SQL 快照。如果归属记录缺少快照，Server 会读取一次对应的原生 Session 工件，并在返回结果前保存缺失快照。Session 时间线请求继续读取原生工件，因为 SQL 快照有意省略了对话内容和详细事件负载。

管理后台提供独立的“用户”和“项目”区域。两个区域使用相同的时间范围规则并聚合同一批 Session 快照，因此其总数与总览保持一致。Session 详情抽屉把安全时间线投影为紧凑事件轨、可滚动事件列表和所选事件检查器。检查器展示模型标识与 Token 用量，或工具标识、状态与耗时，但不暴露消息内容、工具参数、结果、命令输出或文件。

## Data minimization

快照不保存工作区路径、用户或助手消息内容、工具参数、工具结果、命令输出和文件内容。PostgreSQL 只保存标识符、项目名称、Git 根目录和 origin 地址、时间戳、计数、耗时、工具名称及失败聚合，以及模型 Token 用量。

## Alternatives considered

**每次请求都解析所有 Session 文件。** 这种方式减少 PostgreSQL 数据，但管理员切换页面或日期范围时会重复完整日志的 I/O 和解析。

**在 PostgreSQL 中保存每个 Session 事件。** 这种方式支持任意 SQL 查询，但会复制原生 Session 持久化格式并扩大敏感数据范围。

**只维护项目汇总。** 预聚合项目行查询成本低，但如果没有额外的失效规则，就无法可靠支持用户视图、日期范围变化或 Session 归属修正。

## Consequences

快照存在后，总览、用户和项目请求的工作量取决于紧凑 SQL 行，而不是原生日志大小。成功上传 Session 时会增加一次分析和 SQL upsert。部署后的第一次分析请求可能因补建历史 Session 快照而较慢。PostgreSQL 通过 `CREATE TABLE IF NOT EXISTS` 单调创建 schema，删除 Session 归属行时会级联删除对应快照。
