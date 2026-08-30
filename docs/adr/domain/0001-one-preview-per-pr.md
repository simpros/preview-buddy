# One preview (and one preview database) per PR, recreated only by reopen

A PR maps to exactly one preview and one preview database for its whole
lifetime. Pushes to the PR re-deploy the preview app but never recreate the
database. A fresh database happens exactly once per PR id — when the PR is
(re)opened after its previous preview was dropped.

## Considered Options

- **Fresh database on every push** — rejected: pushes are frequent and
  migrating+seeding from zero each time makes preview round-trips slow and
  hammers the shared instance; and the thing developers test mid-PR is the
  migration delta, which a persistent database actually exercises.
- **Fresh database on demand (`/reset` command)** — deferred to post-v0.1: a
  useful escape hatch for a corrupted preview database, but it needs its own
  access-control story. Not part of the core lifecycle.

## Consequences

- `synchronize` webhook actions are explicit no-ops for the database layer;
  the provider may re-deploy the app.
- Migration history in a preview database accumulates across the PR's pushes
  — this is a feature: the PR's migration chain is tested the way it will
  merge.
- Hand over (migrate + seed) runs only on the first deploy after database
  creation; subsequent deploys run migrate only (seed is skipped when the
  `pb_state` row already shows a migrated database — idempotent entrypoints
  make this safe either way).
