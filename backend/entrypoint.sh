#!/bin/bash
set -e

echo "=== James Bot API Starting ==="
echo "Running Alembic migrations..."
python -m alembic upgrade head || echo "Migration warning (may be first run)"

echo "Starting FastAPI server on port ${PORT:-8000}..."
exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8000}" \
    --workers 1 \
    --log-level info
