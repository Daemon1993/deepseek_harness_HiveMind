# Agent Note: Team dimension analytics

Status: implemented

[English](2026-08-31-team-dimension-analytics.md) | 中文

## Problem

团队报表需要在同一用户和仓库下展示 AI 使用与代码交付。把每条 Git commit 归给某个 Agent Session 并不完整：commit 可能来自终端或 IDE；一次 commit 也可能混合人工修改、多个 Session 或延后提交的工作。

## Decision

管理后台把用户和 Git remote 作为相互独立的聚合键。Session 分析提供模型用量、Token、工具、错误、时长和 Session 列表；Git 观察提供 commit hash、subject、采集用户、origin remote、时间和增删统计。用户行按用户 ID 合并两类数据；项目行按精确的 origin remote 合并，并包含只有 commit、没有 Session 活动的项目。

后台并排展示两类数据，但不声称某条 commit 属于某个 Session。Harness 工具能够提供 Session ID 时，Git 记录仍保留这个可空字段，但分析不使用它进行关联。没有 origin remote 的 commit 进入用户分析，不进入项目分析。

总览接口是总览、用户和项目三个栏目共用的聚合数据源。用户和项目行展开后展示模型、工具、commit 和 Session 表。独立的 Session 栏目保留为同步会话记录的运维钻取入口。

## Alternatives considered

**按仓库和时间窗匹配 commit 与 Session。** 并行 Session、外部 Git 客户端、延后提交以及人工和 Agent 混合修改会让结果带有概率性；把这种推断当作归因会制造错误因果。

**要求所有 commit 都通过 Harness 工具执行。** 这种约束可以提高归因覆盖率，但会排除普通终端和 IDE Git 工作流，也无法解决一次 commit 混合多个来源的问题。

**把 AI 和 Git 拆成两个独立产品。** 独立页面可以避免误归因，但会迫使管理员手工对照用户和仓库，而两类数据已经具有稳定的用户和 remote 键。

## Consequences

MVP 可以回答一个用户或仓库发生了哪些 AI 活动和 Git 交付，而不声称两者之间存在因果。commit subject 直接提供面向功能的摘要，不进行语言模型分类。项目键保留精确 remote 字符串，因此等价的 SSH 和 HTTPS remote 在明确实现规范化之前会显示为不同项目。

## Related

Session 侧数据来源遵循 [Team Session analytics snapshots](2026-08-31-team-session-analytics-snapshots.zh.md)。外部终端 commit 遵循 [Team command-line Git observation](2026-08-31-team-command-line-git-observation.zh.md)。
