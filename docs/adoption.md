# Adopting repo guide

Wire your repository to a running preview-buddy gateway. CI builds and pushes
container images; `pbuddy` calls the gateway API. CI never touches Postgres
admin credentials or the Docker socket.

Copy-paste files live in [`examples/adopting-repo/`](../examples/adopting-repo/).

## Prerequisites

- Operator has deployed the [operator compose stack](deploy.md).
- A **deploy token** scoped to your repo's canonical id
  (`https://github.com/<org>/<repo>`).
- CI secrets: `PBUDDY_URL`, `PBUDDY_TOKEN`.
- Container registry your gateway can pull from (configured once on the gateway).

## `.preview-buddy.yaml`

Add at the repo root. The CLI reads this file locally and sends parsed values
to the gateway. Unknown keys are rejected.

Minimal (app only, default health checks):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

With seeding (`health` block **required** when using `-s`):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
```

- `slug` — short name used in database names (`prev_<slug>_pr<id>`) and
  container names. Alphanumeric.
- `preview.hostname` — per-PR URL host; `{pr_id}` is substituted at deploy time.
- `health` — HTTP poll the gateway runs against the app container IP on the
  Postgres network before starting a seed container.

## App image: migrate at startup

The gateway injects **only** these environment variables into preview app
containers:

```
PGHOST  PGPORT  PGUSER  PGPASSWORD  PGDATABASE
```

Your app image must:

1. Wait until Postgres accepts connections.
2. Run migrations against `PGDATABASE`.
3. Start the web server (expose a port — first `EXPOSE` wins, else gateway uses
   `PB_PREVIEW_PORT_DEFAULT`).

There is **no mandatory wrapper image** from preview-buddy. Copy an entrypoint
that fits your stack.

### Shell entrypoint (any runtime)

See [`examples/adopting-repo/docker-entrypoint.sh`](../examples/adopting-repo/docker-entrypoint.sh):

```bash
#!/bin/sh
set -eu
until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"; do
  sleep 1
done
./migrate.sh   # your toolchain: drizzle-kit, prisma, flyway, etc.
exec "$@"
```

### Bun / Node one-liner variant

```bash
until bun -e "await Bun.sql\`select 1\`"; do sleep 1; done
bun run db:migrate
exec bun run start
```

Migrations must be **idempotent** — synchronize re-deploys keep the same
database and re-run migrate on every container start.

## Optional seed image

Build a separate one-shot image when seed data is not part of the app image.
The gateway runs it after the app passes the health check, **once per PR**
(subsequent synchronize deploys skip seeding when `seeded_at` is set).

[`examples/adopting-repo/Dockerfile.seed`](../examples/adopting-repo/Dockerfile.seed)
shows a minimal pattern: install deps, copy seed script, entrypoint runs
`bun run seed` using the same `PG*` env the gateway injects.

Pass runtime inputs without storing secrets in yaml:

```bash
pbuddy deploy -i "$APP_IMAGE" -s "$SEED_IMAGE" \
  --seed-env FIXTURE_SET=demo \
  --seed-arg --reset
```

## CI workflow (GitHub Actions)

Symmetric triggers — no forge webhooks on the gateway:

| Event | Action |
|---|---|
| `pull_request` opened | `pbuddy deploy` |
| `pull_request` synchronize | `pbuddy deploy` (replaces container, keeps DB) |
| `pull_request` closed | `pbuddy teardown` |

See
[`examples/adopting-repo/.github/workflows/preview-buddy.yml`](../examples/adopting-repo/.github/workflows/preview-buddy.yml).

Key steps:

1. Build and push the app image tagged with `${{ github.sha }}`.
2. On deploy events, run `pbuddy deploy -i <image>` (add `-s <seed-image>` when
   seeding).
3. Capture `preview_url=` from stdout and comment on the PR.
4. On close, run `pbuddy teardown` (idempotent — exit 0 if already gone).

CLI environment in CI:

```yaml
env:
  PBUDDY_URL: ${{ secrets.PBUDDY_URL }}
  PBUDDY_TOKEN: ${{ secrets.PBUDDY_TOKEN }}
```

Install `pbuddy` from a release binary when published, or build from source
(see the example workflow in `examples/adopting-repo/`).

Canonical repo id is derived from `GITHUB_REPOSITORY` automatically.

## Dual-image CI recipe (app + seed)

Build both images from the **same commit** so app and seed stay in sync. Tag
both with the same SHA — no separate `--ref` flag on the gateway.

```yaml
- name: Build and push images
  run: |
    APP_IMAGE="${{ vars.REGISTRY }}/myapp:${{ github.sha }}"
    SEED_IMAGE="${{ vars.REGISTRY }}/myapp-seed:${{ github.sha }}"
    docker build -t "$APP_IMAGE" .
    docker build -f Dockerfile.seed -t "$SEED_IMAGE" .
    docker push "$APP_IMAGE"
    docker push "$SEED_IMAGE"
    echo "APP_IMAGE=$APP_IMAGE" >> "$GITHUB_ENV"
    echo "SEED_IMAGE=$SEED_IMAGE" >> "$GITHUB_ENV"

- name: Deploy preview
  if: github.event.action != 'closed'
  run: |
    pbuddy deploy -i "$APP_IMAGE" -s "$SEED_IMAGE" | tee deploy.log
    grep '^preview_url=' deploy.log >> "$GITHUB_OUTPUT"
```

Use `-i` only (no `-s`) when you do not need a seed image.

## Deploy token setup

One-time per adopting repo (operator or lead dev with admin token):

```bash
export PBUDDY_URL=https://preview-buddy.example.com
export PBUDDY_TOKEN=<admin-token>
pbuddy admin token create \
  --scope deploy \
  --repo "https://github.com/${GITHUB_REPOSITORY}"
```

Add the returned token to the repo's `PBUDDY_TOKEN` secret.

## PR comment snippet

`pbuddy deploy` prints `preview_url=<url>` on success. Parse it in CI:

```yaml
- name: Comment preview URL
  if: github.event.action != 'closed'
  uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const line = fs.readFileSync('deploy.log', 'utf8')
        .split('\n').find(l => l.startsWith('preview_url='));
      if (!line) return;
      const url = line.slice('preview_url='.length);
      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `Preview: ${url}`,
      });
```

Reviewers may see brief 502 responses while the app migrates and starts —
Traefik routes exist before the app is healthy.

## See also

- [Operator deployment](deploy.md)
- `docs/adr/0003-seed-as-user-image.md`
- `docs/adr/0004-ci-driven-lifecycle-no-webhooks.md`
- `CONTEXT.md`
