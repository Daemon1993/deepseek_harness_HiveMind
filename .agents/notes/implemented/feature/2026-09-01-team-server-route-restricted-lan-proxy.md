# Agent Note: Team Server route-restricted LAN proxy

Status: implemented

English | [中文](2026-09-01-team-server-route-restricted-lan-proxy.zh.md)

## Problem

Portable team clients need to reach the Team Server from another workstation, but the DSH Web listener also serves privileged Harness APIs. Binding that listener to a LAN interface would expose capabilities outside the Team Server routes and is rejected by the supported CLI.

## Decision

The local Team Server remains bound to `127.0.0.1:3081`. `pnpm start:local` starts a separate listener on the configured `TEAM_SERVER_LAN_HOST` and `TEAM_SERVER_LAN_PORT`; `start:loopback` deliberately omits it. The proxy accepts only `/team` and `/team/*`, requires the configured Host authority, rejects foreign Origin values and cross-site browser requests, strips hop-by-hop headers, and streams accepted HTTP traffic to the loopback Server. WebSocket upgrades and every non-Team route are rejected.

The launcher owns the proxy process, shares its stdout and stderr with the foreground Team Server, and stops it when that Server exits. Proxy access records contain only method, pathname, status, and duration; they omit query strings, headers, and bodies. Before launch, it replaces a previous Team LAN proxy on the configured port, and the local Server script replaces a source-launched DSH Web process on port 3081; both launchers refuse to terminate an unrelated port owner. Portable clients use the LAN proxy origin as `TEAM_SERVER_URL`; Windows Firewall exposes only the proxy port.

This proxy preserves the browser authority checks described by [the API browser trust boundary](../architecture/2026-07-28-api-browser-trust-boundary.md) without granting LAN access to the general DSH configuration and Remote surfaces.

## Alternatives considered

**Bind DSH Web to the LAN address.** The Web Server schema does not accept an arbitrary interface address, the CLI rejects the all-interfaces binding, and the resulting listener would expose unrelated privileged routes.

**Forward the complete DSH port.** A TCP port proxy cannot distinguish Team Server traffic from `/api`, WebSocket, frontend, or future routes, so it gives LAN users a broader surface than the team workflow requires.

**Require Nginx or Caddy for local development.** A production deployment should use a maintained reverse proxy with TLS, but requiring another installation makes the source-checkout LAN workflow harder to reproduce on Windows.

## Consequences

LAN clients and administrators can use the Team Server routes without reaching the general DSH Web API. The Server machine must retain its LAN address, allow the configured proxy port through its firewall, and keep the proxy process running. The built-in proxy provides plain HTTP for a trusted LAN; Internet or untrusted-network deployment still requires TLS and an operational reverse proxy.
