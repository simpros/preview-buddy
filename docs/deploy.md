# Operator deployment

Deploy **Postgres**, the **preview-buddy gateway**, and **Traefik** once per
environment. Adopting repos then call `pbuddy deploy` / `pbuddy teardown` from
CI — no per-repo server setup.

## Quick start (local smoke)

From the repo root:

```bash
cp compose.env.example compose.env
# Edit POSTGRES_PASSWORD, PB_PREVIEW_POSTGRES_URL (keep in sync), PB_PG_PASSWORD.
# URL-encode special characters in the DSN password.

docker compose --env-file compose.env up -d --build
docker compose --env-file compose.env ps
curl -sf http://127.0.0.1:7331/healthz
# Traefik HTTP entrypoint (host port TRAEFIK_HTTP_PORT, default 8880)
curl -sf http://127.0.0.1:${TRAEFIK_HTTP_PORT:-8880}/ || true
```

`compose.env` is the compose project env. Do **not** copy it to `.env` —
`.env` / `.env.example` are for the gateway process on the host (`bun run
dev`).

Tear down:

```bash
docker compose --env-file compose.env down
# docker compose --env-file compose.env down -v   # also drops SQLite + Postgres volumes
```

The stack in `docker-compose.yml` is the reference **operator compose stack**
for local development and CI smoke. Issue #34 builds the E2E harness on top of
this file. Default network names (`preview-buddy-traefik`,
`preview-buddy-postgres`) are project-local so a smoke `up` does not collide
with an existing Coolify Traefik network named `traefik`.

## Architecture

```text
                    ┌─────────────┐
   PR traffic ─────►│   Traefik   │  network: $PB_TRAEFIK_NETWORK
                    │  (labels)   │
                    └──────┬──────┘
                           │ preview app containers
                    ┌──────▼──────┐
                    │   gateway   │  networks: traefik + postgres
                    │  (pbuddy)   │  + Docker socket
                    └──────┬──────┘
                           │ CREATE/DROP DATABASE (admin)
                    ┌──────▼──────┐
                    │  Postgres   │  network: $PB_POSTGRES_NETWORK
                    │  (shared)   │
                    └─────────────┘
```

- **Postgres** hosts all preview logical databases (`prev_<slug>_pr<id>`).
- **Gateway** administers databases, starts preview containers, and sets
  Traefik routing labels. It mounts the Docker socket and joins both networks.
- **Traefik** terminates HTTP for preview hostnames. Preview app containers
  attach only to `traefik` + `postgres`; seed containers attach to `postgres`
  only.

## Dual network attach

The gateway reads two Docker network names from the environment:

| Variable | Purpose |
|---|---|
| `PB_TRAEFIK_NETWORK` | Network shared with Traefik. Preview **app** containers join this network so Traefik can route traffic via Docker labels. |
| `PB_POSTGRES_NETWORK` | Network shared with Postgres. Gateway, preview **app**, and **seed** containers join this network so they can reach the database by hostname. |

Compose declares both networks with `name: ${PB_…}` so the same variable is the
single source for the Docker network name and the gateway env (defaults are
project-local):

```yaml
networks:
  traefik:
    name: ${PB_TRAEFIK_NETWORK:-preview-buddy-traefik}
  postgres:
    name: ${PB_POSTGRES_NETWORK:-preview-buddy-postgres}
```

When the gateway creates a preview app container it attaches **both** networks.
Seed containers get **Postgres only** — they never need Traefik reachability.

## Traefik coexistence (Coolify and other operators)

