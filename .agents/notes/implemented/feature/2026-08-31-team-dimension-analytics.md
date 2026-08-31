# Agent Note: Team dimension analytics

Status: implemented

English | [中文](2026-08-31-team-dimension-analytics.zh.md)

## Problem

Team reporting needs to show AI usage and code delivery for the same users and repositories. Assigning each Git commit to one Agent Session is incomplete when commits come from terminals or IDEs, and misleading when one commit combines human edits, several Sessions, or delayed work.

## Decision

The administration console treats users and Git remotes as independent aggregation keys. Session analytics contribute model usage, tokens, tools, errors, duration, and Session lists. Git observations contribute commit hash, subject, collecting user, origin remote, timestamp, and change counts. User rows combine both sources by user id; Project rows combine them by the exact origin remote and include projects that have commits but no Session activity.

The console displays the two sources together but never claims that a commit belongs to a Session. A nullable Session id remains on Git records when a Harness tool supplies it, but it is not an analytics join key. Commits without an origin remote contribute to User analytics and stay outside Project analytics.

The overview endpoint is the common aggregate source for the Overview, User, and Project sections. User and Project rows expand into model, tool, commit, and Session tables. The separate Session section remains an operational drill-down into synchronized Session records.

## Alternatives considered

**Match commits to Sessions by repository and time window.** Parallel Sessions, external Git clients, delayed commits, and mixed human/agent edits make the result probabilistic. Presenting that inference as attribution would create false causality.

**Require all commits to run through Harness tools.** This would improve attribution coverage by constraining developer workflow, but excludes ordinary terminal and IDE Git use and does not solve mixed-origin commits.

**Keep AI and Git in separate products.** Separate pages avoid accidental attribution, but force administrators to manually reconcile users and repositories even though both sources already carry stable user and remote keys.

## Consequences

The MVP answers what AI activity and Git delivery occurred for a user or repository without claiming why one caused the other. Commit subjects provide a direct feature-oriented summary without language-model classification. Exact remote strings remain the project key, so equivalent SSH and HTTPS remotes appear as separate projects until remote canonicalization becomes an explicit requirement.

## Related

Session-side source data follows [Team Session analytics snapshots](2026-08-31-team-session-analytics-snapshots.md). External terminal commits follow [Team command-line Git observation](2026-08-31-team-command-line-git-observation.md).
