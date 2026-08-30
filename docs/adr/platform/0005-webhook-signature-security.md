# Signed webhooks, optional status token, local-only CLI

preview-buddy's public repo and self-hosted reality set the trust model:
webhook endpoints verify forge signatures (GitHub HMAC-SHA256, GitLab
secret token — both timing-safe), `GET /status` is optionally guarded by
`PB_STATUS_TOKEN` when no token is set it answers only metadata-free
emptiness is never exposed (it fails closed: unset token means status stays
local), and the CLI talks straight to Postgres over the network the operator
already trusts. No user accounts, no admin UI, no sessions.

## Considered Options

- **Fully open endpoints (trusted homelab network)** — rejected: preview-buddy
  is built to be published; unauthenticated webhooks would let anyone create
  or drop databases on the shared instance. Signature verification is cheap
  and removes the whole class of abuse.
- **Token auth for the CLI over HTTP** — rejected: the CLI runs where the
  operator runs (the box that hosts Postgres). It reads the same
  `PB_DATABASE_URL` the sidecar has; adding an HTTP API layer for it would be
  ceremony. `GET /status` exists for dashboards and remote checks, hence its
  optional token.

## Consequences

- Every forge event is verified before parsing beyond signature checks;
  invalid signatures get `400` and no log noise beyond one line.
- `/status` without `PB_STATUS_TOKEN` set returns `401` — operators opt in to
  exposing it explicitly.
- The sweep and all destructive CLI paths (like `drop`) require the admin
  DSN — capability equals holding `PB_DATABASE_URL`, which is operator-only.
- No rate limiting in v0.1: webhook sources are known forges; signature
  checks bound the cost of fakes.
