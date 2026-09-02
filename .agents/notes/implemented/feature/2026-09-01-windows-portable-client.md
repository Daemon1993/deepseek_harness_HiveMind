# Agent Note: Windows portable team client

Status: implemented

English | [中文](2026-09-01-windows-portable-client.zh.md)

## Problem

Employees need the Web client without installing Node, pnpm, or DSH, while server credentials remain outside the distributed archive.

## Decision

`pnpm build:portable` builds DSH and `dsh-team-client`, deploys the published DSH dependency closure with a hoisted copy-only layout, embeds a pinned Windows x64 Node runtime, and creates a zip archive. The builder rejects symbolic links and Windows Junctions before compression, executes the packaged DSH CLI, and verifies the archive contains the CLI's direct boot dependencies. `start.bat` sets a portable `DSH_HOME`, reads only `config/client.env`, and starts the supported `dsh web` entry point with a team-client Cordis overlay. The overlay derives the model gateway from `TEAM_SERVER_URL`; the team-client Host plugin uses that same environment value for login, session synchronization, and Git synchronization.

## Alternatives considered

**Copying the development checkout** — rejected because workspace links and development dependencies are not portable.

**Archive pnpm's isolated linker output** — rejected because Windows Junctions do not survive ordinary zip extraction as installed dependency directories.

**Embedding server API credentials** — rejected because the client authenticates with a user Company Token after login and the server owns model credentials.

## Consequences

The archive is self-contained for Windows x64 and stores user tokens and sessions below `data/.dsh`. Release builders must supply a reviewed Node download URL or use the pinned default.
