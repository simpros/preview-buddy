# Example adopting repo

Copy these files into your application repository and adjust names, registry
paths, and migrate/seed commands for your stack.

| File | Purpose |
|---|---|
| `.preview-buddy.yaml` | Slug, hostname template, health check |
| `Dockerfile` | App image with migrate-at-startup entrypoint |
| `Dockerfile.seed` | Optional one-shot seed image |
| `docker-entrypoint.sh` | Wait for DB → migrate → exec app |
| `docker-seed-entrypoint.sh` | Seed container entrypoint |
| `.github/workflows/preview-buddy.yml` | Symmetric deploy / teardown CI |

See [docs/adoption.md](../../docs/adoption.md) for the full guide.
