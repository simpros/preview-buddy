# E2E acceptance harness

Runs against the **operator compose stack** (`docker-compose.yml` +
`e2e/compose.e2e.env`) with real Docker, Postgres, and Traefik.

## Commands

```bash
# Fixture contract tests only (no Docker)
bun run test:e2e:fixtures

# Full harness: compose up → tests → compose down
bun run test:e2e

# Also run lifecycle suites (needs deploy/teardown endpoints from #25–#31)
PB_E2E_FULL=1 bun run test:e2e
```

Requires Docker. The managed run uses project name `preview-buddy-e2e`, host
ports / admin token from `compose.e2e.env` (also the source for
`e2e/harness/config.ts` — no duplicate defaults). `run.ts` waits for the
gateway once and writes `e2e/.session.json` (gitignored); suites only read
that artifact.

## What runs today vs skipped

| Suite | Needs | Status |
|---|---|---|
| `fixtures.test.ts` | nothing | always runs |
| `stack.test.ts` | compose (`PB_E2E_MANAGED`) | `/healthz` + admin deploy-token create |
| `lifecycle.test.ts` | `#25`–`#28` (+ `#31` for list) | `PB_E2E_FULL=1` gate until endpoints land |
| `sweep.test.ts` | `#30` | `test.todo` until sweep trigger exists |

Compose suites skip cleanly when `PB_E2E_MANAGED` is unset (plain `bun test`).
Setting `PB_E2E_MANAGED=1` without going through `bun run test:e2e` errors
with a clear "run via bun run test:e2e" message (missing session artifact).

## Recorded forge fixtures

Under `fixtures/forge/`:

- `github-open-prs.json` — open PR list for GitHub sweep path
- `github-orphan-no-open-prs.json` — empty list (intentional orphan scenario)
- `gitlab-open-mrs.json` — open MR list for GitLab forge coverage in the suite

Live GitLab is optional; the GitLab fixture is the required coverage for v0.1.
