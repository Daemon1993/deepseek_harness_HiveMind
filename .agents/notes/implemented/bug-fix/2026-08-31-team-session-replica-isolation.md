# Agent Note: Isolate and transactionally publish Team Session replicas

Status: implemented

English | [中文](2026-08-31-team-session-replica-isolation.zh.md)

## Problem

The Team Server accepted raw Session artifacts from a local Client into the active JSONL persistence root. On one machine, an omitted `TEAM_SESSIONS_ROOT` resolved both processes to `$DSH_HOME/sessions`. Full uploads replaced the shared file before parser validation and deleted it when validation failed, so rejecting an incompatible artifact could remove the Client's live log. Incremental uploads appended before checking the resulting size and retained a bad tail after rejection. Concurrent uploads for one Session could also interleave, while one corrupt artifact made the aggregate administration list fail.

## Decision

The Team Server persistence row always resolves to a Server-owned root: `TEAM_SESSIONS_ROOT` when configured, otherwise `$DSH_HOME/team-server-sessions`. The disabled Server bundle preserves `$DSH_HOME/sessions` only when `TEAM_ROLE=client`, so installing both bundles does not redirect Client persistence.

Every upload validates `header.id`, protocol fields, the complete byte count, and the complete MD5. A delta is accepted only when the stored replica itself matches the claimed base size and digest. The Server streams the stored replica into a uniquely named temporary candidate while calculating the base and complete digests in one pass, so it does not construct a complete in-memory buffer. Full and delta uploads parse that candidate through `SessionPersistence.inspect()` and retain or restore the previous replica unless validation succeeds. A per-Session queue serializes those transactions without blocking unrelated Session ids.

The Client coalesces flushes for one Session across a 500 millisecond quiet period. A flush that arrives during synchronization marks the Session dirty, and the scheduler runs once more with the latest durable file after the active upload settles. Disposal and startup backfill bypass the quiet period.

The Server bounds the encoded synchronization request before JSON parsing. The limit covers one 50 MiB binary upload after Base64 expansion plus 64 KiB of metadata; an oversized body returns HTTP 413 and its remaining bytes are discarded without retention.

Team administration reads owned Sessions independently. One unavailable artifact omits only that Session's derived details, and its warning is suppressed until a later successful read proves recovery.

## Alternatives considered

**Require `TEAM_SESSIONS_ROOT` with no default.** Rejected because a missing deployment value should not make startup unsafe or unavailable; the fixed Server-owned default preserves isolation without operator action.

**Validate after replacing and delete on failure.** Rejected because validation failure says nothing about the validity or ownership of the previous file. The previous replica remains recoverable until the candidate passes.

**Append deltas directly and repair on the next full sync.** Rejected because a rejected request must not mutate committed state, and another reader can observe the bad tail before a later repair.

**Serialize every upload globally.** Rejected because only uploads for the same Session contend for one artifact. Unrelated Sessions retain independent progress.

**Use the aggregate Session list and return an empty list on failure.** Rejected because one corrupt artifact would hide every healthy Session and make polling repeat the same global failure.

## Consequences

Server deployments gain a separate default storage tree and must move any intentionally retained replicas or let Clients upload them again. Each accepted upload performs a complete-file digest and transactional replacement, trading additional I/O for rollback and concurrency safety. Streaming bounds memory to the file stream and uploaded delta instead of retaining complete replicas in memory, but strict base verification still reads the stored replica. The encoded request cap bounds retained input before parsing but still permits the protocol's largest supported full upload. Client coalescing delays ordinary flush synchronization by up to 500 milliseconds and reduces repeated reads, hashes, and requests. An incompatible Client artifact is rejected without changing the previous replica. Independent inspection can cost more than header-only aggregate listing, but administration remains available when one artifact is corrupt.
