# Local DSH × N + Server DSH × 1 MVP

## Goal

Prove that multiple employee-owned DSH processes can use their own local workspace, shell, Git, files, tools, and Session storage while one Server DSH owns the real DeepSeek credential, identifies every user, and receives an isolated copy of each logical Session.

## Topology

```text
Local DSH A (liu)   ─┐
                     ├─ authenticated model + Session traffic ─> Server DSH ─> DeepSeek
Local DSH B (zhang) ─┘
```

Local tools always execute on the employee computer. The server proxies model HTTP streams and stores Session Header/Event data; it never replays synchronized events through an Agent and never executes employee tools.

## Required MVP capabilities

1. Each Local DSH logs in to Server DSH and receives a revocable company token.
2. Local DSH uses the existing DeepSeek adapter with the Server Model Gateway as `baseURL`.
3. The gateway validates the company token, replaces it with the real DeepSeek key, and forwards streaming responses without buffering.
4. Existing Agent Loop, tool calling, streaming, workspace, shell, filesystem, and Git behavior remains local and unchanged.
5. Local DSH observes committed `session/created` and `session/event` data through official Host extension points.
6. Server DSH stores each Session Header and contiguous Event log under the authenticated `userId`.
7. Duplicate uploads are idempotent; sequence gaps and cross-user Session conflicts are rejected.
8. Server queries return only Sessions owned by the authenticated user; administrator inspection is outside the MVP acceptance path.

## Acceptance test

- Computer A logs in as `liu`; Computer B logs in as `zhang`.
- Both run Agent work concurrently against different local directories.
- Streaming and tool calls complete normally on both computers.
- Neither client contains the real DeepSeek key.
- Server logs identify the authenticated user for model and Session traffic.
- Server stores both logical Sessions with contiguous Events.
- A and B cannot read or append each other's Sessions.

## Explicitly deferred

Git diff analysis, summaries, experience extraction, project memory, dashboards, reports, pgvector, complex roles, Agent/tool policy, multi-model routing, operations Agents, and customer-service Agents.

Development stops after the acceptance test passes and waits for human validation.
