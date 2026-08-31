# preview-buddy — Specification v0.1

Status: **grilled & adopted** (2026-08-31) — decisions locked in the v0.1
re-grill; normative language (MUST/SHOULD/MAY) per RFC 2119. Every
implementation issue derived from this spec SHOULD reference a section
(`Spec: §N`).

Grounded in: `CONTEXT.md` (vocabulary) · ADRs `0001`–`0005`.

## §1 Product definition

preview-buddy gives every pull request of an **adopting repo** its own
**preview database** on a **shared instance**, and optionally a preview **app
container** reachable via Traefik. Lifecycle:

**create → migrate (app) → seed (optional) → hand over → drop**.

- The **gateway** MUST provision and drop logical databases on the shared
  instance (ADR `0002`).
- The gateway MUST NOT execute adopting-repo migrate logic; the preview app
  image runs migrations at startup.
- Optional seeding MUST use a **seed image** supplied by the adopting repo's
  CI, not gateway-side repo cloning (ADR `0003`).
- Forge webhooks on the gateway are out of scope for v0.1; **symmetric CI**
  drives deploy and teardown (ADR `0004`).

## §2 Architecture

The gateway is **one Docker image, one process**, with two internal modules
(ADR `0001`):

| Module | Responsibility |
|---|---|
| **preview-db** | `CREATE DATABASE` / `DROP DATABASE`, identifier validation |
| **app-deployment** | Preview app containers, Traefik labels, optional seed container |

The operator deploys Postgres and the gateway together (compose). The gateway
container MUST mount the Docker socket and join the Postgres network. It MUST
NOT use the Docker API to manage the Postgres container in v0.1.

Gateway metadata (previews, tokens, repos) MUST live in **SQLite** on the
gateway host, accessed via Bun's built-in SQL API.

## §3 Identity & naming

- Preview identity is **`(canonical_repo_id, pr_id)`**.
- **Canonical repo id** MUST be URL-style, e.g. `https://github.com/org/repo`
  or the GitLab equivalent. The CLI MUST derive it from `git remote` or CI
  env (`GITHUB_REPOSITORY`, `CI_PROJECT_PATH`, etc.) and send it on every
  request.
- **Database name** MUST be `prev_<slug>_pr<id>` where `slug` comes from
  `.preview-buddy.yaml`. The slug MUST be alphanumeric.
- Database identifiers MUST be validated before any SQL.
- Branch names MAY be displayed but MUST NOT key state, routing, or database
  names.

## §4 Preview database module

- Connects via an **admin DSN** (`PB_PREVIEW_POSTGRES_URL` or equivalent).
- On deploy: `CREATE DATABASE prev_<slug>_pr<id>` and grant access to static
  preview credentials configured on the gateway.
- On teardown: `DROP DATABASE` for that name.
- v0.1 supports **Postgres only** on a single shared instance. Per-PR Postgres
  containers are deferred.

## §5 App deployment module

- `pbuddy deploy -i <app-image>` MUST start (or replace) one preview app
  container per `(canonical_repo_id, pr_id)`.
- Container name MUST be `pb-<slug>-pr-<id>` (stable across replacements).
- On **synchronize** (re-deploy): stop and remove the old container, create a
  new one from the new `-i` ref. The preview database MUST NOT be recreated.
- Each preview container MUST be attached to **two** Docker networks:
  `PB_TRAEFIK_NETWORK` and `PB_POSTGRES_NETWORK`.
- Traefik labels MUST be applied at container create. Router hostname MUST
  resolve from `.preview-buddy.yaml` `preview.hostname` with `{pr_id}`
  substituted.
- Service port: first `EXPOSE` port in the image, else
  `PB_PREVIEW_PORT_DEFAULT` (default `8080`).
