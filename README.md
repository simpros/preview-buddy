# preview-buddy

Per-PR **preview databases** (and optional preview app containers) for
self-hosted deployments.

When a pull request opens, CI calls the preview-buddy **gateway**, which
provisions an isolated **logical database** on a shared Postgres instance,
starts a preview app container, optionally runs a seed image, and tears
everything down when the PR closes.

```
create → migrate (app) → seed (optional) → hand over → drop
```

## Why

Preview deployments often share one database with production or with each
other. Migrations in previews then mutate shared state. preview-buddy gives
every PR its own database on a single shared Postgres — low overhead, full
data isolation per PR.

## How

1. Operator deploys **Postgres** + the **gateway** (Docker compose) once.
2. Adopting repo adds `.preview-buddy.yaml` and a CI workflow:
   - `pbuddy deploy -i <app-image>` on PR open/sync
   - `pbuddy deploy -i <app-image> -s <seed-image>` when seeding is needed
   - `pbuddy teardown` on PR close
3. Gateway **preview-db module** creates `prev_<slug>_pr<id>` on the shared
   instance.
4. Gateway **app-deployment module** runs the app container with Traefik
   labels on a shared reverse-proxy network (works alongside Traefik managed
   by Coolify or elsewhere — no Coolify API integration).
5. App image runs migrations at startup; optional **seed image** (built by
   the same CI job) populates data after the app is healthy.
6. **Sweep** reconciles drift if CI teardown is missed.

Auth: deploy tokens for CI, admin tokens for operators. Gateway state in
SQLite. See `docs/SPEC.md` for the full contract.

## Docs

- `CONTEXT.md` — domain vocabulary
- `docs/SPEC.md` — normative v0.1 specification
- `docs/adr/` — architecture decisions

## Status

🚧 v0.1 in progress — specification adopted; implementation catching up.
