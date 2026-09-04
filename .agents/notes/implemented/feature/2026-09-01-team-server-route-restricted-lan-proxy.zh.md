# Agent Note: Team Server 路由受限的 LAN 代理

Status: implemented

English | [中文](2026-09-01-team-server-route-restricted-lan-proxy.md)

## Problem

便携版团队 Client 需要从其他工作站连接 Team Server，但 DSH Web listener 同时提供高权限 Harness API。把该 listener 绑定到 LAN 网卡会暴露 Team Server 路由以外的能力，而且受支持的 CLI 会拒绝这种做法。

## Decision

本地 Team Server 继续绑定 `127.0.0.1:3081`。`pnpm start:local` 会在配置的 `TEAM_SERVER_LAN_HOST` 和 `TEAM_SERVER_LAN_PORT` 上启动独立 listener；`start:loopback` 会刻意省略该 listener。代理只接受 `/team` 和 `/team/*`，要求使用配置的 Host authority，拒绝外部 Origin 值与跨站浏览器请求，移除 hop-by-hop header，并把通过校验的 HTTP 流量流式转发到 loopback Server。WebSocket upgrade 和所有非 Team 路由都会被拒绝。

launcher 持有代理进程，与前台 Team Server 共享 stdout 和 stderr，并在该 Server 退出时停止代理。代理访问记录只包含 method、pathname、status 与 duration，不记录 query string、header 或 body。启动前，它会替换配置端口上的既有 Team LAN 代理，本地 Server 脚本也会替换 3081 端口上的源码启动 DSH Web 进程；两个 launcher 都拒绝终止无关的端口占用进程。Portable Client 使用 LAN 代理 origin 作为 `TEAM_SERVER_URL`；Windows 防火墙只开放代理端口。

该代理保留 [API 浏览器信任边界](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)描述的浏览器 authority 校验，同时不向 LAN 开放 DSH 的通用配置和 Remote surface。

## Alternatives considered

**把 DSH Web 绑定到 LAN 地址。** Web Server schema 不接受任意网卡地址，CLI 会拒绝全网卡绑定，而且生成的 listener 会暴露无关的高权限路由。

**转发完整 DSH 端口。** TCP 端口代理无法区分 Team Server 流量与 `/api`、WebSocket、前端或未来路由，因此会向 LAN 用户提供超出团队工作流需要的 surface。

**要求本地开发安装 Nginx 或 Caddy。** 生产部署应使用带 TLS 的受维护反向代理，但要求额外安装会使 Windows 源码 checkout 的 LAN 工作流更难复现。

## Consequences

LAN Client 与管理员可以使用 Team Server 路由，同时无法访问通用 DSH Web API。Server 机器必须保持其 LAN 地址、在防火墙中放行配置的代理端口，并保持代理进程运行。内置代理为可信 LAN 提供明文 HTTP；Internet 或不可信网络部署仍然需要 TLS 与运维级反向代理。
