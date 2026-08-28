# Team Platform

## 使用洞察

管理员可在后台的“使用洞察”查看工具调用、模型请求、Token、按日趋势和成员排行；数据直接由 DSH 已持久化的会话事件聚合而来。会话过程时间线只展示时间、事件类别、工具名称和成功状态，不展示对话内容、命令参数、文件内容或工具输出。

## Logging

All Host logs use `writeTeamLog()` from `src/team-log.ts`. Routine operational messages pass only their text, for example `writeTeamLog('Redis connected')`. The console emits a readable single line; retained audit events remain structured records.

Each record contains default `timestamp`, `service`, `level`, `event`, `message`, and `source` fields. A text-only call defaults to `info` and `application.log`. `writeTeamLog()` captures a compact `src/file.ts:line` source automatically, so business code never supplies it. Include `requestId`, `userId`, or `sessionId` only when an audit event needs that correlation. Put non-sensitive extra fields in `details`.

Never log passwords, Cookie values, Redis keys, authorization tokens, request bodies, or conversation content. Use PostgreSQL `team_audit_logs` only for retained business audit events; deployment infrastructure collects the stdout stream for operational logs.
