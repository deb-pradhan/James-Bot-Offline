"""
James Bot — FastAPI application entry point.
"""

import asyncio
import json
import logging
import sys
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import redis.asyncio as aioredis
from sqlalchemy import select

from app.config import get_settings
from app.database import init_db, close_db, async_session
from app.api.router import api_router
from app.models.user import User
from app.services.message_consumer import start_message_consumer

# ── Logging Setup ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)
settings = get_settings()

# Background task handle
_consumer_task: asyncio.Task | None = None


async def restore_telegram_sessions():
    """
    Restore Telegram session data from PostgreSQL into Redis
    so the monitor service can pick them up immediately on restart.
    """
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)

    try:
        async with async_session() as db:
            stmt = select(User).where(
                User.telegram_session.isnot(None),
                User.telegram_api_id.isnot(None),
                User.telegram_api_hash.isnot(None),
            )
            result = await db.execute(stmt)
            users = result.scalars().all()

            restored = 0
            for user in users:
                user_id_str = str(user.id)

                # Check if already connected (don't overwrite an active session)
                connected = await redis_client.get(f"telegram:connected:{user_id_str}")
                if connected == "true":
                    logger.info(f"[STARTUP] User {user.email} already connected, skipping restore")
                    continue

                # Push session data into Redis
                session_data = json.dumps({
                    "session_string": user.telegram_session,
                    "api_id": user.telegram_api_id,
                    "api_hash": user.telegram_api_hash,
                })
                await redis_client.set(f"telegram:session:{user_id_str}", session_data)

                # Notify monitor that a session is available
                await redis_client.publish(
                    "telegram:session_updated",
                    json.dumps({"user_id": user_id_str}),
                )

                restored += 1
                logger.info(f"[STARTUP] Restored Telegram session for {user.email}")

            if restored:
                logger.info(f"[STARTUP] Restored {restored} Telegram session(s) from DB")
            else:
                logger.info("[STARTUP] No Telegram sessions to restore")

    except Exception as e:
        logger.error(f"[STARTUP] Failed to restore sessions: {e}", exc_info=True)
    finally:
        await redis_client.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    global _consumer_task

    logger.info("=" * 60)
    logger.info(f"  Starting {settings.app_name}")
    logger.info(f"  Debug: {settings.debug}")
    logger.info(f"  CORS Origins: {settings.cors_origin_list}")
    logger.info(f"  Frontend URL: {settings.frontend_url}")
    logger.info("=" * 60)

    # Init database (pgvector extension)
    await init_db()
    logger.info("[STARTUP] Database initialized")

    # Run Alembic migrations on startup
    # entrypoint.sh already runs this, but this is a fallback for non-Docker deploys
    try:
        import subprocess
        result = subprocess.run(
            ["python", "-m", "alembic", "upgrade", "head"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            logger.info("[STARTUP] Alembic migrations applied")
        else:
            logger.warning(f"[STARTUP] Alembic migration issue: {result.stderr[:200]}")
    except Exception as e:
        logger.warning(f"[STARTUP] Alembic migration skipped: {e}")

    # Restore Telegram sessions from DB → Redis
    await restore_telegram_sessions()

    # Start real-time message consumer (persists live messages + embeds)
    _consumer_task = asyncio.create_task(start_message_consumer())
    logger.info("[STARTUP] Message consumer started")

    yield

    # Shutdown
    if _consumer_task:
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
        logger.info("[SHUTDOWN] Message consumer stopped")

    await close_db()
    logger.info("[SHUTDOWN] Database connections closed")


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    lifespan=lifespan,
)

# Custom CORS middleware that allows Railway domains dynamically
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


class FlexibleCORSMiddleware(BaseHTTPMiddleware):
    """CORS middleware that allows configured origins + Railway domains."""
    
    def __init__(self, app, allowed_origins: list[str]):
        super().__init__(app)
        self.allowed_origins = set(allowed_origins)
        logger.info(f"[CORS] Configured origins: {self.allowed_origins}")
    
    def is_origin_allowed(self, origin: str) -> bool:
        if not origin:
            return False
        # Exact match
        if origin in self.allowed_origins:
            return True
        # Allow any Railway domain (*.up.railway.app)
        if origin.endswith(".up.railway.app") or origin.endswith(".railway.app"):
            logger.info(f"[CORS] Auto-allowing Railway origin: {origin}")
            return True
        # Allow localhost variants for development
        if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
            return True
        return False
    
    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin", "")
        
        # Handle preflight OPTIONS request
        if request.method == "OPTIONS":
            if self.is_origin_allowed(origin):
                return Response(
                    status_code=200,
                    headers={
                        "Access-Control-Allow-Origin": origin,
                        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
                        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
                        "Access-Control-Allow-Credentials": "true",
                        "Access-Control-Max-Age": "600",
                    },
                )
            else:
                logger.warning(f"[CORS] Rejected origin: {origin}")
                return Response(status_code=400, content="CORS origin not allowed")
        
        # Handle actual request
        response = await call_next(request)
        
        if self.is_origin_allowed(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
        
        return response


app.add_middleware(FlexibleCORSMiddleware, allowed_origins=settings.cors_origin_list)

# Routes
app.include_router(api_router)

# Exception handler for AI disabled
from app.services.llm import AIDisabledError


@app.exception_handler(AIDisabledError)
async def ai_disabled_exception_handler(request: Request, exc: AIDisabledError):
    """Return a clear error when AI features are disabled."""
    return JSONResponse(
        status_code=403,
        content={"detail": str(exc)},
    )


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "app": settings.app_name}
