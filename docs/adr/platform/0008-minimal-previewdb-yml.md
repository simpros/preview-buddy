# `.previewdb.yml` stays minimal; behavior is defaulted, not configured

An adopting repo's entire configuration is a handful of lines:

```yaml
database:
  prefix: prev_pr      # optional, this is the default
  ttl: 72h             # optional, default 72h
commands:
  migrate: bun run db:migrate   # optional; entrypoint skips when absent
  seed: bun run seed            # optional; entrypoint skips when absent
```

Everything else — provider selection, ports, the shared-instance DSN, sweep
interval — is sidecar deployment configuration (`PB_*` env), not repo
configuration. If a knob is not needed to make the happy path work or to keep
previews safe, it does not go into `.previewdb.yml`.

## Considered Options

- **Full schema with per-provider blocks (`coolify: app-uuid: …`)** —
  rejected for v0.1: the Coolify application is a deployment-environment fact,
  not a repo fact; the sidecar operator already knows it
  (`PB_COOLIFY_APP_UUID` or repo-matching via API). Putting it in every
  adopting repo duplicates operator knowledge and couples repos to the
  provider prematurely.
- **Zero config (conventions only)** — rejected: `ttl` and the commands are
  genuinely repo-specific; pretending otherwise moves them into hidden
  defaults that surprises adopters.

## Consequences

- `.previewdb.yml` is validated strictly: unknown keys are a hard error, not
  a warning (config drift is how previews silently break).
- The sidecar does not parse `.previewdb.yml` in v0.1 — the *entrypoint
  recipe* (ADR 0003) consumes `commands`; the sidecar consumes `prefix`/`ttl`
  defaults per repo. Parsing lives where the value is used.
- Growing the schema later (per-provider blocks, multiple databases) requires
  an ADR; the minimal shape is a commitment, not an oversight.
