#!/bin/bash
set -e

echo "=== James Bot API Starting ===" >&2
echo "DATABASE_URL host: $(echo $DATABASE_URL | sed 's|.*@||;s|/.*||')" >&2
echo "PORT=${PORT:-8000}" >&2

echo "Running Alembic migrations..." >&2
timeout 30 python -m alembic upgrade head 2>&1 || echo "Migration warning (may be first run)" >&2

echo "Starting FastAPI server on port ${PORT:-8000}..." >&2

if [ "${RAILWAY_ENVIRONMENT:-}" != "" ] || [ "${ENV:-dev}" = "production" ]; then
    exec uvicorn app.main:app \
        --host 0.0.0.0 \
        --port "${PORT:-8000}" \
        --workers 1 \
        --log-level info
else
    exec uvicorn app.main:app \
        --host 0.0.0.0 \
        --port "${PORT:-8000}" \
        --workers 1 \
        --log-level info \
        --reload \
        --reload-dir /app/app
fi
