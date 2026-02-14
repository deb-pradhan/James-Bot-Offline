#!/bin/bash
set -e

echo "=== James Bot API Starting (v2) ===" >&2
echo "DATABASE_URL host: $(echo $DATABASE_URL | sed 's|.*@||;s|/.*||')" >&2
echo "PORT=${PORT:-8000}" >&2

# Skip Alembic for now — DB already at v005
echo "Skipping Alembic (DB pre-migrated). Starting server directly..." >&2

exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8000}" \
    --workers 1 \
    --log-level info
