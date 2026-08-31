# Architecture decision records

Flat numbering. All three ADR criteria (hard to reverse, surprising, real
trade-off) were applied — most v0.1 choices are documented in `docs/SPEC.md`
only.

| ADR | Decision |
|---|---|
| [0001](0001-one-process-two-modules.md) | One Docker image, one process, preview-db + app-deployment modules |
| [0002](0002-shared-logical-databases.md) | Shared Postgres instance, logical per-PR databases |
| [0003](0003-seed-as-user-image.md) | Seeding via user-built one-shot seed image, no gateway clone |
| [0004](0004-ci-driven-lifecycle-no-webhooks.md) | Symmetric CI lifecycle; no forge webhooks in v0.1 |
| [0005](0005-self-made-bearer-tokens.md) | Self-made bearer tokens in SQLite, not better-auth |
