# preview-buddy

preview-buddy gives every pull request its own **preview database** on a shared
Postgres instance, so self-hosted preview deployments (Coolify first) stop
sharing one database with production. The lifecycle is always:
**create → migrate → seed → hand over → drop**.

## Language

**Preview**:
The complete temporary environment for one pull request: the deployed preview
app plus its preview database. One PR has at most one preview.
_Avoid_: Review app, staging, environment

**Preview database**:
The logical Postgres database that belongs to exactly one preview, named
`prev_pr<id>` (for example `prev_pr42`). It is created empty and populated by
the preview app's own entrypoint (migrate, then seed).
_Avoid_: Test database, branch database, ephemeral db

**Shared instance**:
The single Postgres server that hosts all preview databases. It runs as a
regular long-lived resource, outside the preview lifecycle. Total overhead is
roughly one Postgres, regardless of how many previews exist.
_Avoid_: Preview cluster, dedicated postgres, per-PR postgres

**Sidecar**:
The long-running preview-buddy service itself: receives forge webhooks,
provisions and drops preview databases, tracks state, serves `/status`, and
runs the sweep. It never runs an adopting repo's migrate or seed commands.
_Avoid_: Controller, orchestrator, daemon (use "sidecar")

**Provider**:
The adapter that deploys and removes the preview *app* on a target platform.
`coolify` is the first-class provider; `none` is the noop provider that only
does the database part (used for tests and DB-only adoption).
_Avoid_: Backend, driver, plugin

**Hand over**:
The moment responsibility for the fresh preview database moves from the
sidecar to the preview app: the app's entrypoint waits for the database,
runs migrations, runs the seed command, then execs the app. The sidecar is
never involved in hand over.
_Avoid_: Bootstrap, init phase, setup

**Adopting repo**:
A repository that uses preview-buddy for its previews. It opts in by adding
`.previewdb.yml` and pointing its preview app at the shared instance.
_Avoid_: Client, tenant, user repo

**`.previewdb.yml`**:
The config-as-code file in an adopting repo. Minimal by design: database
naming prefix, TTL, migrate and seed commands. Everything else is defaulted.
_Avoid_: previewdb config, pb config

**Sweep**:
The periodic reconciliation pass: drops databases whose PR is closed (orphan
cleanup after missed webhooks) and enforces the TTL. The sweep is the only
component that deletes without a webhook trigger.
_Avoid_: GC, cron job, cleanup job

**PR id**:
The forge's stable pull-request (or merge-request) number. It is the sole
identity for a preview and its database; branch names are never used as
identity because they can be renamed or reused.
_Avoid_: Branch name as id, MR id (use "PR id" for both forges)

**`pb_state`**:
The sidecar's bookkeeping table: which PR ids are known, their repo, deploy
status, and creation time. The source of truth for `/status` and the CLI.
_Avoid_: State store, registry

**Deploy status**:
The provider-reported state of the preview app: `provisioning`, `deployed`,
`failed`, or `removed`. Database state is not part of deploy status.
_Avoid_: Build status, preview status

## See also

- `docs/SPEC.md` — the grilled specification (v0.1)
- `docs/adr/` — architecture decision records
- `docs/agents/` — how agents consume this documentation
