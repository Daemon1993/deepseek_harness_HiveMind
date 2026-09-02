# Agent Note: Windows portable team client

Status: implemented

English | [中文](2026-09-01-windows-portable-client.md)

## Problem

员工需要无需安装 Node、pnpm 或 DSH 的 Web 客户端，且发布包不能包含服务端凭据。

## Decision

`pnpm build:portable` 构建 DSH 和 `dsh-team-client`，以 hoisted 且仅复制实体文件的布局部署 DSH 已发布依赖闭包，内置固定的 Windows x64 Node 运行时并生成 zip。builder 在压缩前拒绝 symbolic link 与 Windows Junction，执行打包后的 DSH CLI，并验证归档包含 CLI 的直接启动依赖。`start.bat` 设置便携式 `DSH_HOME`，只读取 `config/client.env`，再通过 team-client Cordis 覆盖启动受支持的 `dsh web` 入口。覆盖层从 `TEAM_SERVER_URL` 派生模型网关；team-client Host 插件将同一个环境值用于登录、会话同步和 Git 同步。

## Alternatives considered

**复制开发工作区** — 不采用，因为工作区链接和开发依赖无法便携运行。

**归档 pnpm isolated linker 产物** — 不采用，因为普通 zip 解压无法把 Windows Junction 保留为已安装依赖目录。

**嵌入服务端 API 凭据** — 不采用，因为客户端在登录后使用用户 Company Token，模型凭据仅由服务端持有。

## Consequences

该归档包面向 Windows x64 自包含运行，并将用户 Token 和会话存放在 `data/.dsh`。发布构建必须提供已审核的 Node 下载地址，或使用固定默认地址。
