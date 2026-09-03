#!/bin/sh
# Seed image entrypoint — runs once per PR after app health check passes.
# Same PG* contract as the app entrypoint (gateway injects all five).
set -eu

: "${PGHOST:?PGHOST required}"
: "${PGPORT:?PGPORT required}"
: "${PGUSER:?PGUSER required}"
: "${PGDATABASE:?PGDATABASE required}"

until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"; do
  sleep 1
done

exec bun run seed "$@"
