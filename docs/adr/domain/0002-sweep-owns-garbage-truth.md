# The sweep, not the state table, is the authority on what still exists

`pb_state` is a *cache* of what preview-buddy believes exists. The truth
about a preview database is the Postgres catalog itself, and the truth about
whether a PR is open is the forge. The sweep reconciles all three (catalog,
state table, forge) and corrects the state table and the catalog — never
trusting any single one as complete.

## Considered Options

- **`pb_state` as the single source of truth** — rejected: state rows can be
  lost (sidecar crash before write), stale (missed webhook), or ahead of
  reality (create succeeded, state write failed). Any of these orphans a
  database forever if the table is authoritative.
- **Postgres catalog as the sole truth** — rejected: the catalog cannot tell
  which PR a `prev_pr42` belongs to *semantically* (repo? ttl? created by
  whom?) — it only supplies the name; without the forge check the sweep
  could not distinguish "PR still open" from "PR long closed".

## Consequences

- Every sweep pass: list prefixed databases (catalog) + list open PRs (forge)
  + read `pb_state`, then (1) drop databases whose PR is closed/unknown/expired,
  (2) delete state rows without a database, (3) insert state rows for
  databases without one (adopting the orphan with `created_at` unknown → TTL
  applies from adoption).
- `/status` and the CLI may show slight staleness between sweeps; they label
  their data source (`state` vs `catalog`) where it matters.
- A deleted `pb_state` row never leaks a live database: the next sweep
  re-adopts or drops it.