- Injected env into the **app container** MUST be only:
  `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (derived). The
  gateway MUST NOT inject migrate/seed commands or other env vars in v0.1.

## §6 Seeding

When `pbuddy deploy` includes `-s <seed-image>`:

1. After the preview database exists and the app container is healthy (§7),
   the gateway MUST run a **one-shot seed container** on
   `PB_POSTGRES_NETWORK` only.
2. The seed image MUST be built and published by the adopting repo's CI from
   the same commit as the app image (ADR `0003`). The gateway MUST NOT clone
   repositories or use forge tokens for seeding.
3. The seed image entrypoint MUST be self-contained (install + seed logic
   lives inside the image). The gateway MUST NOT override entrypoint or
   command.
4. Injected env into the **seed container**: `PGHOST`, `PGPORT`, `PGUSER`,
   `PGPASSWORD`, `PGDATABASE`. Gateway sets `PG*` **after** any user-supplied
   `--seed-env` so adopters cannot override the connection.
5. CLI flags (repeatable, max 16 each, not stored in SQLite):
   - `--seed-env KEY=VALUE`
   - `--seed-arg VALUE` (passed as docker run args after the image name)
6. Seed MUST run only when no prior `seeded_at` exists for
   `(canonical_repo_id, pr_id)`. Re-deploy (`synchronize`) MUST skip seeding.
   Retry after `failed` before any `running` row MUST re-run seed.
7. `PB_SEED_TIMEOUT` (default **180s**) bounds the seed container wall clock.
8. On seed failure: status `failed`, app container kept running, log
   `seed:failed` with exit code, no auto-retry. `pbuddy deploy` MUST exit
   non-zero if terminal status is `failed`.
9. When `-s` is present, `.preview-buddy.yaml` MUST include a `health` block
   (§7). When `-s` is absent, seeding is skipped entirely.

## §7 Health checks & deploy phases

**Health polling** (HTTP on the app container's IP on `PB_POSTGRES_NETWORK`):

| Setting | Default |
|---|---|
| `path` | `/health` |
| `interval` | `2s` |
| `timeout` | `120s` |
| `expect` | `200` |

When `health` block is omitted and no `-s`: same defaults apply.

**Internal SQLite phases** (logs): `provisioning` → `starting` → `seeding`
(if `-s`) → `running` or `failed`.

**Displayed status** (`pbuddy list`, API): `provisioning`, `running`,
`failed`, `removed`. Map `starting` and `seeding` to `provisioning`.

`pbuddy deploy` MUST be **synchronous**: block until `running` or `failed`.
Stdout MUST print `preview_url=<url>` only on `running`.

Health timeout → `failed`, log `health:timeout`.

## §8 Lifecycle & CI triggers

Symmetric CI (ADR `0004`):

| Forge event | CI action |
|---|---|
| PR `opened` | `pbuddy deploy -i …` [optional `-s …`] |
| PR `synchronize` | `pbuddy deploy -i …` [optional `-s …`] |
| PR `closed` | `pbuddy teardown` |

- The gateway MUST NOT expose forge webhook endpoints in v0.1.
- `pbuddy teardown` MUST be idempotent (missing preview → exit 0).
- Teardown MUST drop the preview database, remove the app container, remove
  any seed container if running, and set status `removed`. Log reason
  `ci:closed` when invoked via API teardown.

One preview per `(canonical_repo_id, pr_id)` for its lifetime. Database
recreation happens only after a prior teardown (reopen after close).

## §9 Sweep

The sweep is the safety net when CI teardown is missed (ADR `0004`).

Each pass MUST reconcile, per registered repo:

1. SQLite `previews` rows
2. Postgres catalog (`prev_<slug>_pr*` databases)
3. Docker preview containers (`pb-<slug>-pr-<id>`)
4. Forge open-PR list (via `PB_FORGE_TOKEN`, sweep-only)

Actions:

- Drop databases, containers, and state for `(repo, pr_id)` not in the forge
  open set → `sweep:pr-not-open`
- Drop TTL-expired previews → `sweep:ttl-expired`
- Drop orphaned catalog entries or containers → `sweep:orphan-db`

Rules:

- Forge API failure MUST skip the entire sweep pass (never mass-delete on
  outage).
- First sweep after gateway start MUST wait one full interval before acting.
- TTL default: **72h** (`PB_TTL_HOURS`). Per-repo TTL in yaml is out of scope
  v0.1.
- v0.1: single `PB_FORGE_TOKEN` + `PB_FORGE=github|gitlab` for all registered
  repos on that forge instance.

## §10 Authentication

Self-made bearer tokens in SQLite (ADR `0005`); SHA-256 hashes stored, never
raw tokens after creation display.

| Scope | Capability |
|---|---|
| **deploy** | `deploy`, `teardown` for one canonical repo id |
| **admin** | `list`, `doctor`, `drop`, admin token CRUD |

- Bootstrap via `PB_ADMIN_TOKEN` env or auto-generated token printed once on
  first start.
- Repo auto-registers in SQLite when the first deploy token is created for it.
- Revocation via `revoked_at`; no expiry in v0.1.
- Adopting-repo CI MUST use deploy tokens only. CI MUST NOT hold admin tokens
  or Postgres admin credentials.

## §11 Configuration

### §11.1 Adopting repo — `.preview-buddy.yaml`

Strict parse; unknown keys MUST error.

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:              # required when deploy uses -s
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
```

