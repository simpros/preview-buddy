# Provider abstraction with Coolify first-class and `none` as noop

Deploying and removing the preview *app* is behind a `Provider` interface
(`onOpened`, `onClosed`, status). The `coolify` provider is the first-class
implementation, driven by the official REST API. The `none` provider is the
default: it does nothing to the app layer, so preview-buddy works DB-only and
tests run without a Coolify instance.

## Considered Options

- **Coolify-only, no abstraction** — rejected: the sidecar core (database
  lifecycle, state, sweep) is platform-independent; hard-wiring it to one
  PaaS would fork the project's future (Dokploy, CapRover, plain Docker are
  obvious follow-ups) for zero upfront cost.
- **Deep Coolify integration from day one** — rejected: upstream Coolify has
  no per-preview env injection and no preview lifecycle events (verified
  against its OpenAPI). The v0.1 model — app derives its database from its
  own `COOLIFY_PULL_REQUEST_ID`; forge webhooks drive the sidecar directly —
  needs no upstream changes, so deeper integration would block on upstream
  anyway.

## Consequences

- `PB_PROVIDER=none|coolify` selects the implementation; `none` is default.
- The Coolify provider only uses documented OpenAPI paths, re-triggering
  deploys idempotently; it never screens-scrapes or pokes undocumented
  internals.
- Deploy status (`provisioning | deployed | failed | removed`) is
  provider-reported and stored in `pb_state`; the noop provider reports
  `deployed` immediately (app layer not its business).
- Platform quirks (Coolify's shared-preview-env-vars limitation, compose
  preview renaming) live in the provider and its docs, not in the core.
