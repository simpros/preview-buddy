# E2E acceptance harness

Runs against the **operator compose stack** (`docker-compose.yml` +
`e2e/docker-compose.e2e.yml`) with real Docker, Postgres, and Traefik.

## Commands

```bash
# Fixture contract tests only (no Docker)
bun run test:e2e:fixtures

# Full harness: compose up → tests → compose down
bun run test:e2e
```

Requires Docker. The managed run uses project name `preview-buddy-e2e`, host
ports **17331** (gateway) / **18880** (Traefik), and admin token
`e2e-admin-token` (see `compose.e2e.env`).

## What runs today vs skipped

| Suite | Needs | Status |
|---|---|---|
| `fixtures.test.ts` | nothing | always runs |
| `stack.test.ts` | compose | `/healthz` + admin deploy-token create |
| `lifecycle.test.ts` | `#25`/`#26`/`#27` (+ seed `#28`) | `skipIf` while `/v1/deploy` or `/v1/teardown` return **501** |
| `sweep.test.ts` | `#25`+`#30`/`#31` | compose assert `skipIf` until deploy + doctor exist; orphan fixture shape in `fixtures.test.ts` |

When feature tickets land and leave the 501 stubs, the lifecycle/sweep tests
enable themselves via the capability probe — no harness edit required for the
skip gate (request body shape may still need a one-line adjust in
`harness/gateway.ts`).

## Recorded forge fixtures

Under `fixtures/forge/`:

- `github-open-prs.json` — open PR list for GitHub sweep path
- `github-orphan-no-open-prs.json` — empty list (intentional orphan scenario)
- `gitlab-open-mrs.json` — open MR list for GitLab forge coverage in the suite

Live GitLab is optional; the GitLab fixture is the required coverage for v0.1.