preview-buddy does **not** manage Traefik or call the Coolify API. It registers
routes by setting standard [Traefik Docker labels](https://doc.traefik.io/traefik/providers/docker/)
on preview app containers.

To coexist with an **externally managed Traefik** (including Coolify's), use the
overlay instead of forking the reference file:

1. Set `PB_TRAEFIK_NETWORK` / `PB_POSTGRES_NETWORK` in `compose.env` to the
   existing network names (Coolify often uses `traefik`).
2. Ensure those networks exist (`docker network create …` if needed).
3. Bring up **only the gateway** against external networks:

```bash
docker compose -f docker-compose.yml -f docker-compose.external.yml \
  --env-file compose.env up -d --build gateway
```

The overlay marks both networks `external: true` and disables the bundled
`traefik` / `postgres` services (via profiles). Point
`PB_PREVIEW_POSTGRES_URL` at the external Postgres admin DSN.

Also ensure the external Traefik has `--providers.docker=true` and
`--providers.docker.exposedbydefault=false` (or equivalent) so only labelled
containers are published.

Label conventions the gateway applies (v0.1):

- `traefik.enable=true`
- `traefik.http.routers.<name>.rule=Host(\`<hostname>\`)`
- `traefik.http.services.<name>.loadbalancer.server.port=<port>`

Coolify-managed Traefik already watches the Docker socket; preview-buddy
preview containers appear alongside Coolify apps as long as they share the
Traefik network.

## Gateway environment

Required today (gateway fails fast if missing):

| Variable | Description |
|---|---|
| `PB_PREVIEW_POSTGRES_URL` | Admin DSN for `CREATE DATABASE` / `DROP DATABASE` |
| `PB_TRAEFIK_NETWORK` | Docker network name for Traefik-facing containers |
| `PB_POSTGRES_NETWORK` | Docker network name for database reachability |
| `PB_REGISTRY_URL` | Registry host for pulling preview images |

Optional registry auth (empty = anonymous pulls — real registry mode, not a
sentinel string):

| Variable | Description |
|---|---|
| `PB_REGISTRY_USER` | Registry username |
| `PB_REGISTRY_PASSWORD` | Registry password or token |

Additional v0.1 variables (used as app-deployment and sweep land; set them in
compose now so operators do not reconfigure later):

| Variable | Description |
|---|---|
| `PB_PG_HOST` | Hostname preview containers use for `PGHOST` |
| `PB_PG_PORT` | Port preview containers use for `PGPORT` (default `5432`) |
| `PB_PG_USER` | Role preview containers use for `PGUSER` |
| `PB_PG_PASSWORD` | Password preview containers use for `PGPASSWORD` |
| `PB_ADMIN_TOKEN` | Bootstrap admin bearer token; auto-generated if **unset** (omit from env — empty string is not unset) |
| `PB_FORGE` | `github` or `gitlab` — sweep forge type |
| `PB_FORGE_TOKEN` | PAT for sweep open-PR listing |
| `PB_STATE_DB_PATH` | SQLite path (use a volume mount in production) |

Optional tuning (defaults in parentheses):

| Variable | Default |
|---|---|
| `PB_PORT` | `7331` |
| `PB_TTL_HOURS` | `72` |
| `PB_SWEEP_MINUTES` | `30` |
| `PB_PREVIEW_PORT_DEFAULT` | `8080` |
| `PB_SEED_TIMEOUT` | `180` |

See `.env.example` (host gateway / `bun run dev`) and `compose.env.example`
(compose stack). Keep `POSTGRES_*` and `PB_PREVIEW_POSTGRES_URL` in sync in
`compose.env`; do not synthesize the DSN from the raw password in YAML.

## Postgres preview role

The compose stack runs `deploy/postgres/ensure-preview-role.sh` on **every**
Postgres start (via the entrypoint wrapper) to create or `ALTER` the static
preview login (`PB_PG_USER` / `PB_PG_PASSWORD`) using `format(... %I … %L)` so
special characters in the password are safe. Changing `PB_PG_PASSWORD` and
recreating the postgres container (same volume) updates the role password.

The gateway preview-db module grants that role access when it creates each
`prev_<slug>_pr<id>` database.

## Bootstrap admin token

After first boot, read the admin token from gateway logs if you did not set
`PB_ADMIN_TOKEN` in `compose.env`:

```bash
docker compose --env-file compose.env logs gateway | grep -i admin
```

Create a **deploy token** for each adopting repo:

```bash
export PBUDDY_URL=http://127.0.0.1:7331
export PBUDDY_TOKEN=<admin-token>
pbuddy admin token create --scope deploy --repo https://github.com/org/repo
```

Store the deploy token in the adopting repo's CI secrets as `PBUDDY_TOKEN`.

## Smoke checklist

| Check | Command |
|---|---|
| Postgres healthy | `docker compose --env-file compose.env ps postgres` |
| Gateway healthy | `curl -sf http://127.0.0.1:7331/healthz` |
| Networks exist | `docker network inspect preview-buddy-traefik preview-buddy-postgres` |
| Traefik sees Docker | `docker compose --env-file compose.env logs traefik \| tail` |

## See also

- [Adoption guide](adoption.md) — `.preview-buddy.yaml`, CI workflows, app entrypoint
- `examples/adopting-repo/` — copy-paste adopting-repo files
- `CONTEXT.md` — domain vocabulary