- `slug` REQUIRED.
- `preview.hostname` REQUIRED; `{pr_id}` placeholder REQUIRED.
- `health` REQUIRED when `pbuddy deploy` passes `-s`; optional otherwise.
- No `commands` block in v0.1 (migrate and seed live in images).

Parsed with Bun's built-in YAML support. CLI reads the file locally and sends
parsed values to the gateway.

### §11.2 Gateway — environment

Env-only in v0.1 (no server yaml file). Required:

| Variable | Purpose |
|---|---|
| `PB_PREVIEW_POSTGRES_URL` | Admin DSN for preview-db module |
| `PB_PG_HOST`, `PB_PG_PORT`, `PB_PG_USER`, `PB_PG_PASSWORD` | Static creds injected into preview containers |
| `PB_TRAEFIK_NETWORK` | Docker network for Traefik routing |
| `PB_POSTGRES_NETWORK` | Docker network for Postgres access |
| `PB_REGISTRY_URL`, `PB_REGISTRY_USER`, `PB_REGISTRY_PASSWORD` | Pull creds for `-i` and `-s` images |
| `PB_ADMIN_TOKEN` | Bootstrap admin token (or auto-generate) |
| `PB_FORGE`, `PB_FORGE_TOKEN` | Sweep-only forge access |
| `PB_PORT` | Gateway listen port (default `7331`) |

Optional with defaults:

| Variable | Default |
|---|---|
| `PB_TTL_HOURS` | `72` |
| `PB_SWEEP_MINUTES` | `30` |
| `PB_PREVIEW_PORT_DEFAULT` | `8080` |
| `PB_SEED_TIMEOUT` | `180` |

Gateway container MUST mount `/var/run/docker.sock`.

## §12 State (SQLite)

Table `previews` (minimum columns):

`canonical_repo_id`, `pr_id`, `slug`, `db_name`, `hostname`, `app_image`,
`container_id`, `status`, `created_at`, `updated_at`, `seeded_at`

Status values stored: `provisioning`, `starting`, `seeding`, `running`,
`failed`, `removed`.

Table `repos`: `canonical_id`, `slug`, `created_at` (auto-populated).

Table `api_tokens`: `token_hash`, `scope`, `canonical_repo_id`, `created_at`,
`revoked_at`.

Log seed image ref and arg/env **key count** on deploy; do not persist
`--seed-env` / `--seed-arg` values in SQLite.

## §13 CLI (`pbuddy`)

Binary name: **`pbuddy`**. Env: `PBUDDY_URL`, `PBUDDY_TOKEN`.

| Command | Token | Notes |
|---|---|---|
| `deploy -i <image> [-s <seed-image>] [--seed-env …] [--seed-arg …]` | deploy | synchronous; prints `preview_url=` on success |
| `teardown` | deploy | idempotent, exit 0 if absent |
| `list` | admin | table of previews |
| `doctor` | admin | health + orphan report; exit 1 on problems |
| `drop <pr_id> [--yes]` | admin | without `--yes`: print plan, exit 2 |
| `admin token create --repo …` | admin | |
| `admin token revoke …` | admin | |
| `admin token list` | admin | |

