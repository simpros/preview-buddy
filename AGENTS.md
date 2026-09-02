# AGENTS.md

## Stack

- **Runtime:** Bun
- **Monorepo:** Turborepo workspaces (`apps/*`, `packages/*`)
- **Language:** TypeScript (strict, ESM)
- **HTTP:** Elysia (`apps/server`)
- **CLI:** `pbuddy` (`apps/cli`)
- **API client:** `@preview-buddy/api-client` (Elysia Eden)
- **Control-plane DB:** SQLite via Drizzle ORM (`drizzle-orm` RC) + `drizzle-kit` migrations
- **Preview Postgres:** `Bun.sql` admin connection for CREATE/DROP DATABASE (later slices)
- **Tests:** `bun test`

## Commands

```bash
bun install
bun run dev          # turbo dev (server watch)
bun test
bun run typecheck    # turbo build (tsc per package)
bun run db:generate  # drizzle-kit generate (apps/server)
bun run db:migrate   # drizzle-kit migrate (apps/server)
```

## Layout

- `apps/server` — gateway process, Drizzle schema/migrations, Elysia HTTP app
- `apps/cli` — `pbuddy` CLI (uses api-client)
- `packages/api-client` — typed Eden client against `apps/server` `PreviewBuddyApi`

## Style

- Plain functions, no classes.
- Keep modules small and focused.
- Fail fast at config load for required env vars.
- DB schema lives in `apps/server/src/infrastructure/db/`; migrations in `apps/server/drizzle/`.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues on `simpros/preview-buddy`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
