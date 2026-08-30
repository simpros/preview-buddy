# preview-buddy — Specification v0.1

Status: **grilled & adopted** (2026-08-30) — decisions locked in the grill
session; normative language (MUST/SHOULD/MAY) per RFC 2119. Every issue
derived from this spec references a section (`Spec: §N`).

Grounded in: `CONTEXT.md` (vocabulary) · ADRs platform/0001–0008,
domain/0001–0002.

## §1 Product definition

preview-buddy gives every pull request of an **adopting repo** its own
**preview database** on a **shared instance**, so self-hosted preview
deployments (Coolify first-class) stop sharing production data. Lifecycle:
**create → migrate → seed → hand over → drop**.

- The sidecar MUST provision/drop logical databases (`prev_pr<id>`) on the
  shared instance (ADR platform/0002).
- The sidecar MUST NOT execute repo code; the preview app runs its own
  migrate + seed at hand over (ADR platform/0003).
- The provider deploys/removes the preview app; `coolify` first-class,
  `none` default (ADR platform/0004).

## §2 Identity & naming

- PR id is the sole identity; database name is `prev_pr<id>` (prefix
  configurable via `.previewdb.yml database.prefix`) (ADR platform/0006).
- Database identifiers MUST be validated (`pr<digits>` only) before any SQL.
- Branch names MAY be displayed but MUST NOT key anything.

## §3 Lifecycle

| Trigger | Database | App (provider) | State |
|---|---|---|---|
| PR opened | `CREATE DATABASE prev_pr<id>` + grants | deploy preview | `provisioning` → `deployed` |
| PR push (`synchronize`) | none (ADR domain/0001) | provider MAY re-deploy | unchanged |
| PR closed | `DROP DATABASE prev_pr<id>` | remove preview | `removed` |
| Sweep pass | drop orphans/TTL-expired (reason-tagged) | — | corrected per ADR domain/0002 |

- One preview per PR for its whole lifetime; fresh database only on reopen
  after drop (ADR domain/0001).
- Hand over (migrate → seed → exec) is the app entrypoint's job (ADR
  platform/0003); seed is skipped on re-deploys when the database is already
  migrated.
- Sidecar MUST answer `400` on bad signature, `422` on unparsable payload.

## §4 Sweep & garbage truth

- The sweep is the only deleter without a webhook (ADR platform/0007):
  reconcile catalog ⇄ `pb_state` ⇄ forge open-PR list (ADR domain/0002).
- Deletion reasons MUST be logged: `webhook:closed`, `sweep:pr-not-open`,
  `sweep:ttl-expired`.
- Forge API failure MUST skip the sweep pass (never mass-delete on outage).
- First sweep after sidecar start MUST wait one interval.
- TTL defaults to 72h, configurable per repo via `.previewdb.yml database.ttl`.

## §5 Server (sidecar)

- Long-running Bun + Elysia service (ADR platform/0001).
- `POST /webhooks/github` (HMAC-SHA256, timing-safe),
  `POST /webhooks/gitlab` (token, timing-safe),
  `GET /healthz` → `{ok:true}`, `GET /status` → preview list.
- `/status` requires `PB_STATUS_TOKEN`; unset ⇒ `401` (ADR platform/0005).
- Events normalize to `{action: opened|closed, prId, repo}`; everything else
  ignored.

## §6 CLI

- `preview-buddy list` — table (pr, repo, db, deploy status, created, TTL
  left); reads `pb_state` via `PB_DATABASE_URL`.
- `preview-buddy doctor` — config check, `SELECT 1`, catalog ⇄ state orphan
  report; exit 1 on problems.
- `preview-buddy drop <pr_id>` — requires explicit `--yes`; without it,
  prints the plan and exits 2.
- No CLI framework dependency; ANSI with `NO_COLOR` support.

## §7 Configuration

- Repo: `.previewdb.yml` minimal shape (ADR platform/0008) — strict parse,
  unknown keys are errors.
- Sidecar env (all `PB_*` unless a forge convention applies):
  `PB_DATABASE_URL` (required, admin DSN), `GITHUB_WEBHOOK_SECRET`,
  `GITLAB_WEBHOOK_SECRET`, `PB_STATUS_TOKEN`, `PB_COOLIFY_URL`,
  `PB_COOLIFY_TOKEN`, `PB_COOLIFY_APP_UUID` (or repo-match),
  `PB_PROVIDER=none|coolify` (default `none`), `PB_DB_PREFIX=prev_pr`,
  `PB_TTL_HOURS=72`, `PB_PORT=7331`, `PB_SWEEP_MINUTES=30`.
- Fail fast at startup on missing required vars.

## §8 Coolify wiring (adopting repo recipe)

1. Shared instance = regular Coolify Postgres resource.
2. Sidecar deployed once (any runner), env per §7.
3. Preview app: static preview-scoped env vars only (`PGHOST`, `PGPORT`,
   `PB_DB_USER`, `PB_DB_PASSWORD`) + entrypoint wrapper deriving
   `PGDATABASE=prev_$COOLIFY_PULL_REQUEST_ID`, then wait → migrate → seed →
   exec. (Upstream Coolify has no per-preview env injection — verified — so
   derivation happens in the container, never in Coolify.)
4. Forge webhook (PR events) → sidecar URL.

## §9 Testing & acceptance

- Unit: config, events, verify, db naming/validation, sweep decisions, CLI
  guards — no live Postgres required (mock provider + mocked SQL).
- Integration (skipped without `PB_TEST_DATABASE_URL`): real
  create/migrate-seed-hand-over/drop against a disposable Postgres.
- Acceptance for v0.1: PR opened on a demo repo with `PB_PROVIDER=none` on a
  local Postgres ⇒ `prev_pr<id>` exists; `/status` and CLI `list` show it;
  PR closed ⇒ gone; `doctor` reports clean.

## §10 Non-goals (v0.1)

Per-PR containers, schema-per-PR, hosted-DB branching, auth UI, `/reset`
command, CI-only mode, per-provider config blocks in `.previewdb.yml` — all
documented as considered-and-rejected or deferred (see ADRs).
