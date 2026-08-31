# Git 命令行外操作监听方案

> 现有 git-sync 监听 `tools/post-execute`，只抓 DSH 对话框内 bash 执行的 git。
> 终端里直接 `git commit/pull` 不经 DSH，抓不到。本方案在不改 DSH 源码、
> 全部在 team-client 插件内实现的前提下，补齐命令行外 git 操作的捕获与同步。

## 1. 约束

- 不改 DSH 源码：全部逻辑落在 `team-client/src/*`。
- hook 失败不得阻断用户 git 操作（git hook 退出非 0 会中断）。
- 易装易卸：装一行、卸一行还原。
- 复用现有上报通道：server 端 `/team/api/git/ops` + `/team/api/git/changes` 不改。

## 2. 核心思路：core.hooksPath + 本地事件队列 + 复用上报

```
终端 git commit
  → post-commit 代理 hook（team-client 为该仓库生成）
  → 追加一行到本地事件队列文件
  → team-client 轮询/监听队列
  → 消费：跑 git rev-parse HEAD + diff-tree（复用 captureAndUpload）
  → POST server /team/api/git/ops + /team/api/git/changes
```

不选"hook 直接 HTTP 回调 client"：hook 进程跨平台、零依赖最稳；选"追加一行到本地文件"
让 hook 端只剩 `echo >> file`，任何失败 `|| true` 兜底，git 操作绝不中断。

## 3. 组件

### 3.1 hooks 目录与脚本（team-client 生成）

team-client 为每个仓库在 `<dataDir>/team-client/hooks/<repository-id>/` 生成：

- `post-commit`、`post-merge` 两个 POSIX sh 脚本（git for Windows 自带 sh 可执行）。
- 脚本先调用安装前已有的同名 hook，再把 `action|repository-id|base-HEAD|HEAD|time` 追加到绝对路径队列，队列写入失败不改变原 hook 的退出状态。

队列文件路径在生成脚本时由 team-client 写死进脚本，hook 不依赖任何环境变量。
队列不含工作区路径，因此路径字符不会破坏记录格式。Client 通过 repository-id 查回 `watched.json` 中的仓库。

### 3.2 装钩子（手动 watch 为主）

team-client 暴露端点：

- `POST /team/git/watch` body `{ cwd }`：
  `git -C <cwd> rev-parse --show-toplevel` 校验为仓库 →
  保存当前 `core.hooksPath` 与已有同名 hook → 安装仓库专属代理目录 → 记入 `watched.json`。
- `POST /team/git/unwatch` body `{ cwd }`：
  仅当当前配置仍指向 team-client 管理目录时恢复原 `core.hooksPath`；用户后来修改过配置则不覆盖。

不自动装：改目标仓库 git config 要用户知情。watchedRoots 可持久化到
`<dataDir>/team-client/watched.json`，重启恢复。

### 3.3 工作区发现（候选提议，不自动装）

从已同步 session 的 `gitProject.root` 收集候选仓库，在 UI 提示
"检测到仓库 X，是否监听其命令行 git 操作？"，用户确认才 watch。
避免擅自改用户仓库配置。

### 3.4 队列消费

team-client 每轮通过原子改名取得一个待处理批次，同一时间只运行一个消费者。代码变更和操作请求均成功后删除该批次；缺少凭证、网络错误或 HTTP 错误会保留批次，下轮继续重试。Git 在消费期间产生的新事件写入新的活动队列，不会被清空操作删除。

## 4. 触发点（hook 选取）

| hook | 抓什么 | action |
|---|---|---|
| post-commit | 本地 commit | commit |
| post-merge | pull/merge 后新提交 | 用 `ORIG_HEAD..HEAD` 枚举并上报 changes |
| post-checkout（可选）| 分支切换 | checkout |
| post-rewrite（可选）| rebase/amend | rebase |

MVP 先 `post-commit` + `post-merge`，覆盖命令行外 commit/pull。
**push 不抓**：git 无本地 post-push hook；push 元数据非必需，DSH 内 push 仍由
`tools/post-execute` 覆盖。

## 5. 与现有 git-sync 的关系

- `tools/post-execute` 监听保留：抓 DSH 内 git（有命令参数，能分类 action）。
- 新增队列消费：抓命令行外 git（只有 commit/merge 事件，无命令参数，靠 hook 名定 action）。
- 两者汇入同一 `captureAndUpload` → 同一 server 端点，server 侧零改动。

## 6. 非侵入边界（诚实）

- 不改 DSH 源码：✅ 全在 team-client。
- 不碰目标仓库工作区文件：✅。
- **动目标仓库一项 git config（`core.hooksPath`）**：⚠️ 装钩子的必然代价。安装记录原值并串联原 hook；卸载只恢复 team-client 仍然拥有的配置，避免覆盖用户后续修改。
- linked worktree 暂时拒绝安装；普通 local config 由多个 worktree 共用，贸然写入会改变其他 worktree。后续支持必须改为 worktree-scoped config 和独立所有权记录。
- 若连 `core.hooksPath` 都不能动 → 退化方案见 §7。

## 7. 退化方案：fs.watch `.git/HEAD`（纯被动、零仓库改动）

team-client 监听已注册工作区 `<root>/.git/HEAD` 与 `.git/refs/heads` 变化，
变化时跑 `git log --since=<lastSeen>` 拉增量提交上报。

- 优点：完全不改目标仓库任何东西。
- 缺点：`.git` 内部 watch 稳定性差、去重难、commit 写到 finalize 前可能误报、
  实时性靠轮询补救。
- 定位：兜底，不作主路。

## 8. 取舍

| 选项 | 实时 | 精准 | 侵入 | 复杂度 |
|---|---|---|---|---|
| core.hooksPath + 队列（主）| 秒级 | 事件驱动 | 改一项 config | 中 |
| fs.watch .git/HEAD（兜底）| 秒~十秒 | 推断 | 零 | 中 |
| 轮询 git log（备选）| 十秒级 | 推断 | 零 | 低 |

主路选 hooks：精准、事件驱动、跨平台（git 自带 sh）、hook 端零依赖不阻断 git。
代价仅"动目标仓库一项 config"，可一行还原。

## 9. 落地步骤

1. team-client 启动生成 hooks 目录 + post-commit/post-merge 脚本（队列路径写死）。
2. 加 `/team/git/watch` `/team/git/unwatch` 端点 + watchedRoots 持久化。
3. 队列消费器：原子取得批次 → 串行上报 → 成功删除；失败保留重试。
4. 工作区候选从 session 的 gitProject.root 提议，UI 确认后 watch。
5. 集成测试：真实 Git 仓库中原 hook 串联、事件写入和 watch/unwatch 配置还原。