All adopting-repo CI traffic MUST go to the gateway API only.

### Adoption recipe (seeded repo)

```yaml
# CI excerpt
- docker build -t $REGISTRY/app:$SHA -f Dockerfile .
- docker build -t $REGISTRY/app-seed:$SHA -f Dockerfile.seed .
- docker push $REGISTRY/app:$SHA
- docker push $REGISTRY/app-seed:$SHA
- pbuddy deploy -i $REGISTRY/app:$SHA -s $REGISTRY/app-seed:$SHA
```

Single-image repos omit `-s`. No enforced seed-image naming convention.

## §14 API (`/v1/*`)

REST JSON over HTTP. All routes except health require bearer auth.

| Method | Path | Token | Purpose |
|---|---|---|---|
| `POST` | `/v1/deploy` | deploy | provision + deploy (+ optional seed) |
| `POST` | `/v1/teardown` | deploy | drop preview |
| `GET` | `/v1/previews` | admin | list previews |
| `GET` | `/v1/doctor` | admin | diagnostics |
| `POST` | `/v1/admin/tokens` | admin | create deploy token |
| `DELETE` | `/v1/admin/tokens/:id` | admin | revoke token |
| `GET` | `/v1/admin/tokens` | admin | list tokens |

Request bodies carry canonical repo id, pr id, parsed yaml fields, image
refs, and optional seed env/args. Exact shapes are implementation detail.

Deletion reason tags (logs): `ci:closed`, `sweep:pr-not-open`,
`sweep:ttl-expired`, `sweep:orphan-db`, `seed:failed`, `health:timeout`.

## §15 Networking & Traefik

- Preview app containers: dual attach (`PB_TRAEFIK_NETWORK` +
  `PB_POSTGRES_NETWORK`).
- Seed containers: `PB_POSTGRES_NETWORK` only.
- Postgres container: `PB_POSTGRES_NETWORK` only (not on Traefik network).
- Traefik MAY be managed by an external orchestrator (e.g. Coolify); the
  gateway registers routes via Docker labels on containers it creates. No
  Coolify API integration in v0.1.
- Traefik labels at create; URL MAY return 502 during bootstrap until healthy.

## §16 Acceptance criteria

v0.1 sign-off requires:

1. Operator compose: Postgres + gateway + Traefik on a shared stack (Traefik
   smoke test; Coolify not required).
2. Demo adopting repo with `.preview-buddy.yaml`, app Dockerfile, optional
   seed Dockerfile, GitHub Actions workflow (symmetric CI).
3. PR opened → SQLite row, `prev_<slug>_pr<id>` exists, app container
   running, Traefik URL loads after deploy completes.
4. PR synchronize → container replaced, database persists, migrate runs at app
   startup, seed skipped if `seeded_at` set.
5. PR closed → CI teardown → database dropped, container removed, status
   `removed`.
6. `pbuddy doctor` clean on happy path.
7. Sweep drops an intentional orphan when forge reports PR closed.
8. **GitHub** live path required for sign-off. **GitLab** code paths and
   fixture tests required; live GitLab demo optional.

## §17 Non-goals (v0.1)

- Forge webhooks on the gateway
- better-auth / browser login UI
- Gateway-side repo cloning or forge-token clone auth
- Per-repo registry credentials
- Per-repo TTL in `.preview-buddy.yaml`
- Gateway-side migrate, seed command execution, or DB timing hooks
- Coolify API / provider abstraction
- Multi-container-per-preview database backend
- CLI or CI direct Postgres admin access
- Per-PR Postgres containers
- Hosted DB branching (Neon, etc.)
- `pbuddy reset` / on-demand database wipe
- Rate limiting
- `.previewdb.yml` (replaced by `.preview-buddy.yaml`)
- Postgres `pb_state` table (SQLite replaces it)
- `GET /status` HTTP endpoint (use `pbuddy list` / API)
- Coolify-first product positioning
