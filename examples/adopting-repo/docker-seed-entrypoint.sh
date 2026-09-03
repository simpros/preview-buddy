#!/bin/sh
# Seed image entrypoint — runs once per PR after app health check passes.
set -eu

: "${PGHOST:?PGHOST required}"
: "${PGDATABASE:?PGDATABASE required}"

until pg_isready -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE"; do
  sleep 1
done

exec bun run scripts/seed.ts "$@"
