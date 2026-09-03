# HiveMind · 团队 AI 工作台

> 多员工 AI 工作台 · 用量与研发轨迹可观测。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **插件系统**构建，核心零改动。

多名员工各在自己的 DSH 上使用 AI；一台中央服务器统一账号与模型网关、归档 Session、采集已导入仓库的 Git 提交，把「员工怎么用 AI、AI 在研发上做了什么」沉淀为后台可观测的数据。

**它是什么**：一个多员工共用的 **AI 工作台 + 运营观测台** —— 管理员发号、管模型入口、看用量与轨迹；服务器本机还保留一个完整的 DSH 工作台供管理员使用。

**它不是什么**（边界，现状如此而非承诺）：
- 不是**研发流程平台** —— 没有任务/需求/评审/CI 工作流；它只记录并统计「AI 参与研发」的过程（Agent 会话 × Git 提交），不驱动研发流程
- 不是**企业知识库** —— 会话归档可浏览与统计，暂无全文检索、问答与知识萃取复用
- 面向研发的定位是**过程可观测与度量**，而非提供研发工具链

## 构建在 DSH 插件系统之上

HiveMind 是两个 Cordis 插件包（`dsh-team-server` + `dsh-team-client`），通过 DSH 官方扩展点组合出全部能力，核心零改动：

| 扩展点 | 用途 |
|---|---|
| `webServer.register / tapIndex` | 挂载路由、向页面注入登录守卫（可见性门控 + 根路径跳转） |
| `cordis.patch.yml`（`!!js` 配置分叉） | 替换 `llm-deepseek` 的 `baseURL` + `apiKeyEnv`，模型流量搬到网关 |
| `session/flush` · `created` · `disposed` | 触发会话增量同步（DSH 持久化提交边界） |
| `credentials` 服务 | Host 托管公司 token（永不进浏览器） |
| `ctx.effect()` 生命周期 | 路由/监听器的注册与清理 |
| `sidebar.footer.action` Client Slot | 同步横幅、账号状态、Git 扫描状态 UI |

> 两个插件包：`dsh-team-server`（服务器侧）+ `dsh-team-client`（员工侧）。同一份 DSH 应用，靠环境变量分叉角色。

## 架构总览

```
┌─ 员工机器（3080）────────────────────┐      ┌─ 中央服务器（3081）─────────────────────────┐
│ 本地 DSH（web profile）              │      │ 本地 DSH（web profile，team-client 禁用）    │
│  · llm-deepseek → 网关（patch 替换）  │ ───▶ │  · 认证：PG 账号 + Redis 会话                │
│  · team-client 插件：登录转发/扣 token │ 同步 │  · 模型网关：chat + Files 透传、真 key 换发  │
│  · 会话/工具在本地执行                  │ ───▶ │  · 会话归档：DSH 原生文件 + PG 索引           │
│  · Git：导入仓库 + 周期 git log 扫描    │ ───▶ │  · Git 提交入库（作者/说明/变更文件）         │
└──────────────────────────────────────┘      │  · 管理后台（总览/用户/项目/账号）            │
                                              └──────────────────────────────────────────────┘
```

**核心原则**：
- **文件为真相，PG 为派生索引** —— 会话日志（DSH 原生格式）是权威，数据库只存归属+同步标记，靠对账收敛漂移
- **token 永不进浏览器** —— 凭证由本地 Host 进程托管，浏览器只见身份
- **员工机器不持有真 key** —— 模型凭证只在 server 进程内 resolve
- **配置替换而非代码改动** —— 用 cordis patch 替换 llm-deepseek 的 `baseURL` + `apiKeyEnv`，模型流量整体搬到网关，上层零感知

## 核心能力

### 1. 认证与身份（三套机制分治）

| 机制 | 载体 | Redis key | 生命周期 | 消费者 |
|---|---|---|---|---|
| 机器认证 | Bearer token | `team:client-token:*` | 固定 7 天 | 本地 DSH |
| 浏览器会话 | HttpOnly Cookie | `team:session:*` | 滑动续期 | 管理员 |
| SSO 桥接 | 一次性 code | `team:admin-ticket:*` | 30 秒、消费即删 | 浏览器跳转 |

登录时 server 签发的 token 被本地 Host 拦截存入 credentials，返回浏览器的只有用户信息。

### 2. 模型网关（chat + Files 完整代理）

```
本地 llm-deepseek（baseURL = {server}/team/api/model，key = 公司 token）
  → POST /team/api/model/chat/completions   → 换真 key → 转发 DeepSeek
  → POST /team/api/model/files              → multipart raw 透传（不解析）→ 上传拿 file-id
  → GET/DELETE /team/api/model/files/:id    → 列表/读取/删除透传
```

- **模型由 client 决定**：请求体带 `model` 字段，网关原样透传不覆盖——两边都是 DSH，模型名一致
- **files-first**：client 优先走 Files API（与本地直连行为一致）。网关必须完整代理 `/files`，否则 client 会退化为 base64 内联（`routes.ts` 对 chat 与 files 都做了无缓冲透传）
- 网关日志/审计带 `model` 字段，每次请求可追溯用了哪个模型；网关本身不透传/提取 usage
- 真 key 只在 server 进程内 resolve（`credentials.resolve`），员工机与浏览器均不持有；不向 LAN 暴露 loopback 网关端口
- Token / 模型用量在会话归档后由 Session 事件流聚合得到，用于后台展示；成本估算与价目表尚在规划中，未实现

### 3. 会话同步归档（md5 字节增量）

