# AGENTS.md

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict, ESM)
- **HTTP:** Elysia
- **Tests:** `bun test`
- **Postgres:** `Bun.sql` (admin connection for CREATE/DROP DATABASE)

## Commands

```bash
bun install
bun run dev          # watch src/main.ts
bun test
bun run typecheck
bun run seed         # demo seed fixture (echo demo-seed)
```

## Style

- Plain functions, no classes.
- Keep modules small and focused (`config`, `db`, `events`, `verify`, `server`, `sweep`).
- Fail fast at config load for required env vars.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues on `simpros/preview-buddy`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
