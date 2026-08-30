# PR id is the sole preview identity; branch names are never identity

A preview and its database are identified by the forge's PR id only:
`prev_pr<id>`. Branch names are metadata at best. Forge PR ids are never
reused, survive renames and force-pushes, and are identical across
webhook payloads, Coolify's `COOLIFY_PULL_REQUEST_ID`, and the CLI.

## Considered Options

- **Branch-name-derived database names (`prev_feature-x`)** — rejected:
  branches get renamed, deleted, and reused; a `prev_` name collision between
  an old and a new branch would silently couple two previews; and
  human-readable does not survive `psql \l` for long anyway once the count
  grows.
- **Random suffix per creation (`prev_pr42_a1b2`)** — rejected: it breaks the
  one-to-one mapping between PR and database that `/status`, the CLI, and the
  sweep rely on, and turns every lookup into a state-table join for zero
  gained safety.

## Consequences

- Webhook → database name mapping is pure arithmetic; no collision logic.
- Recreating a closed PR is impossible (forges never reuse ids), so the sweep
  can safely treat `prev_pr<id>` as authoritative for stateless cleanup.
- Display surfaces (CLI `list`, `/status`) may *additionally* show the branch
  name for humans, but never key on it.