```
session/flush（主）· created · disposed · 挂载补传
  → 拉 server 标记（fileSize + contentMd5）→ 本地算 md5 → 决策：
     ① 完全一致 → 跳过（零传输）
     ② 前缀一致 → 增量（只传新增尾部，server 校验 base 后追加 + size 校验）
     ③ 无标记/不一致 → 全量（tmp + rename 原子替换）
  → 全量落盘后 inspect 首帧校验（防无头文件入库）→ 更新标记
```

正确性 = **验证 + 幂等 + 可重建**：任何异常（409/校验失败）回退全量，全量替换天然幂等。

### 4. Git / 代码变更同步

员工侧导入 Git 仓库后，Client 用 `git log` 抽取提交并批量上报，之后按游标周期增量扫描。不安装 Git Hook，也不监听 `tools/post-execute`。

- 导入：`POST /team/git/import`（目录路径），首次全量抽取该仓库历史提交
- 增量：启动补扫，并按 `TEAM_GIT_SCAN_MINUTES`（默认 5）轮询；游标写在 `watched.json`
- 入库：`POST /team/api/git/changes`；幂等键为 `(git_remote, commit_hash)`
- 字段：作者姓名/邮箱、subject、完整 message、变更文件路径、增删行、提交时间
- 归因：管理员把 Git 邮箱绑定到平台用户；分析按用户 ID 或 origin remote 独立汇总，不把某条 commit 归给某个 Session
- 没有 origin 的提交只进入用户统计，不进入项目统计

### 5. 管理后台

`/team/admin` 五个栏目 + 一个跳转入口：

| 栏目 | 内容 |
|---|---|
| 总览 | 团队运行概况（活跃项目/开发者/AI 协作）、本周期研发动态摘要、研发活动趋势、运行健康、最近 AI 协作、成员/项目/工具/模型用量排行 |
| 用户 | 按成员查看参与项目、研发活动与 AI 消耗；详情含工具/模型用量、提交类型分布、按项目分组的提交 |
| 项目 | 按 Git remote 聚合；详情含提交趋势、按作者分布与分组的提交、高频目录、提交类型 |
| 账号与权限 | 账号审核与角色、Git 邮箱映射、Session 同步状态与对账、每日工作洞察 |
| 平台能力 | 当前数据范围、AI 可提取洞察与迭代路线图 |
| DSH 工作台（跳转） | 仅管理员可在 Server 本机打开完整 DSH 工作台 |

### 6. 工作台访问控制

- server 通过 `tapIndex` 向页面注入守卫脚本：`/team/session` 未通过 admin 认证时页面保持隐藏并跳转 `/team/admin`（非真实路由重定向）
- `/team/workspace` 仅供 admin：用团队会话换取本机 DSH 浏览器令牌进入工作台（双保险：服务端校验 + 页面守卫脚本）

## 现状与路线图

**当前已具备**：统一身份与权限、模型网关、会话归档与统计、Git 提交采集、运行安全基础（LAN 受限访问、Server Gateway、对账）；按用户/项目/提交人浏览会话与提交已可覆盖日常观测。

**AI 洞察为少量实现**：每日工作洞察（每日 17:20 对活跃用户的 Session+Git 证据做摘要）已实现；会话自动摘要、日报/周报、异常模式识别、知识沉淀均未落地，见后台「平台能力」。

**迭代顺序**：近期（稳定性与可观测性：同步重试、Client 健康检查、错误归因）→ 下一阶段（AI 数据洞察：摘要、标签、日报、成本、异常趋势、项目画像）→ 长期（企业治理与集成：部门/项目权限、额度、审计、SSO、GitLab/企业 IM 集成）。

## 快速开始

### 环境要求
- Node ^22.19 || >=24，pnpm workspaces
- PostgreSQL（账号/会话索引/审计）+ Redis（登录会话/token/ticket）
- 服务器进程需 `DEEPSEEK_API_KEY`（真密钥，只在 server 内 resolve）

### 安装

```powershell
# 两个包分别安装依赖并构建
cd scratch-plugin/team-server
pnpm install --ignore-workspace
pnpm run build
pnpm pack          # 产出 dsh-team-server-0.1.0.tgz

cd ../team-client
pnpm install
pnpm run build
pnpm pack          # 产出 dsh-team-client-0.1.0.tgz
```

安装到 profile（以 web profile 为例）：

```powershell
dsh plugin --profile web add <dsh-team-server-0.1.0.tgz>   # 服务器
dsh plugin --profile web add <dsh-team-client-0.1.0.tgz>   # 员工机
```

### 配置

**服务器**（`team-server/.env.server`）：

```env
TEAM_ROLE=server
DB_URL=postgres://user:pass@host:5432/deepseek_hahame_db
REDIS_URL=redis://host:6379
TEAM_SESSIONS_ROOT=E:/path/to/.dsh-server-sessions
DEEPSEEK_API_KEY=sk-xxxx
```

**员工机**（`team-client/.env.client`）：

```env
TEAM_ROLE=client
TEAM_SERVER_URL=http://192.168.1.10:3082
# 可选：Git 增量扫描间隔（分钟），默认 5
# TEAM_GIT_SCAN_MINUTES=5
```

> `!!js` 表达式在进程加载时求值：有 `TEAM_SERVER_URL` → llm-deepseek 指向网关 + 公司 token；没有 → 本地直连。同一份 patch 按环境分叉。

### 启动

```powershell
# 服务器（loopback 3081 + LAN 代理 3082；员工机连 3082）
cd scratch-plugin/team-server
pnpm start:local

# 员工机（3080，TEAM_SERVER_URL 指向 LAN 3082）
cd scratch-plugin/team-client
./start-local.ps1
```

### 账号

账号由 `team-server/src/users.json` 播种（含一个 admin 与若干 developer），并在首次启动时落库。代码不预设密码——账号以"未设密码"哨兵落库，需先在管理后台为账号分配密码后才能登录。账号清单与角色请以该文件为准。
