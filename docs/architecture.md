# Architecture

preview-buddy provisions **per-PR logical databases** on a shared Postgres instance for self-hosted PaaS preview deployments (Coolify first).

## Flow

```
forge webhook → verify signature/token → normalize event → act on Postgres
```

| Event | Action |
|-------|--------|
| PR opened | `CREATE DATABASE prev_pr<id>`, ensure `preview_buddy_app` role, grant per-DB access, record in `pb_state` |
| PR closed | `DROP DATABASE prev_pr<id>`, clear `pb_state` row |

Ignored events: GitHub `synchronize`, GitLab `update` (push-without-lifecycle-change).

## Database naming

- Prefix: `PB_DB_PREFIX` (default `prev_pr`)
- Name: `prev_pr` + PR number, e.g. `prev_pr42`
- `prId` must be digits; identifiers are validated before quoting

## App role

- Role: `preview_buddy_app` (created once with random password if missing)
- Grants: `ALL PRIVILEGES ON DATABASE` for each preview DB
- Preview apps connect with this role; admin DSN stays on preview-buddy only

## Sweep & TTL

`sweep()` reconciles drift:

1. Query `pb_state` (`pr_id`, `repo`, `created_at`)
2. Drop DBs whose PR is not in the open-PR set (provider stub in MVP)
3. Drop DBs older than `PB_TTL_HOURS` (default 72h)
4. Drop orphaned `prev_pr*` databases not backed by open PRs

Run on a cron schedule in production.

## Config-as-code (planned)

`.previewdb.yml` will declare migrate/seed commands and repo wiring. **Not implemented in MVP.**

## Coolify wiring (sketch)

Static preview-scoped env on the preview service:

- `PB_DATABASE_URL` — points at shared Postgres (host/port), database derived at runtime
- `COOLIFY_PULL_REQUEST_ID` — app builds DB name: `prev_pr${COOLIFY_PULL_REQUEST_ID}`
- Entrypoint: run migrate + seed (`bun run seed`) before `exec` the app process

preview-buddy sidecar receives forge webhooks; the preview app never needs per-PR env injection from the PaaS.

## Roadmap

- **Dedicated-container backend** — preview-buddy as its own Coolify service
- **CLI** — manual provision/sweep, local dev helpers
- **Forge API provider** — real open-PR listing for sweep (replacing MVP stub)
