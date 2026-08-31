# HiveMind · 团队 AI 协作与知识沉淀平台

> 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **插件系统**构建的团队 AI 平台。

多员工团队 AI 平台：每个员工在本地跑自己的 DSH 实例，一台中央服务器统一认证、代理模型流量、归档会话、跟踪 Git/代码变更，并提供管理后台。"企业 AI 知识中枢"——把员工的 AI 工作过程沉淀成可检索、可复用的公司知识。

## 构建在 DSH 插件系统之上

HiveMind 是两个 Cordis 插件包（`dsh-team-server` + `dsh-team-client`），通过 DSH 官方扩展点组合出全部能力，核心零改动：

| 扩展点 | 用途 |
|---|---|
| `webServer.register / tapIndex / registerFallback` | 挂载路由、注入登录守卫、接管根路径重定向 |
| `cordis.patch.yml`（`!!js` 配置分叉） | 替换 `llm-deepseek` 的 `baseURL` + `apiKeyEnv`，模型流量搬到网关 |
| `session/flush` · `created` · `disposed` | 触发会话增量同步（DSH 持久化提交边界） |
| `tools/post-execute` | 检测 Git 命令、提取代码变更元数据 |
| `credentials` 服务 | Host 托管公司 token（永不进浏览器） |
| `ctx.effect()` 生命周期 | 路由/监听器的注册与清理 |
| `sidebar.footer.action` Client Slot | 同步横幅、账号状态 UI |

> 两个插件包：`dsh-team-server`（服务器侧）+ `dsh-team-client`（员工侧）。同一份 DSH 应用，靠环境变量分叉角色。

## 架构总览

```
┌─ 员工机器（3080）────────────────────┐      ┌─ 中央服务器（3081）─────────────────────────┐
│ 本地 DSH（web profile）              │      │ 本地 DSH（web profile，team-client 禁用）    │
│  · llm-deepseek → 网关（patch 替换）  │ ───▶ │  · 认证：PG 账号 + Redis 会话                │
│  · team-client 插件：登录转发/扣 token │ 同步 │  · 模型网关：chat + Files 透传、真 key 换发  │
│  · 会话/工具/Git 全在本地执行          │ ───▶ │  · 会话归档：DSH 原生文件 + PG 索引           │
└──────────────────────────────────────┘      │  · Git/代码变更记录                          │
                                              │  · 管理后台（总览/账号/会话/同步状态）         │
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
- **files-first**：client 优先走 Files API（与本地直连行为一致），上传失败自动降级 base64 内联
- 网关日志/审计带 `model` 字段，每次请求可追溯用了哪个模型
- 一个真 key = 一个共享文件空间：同内容图片天然去重复用

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

监听 `tools/post-execute` 检测 git 命令（水瀑，必须 `next()`）→ commit 成功后提取元数据上传：
- `team_git_ops`：操作流水（谁/哪会话/哪项目/动作/成败）
- `team_code_changes`：commit_hash UNIQUE 幂等（提交/文件数/增删行）
- 隐私边界：**只传元数据，不传命令参数、commit 消息、diff 内容**

### 5. 管理后台

`/team/admin`（仅 admin）：总览仪表盘（指标卡/趋势/排行/模型消耗）、会话分析抽屉（指标/工具耗时/分组时间线）、账号管理、同步状态、手动对账。

### 6. 工作台访问控制

- 根路径 `/` 由 server 端重定向：已登录 → 后台，未登录 → 登录页（工作台不再直接可达）
- 工作台仅在 `/team/workspace`，且只允许 admin 角色（双保险：server 重定向 + 页面守卫脚本）

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
TEAM_SERVER_URL=http://127.0.0.1:3081
```

> `!!js` 表达式在进程加载时求值：有 `TEAM_SERVER_URL` → llm-deepseek 指向网关 + 公司 token；没有 → 本地直连。同一份 patch 按环境分叉。

### 启动

```powershell
# 服务器（3081）
cd scratch-plugin/team-server
./start-local.ps1

# 员工机（3080）
cd scratch-plugin/team-client
./start-local.ps1
```

