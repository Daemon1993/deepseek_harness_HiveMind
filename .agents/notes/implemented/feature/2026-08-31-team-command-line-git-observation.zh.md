# Agent Note: 团队命令行 Git 操作观测

Status: implemented

[English](2026-08-31-team-command-line-git-observation.md) | 中文

## Problem

团队 Client 能观测 Harness 工具执行的 Git 命令，但外部终端中的 Git 命令不会经过该事件流。因此，团队活动报表会漏掉 Agent Session 之外产生的提交和合并。

## Decision

用户通过团队 Client 的本地 HTTP 路由显式监听每个仓库。Client 记录仓库当前生效的 post-commit 和 post-merge Hook，为该仓库创建专属代理 Hook 目录，并通过本地 `core.hooksPath` 指向该目录。每个代理先调用原 Hook，再把仓库标识、变更前版本、变更后版本、动作和时间追加到 Client 自有队列，不在 Hook 中发起网络请求。

Client 通过原子改名把活动队列取得为一个待处理批次，并且同一时间只上传一个批次。凭证缺失或任一 Server 请求失败时，批次继续保留在磁盘；代码变更和操作记录都成功后才删除。合并事件通过 `ORIG_HEAD..HEAD` 枚举提交。unwatch 仅在当前配置仍指向 Client 自有目录时恢复原配置，因此用户后来设置的值优先。在 Client 拥有 worktree 作用域配置和所有权记录之前，watch 会拒绝 linked worktree；写入共享 local config 会影响同仓库的其他 worktree。

## Alternatives considered

**轮询仓库 HEAD。** 轮询不改 Git 配置，但只能推断事件，可能漏掉两次轮询之间被替换的版本，也无法可靠地区分提交与合并。

**Git Hook 直接发送 HTTP。** 直接发送不需要队列，但会让 Git 完成依赖 Client 可用性、凭证、网络和跨平台 HTTP 工具。

**不串联地替换为一个共享 Hook 目录。** 共享目录实现更小，但会禁用仓库专属 Hook，也无法安全恢复原配置。

## Consequences

外部终端的提交和合并通过与 Harness 工具执行相同的 Server 元数据端点上报，并且 Git 操作不等待网络。监听会修改仓库配置，因此始终需要用户显式执行。该实现只覆盖 post-commit 和 post-merge；checkout、rewrite、reset 和 push 不在这条路径内。
