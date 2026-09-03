#!/bin/bash
set -euo pipefail

preview_user="${PB_PG_USER:-pb_preview}"
preview_password="${PB_PG_PASSWORD:?PB_PG_PASSWORD must be set for postgres init}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${preview_user}') THEN
      CREATE ROLE ${preview_user} LOGIN PASSWORD '${preview_password}';
    END IF;
  END
  \$\$;
EOSQL
