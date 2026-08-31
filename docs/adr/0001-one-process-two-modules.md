# One Docker image, one process, two modules

The gateway ships as a single Docker image running one process with two
internal modules — **preview-db** (logical database lifecycle) and
**app-deployment** (preview containers and Traefik labels). Postgres for
previews is a separate operator-managed container, not bundled in the gateway
image.

Splitting into multiple services or a worker/API pair was rejected: the
workload is a few SQL statements and Docker API calls per PR event, and one
deployable artifact keeps operator setup minimal.