### 默认账号

`team-server/src/users.json` 播种：`hahame/a123456`（admin）、`liu/123456`、`zhang/123456`（developer）。

## 目录结构

```
scratch-plugin/
├── README.md                 # 本文档
├── team-server/              # 服务器侧插件
│   ├── src/index.ts          #   插件入口（Service 实现）
│   ├── src/routes.ts         #   HTTP 路由（网关/同步/Git/管理后台）
│   ├── src/auth.ts           #   认证会话（Cookie/Bearer/ticket）
│   ├── src/database.ts       #   PG 访问
│   ├── src/reconcile.ts      #   对账（文件↔PG 收敛）
│   ├── src/session-metrics.ts#   会话指标聚合
│   ├── src/admin/main.tsx    #   管理后台前端
│   └── src/login/            #   登录页
├── team-client/              # 员工侧插件
│   ├── src/index.ts          #   插件入口（登录转发/扣 token/守卫）
│   ├── src/sync.ts           #   会话同步（md5 增量 + 稳定性校验）
│   ├── src/git-sync.ts       #   Git/代码变更同步
│   ├── src/client/           #   UI（同步横幅/账号状态）
│   └── src/login/            #   登录页
└── *.md / *.html             # 设计与文档
```

## 环境变量一览

| 变量 | 适用 | 说明 |
|---|---|---|
| `TEAM_ROLE` | 两端 | `client` 或 `server`（server 禁用 team-client） |
| `TEAM_SERVER_URL` | client | 服务器地址；有值 → 网关模式 |
| `DB_URL` / `REDIS_URL` | server | PG / Redis 连接串 |
| `TEAM_SESSIONS_ROOT` | server | 会话文件根目录 |
| `DEEPSEEK_API_KEY` | server | 真密钥（只 server 内 resolve） |

## 关键端点

| 域 | 端点 | 鉴权 |
|---|---|---|
| client | `/team/login` `/team/session` `/team/enter` `/team/logout` `/team/login-page` | — / Cookie |
| server API | `/team/api/login` `/team/api/session` `/team/api/model/chat/completions` `/team/api/model/files*` | Bearer |
| server API | `/team/api/sync/session` `/session/status` `/sessions` `/team/api/git/ops` `/changes` | Bearer |
| server API | `/team/api/admin-ticket` `/team/admin/consume` | Bearer / — |
| server admin | `/team/admin` `/team/admin/overview` `/users` `/sessions` `/analytics` `/insights` `/sync-status` `/sync/reconcile` | admin |

## 设计决策（为什么这样做）

| 决策 | 选择 | 不选 X 的原因 |
|---|---|---|
| 会话存储 | 文件真相 + PG 派生索引 | DB blob 无法重放/版本化 |
| 同步粒度 | 字节增量 + md5 | 整文件 O(n²) 带宽 |
| 进度标记 | md5（内容指纹） | size+mtime 漏判压缩重写 |
| 位置来源 | 每次拉 server 标记 | 本地记：崩溃即丢、压缩弄脏 |
| 会话凭证 | Redis 服务端会话 | JWT 撤销要黑名单 |
| 两套认证 | Bearer + Cookie 分治 | 合并会暴露 token |
| 跨边界凭证 | 30 秒一次性 code | token 直传泄露窗口 7 天 |
| 一致性 | 写路径尽力 + 对账 | 文件系统 + DB 无法原子 |
| 坏文件 | 全量后首帧校验 + 清标记 | 无头文件会拖垮启动/列表 |

## 已知取舍与路线图

- **安全后置项**：scrypt 密码哈希、token sha256、禁用即时生效、登录限流
- **Git Step 2**：代码分析面板（统一字段已具备，按 cwd/userId/sessionId 关联）
- **愿景阶段 1**：会话经验卡 schema + LLM 提炼（本地提炼再上传，守隐私）
- **愿景金字塔**：采集 ✅ → 提炼（命门）→ 检索 → 问答，不能跳步
