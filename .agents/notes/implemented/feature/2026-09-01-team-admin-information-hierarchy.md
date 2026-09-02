# Agent Note: Team admin information hierarchy

Status: implemented

English | [中文](2026-09-01-team-admin-information-hierarchy.zh.md)

## Problem

The team administration page exposes useful account, session, project, Git, and model data, but equal visual weight across navigation, cards, tables, and decorative gradients makes operational state difficult to scan.

## Decision

The administration Client uses one restrained enterprise-console system: a light persistent navigation rail, a white page header with the current section and Server state, neutral work surfaces, blue as the primary action color, and consistent borders and spacing for cards and tables. Existing routes, data fields, permissions, and workflows remain unchanged.

The administrator-only DSH workbench menu opens the local `/team/workspace` entry only from a browser on the Server host. The entry separately requires an administrator session, exchanges it for the DSH browser token, and the LAN proxy rejects that path.

Daily work facts are derived at 17:20 Asia/Shanghai from the user's already persisted Session analytics and Git summaries. A Server-only LLM returns validated structured fields, and each `(user, local date)` row is replaced on regeneration so reports can later aggregate the stored facts without rereading raw session logs.

The user panel applies one selected work date to availability, detail viewing, and manual regeneration. Manual all-user regeneration returns immediately, continues as a Server background job, and exposes queryable status so the page can restore its running indicator after navigation without keeping the request open.

Default accounts from `users.json` are restored individually when missing from PostgreSQL. Existing account data and passwords remain authoritative and are not overwritten by seeds.

## Alternatives considered

**Keep the decorative gradient theme.** This retained the visual noise that obscured hierarchy and made unrelated metrics appear equally important.

**Replace the administration application.** A new application would duplicate working analytics, account, synchronization, and detail workflows without improving their data contracts.

## Consequences

The UI is easier to scan and keeps the existing backend behavior. The administration page owns additional CSS, and future panels must follow the same navigation, surface, and status conventions. Missing seed users return with no password except where an administrator explicitly sets one.
