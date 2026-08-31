# Agent Note: Team command-line Git observation

Status: implemented

English | [中文](2026-08-31-team-command-line-git-observation.zh.md)

## Problem

The team client observes Git commands executed by Harness tools, but Git commands executed in an external terminal never cross that event stream. Team activity reports therefore omit commits and merges made outside an agent Session.

## Decision

A user explicitly watches each repository through the team client's local HTTP route. The client records the repository's effective post-commit and post-merge hooks, creates a repository-specific proxy hook directory, and assigns that directory through local `core.hooksPath`. Each proxy invokes the previous hook and then appends the repository identifier, previous revision, new revision, action, and timestamp to a client-owned queue without making a network request.

The client atomically renames the active queue into one pending batch and uploads one batch at a time. A batch remains on disk when credentials or either server request fail and is deleted only after the code-change and operation records succeed. Merge events enumerate commits from `ORIG_HEAD..HEAD`. Unwatch restores the prior configuration only while the current value still names the client-owned directory, so a later user change wins. Watch rejects linked worktrees until the client owns worktree-scoped configuration and ownership records; writing shared local configuration would affect sibling worktrees.

## Alternatives considered

**Poll repository HEAD values.** Polling avoids Git configuration changes, but it infers events, can miss revisions replaced between polls, and cannot reliably distinguish commit and merge operations.

**Send HTTP directly from a Git hook.** Direct delivery removes the queue, but makes Git completion depend on client availability, credentials, networking, and cross-platform HTTP tooling.

**Replace one shared hook directory without chaining.** A shared directory is smaller, but disables repository-specific hooks and cannot restore prior configuration safely.

## Consequences

External terminal commits and merges reach the same server metadata endpoints as Harness tool executions without blocking on the network. Watching remains explicit because it changes repository configuration. The implementation intentionally covers post-commit and post-merge only; checkout, rewrite, reset, and push events remain outside this path.
