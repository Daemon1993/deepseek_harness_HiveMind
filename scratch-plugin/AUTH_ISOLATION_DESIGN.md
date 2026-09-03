# DSH 多用户隔离设计（面试版）

> 多台本地 DSH → 一台服务器 DSH。Server 统一认证、凭证 Host 托管、
> 数据按用户三层隔离。核心：认得出是谁、只让看自己的、员工机器碰不到真密钥。

## 1. 问题与目标

- 员工 A/B 各自本地 DSH，共享一台服务器（模型网关 + 会话归档）
- 验收硬性要求：**A 和 B 不能读取、不能追加对方的会话**；员工机器不持有真 DeepSeek key
- 单向信任：服务器识别每个请求是谁发出的，且数据访问按身份隔离

## 2. 架构全景：两类消费者 × 两套认证 × 三层隔离

```
① 认证层（Server 统一认证）
   机器（本地 DSH Host） → Bearer token   （Redis team:client-token，Host 托管）
   浏览器（管理员）      → HttpOnly Cookie（Redis team:session，浏览器自动携带）

② 数据层（归属绑定）
   team_session_log：session_id → user_id（跨用户冲突被 DB 约束拒绝）
   文件为真相（session.jsonl.zstd 副本）+ PG 派生索引 + 对账兜底

③ 接口层（每次请求校验身份）
   端点 Bearer → userId → 只允许操作自己的会话（403/404 区分）
   查询按 userId 过滤（listOwnSessions）
```

## 3. 认证细节

| 机制 | 载体 | Redis key | 生命周期 | 消费者 |
|---|---|---|---|---|
| 机器认证 | Bearer token | team:client-token:* | 固定 7 天 | 本地 DSH（网关/同步/水合） |
| 浏览器会话 | HttpOnly Cookie | team:session:* | 滑动续期 | 管理员（后台/入口） |
| SSO 桥接 | 一次性 code | team:admin-ticket:* | 30 秒、消费即删 | 浏览器跳转（免密进后台） |

**登录流程（本地 DSH）**：浏览器提交账号密码 → Host 转发 server → server 校验（PG 账号）→ 建 Redis 记录 → 返回 token → **Host 拦截**（credentials + 内存）→ 浏览器只收到 user 信息。

**SSO ticket 流程**：点头像 → Host 拿 token 换一次性 code → 浏览器跳 server 消费 → 种管理员 Cookie → 进后台。code 只能换一个新会话、不能调任何 API。

**水合（重启恢复）**：重启后 Host 用持久化 token 调 server 校验 → 恢复用户 → 免重登。

## 4. 隔离的三层落实

```
存储层：归属绑定表约束（INSERT ... ON CONFLICT DO UPDATE ... WHERE user_id = EXCLUDED.user_id）
        → 会话已被他人绑定则拒绝，跨用户追加/改写不可能
查询层：listOwnSessions(userId) 按 userId 过滤；管理端才可见全量
接口层：每个 /team/api/* 端点先 Bearer → userId → 再查归属 → 403（非本人）/404（不存在）
```

## 5. 五个技术亮点

1. **Token 永不进浏览器**：凭证只存在于 Host 进程（credentials 文件 + 内存），不进 devtools/历史/localStorage，泄露面最小化
2. **两套认证 = 两类消费者，不合并**：机器要可携带的 Bearer，浏览器要自动携带的 Cookie；合并会暴露 token 或需要嗅探调用方
3. **SSO ticket 用短命一次性 code 桥接**：泄露窗口从 7 天（token）缩到 30 秒（code），且 code 用途单一、消费即删——OAuth2 authorization code 同款
4. **模型网关凭证代换**：公司 token → server 内部换真 DEEPSEEK_API_KEY → 流式转发，真 key 不出 server
5. **隔离靠数据库约束而非信任**：跨用户操作在存储层被拒绝，不是客户端自觉

## 6. 面试追问要点

- **为什么不共享 Cookie**：生产环境 client=127.0.0.1、server=公司域名，Cookie 跨域不共享，SameSite/Secure 全踩坑
- **为什么不用 JWT**：Redis 会话可服务端撤销、可滑动续期、O(1) 校验；JWT 无状态但撤销要黑名单
- **隔离在哪几层**：存储（约束）→ 查询（过滤）→ 接口（鉴权）三层
- **为什么不用加盐 md5**：内容指纹非秘密，盐是密码哈希概念，加盐会破坏对账（详见 SYNC_DESIGN.md）
- **已知取舍**（诚实）：token 未哈希存储、禁用账号不即时生效——识别了风险，按 MVP 优先级后置，演进方向明确（token 哈希、状态即时校验）。
  密码已用 scrypt 哈希存储（自描述格式 `scrypt$v=1$N$r$p$salt$hash` + 常量时间比较，见 `passwords.ts`）；启动时会自动把旧明文/旧列迁移为哈希（见 `index.ts`、`database.ts` 的 `password → password_hash` 改名），因此"明文密码"已不再是当前取舍。

## 7. 演进方向（后置清单）

- ~~密码 scrypt 哈希~~（已完成：见 `passwords.ts`）
- Redis token 哈希存储（当前原始 token 作 key）
- 账号禁用即时生效（网关/同步处校验 status）
- Access/Refresh 双 token + 轮换（受官方适配器 401 重试限制，需动 packages/）
- 多设备管理（deviceId 已预留字段思路）
