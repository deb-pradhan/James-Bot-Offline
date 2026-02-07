#!/bin/bash
set -e

echo "=== James Bot API Starting ==="
echo "Running Alembic migrations..."
python -m alembic upgrade head || echo "Migration warning (may be first run)"

echo "Starting FastAPI server on port ${PORT:-8000}..."

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
