# preview-buddy

Per-PR **preview databases** for self-hosted PaaS (Coolify first-class).

When a pull request opens, preview-buddy provisions an isolated **logical
database** on a shared Postgres instance, lets the preview app run its
migrations and seed command against it, and drops everything when the PR
closes.

```
create → migrate → seed → hand over → drop
```

## Why

Self-hosted PaaS preview deployments usually share one database with
production (or with each other). Migrations in previews then mutate shared
state. preview-buddy gives every PR its own database on a single shared
Postgres — ~100 MB overhead total, full data isolation per PR.

## How (shared-instance mode)

- A small sidecar receives forge PR events (GitHub/GitLab webhooks).
- PR opened → `CREATE DATABASE prev_pr<id>` + per-DB grants.
- The preview app derives its database from its own PR context
  (`COOLIFY_PULL_REQUEST_ID` / `COOLIFY_BRANCH`) — no per-PR env injection
  into the PaaS required.
- Migrations + seed run at container start (config: `migrate_command`,
  `seed_command` — e.g. `bun run seed`).
- PR closed → `DROP DATABASE`; a cron sweep reconciles against open PRs
  (orphan cleanup, TTL enforcement).

## Status

🚧 MVP in progress. See `docs/architecture.md` soon.
