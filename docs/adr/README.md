# Platform ADRs

Architecture decisions about how preview-buddy itself is built, deployed, and operated.

| # | Decision |
|---|----------|
| [0001](0001-sidecar-service-not-ci.md) | Long-running sidecar service, not CI jobs |
| [0002](0002-shared-instance-logical-dbs.md) | Shared instance with logical per-PR databases, not containers |
| [0003](0003-app-runs-migrate-seed.md) | The preview app runs its own migrate and seed at hand over |
| [0004](0004-provider-abstraction.md) | Provider abstraction with Coolify first-class and `none` as noop |
| [0005](0005-webhook-signature-security.md) | Signed webhooks, optional status token, local-only CLI |
| [0006](0006-pr-id-identity.md) | PR id is the sole preview identity; branch names are never identity |
| [0007](0007-sweep-is-the-only-deleter.md) | The sweep is the only component that deletes without a webhook |
| [0008](0008-minimal-previewdb-yml.md) | `.previewdb.yml` stays minimal; behavior is defaulted, not configured |
