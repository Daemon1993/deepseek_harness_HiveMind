# Agent Note: Team Session analytics snapshots

Status: implemented

English | [中文](2026-08-31-team-session-analytics-snapshots.zh.md)

## Problem

The administration console needs user-level and project-level usage views. Computing these views by opening and parsing every native Session artifact on each request makes page latency and memory work grow with all retained logs.

## Decision

The Team Server writes one content-free analytics snapshot to PostgreSQL after each successful Session publication. The Client asks Git for the repository root and optional `remote.origin.url`; a plain workspace leaves the project fields empty and is excluded from project analytics. The snapshot is keyed by Session ID and stores the project name and Git fields, plus the title, last activity time, and the aggregate result of `analyzeSessionEvents()`. It does not store the workspace path.

Analytics requests read the SQL snapshots. When an ownership row has no snapshot, the Server inspects that native Session artifact once and persists the missing snapshot before returning the result. Session timeline requests continue to inspect the native artifact because the SQL snapshot deliberately omits conversation content and detailed event payloads.

The administration console exposes separate User and Project sections. Both sections use the same time-range rules and aggregate the same Session snapshots, so their totals remain consistent with the overview. A Session detail drawer projects the safe timeline as a compact event rail, a scrollable event list, and a selected-event inspector. The inspector shows model identity and token usage or tool identity, status, and duration without exposing message content, tool arguments, results, command output, or files.

## Data minimization

The snapshot excludes workspace paths, user and assistant message content, tool arguments, tool results, command output, and file content. PostgreSQL contains identifiers, project names, Git roots and origin URLs, timestamps, counters, durations, tool names and aggregate failures, and model token usage.

## Alternatives considered

**Parse every Session file on every request.** This keeps PostgreSQL smaller but repeats full-log I/O and parsing whenever an administrator changes pages or date ranges.

**Store every Session event in PostgreSQL.** This would support arbitrary SQL queries but duplicates the native Session persistence format and expands the sensitive-data footprint.

**Maintain only project totals.** Pre-aggregated project rows are cheap to query but cannot reliably support user views, changed date ranges, or corrected Session ownership without additional invalidation rules.

## Consequences

Overview, User, and Project requests scale with compact SQL rows instead of native log size after snapshots exist. A successful Session upload performs one additional analysis and SQL upsert. The first analytics request after deployment can be slower while it backfills historical Sessions. PostgreSQL schema creation remains monotonic through `CREATE TABLE IF NOT EXISTS`, and deleting a Session ownership row cascades to its snapshot.
