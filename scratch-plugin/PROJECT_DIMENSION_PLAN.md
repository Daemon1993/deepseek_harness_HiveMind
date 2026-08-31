# 项目维度数据提取方案（MVP）

## 一、问题判断：放弃 session × git 的 1:1 强绑定

原先想"把每次 git commit 关联到产生它的那个 AI session"。判断**不可行且低价值**：

| 难点 | 说明 |
|---|---|
| 命令行外 git 没有 sessionId | hook 进程不在 DSH session 内，只能靠 cwd + 时间窗猜，一个仓库多个 session 在跑时歧义大 |
| 语义本来就弱 | 一个 commit 常混着人手改 + AI 改，硬说"这是那个对话的产物"站不住 |
| commit 常在 session 结束后才提交 | 时间窗匹配猜错比猜对更可能，错了反而误导 |

**结论**：砍掉"commit 属于哪个 session"的执念。

## 二、核心思路：以项目（gitRemote）为核心维度

不要求 session 和 git 互相归属，而是让它们**各自归到同一个项目桶里**，在桶里并排展示：

```
项目（gitRemote）
├── session 侧（AI 协作过程）  ← 来自 analytics 快照
│   会话数 / token / 工具调用 / 错误 / 成员 / 活跃时长
└── git 侧（代码产出）          ← 来自 team_code_changes
    提交数 / 增删行 / 最近提交
```

回答的是"**这个项目有多少 AI 协作 + 多少代码产出**"，不回答"这个 commit 属于哪个 session"。
`gitRemote` 跨人跨机一致，是稳定的桶 key。

## 三、砍 / 留 清单

**砍掉**：
- 强行把命令行外 git 绑到某个 session（cwd + 时间模糊匹配那套）——不实现
- session × commit 的 1:1 关联视图——不做

**保留（白捡且确定）**：
- DSH 对话框内 git 的 `sessionId`（`exec.agent?.session?.id` 原生带）——免费关联，存着当可选增强
- git 记录表的 `session_id` 列（nullable）——留着，命令行外 git 留 null，不强求
- git-hooks-sync 命令行外采集——作为"项目级 git 活动可见性"保留（团队谁在哪个项目提交）

## 四、MVP 实现（最小可行）

只给 commit 统计的来源表 `team_code_changes` 补 `git_remote` key，把提交统计并进**现有项目页**。`team_git_ops`（操作流水）对项目汇总价值低，先不动。

### 改动点（每处都很小）

**1. DB（database.ts）**
- `team_code_changes` 加列 `git_remote TEXT` + 索引 `(git_remote, created_at DESC)`
- `recordCodeChanges` 接收并存储 `gitRemote`；冲突时 `ON CONFLICT` 补全 remote/cwd
- 新增 `listGitStatsByRemote(since)`：按 remote 聚合 `commits / insertions / deletions / lastCommitAt`

**2. server（routes.ts + types.ts + index.ts）**
- `handleGitChanges`：从 payload 读 `gitRemote` 透传
- `handleAdminOverview`：循环后按 `gitRemote` 把 commit 统计合并进 `directories`
- 接口/委托层同步 `listGitStatsByRemote`

**3. client**
- `git-sync.ts`（DSH 内 git）：commit 时 `git remote get-url origin`，填进 changes payload；无 origin 则不带
- `git-hooks-sync.ts`（命令行外 git）：`uploadRecord` 解析一次 remote，并入每个 commit

**4. frontend（admin/main.tsx）**
- `OverviewDirectory` 加 `commits / insertions / deletions / lastCommitAt`
- 项目页表格加"提交""代码增删"两列（与现有 session 列并排）

### 数据流

```
client git-sync / git-hooks-sync
  └─ commit 时解析 git remote get-url origin → 带 gitRemote 上报 /team/api/git/changes
       └─ server recordCodeChanges 存 git_remote
            └─ handleAdminOverview 用 listGitStatsByRemote(since) 按 remote 聚合
                 └─ 合并进 directories（与 session 指标同桶并排）
                      └─ 项目页表格展示 提交/增删 + 会话/token/工具…
```

## 五、已知局限（MVP 接受，后续再补）

1. **项目桶仍由 session 驱动**：只有"窗口内有 session 活动"的项目才出现在 `directories` 里；纯 git 提交但无 session 的项目暂不显示。后续可加"git-only 项目"补齐。
2. **无远端的本地仓库**：`git remote get-url origin` 失败 → 不带 gitRemote → 该 commit 不进项目桶（与 session 侧"未关联 Git 项目"分组一致）。
3. **时间窗一致性**：git 统计按 overview 的 `days` 阈值过滤（与 session 同窗），保证并排数据可比。
4. **历史数据无 git_remote**：补 key 前已存的 commit 行 remote 为 null，不进桶；新提交起逐步填充。

## 六、后续可选增强（非 MVP）

- 用户维度同理（userId 两边都有，不用加列，更简单）
- `team_git_ops` 也加 `git_remote`，项目页补"操作活动"列
- 项目详情钻取页（点击项目 → session 列表 + commit 时间线）
- 错误/失败模式聚类、工具使用模式、token 投入产出比（纯 session 事件，不依赖 git 关联）
