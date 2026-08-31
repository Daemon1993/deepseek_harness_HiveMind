# Agent Note: 隔离并事务发布团队 Session 副本

Status: implemented

[English](2026-08-31-team-session-replica-isolation.md) | 中文

## Problem

Team Server 曾把本地 Client 上传的原始 Session 工件写入活动 JSONL 持久化根。同机运行时，未设置 `TEAM_SESSIONS_ROOT` 会让两个进程都解析到 `$DSH_HOME/sessions`。全量上传在解析校验前替换共享文件，并在校验失败时删除它，因此拒绝不兼容工件可能同时删除 Client 的活动日志。增量上传也会先追加、再检查结果大小，拒绝后仍保留错误尾部。同一 Session 的并发上传还可能交错，而一个损坏工件会让管理端聚合列表整体失败。

## Decision

Team Server 持久化行始终解析到 Server 独占根目录：已配置时使用 `TEAM_SESSIONS_ROOT`，否则使用 `$DSH_HOME/team-server-sessions`。只有 `TEAM_ROLE=client` 时，已安装但禁用的 Server bundle 才保留 `$DSH_HOME/sessions`，因此同时安装两个 bundle 不会改写 Client 持久化目录。

每次上传都校验 `header.id`、协议字段、完整字节数和完整 MD5。只有磁盘中的 Server 副本本身符合声明的基准大小和摘要时才接受增量。Server 把已有副本流式写入唯一命名的临时候选，并在一次遍历中计算基准摘要和完整摘要，因此不构造完整的内存缓冲区。全量和增量上传都通过 `SessionPersistence.inspect()` 解析候选；校验成功前保留或恢复旧副本。每个 Session 的队列只串行该 Session 的事务，不阻塞其他 Session id。

Client 在每个 Session 的 500 毫秒静默期内合并 flush。同步期间到达的 flush 会把 Session 标记为 dirty，调度器在当前上传完成后使用最新的持久化文件再运行一次。Session 释放和启动补传不等待静默期。

Server 在 JSON 解析前限制编码同步请求。上限容纳一个 50 MiB 二进制上传经过 Base64 膨胀后的内容以及 64 KiB 元数据；超限请求返回 HTTP 413，其剩余字节会被丢弃且不保留。

Team 管理接口独立读取每个归属 Session。一个不可用工件只会让该 Session 缺少派生详情；对应警告会被抑制，直到后续成功读取证明它已经恢复。

## Alternatives considered

**强制配置 `TEAM_SESSIONS_ROOT`，不提供默认值。** 拒绝，因为缺少部署变量不应让启动变得不安全或不可用；固定的 Server 独占默认值可以在无需操作员介入时保持隔离。

**替换后再校验，失败时删除。** 拒绝，因为候选校验失败不能证明旧文件无效或属于当前写入者；候选通过前必须保留可恢复的旧副本。

**直接追加增量，等待下次全量同步修复。** 拒绝，因为被拒绝的请求不能修改已提交状态，而且其他读取者可能在后续修复前看到错误尾部。

**全局串行所有上传。** 拒绝，因为只有同一 Session 的上传会竞争同一个工件；不同 Session 应独立推进。

**使用聚合 Session 列表，失败时返回空列表。** 拒绝，因为一个损坏工件会隐藏全部健康 Session，并使轮询重复同一个全局错误。

## Consequences

Server 部署获得独立的默认存储树；需要保留的旧副本必须迁移，或者由 Client 重新上传。每次接受上传都会执行完整文件摘要和事务替换，以额外 I/O 换取回滚与并发安全。流式同步把内存限制为文件流和上传增量，不再同时保存完整副本，但严格基准验证仍需读取已有副本。编码请求上限会在解析前限制保留的输入，同时允许协议支持的最大全量上传。Client 合并会让普通 flush 同步最多延迟 500 毫秒，并减少重复读取、摘要计算和请求。不兼容的 Client 工件会被拒绝，但不会改变旧副本。独立检查可能比只读头部的聚合列表成本更高，但一个工件损坏时管理功能仍然可用。
