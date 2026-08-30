# AGENTS.md

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict, ESM)
- **HTTP:** Elysia
- **Tests:** `bun test`
- **Postgres:** `pg` (admin connection for CREATE/DROP DATABASE)

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

## Issue tracking

GitHub issues (once repo is pushed).
