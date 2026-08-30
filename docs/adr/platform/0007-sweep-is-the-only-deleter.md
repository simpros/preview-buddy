# The sweep is the only component that deletes without a webhook

Webhooks drive the happy path (opened → create, closed → drop), but they are
not trusted for correctness: missed deliveries, sidecar downtime, and manual
PR closures can leave orphaned preview databases. The **sweep** — the
sidecar's periodic reconciliation pass — is the sole component allowed to
delete without having received a webhook: it queries the forge for currently
open PRs, drops `prev_pr*` databases (and `pb_state` rows) that no longer
correspond to an open PR or exceeded the TTL, and logs every deletion with a
reason.

## Considered Options

- **Webhooks as the only deletion trigger** — rejected: a single missed
  `closed` event (downtime, misconfigured forge, GitLab webhook expiry)
  leaks a database forever. Databases without owners are cost and confusion.
- **TTL-only cleanup** — rejected: TTL bounds lifetime but not count; a burst
  of 30 PRs closed in one hour would keep 30 seeded databases alive for days.
- **Manual cleanup via CLI only** — rejected: the CLI exists, but cleanup
  that only happens when someone notices is not cleanup.

## Consequences

- Deletion is idempotent and reason-tagged: `webhook:closed`,
  `sweep:pr-not-open`, `sweep:ttl-expired`.
- The sweep's provider call is a list of open PR ids per configured repo;
  forge API failures skip the sweep run (fail safe, never mass-delete on
  forge outage).
- First sweep after sidecar startup waits one full interval before acting,
  so a sidecar restart cannot race a just-created database.
