# Long-running sidecar service, not CI jobs

Preview-buddy runs as a single long-running service: it receives forge
webhooks, serves `GET /status`, and runs the sweep on a timer. It is deployed
once next to the shared instance and stays out of every adopting repo's CI.

## Considered Options

- **GitHub Actions / CI-only (no server)** — rejected: the sidecar must also
  serve `/status`, receive GitLab *and* GitHub webhooks with per-repo secrets,
  and react to PRs closed while CI is not running. A CI-only design either
  loses events or needs a database anyway — at which point the server part is
  the smaller half.
- **Two components (API + worker)** — rejected: the workload is tiny (a few
  SQL statements per PR event). One process keeps deployment, config, and
  ops surface minimal.

## Consequences

- One deployable artifact (Bun + Elysia), one `PB_*` env block, one log
  stream.
- The sweep runs in-process on a timer; no external scheduler.
- Downtime of the sidecar delays previews but never breaks existing ones:
  missed events are recovered by the sweep.
