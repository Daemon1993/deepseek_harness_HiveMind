# Git 提交同步方案（已落地 + 被否设计对照）

> 现状与取舍记录。实际实现的 team-client 只用 `git log` 命令抽取提交，不安装任何
> Git hook、不监听工具事件（README 与代码 `git-sync.ts` 一致）。曾认真设计的
> `core.hooksPath` + 事件队列方案最终被否；本文件先讲"落地了什么"，再讲"否决了什么、为什么"。

## 1. 落地现状：`git log` 游标扫描（唯一数据源）

```
管理员/员工导入仓库目录
  → team-client 校验 `git rev-parse --show-toplevel`（是仓库）
  → 记入 <dataDir>/team-client/watched.json（root + 游标）
  → 启动即全量抽取该仓库历史提交
  → 之后周期（TEAM_GIT_SCAN_MINUTES，默认 5 分钟）+ 每次扫描同步
     跑 `git log` → 解析 metadata / --name-status / --shortstat
     按仓库的 syncedTips 游标排除已同步 commit 的祖先 → 只取增量
  → 分批（100/批）POST server /team/api/git/changes
server 以 (git_remote, commit_hash) 幂等去重
```

- **数据源唯一是 `git log`**：不做任何 hook / 工具事件监听，无 Git 配置改动、
  不碰仓库工作区、不依赖 DSH 对话框内的命令上下文。
- **游标**：`syncedTips`（heads/remotes 的 tip 集合，`git log --not <tips>` 取增量）；
  兼容旧版单 hash `lastSyncedHash`。游标存于 `watched.json`，重启后仍增量（不整仓重传）。
- **触发点**：项目导入即全量 + 启动扫描一次 + 周期轮询 + `/team/git/status` 汇报进度。
  只捕捉"已提交到本仓库"的结果，实时性 = 扫描间隔（秒~分钟级），属轮询式推断。
- **端点是本机 DSH** 的 `/team/git/import|remove|status`（员工/导入侧工具或 UI 调用），
  上报仍走既有的 server `/team/api/git/changes`，server 侧与 Session 通道分开但无需新增鉴权面。

### 优点
零侵入（不动仓库、不加 hook、不读 `.git` 内部文件）、跨平台稳定、实现简单；
`(git_remote, commit_hash)` 幂等使重复/并发上报安全。

### 代价与边界（诚实）
- 实时性受轮询间隔限制（默认 5 分钟），不是事件驱动。
- 只捕捉"已落库的提交"，拿不到命令上下文（action 类型：是 commit 还是 pull 引入等），
  无法区分操作类型——因此**不填充 `git ops` 流水**（`/team/api/git/ops` server 端存在，
  但当前 client 无任何调用，team_git_ops 表实际空转）。
- `git log` 只覆盖当前工作副本可达到的引用；孤悬 / 被强制改写丢弃的提交抓不到（可接受，非必需）。
- 大仓库历史首扫要解析三份全量输出（metadata/name-status/shortstat），内存与耗时偏高。

## 2. 被否设计 A：`core.hooksPath` + 本地事件队列

原设想（本文档旧版）：为每个受 watch 仓库生成 `post-commit` / `post-merge` 代理 hook，
hook 端 `echo >> 队列文件`，client 轮询队列并上报，以捕获**命令行外（不经 DSH 工具）**的
git 操作。

- **优点（设想）**：事件驱动秒级实时、能按 hook 名区分 action、跨平台（git 自带 sh）。
- **否决理由**：
  1. 必须改目标仓库 `git config core.hooksPath`——侵入用户仓库，需要知情同意，与
     linked worktree / 多 worktree 共用 config 冲突。
  2. 一个数据源、两套通道（DSH 内靠工具事件、DSH 外靠 hook）维护成本高；
     而 team-client 的目标是"团队成员各自 repo 的提交入库"，`git log` 已能拿到全部结果，
     hook 额外带来的只是 action 分类与秒级实时，收益不抵侵入成本。
  3. hook 安装/卸载/串联原 hook 的边界复杂，是持续出错源。

**结论**：如果"命令行外 commit 也必须实时到秒 + 必须知道操作类型"成为硬需求，
才值得重新引入（可退化为只装 post-commit 单 hook）。当前以归档/分析为目标，不需要。

## 3. 被否设计 B：`fs.watch` `.git/HEAD` 与 `.git/refs/heads`

纯被动监听 `.git` 内部文件变化，变化时 `git log --since=<lastSeen>` 补增量。

- **优点**：完全不改仓库任何东西。
- **否决理由**：`.git` 内部 watch 跨平台稳定性差、去重难、commit 写到 finalize 前会误报、
  实时性仍靠轮询补救；而同样零侵入的 `git log` 轮询更简单可靠。**不采用。**

## 4. 取舍总表

| 方案 | 实时 | 精准(action) | 侵入 | 复杂度 | 状态 |
|---|---|---|---|---|---|
| `git log` 游标扫描 | 秒~分钟(轮询) | 只到提交，无 action | 零 | 低 | ✅ 已落地 |
| `core.hooksPath`+队列 | 秒级(事件) | 有 action | 改一项 config | 中 | ❌ 否决（侵入+双通道） |
| `fs.watch .git/HEAD` | 秒~十秒 | 推断 | 零 | 中 | ❌ 否决（不稳） |

## 5. 落地步骤回顾（对应现代码）

1. 加 `/team/git/import`：校验是 git 仓库 → 记入 `watched.json` → 启动即全量抽取。
2. 游标持久化 `syncedTips` / `lastSyncedHash`，重启续扫不重传。
3. 周期扫描 `git log` 增量 + 批量上报 `/team/api/git/changes`。
4. 加 `/team/git/remove`、`/team/git/status` 管理已导入仓库。
5. 集成测试：真实 Git 仓库的导入/增量游标/remove（见 `team-client/tests/git-import.spec.ts`）。

## 6. 与"DSH 内 git 操作"的关系

若要捕捉 DSH 对话框内 `bash` 工具执行的 git（有命令参数、能分类 action、实时），
未来可另挂 `tools/post-execute` 水瀑（必须调用 `next()`）上报 `/team/api/git/ops`。
当前实现没有做这一步——团队分析只按 commit 归属（`git log` 作者邮箱 → `team_git_emails`
绑定平台用户），不需要命令级 action。是否补上取决于是否要"用户实时操作行为"这一维。
