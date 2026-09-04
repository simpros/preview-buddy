# E2E acceptance harness

Runs against the **operator compose stack** (`docker-compose.yml` +
`e2e/compose.e2e.env`) with real Docker, Postgres, and Traefik.

## Commands

```bash
# Compose smoke: up → /healthz + admin deploy-token → down
bun run test:e2e

# Also build demo adopting-repo images (needed once lifecycle tests exist)
PB_E2E_FULL=1 bun run test:e2e
```

Requires Docker. Project name `preview-buddy-e2e`. Host ports
(`PB_GATEWAY_HOST_PORT`, `TRAEFIK_HTTP_PORT`) and `PB_ADMIN_TOKEN` are required
keys in `compose.e2e.env` — `e2e/harness/config.ts` fails at load if any are
missing. `run.ts` waits for the gateway once and writes a marker at
`e2e/.session.json` (gitignored); compose suites call `assertSessionLatch()`.

Stack smoke uses `@preview-buddy/api-client` (Eden) for live routes only.

## What runs today vs deferred

| Suite | Status |
|---|---|
| `stack.test.ts` | compose smoke under `PB_E2E_MANAGED` (`/healthz`, admin mint deploy token) |
| `lifecycle.test.ts` | `test.todo` — #25 deploy, #28 seed-skip, #31 teardown/previews |
| `sweep.test.ts` | `test.todo` — #30 sweep |

Compose suites skip cleanly when `PB_E2E_MANAGED` is unset. Setting
`PB_E2E_MANAGED=1` without `bun run test:e2e` errors with a clear missing-latch
message.

## Forge fixture stubs (not coverage yet)

JSON under `fixtures/forge/` are **inert data seeds** for #30 (sweep). There is
no forge/sweep parser in this tree yet, so they do not exercise a code path.

**#34 AC gap:** “GitLab forge code path covered by fixture tests” is **not**
satisfied by this harness MR — real forge coverage lands with #30’s parser
feeding these stubs (and then compose sweep assertions).
