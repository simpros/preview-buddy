# Shared instance with logical per-PR databases, not containers

Each preview gets its own **logical database** (`prev_pr<id>`) on one shared
Postgres instance that runs as a normal long-lived resource. preview-buddy
does not spawn Postgres containers per PR.

## Considered Options

- **One Postgres container per PR (dedicated-container backend)** — rejected
  for v0.1: correct isolation, but every open PR costs a container (~50–100
  MB RAM) and preview-buddy must own container lifecycle. Kept on the roadmap
  as a second backend behind the same interface; useful when tenants need hard
  isolation or different Postgres versions.
- **One schema per PR on a shared database** — rejected: schema-qualified
  `search_path` leaks into application code and migrations; dumps/restore and
  `DROP DATABASE` cleanup become awkward. Logical databases keep the adopting
  app completely unaware.
- **Hosted DB branching (Neon-style)** — rejected: preview-buddy's reason to
  exist is self-hosted first; a hosted control plane contradicts the premise.

## Consequences

- Total database overhead is ~one Postgres regardless of PR count.
- Isolation is per-database: strong for data, shared for CPU/RAM/disk.
- Creation and removal are plain SQL (`CREATE DATABASE` / `DROP DATABASE`),
  identifier-validated; no Docker API involvement.
- A per-PR database password is unnecessary; a single
  `preview_buddy_app` role with per-database grants is the v0.1 trust model.
