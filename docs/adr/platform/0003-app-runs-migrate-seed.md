# The preview app runs its own migrate and seed at hand over

After the sidecar creates the preview database, responsibility moves to the
preview app in one deterministic hand-over step: the app's container
entrypoint waits for the database, runs the repo's `migrate` command, runs its
`seed` command, then execs the application. The sidecar never executes an
adopting repo's commands.

## Considered Options

- **Sidecar runs migrate + seed after `CREATE DATABASE`** — rejected: the
  sidecar would need the repo's runtime (bun versions, package managers,
  native deps) or a runner image per stack; secrets for seed scripts would
  flow through the sidecar; and the sidecar becomes an execution engine for
  arbitrary repo code — a much bigger attack surface and ops burden.
- **Forge CI runs migrate + seed after deploy** — rejected: split-brain
  timing (deploy is up before seed finishes), and repos without CI get
  nothing.

## Consequences

- Adopting repos ship a tiny entrypoint wrapper (provided as a copy-paste
  recipe per stack; Bun first): `wait-for-db → migrate → seed → exec`.
- The sidecar stays a provisioner: SQL in, status out, no repo code executed.
- Seed failure surfaces as a failed preview app start — visible where the
  developer is already looking (the preview), not hidden in sidecar logs.
- Re-deploys of the same PR may re-run migrate/seed against the existing
  preview database; adopters make those commands idempotent (standard
  migration-tool behavior).
