#!/bin/bash
# Start Postgres, ensure the preview role exists/matches PB_PG_PASSWORD, then wait.
set -euo pipefail

docker-entrypoint.sh postgres "$@" &
pid=$!

until pg_isready -U "${POSTGRES_USER:-pb_admin}" -d "${POSTGRES_DB:-postgres}"; do
  sleep 1
done

/ensure-preview-role.sh

wait "$pid"
