"""
James Bot — FastAPI application entry point.
"""

import logging
import sys
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.database import init_db, close_db
from app.api.router import api_router

# ── Logging Setup ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("=" * 60)
    logger.info(f"  Starting {settings.app_name}")
    logger.info(f"  Debug: {settings.debug}")
    logger.info("=" * 60)

    # Init database (pgvector extension)
    await init_db()
    logger.info("[STARTUP] Database initialized")

    # Run Alembic migrations on startup (optional — can also run separately)
    # This ensures the DB schema is always up-to-date on Railway deploys
    try:
        from alembic.config import Config
        from alembic import command

        alembic_cfg = Config("alembic.ini")
        command.upgrade(alembic_cfg, "head")
        logger.info("[STARTUP] Alembic migrations applied")
    except Exception as e:
        logger.warning(f"[STARTUP] Alembic migration skipped: {e}")

    yield

    # Shutdown
    await close_db()
    logger.info("[SHUTDOWN] Database connections closed")


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(api_router)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "app": settings.app_name}
